/**
 * Restart recovery for one pipeline intervention.
 *
 * An intervention is a transaction with real side effects: an instruction is
 * sent into a live conversation, its answer becomes child tasks, and those
 * children are inserted after their parent. A crash in the middle of that
 * transaction must not repeat a side effect, and it must not discard the
 * answer that is already in the session log.
 *
 * The rule this module implements is simple:
 *
 * ```text
 * phase             recovery action
 * planned           read the log: adopt a delivered instruction, else re-enter
 * prompt-sent       re-read session+turn: never send the instruction again
 * prompt-captured   parse the durable answer and insert children (idempotent ids)
 * children-inserted reconcile the queue order, then settle
 * ```
 *
 * Failure is reserved for evidence that cannot be reconciled: a session that
 * no longer exists, a log that cannot be read, or a record that exhausted its
 * explicit restart budget. Every failure records the stable reason in `note`.
 *
 * The module never talks to an agent and never appends a Session event. It
 * reads durable storage and advances records, so a host can run it before the
 * first scheduling tick.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/intervention-recovery
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

import type { DurableSessionReader } from './recovery.ts'
import { TaskId } from './brand.ts'
import type { QueueId, RunId, TaskId as TaskIdType } from './brand.ts'
import type { InterventionRecord, QueueRecord, RunRecord, TaskSpec } from './schema.ts'
import type { DecomposedTask } from './warden.ts'
import {
  DEFAULT_DECOMPOSE_LIMITS,
  FIXED_DECOMPOSE_PROMPT,
  parseDecomposition,
} from './warden.ts'

/** Durable records one recovery pass reads and advances. */
export interface InterventionStore {
  /** One stored intervention, or `undefined`. */
  getIntervention(id: string): InterventionRecord | undefined
  /** Advance one intervention under phase CAS. */
  advanceIntervention(
    id: string,
    expectedPhase: InterventionRecord['phase'],
    next: InterventionRecord,
  ): Promise<InterventionRecord>
  /** One stored run, or `undefined`. */
  getRun(id: RunId): RunRecord | undefined
  /** Replace one run under revision CAS. */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord>
  /** One stored task, or `undefined`. */
  getTask(id: TaskIdType): TaskSpec | undefined
  /** Insert one task at revision 0. */
  createTask(spec: TaskSpec): Promise<TaskSpec>
  /** One stored queue, or `undefined`. */
  getQueue(id: QueueId): QueueRecord | undefined
  /** Replace one queue under revision CAS. */
  updateQueue(id: QueueId, expectedRevision: number, next: QueueRecord): Promise<QueueRecord>
}

/** Durable facts about one instruction and the turn it opened. */
export interface InterventionEvidence {
  /** Session that was read. */
  readonly sessionId: SessionId
  /** Sequence number of the instruction's `user/message`. */
  readonly instructionSeq: number
  /** Text of the durable instruction, used to backfill `promptSent`. */
  readonly instructionText: string
  /** Turn that owns the instruction, when the log proves it. */
  readonly turn: number | undefined
  /** Whether that turn already closed. */
  readonly turnEnded: boolean
  /** Flattened assistant text of that turn, capped by the capture budget. */
  readonly answer: string
}

/** Result of reading one intervention log. */
export type InterventionRead =
  | { readonly kind: 'evidence'; readonly evidence: InterventionEvidence }
  | { readonly kind: 'instruction-missing'; readonly sessionId: SessionId }
  | { readonly kind: 'session-missing'; readonly sessionId: SessionId; readonly detail: string }
  | { readonly kind: 'session-unreadable'; readonly sessionId: SessionId; readonly detail: string }
  | { readonly kind: 'no-session'; readonly detail: string }

/** Identity matched while scanning a session log. */
export interface InterventionIdentity {
  /** Intervention id carried by the instruction's persistent source. */
  readonly interventionId: string
  /** Run the instruction belongs to. */
  readonly runId: string
  /** Turn already persisted by a previous host, when known. */
  readonly turn?: number
}

/** Bounds used while parsing a captured answer. */
export interface InterventionRecoveryLimits {
  /** Maximum child tasks one answer may produce. */
  readonly maxTasks: number
  /** Maximum characters kept from one child prompt. */
  readonly maxPromptChars: number
  /** Maximum characters kept from the whole answer. */
  readonly maxProducedChars: number
}

/** Default bounds, matching the runtime's own decomposition budget. */
export const DEFAULT_INTERVENTION_LIMITS: InterventionRecoveryLimits = Object.freeze({
  maxTasks: DEFAULT_DECOMPOSE_LIMITS.maxTasks,
  maxPromptChars: DEFAULT_DECOMPOSE_LIMITS.maxPromptChars,
  maxProducedChars: DEFAULT_DECOMPOSE_LIMITS.maxProducedChars,
})

/** One phase step a restarted host takes. */
export type InterventionStep =
  /** The transaction reached `settled`; nothing more to do. */
  | { readonly kind: 'settled'; readonly record: InterventionRecord }
  /** The transaction failed for a recorded reason; no retry remains. */
  | { readonly kind: 'failed'; readonly record: InterventionRecord; readonly reason: string }
  /** The instruction is in the log but its turn has not produced an answer yet. */
  | {
      readonly kind: 'awaiting-answer'
      readonly record: InterventionRecord
      readonly sessionId: SessionId
      readonly turn: number | undefined
    }
  /** No instruction is durable; the host may safely enter the transaction. */
  | { readonly kind: 'not-started'; readonly record: InterventionRecord }
  /** Reconciliation made no progress, but nothing was lost. */
  | { readonly kind: 'unchanged'; readonly record: InterventionRecord; readonly reason: string }

/** Options of one recovery coordinator. */
export interface InterventionRecoveryOptions {
  /** Durable records. */
  readonly store: InterventionStore
  /**
   * Durable session logs. Pass `ctx.sessionPersistence`; omitted means every
   * phase that needs log evidence fails as unreadable instead of guessing.
   */
  readonly durableSessions?: DurableSessionReader
  /** Clock for record timestamps; defaults to `Date.now`. */
  readonly now?: () => number
  /** How many restart passes may try to reconcile one record before failing. */
  readonly maxAttempts?: number
  /** Parse bounds; defaults to the warden's own decomposition limits. */
  readonly limits?: Partial<InterventionRecoveryLimits>
}

/** Terminal run states that no longer accept a deferral. */
const TERMINAL_RUN_STATES: ReadonlySet<RunRecord['state']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'deferred',
])

/** Run states a hand-over may still defer. */
const DEFERRABLE_RUN_STATES: ReadonlySet<RunRecord['state']> = new Set([
  'starting',
  'running',
  'needs-attention',
  'paused',
])

/**
 * Flatten assistant content into text.
 * @param content - message content blocks.
 * @returns the concatenated text blocks.
 */
function contentText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Scan one durable session log for an intervention instruction and its answer.
 *
 * The instruction is identified by the persistent message source, not by text
 * or sequence: the source is written with the message, so it survives a crash
 * that loses the host's in-memory capture. The answer is scoped to the turn
 * that owns the instruction; an earlier answer from the task's own work is
 * never mistaken for the decomposition.
 * @param sessionId - session inspected.
 * @param events - durable events in sequence order.
 * @param identity - intervention, run and any previously persisted turn.
 * @param maxChars - cap on the captured answer.
 * @returns the evidence, or `undefined` when the instruction is not durable.
 */
export function scanInterventionLog(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  identity: InterventionIdentity,
  maxChars: number = DEFAULT_INTERVENTION_LIMITS.maxProducedChars,
): InterventionEvidence | undefined {
  let openTurn: number | undefined
  let instructionSeq: number | undefined
  let instructionText = ''
  let turnAtInstruction: number | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'turn/end':
        if (openTurn === event.data.turn) openTurn = undefined
        break
      case 'user/message': {
        if (instructionSeq !== undefined) break
        const source = event.data.source
        if (source.kind !== 'session-orchestrator') break
        if (source.intervention !== identity.interventionId) break
        if (source.runId !== identity.runId) break
        instructionSeq = event.seq
        instructionText = contentText(event.data.content)
        turnAtInstruction = openTurn
        break
      }
      default:
        break
    }
  }
  if (instructionSeq === undefined) return undefined

  const turn = identity.turn ?? turnAtInstruction ?? nextTurnAfter(events, instructionSeq)
  const texts: string[] = []
  let ended = false
  if (turn !== undefined) {
    for (const event of events) {
      if (event.type === 'assistant/message' && event.data.turn === turn && event.seq > instructionSeq) {
        const text = contentText(event.data.message.content).trim()
        if (text !== '') texts.push(text)
      }
      if (event.type === 'turn/end' && event.data.turn === turn) ended = true
    }
  }
  const answer = texts.join('\n\n').slice(0, maxChars)

  return {
    sessionId,
    instructionSeq,
    instructionText,
    turn,
    turnEnded: ended,
    answer,
  }
}

/**
 * Find the first turn opened after one event.
 *
 * A follow-up can be queued while the task's own turn is still open; the agent
 * admits it as the sole message of the *next* turn. That turn, not the open
 * one, is the capture scope.
 * @param events - durable events in sequence order.
 * @param seq - sequence of the instruction message.
 * @returns the next turn number, or `undefined` when none started yet.
 */
function nextTurnAfter(events: readonly SessionEvent[], seq: number): number | undefined {
  for (const event of events) {
    if (event.seq <= seq) continue
    if (event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

/**
 * Read one intervention instruction and answer from durable storage.
 * @param reader - durable session reader, when the host mounted persistence.
 * @param sessionId - session to read.
 * @param identity - intervention identity and any persisted turn.
 * @param maxChars - cap on the captured answer.
 * @returns evidence or a stable read failure.
 */
export async function readInterventionEvidence(
  reader: DurableSessionReader | undefined,
  sessionId: SessionId,
  identity: InterventionIdentity,
  maxChars: number = DEFAULT_INTERVENTION_LIMITS.maxProducedChars,
): Promise<InterventionRead> {
  if (reader === undefined) {
    return {
      kind: 'session-unreadable',
      sessionId,
      detail: 'the host mounted no durable session reader',
    }
  }
  let handle: Awaited<ReturnType<DurableSessionReader['open']>>
  try {
    handle = await reader.open(sessionId, 'read')
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') {
      return {
        kind: 'session-missing',
        sessionId,
        detail: `session '${sessionId}' is absent from durable storage`,
      }
    }
    return {
      kind: 'session-unreadable',
      sessionId,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const { events } = await handle.read(0)
    const evidence = scanInterventionLog(sessionId, events, identity, maxChars)
    return evidence === undefined
      ? { kind: 'instruction-missing', sessionId }
      : { kind: 'evidence', evidence }
  } catch (error) {
    return {
      kind: 'session-unreadable',
      sessionId,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await handle.close()
  }
}

/**
 * Restart reconciliation for pipeline interventions.
 *
 * One instance per host. `resume()` is safe to call repeatedly: every side
 * effect is guarded by the record's phase and by deterministic child ids, so a
 * second pass either advances the record or observes it is already finished.
 */
export class InterventionRecovery {
  private readonly store: InterventionStore
  private readonly durableSessions: DurableSessionReader | undefined
  private readonly now: () => number
  private readonly maxAttempts: number
  private readonly limits: InterventionRecoveryLimits

  /**
   * @param options - durable records, log reader and bounds.
   */
  constructor(options: InterventionRecoveryOptions) {
    this.store = options.store
    this.durableSessions = options.durableSessions
    this.now = options.now ?? (() => Date.now())
    this.maxAttempts = options.maxAttempts ?? 3
    this.limits = {
      maxTasks: options.limits?.maxTasks ?? DEFAULT_INTERVENTION_LIMITS.maxTasks,
      maxPromptChars: options.limits?.maxPromptChars ?? DEFAULT_INTERVENTION_LIMITS.maxPromptChars,
      maxProducedChars: options.limits?.maxProducedChars ?? DEFAULT_INTERVENTION_LIMITS.maxProducedChars,
    }
  }

  /**
   * Read the durable evidence of one instruction.
   * @param record - intervention to inspect.
   * @returns evidence or a stable read failure.
   */
  async read(record: InterventionRecord): Promise<InterventionRead> {
    const run = this.store.getRun(record.runId)
    const sessionId = record.sessionId
      ?? run?.activeSessionId
      ?? run?.sessionLineage[run.sessionLineage.length - 1]
    if (sessionId === undefined) {
      return {
        kind: 'no-session',
        detail: `intervention '${record.id}' names no session`,
      }
    }
    return await readInterventionEvidence(
      this.durableSessions,
      sessionId,
      {
        interventionId: record.id,
        runId: record.runId,
        ...(record.turn === undefined ? {} : { turn: record.turn }),
      },
      this.limits.maxProducedChars,
    )
  }

  /**
   * Reconcile one intervention from its persisted phase.
   *
   * `countAttempt` is true only on a restart pass: a long-running turn is not a
   * retry, so polling inside the same process never consumes the budget.
   * @param record - intervention as observed.
   * @param options - whether this pass consumes one retry.
   * @returns the step the caller must act on.
   */
  async resume(
    record: InterventionRecord,
    options: { readonly countAttempt?: boolean } = {},
  ): Promise<InterventionStep> {
    const current = this.store.getIntervention(record.id) ?? record
    switch (current.phase) {
      case 'planned':
        return await this.resumePlanned(current, options)
      case 'prompt-sent':
        return await this.resumePromptSent(current, options)
      case 'prompt-captured':
        return await this.finishCaptured(current)
      case 'children-inserted':
        return await this.finishInserted(current, options)
      case 'settled':
        return { kind: 'settled', record: current }
      case 'failed':
        return { kind: 'failed', record: current, reason: current.note ?? 'failed' }
    }
  }

  /**
   * Persist the answer captured from the live event stream.
   *
   * This is the only bridge between the live transaction and durable recovery:
   * once the answer is persisted, a restart can finish the transaction without
   * the conversation still being live.
   * @param record - intervention at `prompt-sent`.
   * @param produced - captured answer text.
   * @param turn - turn it was captured from, when known.
   * @returns the advanced record at `prompt-captured`.
   */
  async capture(
    record: InterventionRecord,
    produced: string,
    turn?: number,
  ): Promise<InterventionRecord> {
    const current = this.store.getIntervention(record.id) ?? record
    if (current.phase !== 'prompt-sent') return current
    return await this.advance(current, 'prompt-sent', {
      phase: 'prompt-captured',
      producedPrompt: produced.slice(0, this.limits.maxProducedChars),
      ...(turn === undefined || current.turn !== undefined ? {} : { turn }),
    })
  }

  /**
   * Record the instruction that was sent, and the session it went to.
   * @param record - planned intervention.
   * @param prompt - instruction text.
   * @param sessionId - session that received it.
   * @returns the advanced record at `prompt-sent`.
   */
  async markPromptSent(
    record: InterventionRecord,
    prompt: string,
    sessionId: SessionId,
  ): Promise<InterventionRecord> {
    const current = this.store.getIntervention(record.id) ?? record
    if (current.phase !== 'planned') return current
    return await this.advance(current, 'planned', {
      phase: 'prompt-sent',
      promptSent: prompt,
      sessionId,
    })
  }

  /**
   * Persist the turn the instruction opened, under phase CAS.
   * @param record - intervention at `prompt-sent`.
   * @param turn - turn observed in the live event stream.
   * @returns the advanced record, or the current one when the phase moved on.
   */
  async markTurn(record: InterventionRecord, turn: number): Promise<InterventionRecord> {
    const current = this.store.getIntervention(record.id) ?? record
    if (current.phase !== 'prompt-sent' || current.turn !== undefined) return current
    try {
      return await this.advance(current, 'prompt-sent', { turn })
    } catch {
      // A concurrent capture may have moved the phase; its write is authoritative.
      return this.store.getIntervention(record.id) ?? current
    }
  }

  /**
   * Fail one intervention with a stable reason and record it in `note`.
   * @param record - intervention to fail.
   * @param reason - stable code.
   * @param detail - optional diagnostic.
   * @returns the failed step.
   */
  async fail(
    record: InterventionRecord,
    reason: string,
    detail?: string,
  ): Promise<InterventionStep> {
    const current = this.store.getIntervention(record.id) ?? record
    if (current.phase === 'failed' || current.phase === 'settled') {
      return { kind: 'failed', record: current, reason: current.note ?? reason }
    }
    const note = detail === undefined ? reason : `${reason}: ${detail}`
    const failed = await this.advance(current, current.phase, { phase: 'failed', note })
    return { kind: 'failed', record: failed, reason }
  }

  /**
   * Settle a `planned` record that can never be sent.
   *
   * A run that already ended performed no side effect, so the honest terminal
   * phase is `settled` with the reason in `note`, not `failed`.
   * @param record - unstarted intervention.
   * @param note - why no instruction will be sent.
   * @returns the settled record.
   */
  async abandon(record: InterventionRecord, note: string): Promise<InterventionRecord> {
    const current = this.store.getIntervention(record.id) ?? record
    if (current.phase !== 'planned') return current
    return await this.advance(current, 'planned', { phase: 'settled', note })
  }

  /**
   * Record a pass that could not progress, consuming the retry only when asked.
   * @param record - record that stalled.
   * @param countAttempt - whether this pass uses the restart budget.
   * @param reason - stable reason.
   * @param detail - diagnostic.
   * @returns the unchanged or failed step.
   */
  async stall(
    record: InterventionRecord,
    countAttempt: boolean,
    reason: string,
    detail: string,
  ): Promise<InterventionStep> {
    return await this.retry(record, { countAttempt }, reason, detail)
  }

  /** Reconcile a `planned` record: adopt a delivered instruction or report safe re-entry. */
  private async resumePlanned(
    record: InterventionRecord,
    options: { readonly countAttempt?: boolean },
  ): Promise<InterventionStep> {
    const read = await this.read(record)
    if (read.kind === 'no-session') {
      return await this.fail(record, 'session-missing', read.detail)
    }
    if (read.kind === 'session-missing') {
      return await this.fail(record, 'session-missing', read.detail)
    }
    if (read.kind === 'session-unreadable') {
      return await this.fail(record, 'session-unreadable', read.detail)
    }
    if (read.kind === 'instruction-missing') {
      return { kind: 'not-started', record }
    }
    const evidence = read.evidence
    const adopted = await this.advance(record, 'planned', {
      phase: 'prompt-sent',
      ...(record.promptSent === undefined
        ? { promptSent: evidence.instructionText.trim() === '' ? defaultPrompt(record) : evidence.instructionText }
        : {}),
      sessionId: evidence.sessionId,
      ...(evidence.turn === undefined ? {} : { turn: evidence.turn }),
    })
    return await this.resumePromptSent(adopted, options)
  }

  /** Re-read the instruction turn and capture its answer without resending. */
  private async resumePromptSent(
    record: InterventionRecord,
    options: { readonly countAttempt?: boolean },
  ): Promise<InterventionStep> {
    const read = await this.read(record)
    if (read.kind === 'no-session') {
      return await this.fail(record, 'session-missing', read.detail)
    }
    if (read.kind === 'session-missing') {
      return await this.fail(record, 'session-missing', read.detail)
    }
    if (read.kind === 'session-unreadable') {
      return await this.fail(record, 'session-unreadable', read.detail)
    }
    if (read.kind === 'instruction-missing') {
      return await this.retry(record, options, 'instruction-missing',
        'the instruction is recorded as sent but no durable message carries it')
    }
    const evidence = read.evidence
    // Backfill the capture scope a crashed host never got to persist.
    const scope = {
      ...(record.sessionId === undefined ? { sessionId: evidence.sessionId } : {}),
      ...(record.turn === undefined && evidence.turn !== undefined ? { turn: evidence.turn } : {}),
      ...(record.promptSent === undefined && evidence.instructionText.trim() !== ''
        ? { promptSent: evidence.instructionText }
        : {}),
    }
    const withScope = Object.keys(scope).length === 0
      ? record
      : await this.advance(record, 'prompt-sent', scope)
    if (evidence.answer.trim() !== '') {
      const captured = await this.capture(withScope, evidence.answer, evidence.turn)
      return await this.finishCaptured(captured)
    }
    if (evidence.turnEnded) {
      return await this.retry(withScope, options, 'answer-missing',
        `turn ${evidence.turn ?? '?'} closed without assistant text`)
    }
    return {
      kind: 'awaiting-answer',
      record: withScope,
      sessionId: evidence.sessionId,
      turn: evidence.turn,
    }
  }

  /** Insert children from the durable answer, then settle. */
  private async finishCaptured(record: InterventionRecord): Promise<InterventionStep> {
    const produced = record.producedPrompt
    if (produced === undefined || produced.trim() === '') {
      return await this.fail(record, 'answer-missing', 'the record has no produced prompt to parse')
    }
    const parent = this.store.getTask(TaskId(record.taskId))
    if (parent === undefined) {
      return await this.fail(record, 'task-missing', `task '${record.taskId}' is not stored`)
    }
    const queue = this.store.getQueue(parent.queueId)
    if (queue === undefined) {
      return await this.fail(record, 'queue-missing', `queue '${parent.queueId}' is not stored`)
    }
    const items = parseDecomposition(produced, this.limits)
    if (items.length === 0) {
      return await this.fail(record, 'answer-unparseable', 'the answer contained no executable task')
    }
    const children = await this.insertChildren(parent, queue, items)
    const inserted = await this.advance(record, 'prompt-captured', {
      phase: 'children-inserted',
      childTaskIds: mergeIds(record.childTaskIds, children),
    })
    return await this.settle(inserted)
  }

  /** Reconcile an already inserted transaction without creating anything twice. */
  private async finishInserted(
    record: InterventionRecord,
    options: { readonly countAttempt?: boolean },
  ): Promise<InterventionStep> {
    const parent = this.store.getTask(TaskId(record.taskId))
    if (parent === undefined) {
      return await this.fail(record, 'task-missing', `task '${record.taskId}' is not stored`)
    }
    const queue = this.store.getQueue(parent.queueId)
    if (queue === undefined) {
      return await this.fail(record, 'queue-missing', `queue '${parent.queueId}' is not stored`)
    }
    const missing = record.childTaskIds.filter(id => this.store.getTask(TaskId(id)) === undefined)
    if (missing.length > 0) {
      return await this.retry(record, options, 'children-missing',
        `inserted children are absent: ${missing.join(', ')}`)
    }
    const ids = record.childTaskIds.map(id => TaskId(id))
    const ordered = orderWithChildren(queue, parent.id, ids)
    if (!sameOrder(queue.taskOrder, ordered)) {
      await this.writeQueue(queue, ordered)
    }
    return await this.settle(record)
  }

  /**
   * Create child tasks after the parent, idempotently.
   *
   * Child ids are derived from the parent and their position in the answer, so
   * a retried parse names the same tasks and an existing record is never
   * replaced. The queue order is a set union, not an insertion at a fixed
   * index, so the same children can never be queued twice.
   * @param parent - task the children belong to.
   * @param queue - parent's queue, as observed.
   * @param items - parsed children, in answer order.
   * @returns the child identities, in answer order.
   */
  async insertChildren(
    parent: TaskSpec,
    queue: QueueRecord,
    items: readonly DecomposedTask[],
  ): Promise<readonly TaskIdType[]> {
    const ids: TaskIdType[] = []
    for (const [index, item] of items.entries()) {
      const id = TaskId(`task-${parent.id}-c${index + 1}`)
      ids.push(id)
      if (this.store.getTask(id) !== undefined) continue
      await this.store.createTask({
        id,
        queueId: parent.queueId,
        title: item.title,
        prompt: item.prompt,
        workspaceId: parent.workspaceId,
        cwd: parent.cwd,
        preset: parent.preset,
        model: parent.model,
        skills: parent.skills,
        dependsOn: [parent.id],
        priority: parent.priority,
        handoff: parent.handoff,
        enabled: true,
        stage: parent.stage ?? 'implement',
        parentTaskId: parent.id,
        revision: 0,
      })
    }
    const current = this.store.getQueue(queue.id) ?? queue
    const ordered = orderWithChildren(current, parent.id, ids)
    if (!sameOrder(current.taskOrder, ordered)) {
      await this.writeQueue(current, ordered)
    }
    return ids
  }

  /** Defer the parent run (when a hand-over paused it) and settle the record. */
  private async settle(record: InterventionRecord): Promise<InterventionStep> {
    if (record.kind === 'pause-context') await this.deferRun(record.runId)
    const settled = await this.advance(record, record.phase, { phase: 'settled' })
    return { kind: 'settled', record: settled }
  }

  /**
   * Mark one handed-over attempt as `deferred` under revision CAS.
   * @param runId - attempt whose remainder moved to children.
   */
  async deferRun(runId: RunId): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = this.store.getRun(runId)
      if (latest === undefined) return
      if (TERMINAL_RUN_STATES.has(latest.state)) return
      if (!DEFERRABLE_RUN_STATES.has(latest.state)) return
      try {
        await this.store.updateRun(latest.id, latest.revision, {
          ...latest,
          state: 'deferred',
          revision: latest.revision + 1,
          updatedAt: this.now(),
        })
        return
      } catch {
        // Retry against the newer revision another writer just stored.
      }
    }
  }

  /**
   * Consume one restart attempt, failing only when the explicit budget is gone.
   * @param record - record that made no progress.
   * @param options - whether this pass consumes a retry.
   * @param reason - stable reason.
   * @param detail - diagnostic.
   * @returns the unchanged or failed step.
   */
  private async retry(
    record: InterventionRecord,
    options: { readonly countAttempt?: boolean },
    reason: string,
    detail: string,
  ): Promise<InterventionStep> {
    if (options.countAttempt !== true) {
      return { kind: 'unchanged', record, reason }
    }
    const attempts = (record.recoveryAttempts ?? 0) + 1
    if (attempts >= this.maxAttempts) {
      return await this.fail(record, 'retry-exhausted',
        `${reason} (${attempts}/${this.maxAttempts} restart attempts): ${detail}`)
    }
    const updated = await this.advance(record, record.phase, {
      recoveryAttempts: attempts,
      note: `${reason}: ${detail}`,
    })
    return { kind: 'unchanged', record: updated, reason }
  }

  /** Advance one record under phase CAS from the freshest observed value. */
  private async advance(
    record: InterventionRecord,
    expected: InterventionRecord['phase'],
    patch: Partial<Pick<
      InterventionRecord,
      'phase' | 'promptSent' | 'sessionId' | 'turn' | 'producedPrompt' | 'childTaskIds' | 'recoveryAttempts' | 'note'
    >>,
  ): Promise<InterventionRecord> {
    return await this.store.advanceIntervention(record.id, expected, {
      ...record,
      ...patch,
      updatedAt: this.now(),
    })
  }

  /** Write one queue under revision CAS, retrying against a newer revision. */
  private async writeQueue(queue: QueueRecord, taskOrder: readonly TaskIdType[]): Promise<void> {
    let current = this.store.getQueue(queue.id) ?? queue
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.store.updateQueue(current.id, current.revision, {
          ...current,
          taskOrder: [...taskOrder],
          revision: current.revision + 1,
        })
        return
      } catch {
        const retry = this.store.getQueue(current.id)
        if (retry === undefined) return
        current = retry
      }
    }
  }
}

/**
 * Choose the instruction a resumed record should carry when it has none.
 * @param record - intervention record.
 * @returns the fixed instruction for real decompositions, otherwise its kind.
 */
function defaultPrompt(record: InterventionRecord): string {
  switch (record.kind) {
    case 'pause-context':
    case 'decompose':
    case 'refine':
      return FIXED_DECOMPOSE_PROMPT
    default:
      return record.reason
  }
}

/** Merge two identity lists without duplicates, preserving order. */
function mergeIds(
  existing: readonly TaskIdType[],
  added: readonly TaskIdType[],
): TaskIdType[] {
  const merged = [...existing]
  for (const id of added) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}

/**
 * Place children immediately after their parent, keeping existing order.
 *
 * The result is a set union: no child is inserted twice and children already
 * present keep their relative order.
 * @param queue - queue as observed.
 * @param parentId - parent task identity.
 * @param childIds - children to ensure after the parent.
 * @returns the desired task order.
 */
function orderWithChildren(
  queue: QueueRecord,
  parentId: TaskIdType,
  childIds: readonly TaskIdType[],
): readonly TaskIdType[] {
  const order = [...queue.taskOrder]
  const siblings = new Set<TaskIdType>(childIds)
  let insertAt = order.indexOf(parentId)
  if (insertAt < 0) {
    order.push(parentId)
    insertAt = order.length - 1
  }
  for (const [index, id] of order.entries()) {
    if (siblings.has(id)) insertAt = Math.max(insertAt, index)
  }
  const missing = childIds.filter(id => !order.includes(id))
  if (missing.length > 0) order.splice(insertAt + 1, 0, ...missing)
  return order
}

/** Compare two order arrays element by element. */
function sameOrder(left: readonly TaskIdType[], right: readonly TaskIdType[]): boolean {
  if (left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
}
