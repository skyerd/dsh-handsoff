/**
 * Restart reconciliation for the session orchestrator.
 *
 * Recovery is deliberately read-mostly: it reconstructs what a crashed host
 * actually did from the durable Run/Operation records, the Session header and
 * the Session event log, then performs only transitions that the evidence
 * supports. The operation's persistent message source — not a `MessageId` — is
 * the authority for "was this prompt delivered"; a message identity that
 * cannot be tied to this run/generation/attempt is never replayed.
 *
 * The public surface here is intentionally separate from `RunSupervisor`: the
 * manager owns the startup ordering (host claim, lease acquisition, per-run
 * decision, then scheduler opening), the handle re-acquisition seam, and the
 * unload order. It calls no model, registers no tool and appends no event.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/recovery
 */

import type { Session, SessionEvent, SessionHeader, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import { SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SchedulerTickResult } from './scheduler.ts'
import type {
  RunAcceptedTurn,
  RunResumeProgress,
  RunResumeRequest,
  RunResumeStart,
  RunSettlement,
} from './supervisor.ts'
import type { OperationId, RunId } from './brand.ts'
import { OrchestratorError } from './errors.ts'
import {
  initialPromptOperationId,
  initialPromptRequestHash,
  operationLinkConflict,
} from './operation.ts'
import type { GlobalSettings, OperationRecord, RunLease, RunRecord, TaskSpec } from './schema.ts'

/** Run states recovery must resolve before the scheduler opens. */
const ACTIVE_RUN_STATES: ReadonlySet<RunRecord['state']> = new Set([
  'starting',
  'running',
  'handoff-pending',
  'handing-off',
])

/** Run states that need no reconciliation or re-observation. */
const SETTLED_RUN_STATES: ReadonlySet<RunRecord['state']> = new Set([
  'succeeded',
  'needs-attention',
  'paused',
  'deferred',
  'cancelled',
  'failed',
])

/** The durable run/operation/settings operations recovery needs. */
export interface RecoveryStore {
  /** Every stored run. */
  listRuns(): readonly RunRecord[]
  /** One stored run, or `undefined`. */
  getRun(id: RunId): RunRecord | undefined
  /** Replace one run under revision CAS. */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord>
  /** Every stored operation. */
  listOperations(): readonly OperationRecord[]
  /** One stored operation, or `undefined`. */
  getOperation(id: OperationId): OperationRecord | undefined
  /** Advance one operation phase under phase CAS. */
  advanceOperation(
    id: OperationId,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord>
  /** One stored task, or `undefined`. */
  getTask(id: TaskSpec['id']): TaskSpec | undefined
  /** The single durable global settings record. */
  getSettings(): GlobalSettings
  /** Replace global settings under revision CAS. */
  updateSettings(expectedRevision: number, next: GlobalSettings): Promise<GlobalSettings>
}

/**
 * The read-only durable Session seam recovery needs.
 *
 * `ctx.sessionPersistence` satisfies this structurally. `read` access is used
 * on purpose: reconciliation must work while another handle owns the session
 * for write, and it must never mutate the log.
 */
export interface DurableSessionReader {
  /**
   * Open one stored session for reading.
   * @param id - stored session identity.
   * @param access - always `read` for recovery.
   * @returns the open read handle.
   */
  open(id: SessionId, access: 'read'): Promise<DurableSessionHandle>
}

/** One open durable Session log, narrowed to what recovery reads. */
export interface DurableSessionHandle {
  /** Stored session identity. */
  readonly id: SessionId
  /** Immutable stored header. */
  readonly header: SessionHeader
  /**
   * Read a contiguous prefix slice.
   * @param offset - first sequence number to include.
   * @returns the caller-owned events.
   */
  read(offset?: number): Promise<{ readonly events: readonly SessionEvent[] }>
  /** Release the read handle. */
  close(): Promise<void>
}

/** Live-session directory used only to detect another owner before resuming. */
export interface RecoverySessionDirectory {
  /** One live session, or `undefined` when this process has none. */
  get(id: SessionId): Session | undefined
}

/** The handler re-acquisition seam; `RunSupervisor` satisfies it. */
export interface RecoverySupervisor {
  /**
   * Re-hold an existing session after recovery accepted the evidence.
   * @param request - operation/session/progress evidence plus the submit decision.
   * @returns the held identities and the eventual settlement.
   */
  resume(request: RunResumeRequest): Promise<RunResumeStart>
  /** Stop new supervision, wait for in-flight runs and dispose leftovers. */
  close(): Promise<void>
}

/** Scheduler surface recovery gates and later releases. */
export interface RecoveryScheduler {
  /** One scheduling tick. */
  tick(): Promise<SchedulerTickResult>
  /** Refuse new starts and drain in-flight launches. */
  close(): Promise<void>
}

/** Dependencies of one recovery manager. */
export interface RecoveryManagerOptions {
  /** Durable orchestration records. */
  readonly store: RecoveryStore
  /** Durable Session logs. Pass `ctx.sessionPersistence`. */
  readonly durableSessions: DurableSessionReader
  /** Live sessions, used only for owned/observed classification. Pass `ctx.sessions`. */
  readonly sessions: RecoverySessionDirectory
  /** Handle re-acquisition. Pass the same `RunSupervisor` used by the host. */
  readonly supervisor: RecoverySupervisor
  /** Scheduler to gate. Omitted means the host ticks on its own. */
  readonly scheduler?: RecoveryScheduler
  /** Stable identity of this host; must match the durable host claim. */
  readonly hostInstanceId: string
  /** Clock for record timestamps and lease expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /** How long a reconciliation lease is claimed for. */
  readonly leaseTtlMs?: number
  /** How many CAS retries one record write may take. */
  readonly writeAttempts?: number
  /** Optional last step after all orchestration resources settled. */
  readonly closeDomain?: () => Promise<void>
}

/** Recovery lifecycle, exposed for diagnostics and tests. */
export type RecoveryState = 'closed' | 'reconciling' | 'open' | 'closing'

/** Verdict for one durable run lease. */
export type RunLeaseVerdict =
  | 'free'
  | 'owned'
  | 'expired'
  | 'foreign-held'
  | 'clock-anomaly'

/** Stable reasons recovery writes into `lastError.code`. */
export type RecoveryReason =
  | 'second-writer'
  | 'lease-held'
  | 'operation-missing'
  | 'operation-run-mismatch'
  | 'operation-generation-mismatch'
  | 'operation-attempt-mismatch'
  | 'operation-id-mismatch'
  | 'request-hash-mismatch'
  | 'session-missing'
  | 'session-writer-held'
  | 'session-format-unsupported'
  | 'session-corrupt'
  | 'active-session-mismatch'
  | 'message-source-mismatch'
  | 'submission-unverified'
  | 'turn-owner-unknown'
  | 'external-input'
  | 'awaiting-approval'
  | 'turn-error'
  | 'turn-aborted'
  | 'turn-blocked'
  | 'turn-max-tokens'
  | 'turn-interrupted'
  | 'turn-forked'
  | 'turn-unknown'
  | 'turn-missing'
  | 'restart-uncertain'
  | 'handoff-unverified'
  | 'handoff-session-missing'
  | 'task-missing'
  | 'resume-failed'
  | 'recovery-error'

/** What recovery did to one run. */
export type RecoveryAction =
  | 'untouched'
  | 'rolled-back'
  | 'settled-succeeded'
  | 'settled-failed'
  | 'needs-attention'
  | 'resumed'
  | 'blocked'

/** One durable message found for the operation. */
export interface RecoveryMessage {
  /** Message identity from the durable event. */
  readonly messageId: string
  /** Sequence number of its `user/message`. */
  readonly seq: number
  /** Turn open when the message entered the log, if any. */
  readonly turn: number | undefined
}

/** Durable facts reconstructed from one Session log. */
export interface SessionEvidence {
  /** Session inspected. */
  readonly sessionId: SessionId
  /** Whether the log exists in durable storage. */
  readonly exists: boolean
  /** Last event sequence, or -1 for an empty/absent log. */
  readonly lastSeq: number
  /** Messages whose source links to this operation and run identity. */
  readonly messages: readonly RecoveryMessage[]
  /** Messages carrying this operation id but a different run identity. */
  readonly sourceMismatches: number
  /** Run-owned turns that already closed. */
  readonly accepted: readonly RunAcceptedTurn[]
  /** Every closed turn and its end sequence. */
  readonly endedTurns: readonly { readonly turn: number; readonly seq: number }[]
  /** Run-owned turn still open. */
  readonly openTurn: number | undefined
  /** An open turn that cannot be tied to this run. */
  readonly foreignOpenTurn: number | undefined
  /** Human input that arrived after this run's prompt. */
  readonly externalInput: boolean
  /** Approvals still awaiting a decision. */
  readonly pendingApprovals: readonly { readonly id: string; readonly toolName: string }[]
  /** Run-owned messages not yet claimed by a closed turn. */
  readonly pendingMessages: readonly RecoveryMessage[]
}

/** Result of one durable Session read: evidence, or a persistence refusal. */
type InspectResult =
  | { readonly kind: 'evidence'; readonly evidence: SessionEvidence }
  | {
      readonly kind: 'failure'
      readonly reason: RecoveryReason
      readonly detail: string
      readonly sessionId: SessionId
    }

/** One run's reconciled outcome. */
export interface RecoveryDecision {
  /** Run reconciled. */
  readonly runId: RunId
  /** Run state observed before recovery. */
  readonly stateBefore: RunRecord['state']
  /** Run state after recovery. */
  readonly stateAfter: RunRecord['state']
  /** Action taken. */
  readonly action: RecoveryAction
  /** Stable reason or diagnosis. */
  readonly reason: string
  /** Human-readable detail without prompt content. */
  readonly detail?: string
  /** Operation this run points at. */
  readonly operationId?: OperationId
  /** Operation phase observed before recovery. */
  readonly operationPhaseBefore?: OperationRecord['phase']
  /** Operation phase after recovery. */
  readonly operationPhaseAfter?: OperationRecord['phase']
  /** Session the run drives, when known. */
  readonly sessionId?: SessionId
  /** Message identity recovered from the log, never guessed. */
  readonly messageId?: string
  /** Turn claiming the prompt, when the log shows it. */
  readonly turn?: number
  /** Whether this resume may submit the prompt once. */
  readonly submitPrompt?: boolean
  /** Settlement started by a resume, when one was started. */
  readonly settlement?: Promise<RunSettlement>
}

/** Startup reconciliation report. */
export interface RecoveryReport {
  /** Host identity this process used. */
  readonly hostInstanceId: string
  /** Whether this process claimed an unclaimed domain. */
  readonly claimedHost: boolean
  /** Per-run decisions in stored order. */
  readonly decisions: readonly RecoveryDecision[]
  /** Fatal refusal that keeps the scheduler closed, when one exists. */
  readonly fatal?: { readonly code: RecoveryReason; readonly detail: string }
  /** Whether the scheduler may now tick. */
  readonly schedulerOpen: boolean
  /** Start time. */
  readonly startedAt: number
  /** Finish time. */
  readonly finishedAt: number
}

/** Ordered unload evidence. */
export interface RecoveryUnloadReport {
  /** Steps in the order they ran. */
  readonly steps: readonly string[]
  /** Failures contained during teardown, in step order. */
  readonly failures: readonly string[]
}

/** One host-claim decision. */
type HostClaim =
  | { readonly kind: 'same' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'refused'; readonly detail: string }

/**
 * Classify one durable run lease without consulting a clock inside the
 * decision. A lease owned by this host is always reclaimable. A foreign lease
 * that has not expired is held; one whose expiry lies beyond one full TTL into
 * the future is a clock anomaly and is also held. An expired foreign lease may
 * be reclaimed only because the domain-level host claim already proved this
 * host is the single writer.
 * @param lease - stored lease, or `undefined`.
 * @param ownerId - this host's stable identity.
 * @param now - current wall-clock reading.
 * @param ttlMs - the lease duration this host writes.
 * @returns the verdict recovery acts on.
 */
export function assessRunLease(
  lease: RunLease | undefined,
  ownerId: string,
  now: number,
  ttlMs: number,
): RunLeaseVerdict {
  if (lease === undefined) return 'free'
  if (lease.ownerId === ownerId) return 'owned'
  if (lease.expiresAt > now + ttlMs) return 'clock-anomaly'
  if (lease.expiresAt > now) return 'foreign-held'
  return 'expired'
}

/** Mutable scan accumulator. */
interface ScanState {
  readonly runId: RunId
  readonly operationId: OperationId
  readonly generation: number
  readonly attempt: number
  readonly messages: RecoveryMessage[]
  readonly seenMessageIds: Set<string>
  readonly accepted: RunAcceptedTurn[]
  readonly endedTurns: Map<number, number>
  readonly runTurns: Set<number>
  readonly pendingApprovals: Map<string, string>
  readonly humanSeqs: number[]
  openTurn: number | undefined
  lastSeq: number
  mismatches: number
  firstOwnedSeq: number | undefined
}

/**
 * Restart reconciliation and host unload.
 *
 * One instance owns one host's startup decision. `reconcile()` is idempotent
 * and must resolve before `tick()` dispatches anything. The manager never
 * writes a Session event, never creates a Session for an existing generation,
 * and never calls an LLM.
 */
export class RecoveryManager {
  private readonly store: RecoveryStore
  private readonly durableSessions: DurableSessionReader
  private readonly sessions: RecoverySessionDirectory
  private readonly supervisor: RecoverySupervisor
  private readonly scheduler: RecoveryScheduler | undefined
  private readonly hostInstanceId: string
  private readonly now: () => number
  private readonly leaseTtlMs: number
  private readonly writeAttempts: number
  private readonly closeDomain: (() => Promise<void>) | undefined

  private lifecycle: RecoveryState = 'closed'
  private lastReport: RecoveryReport | undefined
  private pending: Promise<RecoveryReport> | undefined
  private closing: Promise<RecoveryUnloadReport> | undefined

  /**
   * @param options - durable seams, host identity and optional scheduler gate.
   */
  constructor(options: RecoveryManagerOptions) {
    if (options.hostInstanceId.trim() === '') {
      throw new OrchestratorError('invalid-transition', 'hostInstanceId must be non-empty')
    }
    this.store = options.store
    this.durableSessions = options.durableSessions
    this.sessions = options.sessions
    this.supervisor = options.supervisor
    this.scheduler = options.scheduler
    this.hostInstanceId = options.hostInstanceId
    this.now = options.now ?? (() => Date.now())
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000
    this.writeAttempts = options.writeAttempts ?? 3
    this.closeDomain = options.closeDomain
  }

  /** Current lifecycle state. */
  get state(): RecoveryState {
    return this.lifecycle
  }

  /** Whether the scheduler gate is open. */
  get schedulerOpen(): boolean {
    return this.lifecycle === 'open'
  }

  /** Last completed report, when reconciliation finished. */
  get report(): RecoveryReport | undefined {
    return this.lastReport
  }

  /**
   * Reconcile every durable run, then open the scheduler gate.
   *
   * Idempotent: a second call returns the same completed report, and concurrent
   * calls share one in-flight run. A refused host claim leaves the gate closed.
   * @returns the reconciliation report.
   * @throws OrchestratorError when called during or after shutdown.
   */
  async reconcile(): Promise<RecoveryReport> {
    // `closed` is also the initial state of a manager that has never run, so
    // only an unload in progress (or completed) refuses reconciliation. A
    // failed pass may be retried: it reads durable state again and the gate
    // stays closed until one pass completes.
    if (this.closing !== undefined || this.lifecycle === 'closing') {
      throw new OrchestratorError('closed', 'recovery is closing and cannot reconcile')
    }
    if (this.lifecycle === 'open' && this.lastReport !== undefined) return this.lastReport
    if (this.lifecycle === 'reconciling' && this.pending !== undefined) return await this.pending
    this.lifecycle = 'reconciling'
    this.pending = this.runReconciliation()
    try {
      const report = await this.pending
      this.lastReport = report
      this.lifecycle = report.schedulerOpen ? 'open' : 'closed'
      return report
    } catch (error) {
      // A durable store failure leaves the gate closed: the host must not start
      // work over records recovery could not read or write.
      this.lifecycle = 'closed'
      throw error
    } finally {
      this.pending = undefined
    }
  }

  /**
   * Run one scheduler tick only after reconciliation opened the gate.
   * @returns whether the scheduler ran, plus its result when it did.
   */
  async tick(): Promise<{ readonly ran: boolean; readonly result?: SchedulerTickResult }> {
    if (this.lifecycle !== 'open' || this.scheduler === undefined) return { ran: false }
    return { ran: true, result: await this.scheduler.tick() }
  }

  /**
   * Unload in the documented order: stop the gate, persist the pause, stop the
   * scheduler, wait for in-flight supervision, dispose leftovers, then close
   * the domain. Every step contains its own failure so later steps still run.
   * @returns the ordered step and failure evidence.
   */
  async close(): Promise<RecoveryUnloadReport> {
    if (this.closing !== undefined) return await this.closing
    this.closing = this.runUnload()
    return await this.closing
  }

  /** Perform one idempotent reconciliation pass. */
  private async runReconciliation(): Promise<RecoveryReport> {
    const startedAt = this.now()
    const claim = await this.claimHost()
    if (claim.kind === 'refused') {
      return {
        hostInstanceId: this.hostInstanceId,
        claimedHost: false,
        decisions: [],
        fatal: { code: 'second-writer', detail: claim.detail },
        schedulerOpen: false,
        startedAt,
        finishedAt: this.now(),
      }
    }

    const decisions: RecoveryDecision[] = []
    for (const run of this.store.listRuns()) {
      if (!ACTIVE_RUN_STATES.has(run.state)) continue
      const decision = await this.reconcileRun(run)
      decisions.push(decision)
    }

    return {
      hostInstanceId: this.hostInstanceId,
      claimedHost: claim.kind === 'claimed',
      decisions,
      schedulerOpen: true,
      startedAt,
      finishedAt: this.now(),
    }
  }

  /**
   * Claim the single-writer host identity from global settings.
   *
   * `unclaimed` is the only value a new host may replace. Any other value means
   * another host owns this domain; recovery refuses to touch runs rather than
   * becoming a second writer. Revision CAS makes concurrent claims exclusive.
   * @returns the claim outcome.
   */
  private async claimHost(): Promise<HostClaim> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const settings = this.store.getSettings()
      if (settings.hostInstanceId === this.hostInstanceId) return { kind: 'same' }
      if (settings.hostInstanceId !== 'unclaimed') {
        return {
          kind: 'refused',
          detail: `domain is owned by host '${settings.hostInstanceId}'`,
        }
      }
      try {
        await this.store.updateSettings(settings.revision, {
          ...settings,
          hostInstanceId: this.hostInstanceId,
          revision: settings.revision + 1,
          updatedAt: this.now(),
        })
        return { kind: 'claimed' }
      } catch (error) {
        if (!isRevisionConflict(error)) throw error
      }
    }
    return {
      kind: 'refused',
      detail: 'host claim lost a revision race; refusing to become a second writer',
    }
  }

  /**
   * Reconcile one active run.
   *
   * A durable write that fails is rethrown instead of being contained: it may
   * have landed before the response was lost, so marking the run here would
   * destroy the evidence the next startup needs. The caller then keeps the
   * scheduler closed and retries reconciliation from durable state.
   * @param run - active run observed at startup.
   * @returns the decision for this run.
   */
  private async reconcileRun(run: RunRecord): Promise<RecoveryDecision> {
    return await this.decideRun(run)
  }

  /**
   * Reconcile one active run from durable evidence.
   * @param run - active run.
   * @returns its decision.
   */
  private async decideRun(run: RunRecord): Promise<RecoveryDecision> {
    if (run.state === 'handoff-pending') {
      // Handoff pressure belongs to the next block; recovery must not guess.
      return decision(run, 'untouched', 'handoff-pending', 'handoff-pending is not reconcilable yet')
    }

    const operation = this.findOperation(run)
    if (operation === undefined) {
      return await this.handleMissingOperation(run)
    }
    const link = operation.kind === 'handoff'
      ? handoffLinkConflict(run, operation)
      : operationLinkConflict(run, operation)
    if (link !== undefined) {
      return await this.markNeedsAttention(run, operation, link, `operation '${operation.id}' does not belong to this run attempt`)
    }
    if (operation.kind === 'initial-prompt') {
      if (operation.id !== initialPromptOperationId(run)) {
        return await this.markNeedsAttention(run, operation, 'operation-id-mismatch', `operation '${operation.id}' is not the canonical operation for this generation`)
      }
      if (operation.requestHash !== initialPromptRequestHash(run)) {
        return await this.markNeedsAttention(run, operation, 'request-hash-mismatch', 'stored request hash does not match the durable run identity')
      }
    }

    const lease = await this.acquireLease(run)
    if (lease.kind === 'refused') {
      return decision(run, 'blocked', lease.verdict, `run lease is held by '${lease.ownerId}'`, {
        operationId: operation.id,
        operationPhaseBefore: operation.phase,
      })
    }
    const current = lease.run

    if (current.state === 'starting') {
      return await this.reconcileStarting(current, operation)
    }
    if (current.state === 'handing-off') {
      return await this.reconcileHandingOff(current, operation)
    }
    return await this.reconcileRunning(current, operation)
  }

  /**
   * Resolve a run that has no operation record.
   *
   * A `starting` run with no session evidence is safe to roll back: no Session
   * was created and no prompt can exist. Anything else is a conflict.
   * @param run - active run.
   * @returns its decision.
   */
  private async handleMissingOperation(run: RunRecord): Promise<RecoveryDecision> {
    if (run.state === 'starting' && run.activeSessionId === undefined) {
      const candidate = this.candidateSession(run)
      if (!await this.sessionExists(candidate)) {
        return await this.rollback(run, 'no operation and no session; nothing was created')
      }
    }
    return await this.markNeedsAttention(run, undefined, 'operation-missing', 'the run points at no durable operation')
  }

  /**
   * Reconcile a `starting` run: roll back when nothing happened, adopt when a
   * Session exists, and never create a second Session.
   * @param run - starting run.
   * @param operation - its linked operation.
   * @returns its decision.
   */
  private async reconcileStarting(run: RunRecord, operation: OperationRecord): Promise<RecoveryDecision> {
    const target = run.activeSessionId ?? operation.targetSessionId
    const candidate = target ?? this.candidateSession(run)
    const inspected = await this.inspect(candidate, run, operation)
    if (inspected.kind === 'failure') {
      return await this.markNeedsAttention(
        run,
        operation,
        inspected.reason,
        inspected.detail,
        inspected.sessionId,
      )
    }
    const evidence = inspected.evidence
    if (!evidence.exists) {
      if (target !== undefined) {
        return await this.markNeedsAttention(run, operation, 'session-missing', `session '${target}' is recorded but absent from durable storage`)
      }
      return await this.rollback(run, 'no Session was created before the crash')
    }

    const adopted = await this.adoptSession(run, operation, evidence.sessionId)
    if ('conflict' in adopted) {
      return await this.markNeedsAttention(run, operation, adopted.conflict, adopted.detail)
    }
    return await this.reconcileEvidence(adopted.run, adopted.operation, evidence)
  }

  /**
   * Reconcile a `running` run from its active Session log.
   * @param run - running run.
   * @param operation - linked operation.
   * @returns its decision.
   */
  private async reconcileRunning(run: RunRecord, operation: OperationRecord): Promise<RecoveryDecision> {
    const sessionId = run.activeSessionId
      ?? operation.targetSessionId
      ?? this.candidateSession(run)
    const inspected = await this.inspect(sessionId, run, operation)
    if (inspected.kind === 'failure') {
      return await this.markNeedsAttention(
        run,
        operation,
        inspected.reason,
        inspected.detail,
        inspected.sessionId,
      )
    }
    const evidence = inspected.evidence
    if (!evidence.exists) {
      if (run.activeSessionId === undefined && operation.targetSessionId === undefined) {
        return await this.markNeedsAttention(run, operation, 'session-missing', `run '${run.id}' has no session identity`)
      }
      return await this.markNeedsAttention(run, operation, 'session-missing', `session '${sessionId}' is absent from durable storage`)
    }
    if (run.activeSessionId === undefined) {
      const adopted = await this.adoptSession(run, operation, sessionId)
      if ('conflict' in adopted) {
        return await this.markNeedsAttention(run, operation, adopted.conflict, adopted.detail)
      }
      return await this.reconcileEvidence(adopted.run, adopted.operation, evidence)
    }
    return await this.reconcileEvidence(run, operation, evidence)
  }

  /**
   * Reconcile a run caught mid-handoff.
   *
   * A child Session that received this operation's message may be adopted; a
   * child without a message cannot be continued because the handoff prompt
   * body is built by the later handoff block, so it needs a human.
   * @param run - handing-off run.
   * @param operation - run operation, possibly the source prompt.
   * @returns its decision.
   */
  private async reconcileHandingOff(run: RunRecord, operation: OperationRecord): Promise<RecoveryDecision> {
    const handoff = this.findHandoffOperation(run)
    if (handoff === undefined) {
      return await this.markNeedsAttention(run, operation, 'handoff-unverified', 'no durable handoff operation names the child session')
    }
    const childId = handoff.targetSessionId
      ?? run.sessionLineage[run.generation + 1]
    if (childId === undefined) {
      return await this.markNeedsAttention(run, handoff, 'handoff-unverified', 'the handoff operation does not name a child session')
    }
    const inspected = await this.inspect(childId, run, handoff)
    if (inspected.kind === 'failure') {
      return await this.markNeedsAttention(
        run,
        handoff,
        inspected.reason,
        inspected.detail,
        inspected.sessionId,
      )
    }
    const evidence = inspected.evidence
    if (!evidence.exists) {
      return await this.markNeedsAttention(run, handoff, 'handoff-session-missing', `child session '${childId}' is absent from durable storage`)
    }
    if (evidence.messages.length === 0) {
      return await this.markNeedsAttention(
        run,
        handoff,
        'handoff-unverified',
        `child session '${childId}' has no delivered handoff message; recovery will not create a second child`,
      )
    }
    const adopted = await this.adoptSession(run, handoff, childId)
    if ('conflict' in adopted) {
      return await this.markNeedsAttention(run, handoff, adopted.conflict, adopted.detail)
    }
    return await this.reconcileEvidence(adopted.run, adopted.operation, evidence)
  }

  /**
   * Decide from one Session log whether the run settled, must resume, or needs
   * a human. Operation phase `uncertain` only allows a decision the log proves.
   * @param run - durable run that already names this session.
   * @param operation - operation carrying the log.
   * @param evidence - scanned durable facts.
   * @returns its decision.
   */
  private async reconcileEvidence(
    run: RunRecord,
    operation: OperationRecord,
    evidence: SessionEvidence,
  ): Promise<RecoveryDecision> {
    if (evidence.sourceMismatches > 0) {
      return await this.markNeedsAttention(run, operation, 'message-source-mismatch', 'a Session message names this operation but a different run identity')
    }
    if (evidence.externalInput) {
      return await this.markNeedsAttention(run, operation, 'external-input', 'human input arrived after this run prompt')
    }
    if (evidence.pendingApprovals.length > 0) {
      return await this.markNeedsAttention(run, operation, 'awaiting-approval', 'an approval request is still unanswered')
    }
    const failed = evidence.accepted.find(entry => entry.reason.kind !== 'completed')
    if (failed !== undefined) {
      const reason = turnFailureReason(failed.reason)
      const detail = failed.reason.kind === 'error'
        ? `${failed.reason.error.code}: ${failed.reason.error.message}`
        : failed.reason.kind
      return await this.commitFailure(run, operation, reason, detail, evidence)
    }

    const claimedTurn = claimTurn(evidence, operation)
    const openOwnedTurn = evidence.openTurn !== undefined
      && evidence.messages.some(message => message.turn === evidence.openTurn)
    const resume = evidence.pendingMessages.length > 0
      || (evidence.openTurn !== undefined && openOwnedTurn)
      || (evidence.openTurn !== undefined && evidence.openTurn === run.claimedTurn)

    if (operation.phase === 'uncertain') {
      if (evidence.messages.length > 0 && evidence.accepted.length > 0 && !resume) {
        return await this.commitSuccess(run, operation, evidence, claimedTurn)
      }
      return await this.markNeedsAttention(run, operation, 'restart-uncertain', 'operation was uncertain and the log does not prove a settled turn')
    }

    if (evidence.messages.length === 0) {
      const intent = operation.messageId ?? run.submittedMessageId
      if (intent !== undefined) {
        return await this.markNeedsAttention(run, operation, 'submission-unverified', `prompt identity '${intent}' has no durable Session message; refusing to replay`)
      }
      if (
        evidence.openTurn !== undefined
        || evidence.foreignOpenTurn !== undefined
        || evidence.accepted.length > 0
      ) {
        return await this.markNeedsAttention(run, operation, 'turn-owner-unknown', 'the Session has turn activity but no message from this operation')
      }
      if (operation.phase !== 'planned' && operation.phase !== 'session-created') {
        return await this.markNeedsAttention(run, operation, 'restart-uncertain', `operation is '${operation.phase}' but the log holds no prompt`)
      }
      return await this.resumeRun(run, operation, evidence, true, undefined)
    }

    if (operation.phase === 'planned' && operation.kind === 'initial-prompt') {
      return await this.markNeedsAttention(run, operation, 'message-source-mismatch', 'a message exists while the operation is still planned')
    }
    if (evidence.accepted.length > 0 && !resume) {
      return await this.commitSuccess(run, operation, evidence, claimedTurn)
    }
    if (resume) {
      return await this.resumeRun(run, operation, evidence, false, evidence.messages[0]?.messageId)
    }
    return await this.commitFailure(run, operation, 'turn-missing', 'prompt is durable but no run-owned turn closed', evidence)
  }

  /**
   * Re-hold the session and continue supervision without resubmitting.
   * @param run - run to resume.
   * @param operation - linked operation.
   * @param evidence - scanned log.
   * @param submitPrompt - whether recovery allows the one remaining submission.
   * @param messageId - recovered prompt identity, when the log has one.
   * @returns a resumed decision, or a needs-attention decision on refusal.
   */
  private async resumeRun(
    run: RunRecord,
    operation: OperationRecord,
    evidence: SessionEvidence,
    submitPrompt: boolean,
    messageId: string | undefined,
  ): Promise<RecoveryDecision> {
    const sessionId = run.activeSessionId ?? operation.targetSessionId
    if (sessionId === undefined) {
      return await this.markNeedsAttention(run, operation, 'session-missing', 'no session identity to resume')
    }
    if (this.sessions.get(sessionId) !== undefined) {
      return await this.markNeedsAttention(run, operation, 'active-session-mismatch', `session '${sessionId}' is already live under another owner; not resuming`)
    }
    const task = this.store.getTask(run.taskId)
    if (task === undefined) {
      return await this.markNeedsAttention(run, operation, 'task-missing', `task '${run.taskId}' is not stored`)
    }
    const claimedTurn = claimTurn(evidence, operation)
    const progress = progressFrom(evidence, messageId ?? operation.messageId, claimedTurn)
    try {
      const started = await this.supervisor.resume({
        run,
        task,
        operationId: operation.id,
        sessionId,
        progress,
        submitPrompt,
      })
      return decision(run, 'resumed', 'resumed', submitPrompt
        ? 'session exists with no delivered prompt; resuming for one submission'
        : 'session exists with durable prompt evidence; resuming without replay', {
        operationId: operation.id,
        operationPhaseBefore: operation.phase,
        sessionId,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(claimedTurn !== undefined ? { turn: claimedTurn } : {}),
        submitPrompt,
        settlement: started.settlement,
      })
    } catch (error) {
      return await this.classifyResumeFailure(run, operation, error, sessionId)
    }
  }

  /**
   * Map one failed resume to an actionable needs-attention reason.
   * @param run - run that could not be resumed.
   * @param operation - its operation.
   * @param error - resume failure.
   * @param sessionId - session the resume targeted.
   * @returns the needs-attention decision.
   */
  private async classifyResumeFailure(
    run: RunRecord,
    operation: OperationRecord,
    error: unknown,
    sessionId: SessionId,
  ): Promise<RecoveryDecision> {
    const name = error instanceof Error ? error.name : ''
    const detail = error instanceof Error ? error.message : String(error)
    const reason: RecoveryReason = name === 'SessionAlreadyOwnedError'
      ? 'session-writer-held'
      : name === 'SessionPersistenceNotFoundError'
        ? 'session-missing'
        : name === 'SessionFormatUnsupportedError'
          ? 'session-format-unsupported'
          : name === 'SessionPersistenceCorruptionError'
            ? 'session-corrupt'
            : 'resume-failed'
    return await this.markNeedsAttention(run, operation, reason, detail, sessionId)
  }

  /**
   * Commit success only when the log proves a completed run-owned turn with no
   * open or pending run-owned work.
   * @param run - durable run.
   * @param operation - linked operation.
   * @param evidence - scanned log.
   * @param claimedTurn - turn that claimed the prompt.
   * @returns the committed decision.
   */
  private async commitSuccess(
    run: RunRecord,
    operation: OperationRecord,
    evidence: SessionEvidence,
    claimedTurn: number | undefined,
  ): Promise<RecoveryDecision> {
    const last = evidence.accepted[evidence.accepted.length - 1]
    if (last === undefined) {
      return await this.markNeedsAttention(run, operation, 'turn-missing', 'no accepted turn to settle')
    }
    const updated = await this.writeRun(run.id, current => ({
      ...withoutLease(current),
      state: 'succeeded',
      operationId: operation.id,
      acceptedTurnEndSeq: last.seq,
      ...(claimedTurn !== undefined ? { claimedTurn } : {}),
      revision: current.revision + 1,
      updatedAt: this.now(),
    }))
    return decision(updated, 'settled-succeeded', 'completed', `durable turn ${last.turn} completed`, {
      operationId: operation.id,
      operationPhaseBefore: operation.phase,
      sessionId: evidence.sessionId,
      ...(evidence.messages[0]?.messageId !== undefined
        ? { messageId: evidence.messages[0].messageId }
        : {}),
      ...(claimedTurn !== undefined ? { turn: claimedTurn } : {}),
    })
  }

  /**
   * Commit a failure the durable log proves, without replaying any prompt.
   * @param run - durable run.
   * @param operation - linked operation.
   * @param reason - stable failure reason.
   * @param detail - diagnostic text.
   * @param evidence - scanned log, when available.
   * @returns the committed decision.
   */
  private async commitFailure(
    run: RunRecord,
    operation: OperationRecord,
    reason: RecoveryReason,
    detail: string,
    evidence?: SessionEvidence,
  ): Promise<RecoveryDecision> {
    const last = evidence?.accepted[evidence.accepted.length - 1]
    const updated = await this.writeRun(run.id, current => ({
      ...withoutLease(current),
      state: 'failed',
      operationId: operation.id,
      ...(last !== undefined ? { acceptedTurnEndSeq: last.seq } : {}),
      ...(evidence?.openTurn === undefined && run.claimedTurn !== undefined
        ? { claimedTurn: run.claimedTurn }
        : {}),
      lastError: { code: reason, message: detail, retryable: false },
      revision: current.revision + 1,
      updatedAt: this.now(),
    }))
    return decision(updated, 'settled-failed', reason, detail, {
      operationId: operation.id,
      operationPhaseBefore: operation.phase,
      ...(evidence !== undefined ? { sessionId: evidence.sessionId } : {}),
      ...(evidence?.messages[0]?.messageId !== undefined
        ? { messageId: evidence.messages[0].messageId }
        : {}),
    })
  }

  /**
   * Commit `needs-attention` and preserve the session identity for a human.
   * @param run - durable run.
   * @param operation - linked operation, when known.
   * @param reason - actionable reason code.
   * @param detail - diagnostic text.
   * @param sessionId - session a human should inspect, when known.
   * @returns the committed decision.
   */
  private async markNeedsAttention(
    run: RunRecord,
    operation: OperationRecord | undefined,
    reason: RecoveryReason,
    detail: string,
    sessionId?: SessionId,
  ): Promise<RecoveryDecision> {
    const updated = await this.writeRun(run.id, current => ({
      ...withoutLease(current),
      state: 'needs-attention',
      ...(operation !== undefined ? { operationId: operation.id } : {}),
      lastError: {
        code: reason,
        message: detail,
        retryable: reason === 'session-writer-held'
          || reason === 'lease-held'
          || reason === 'recovery-error',
      },
      revision: current.revision + 1,
      updatedAt: this.now(),
    }))
    return decision(updated, 'needs-attention', reason, detail, {
      ...(operation !== undefined ? { operationId: operation.id, operationPhaseBefore: operation.phase } : {}),
      ...(sessionId !== undefined
        ? { sessionId }
        : updated.activeSessionId !== undefined
          ? { sessionId: updated.activeSessionId }
          : {}),
    })
  }

  /**
   * Roll a `starting` run with no Session evidence back to `ready`.
   * @param run - starting run.
   * @param detail - why rollback is safe.
   * @returns the rolled-back decision.
   */
  private async rollback(run: RunRecord, detail: string): Promise<RecoveryDecision> {
    const updated = await this.writeRun(run.id, current => ({
      ...withoutLease(current),
      state: 'ready',
      revision: current.revision + 1,
      updatedAt: this.now(),
    }))
    return decision(updated, 'rolled-back', 'nothing-created', detail, {
      ...(run.operationId !== undefined ? { operationId: run.operationId } : {}),
    })
  }

  /**
   * Adopt an existing Session into the run/operation records under CAS.
   *
   * Adoption never changes the Session identity when one is already recorded:
   * a second candidate is a conflict, not a replacement. Generation follows
   * lineage length, and a handoff operation supplies the next generation.
   * @param run - active run.
   * @param operation - operation that should point at the session.
   * @param sessionId - session proven to exist.
   * @returns adopted records, or a conflict reason.
   */
  private async adoptSession(
    run: RunRecord,
    operation: OperationRecord,
    sessionId: SessionId,
  ): Promise<{ run: RunRecord; operation: OperationRecord } | { conflict: RecoveryReason; detail: string }> {
    if (run.activeSessionId !== undefined && run.activeSessionId !== sessionId) {
      const replacingHandoffSource = operation.kind === 'handoff'
        && run.activeSessionId === operation.sourceSessionId
      if (!replacingHandoffSource) {
        return {
          conflict: 'active-session-mismatch',
          detail: `run records '${run.activeSessionId}' but evidence points at '${sessionId}'`,
        }
      }
    }
    let currentOperation = this.store.getOperation(operation.id) ?? operation
    if (currentOperation.targetSessionId !== undefined && currentOperation.targetSessionId !== sessionId) {
      return {
        conflict: 'active-session-mismatch',
        detail: `operation targets '${currentOperation.targetSessionId}' but evidence points at '${sessionId}'`,
      }
    }
    if (currentOperation.phase === 'planned') {
      currentOperation = await this.store.advanceOperation(currentOperation.id, 'planned', {
        ...currentOperation,
        phase: 'session-created',
        targetSessionId: sessionId,
        updatedAt: this.now(),
      })
    } else if (currentOperation.targetSessionId === undefined) {
      currentOperation = await this.store.advanceOperation(currentOperation.id, currentOperation.phase, {
        ...currentOperation,
        targetSessionId: sessionId,
        updatedAt: this.now(),
      })
    }

    let admitted: RunRecord
    try {
      admitted = await this.writeRun(run.id, current => {
        const lineage = current.sessionLineage.includes(sessionId)
          ? [...current.sessionLineage]
          : [...current.sessionLineage, sessionId]
        const generation = operation.kind === 'handoff' ? operation.generation : current.generation
        if (generation !== Math.max(0, lineage.length - 1)) {
          throw new OrchestratorError(
            'invalid-transition',
            `adopting '${sessionId}' would break the generation/lineage invariant`,
          )
        }
        return {
          ...current,
          state: 'running',
          activeSessionId: sessionId,
          sessionLineage: lineage,
          generation,
          operationId: operation.id,
          revision: current.revision + 1,
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      if (error instanceof OrchestratorError && error.code === 'invalid-transition') {
        return { conflict: 'active-session-mismatch', detail: error.message }
      }
      throw error
    }
    return { run: admitted, operation: currentOperation }
  }

  /**
   * Acquire this host's reconciliation lease on one active run.
   * @param run - active run.
   * @returns the run at the revision carrying this host's lease, or a refusal.
   */
  private async acquireLease(
    run: RunRecord,
  ): Promise<
    | { kind: 'acquired'; run: RunRecord; ownerId: string }
    | { kind: 'refused'; verdict: RunLeaseVerdict; ownerId: string }
  > {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const current = this.store.getRun(run.id) ?? run
      const verdict = assessRunLease(current.lease, this.hostInstanceId, this.now(), this.leaseTtlMs)
      if (verdict === 'foreign-held' || verdict === 'clock-anomaly') {
        return { kind: 'refused', verdict, ownerId: current.lease?.ownerId ?? 'unknown' }
      }
      if (verdict === 'owned' && current.lease !== undefined && current.lease.expiresAt > this.now()) {
        return { kind: 'acquired', run: current, ownerId: this.hostInstanceId }
      }
      try {
        const next = await this.store.updateRun(current.id, current.revision, {
          ...current,
          lease: { ownerId: this.hostInstanceId, expiresAt: this.now() + this.leaseTtlMs },
          revision: current.revision + 1,
          updatedAt: this.now(),
        })
        return { kind: 'acquired', run: next, ownerId: this.hostInstanceId }
      } catch (error) {
        if (!isRevisionConflict(error)) throw error
      }
    }
    return {
      kind: 'refused',
      verdict: 'foreign-held',
      ownerId: 'unknown',
    }
  }

  /**
   * Probe whether a stored session exists without reading its events.
   * @param sessionId - identity to probe.
   * @returns true when the backend holds the session.
   */
  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    let handle: DurableSessionHandle
    try {
      handle = await this.durableSessions.open(sessionId, 'read')
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return false
      throw error
    }
    await handle.close()
    return true
  }

  /**
   * Scan one durable Session log, or report absence.
   * @param sessionId - session to inspect.
   * @param run - run whose operation source is matched.
   * @param operation - operation whose source is matched, when linked.
   * @returns the evidence, whether or not the log exists.
   */
  private async inspect(
    sessionId: SessionId,
    run: RunRecord,
    operation: OperationRecord | undefined,
  ): Promise<InspectResult> {
    if (operation === undefined) {
      return { kind: 'evidence', evidence: absentEvidence(sessionId) }
    }
    let handle: DurableSessionHandle
    try {
      handle = await this.durableSessions.open(sessionId, 'read')
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') {
        return { kind: 'evidence', evidence: absentEvidence(sessionId) }
      }
      const failure = persistenceFailure(error)
      if (failure !== undefined) return { kind: 'failure', ...failure, sessionId }
      throw error
    }
    try {
      const { events } = await handle.read(0)
      return { kind: 'evidence', evidence: scanEvents(sessionId, events, run, operation) }
    } catch (error) {
      const failure = persistenceFailure(error)
      if (failure !== undefined) return { kind: 'failure', ...failure, sessionId }
      throw error
    } finally {
      await handle.close()
    }
  }

  /**
   * Find the operation a run points at.
   *
   * `run.operationId` is authoritative when present; otherwise the latest
   * operation for this run/generation is the candidate. A missing record is a
   * conflict, not permission to plan a new one.
   * @param run - active run.
   * @returns the operation, or `undefined`.
   */
  private findOperation(run: RunRecord): OperationRecord | undefined {
    if (run.operationId !== undefined) return this.store.getOperation(run.operationId)
    const candidates = this.store.listOperations()
      .filter(operation => operation.runId === run.id && operation.generation === run.generation)
      .sort((left, right) => right.attempt - left.attempt || right.updatedAt - left.updatedAt)
    return candidates[0]
  }

  /**
   * Find the handoff operation that moved this run into a child generation.
   * @param run - handing-off run.
   * @returns the handoff operation, or `undefined`.
   */
  private findHandoffOperation(run: RunRecord): OperationRecord | undefined {
    const candidates = this.store.listOperations()
      .filter(operation => operation.runId === run.id && operation.kind === 'handoff')
      .filter(operation => operation.generation === run.generation || operation.generation === run.generation + 1)
      .sort((left, right) => right.generation - left.generation || right.updatedAt - left.updatedAt)
    return candidates[0]
  }

  /**
   * Derive the deterministic initial-prompt session identity.
   * @param run - run whose generation is being created.
   * @returns the identity the supervisor would create.
   */
  private candidateSession(run: RunRecord): SessionId {
    return sessionIdOf(`session-${run.id}-${run.generation}`)
  }

  /**
   * Write one run under revision CAS with bounded retries.
   *
   * The mutation receives the latest record, so a caller never overwrites a
   * revision it did not read. Terminal records are returned untouched.
   * @param runId - run identity.
   * @param mutate - builds the replacement.
   * @returns the stored run after the write, or the latest unchanged record.
   */
  private async writeRun(runId: RunId, mutate: (current: RunRecord) => RunRecord): Promise<RunRecord> {
    let last: RunRecord | undefined
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const current = this.store.getRun(runId)
      if (current === undefined) {
        throw new OrchestratorError('not-found', `run '${runId}' disappeared during recovery`)
      }
      last = current
      if (SETTLED_RUN_STATES.has(current.state)) return current
      try {
        return await this.store.updateRun(current.id, current.revision, mutate(current))
      } catch (error) {
        if (!isRevisionConflict(error)) throw error
      }
    }
    if (last === undefined) {
      throw new OrchestratorError('not-found', `run '${runId}' disappeared during recovery`)
    }
    return last
  }

  /** Perform the ordered unload with contained failures. */
  private async runUnload(): Promise<RecoveryUnloadReport> {
    const steps: string[] = []
    const failures: string[] = []

    this.lifecycle = 'closing'
    steps.push('gate-closed')

    try {
      const settings = this.store.getSettings()
      if (!settings.paused) {
        await this.store.updateSettings(settings.revision, {
          ...settings,
          paused: true,
          revision: settings.revision + 1,
          updatedAt: this.now(),
        })
      }
    } catch (error) {
      failures.push(`pause: ${messageOf(error)}`)
    }
    steps.push('paused')

    if (this.scheduler !== undefined) {
      try {
        await this.scheduler.close()
      } catch (error) {
        failures.push(`scheduler: ${messageOf(error)}`)
      }
    }
    steps.push('scheduler-closed')

    try {
      await this.supervisor.close()
    } catch (error) {
      failures.push(`supervisor: ${messageOf(error)}`)
    }
    steps.push('supervisor-closed')

    if (this.closeDomain !== undefined) {
      try {
        await this.closeDomain()
      } catch (error) {
        failures.push(`domain: ${messageOf(error)}`)
      }
    }
    steps.push('domain-closed')

    this.lifecycle = 'closed'
    return { steps, failures }
  }
}

/**
 * Build a decision record with defaults.
 * @param run - run the decision is about.
 * @param action - what recovery did.
 * @param reason - stable diagnosis.
 * @param detail - optional prose.
 * @param extra - identity and evidence fields.
 * @returns the decision.
 */
function decision(
  run: RunRecord,
  action: RecoveryAction,
  reason: string,
  detail?: string,
  extra: Partial<Omit<RecoveryDecision, 'runId' | 'stateBefore' | 'stateAfter' | 'action' | 'reason' | 'detail'>> = {},
): RecoveryDecision {
  return {
    runId: run.id,
    stateBefore: run.state,
    stateAfter: run.state,
    action,
    reason,
    ...(detail !== undefined ? { detail } : {}),
    ...extra,
  }
}

/**
 * Drop lease and failure fields from a terminal/ready replacement.
 * @param run - current record.
 * @returns the record without `lease` or `lastError`.
 */
function withoutLease(run: RunRecord): RunRecord {
  const { lease: _lease, lastError: _lastError, ...rest } = run
  return rest
}

/**
 * Scan a durable Session log for this operation's messages and turns.
 *
 * Matching requires every source field: operation id, run id, generation and
 * attempt. A message with the operation id but another run identity is counted
 * as a mismatch and never accepted. Human input is only considered external
 * when it follows this operation's first durable message.
 * @param sessionId - session inspected.
 * @param events - durable events in seq order.
 * @param run - run whose identity is matched.
 * @param operation - operation whose identity is matched.
 * @returns the evidence.
 */
export function scanEvents(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  run: RunRecord,
  operation: OperationRecord,
): SessionEvidence {
  const state: ScanState = {
    runId: run.id,
    operationId: operation.id,
    generation: operation.generation,
    attempt: operation.attempt,
    messages: [],
    seenMessageIds: new Set(),
    accepted: [],
    endedTurns: new Map(),
    runTurns: new Set(),
    pendingApprovals: new Map(),
    humanSeqs: [],
    openTurn: undefined,
    lastSeq: -1,
    mismatches: 0,
    firstOwnedSeq: undefined,
  }
  for (const event of events) {
    observeEvent(state, event)
  }
  const pendingMessages = state.messages.filter(message => message.turn === undefined
    || !state.endedTurns.has(message.turn))
  const foreignOpenTurn = state.openTurn !== undefined && !state.runTurns.has(state.openTurn)
    ? state.openTurn
    : undefined
  const externalInput = state.firstOwnedSeq !== undefined
    && state.humanSeqs.some(seq => seq > (state.firstOwnedSeq ?? Number.POSITIVE_INFINITY))
  return {
    sessionId,
    exists: true,
    lastSeq: state.lastSeq,
    messages: state.messages,
    sourceMismatches: state.mismatches,
    accepted: state.accepted,
    endedTurns: [...state.endedTurns.entries()].map(([turn, seq]) => ({ turn, seq })),
    openTurn: state.runTurns.has(state.openTurn ?? -1) ? state.openTurn : undefined,
    foreignOpenTurn,
    externalInput,
    pendingApprovals: [...state.pendingApprovals.entries()].map(([id, toolName]) => ({ id, toolName })),
    pendingMessages,
  }
}

/**
 * Check that a handoff operation links to the source or target generation.
 *
 * A handoff prepared from generation N carries N+1 as its target generation,
 * so both are valid until the run adopts the child.
 * @param run - run being reconciled.
 * @param operation - handoff operation.
 * @returns the conflict reason, or `undefined` when the link is sound.
 */
function handoffLinkConflict(
  run: RunRecord,
  operation: OperationRecord,
): 'operation-run-mismatch' | 'operation-generation-mismatch' | 'operation-attempt-mismatch' | undefined {
  if (operation.runId !== run.id) return 'operation-run-mismatch'
  if (operation.attempt !== run.attempt) return 'operation-attempt-mismatch'
  if (operation.generation !== run.generation && operation.generation !== run.generation + 1) {
    return 'operation-generation-mismatch'
  }
  return undefined
}

/**
 * Fold one durable event into the scan.
 * @param state - accumulator.
 * @param event - committed event.
 * @returns nothing.
 */
function observeEvent(state: ScanState, event: SessionEvent): void {
  if (event.seq <= state.lastSeq) return
  state.lastSeq = event.seq
  switch (event.type) {
    case 'turn/start':
      state.openTurn = event.data.turn
      return
    case 'turn/end': {
      const turn = event.data.turn
      if (state.endedTurns.has(turn)) return
      state.endedTurns.set(turn, event.seq)
      if (state.openTurn === turn) state.openTurn = undefined
      if (state.runTurns.has(turn)) {
        state.accepted.push({ turn, seq: event.seq, reason: event.data.reason })
      }
      return
    }
    case 'user/message':
      observeMessage(state, event.data, event.seq)
      return
    case 'approval/asked':
      state.pendingApprovals.set(String(event.data.id), event.data.toolName)
      return
    case 'approval/decided':
      state.pendingApprovals.delete(String(event.data.id))
      return
    default:
      return
  }
}

/**
 * Match one durable message against this operation's persistent source.
 * @param state - accumulator.
 * @param message - user message event data.
 * @param seq - event sequence.
 * @returns nothing.
 */
function observeMessage(state: ScanState, message: UserMessage, seq: number): void {
  const source = message.source
  if (source.kind === 'user') {
    state.humanSeqs.push(seq)
    return
  }
  if (source.kind !== 'session-orchestrator') return
  if (source.operationId !== state.operationId) return
  const identityMatches = source.runId === state.runId
    && source.generation === state.generation
    && source.attempt === state.attempt
  if (!identityMatches) {
    state.mismatches += 1
    return
  }
  if (state.seenMessageIds.has(message.id)) return
  state.seenMessageIds.add(message.id)
  if (state.firstOwnedSeq === undefined) state.firstOwnedSeq = seq
  const turn = state.openTurn
  state.messages.push({ messageId: message.id, seq, turn })
  if (turn !== undefined) state.runTurns.add(turn)
}

/**
 * Choose the turn that claimed this operation's prompt.
 *
 * The operation's recorded message identity wins; otherwise the first durable
 * run-owned message names the claim. A message not yet in a turn has no claim.
 * @param evidence - scanned log.
 * @param operation - linked operation.
 * @returns the claimed turn, or `undefined`.
 */
function claimTurn(evidence: SessionEvidence, operation: OperationRecord): number | undefined {
  const recorded = operation.messageId === undefined
    ? undefined
    : evidence.messages.find(message => message.messageId === operation.messageId)
  const chosen = recorded ?? evidence.messages[0]
  return chosen?.turn
}

/**
 * Build the supervisor progress from one scan.
 * @param evidence - scanned log.
 * @param messageId - recovered prompt identity.
 * @param claimedTurn - turn that claimed it.
 * @returns the progress.
 */
function progressFrom(
  evidence: SessionEvidence,
  messageId: string | undefined,
  claimedTurn: number | undefined,
): RunResumeProgress {
  return {
    ...(messageId !== undefined ? { messageId: MessageId(messageId) } : {}),
    ...(claimedTurn !== undefined ? { claimedTurn } : {}),
    accepted: [...evidence.accepted],
    endedTurns: [...evidence.endedTurns],
    ...(evidence.openTurn !== undefined ? { openTurn: evidence.openTurn } : {}),
    lastSeq: evidence.lastSeq,
    externalInput: evidence.externalInput,
    pendingApprovals: [...evidence.pendingApprovals],
    runOwnedMessages: evidence.messages.map(message => message.messageId),
  }
}

/**
 * Evidence for a session that does not exist in durable storage.
 * @param sessionId - identity that was probed, when one was known.
 * @returns absent evidence.
 */
function absentEvidence(sessionId: SessionId): SessionEvidence {
  return {
    sessionId,
    exists: false,
    lastSeq: -1,
    messages: [],
    sourceMismatches: 0,
    accepted: [],
    endedTurns: [],
    openTurn: undefined,
    foreignOpenTurn: undefined,
    externalInput: false,
    pendingApprovals: [],
    pendingMessages: [],
  }
}

/**
 * Map one durable turn-end reason to the recovery failure code.
 * @param reason - stored reason.
 * @returns the failure reason.
 */
function turnFailureReason(reason: TurnEndReason): RecoveryReason {
  switch (reason.kind) {
    case 'error':
      return 'turn-error'
    case 'aborted':
      return 'turn-aborted'
    case 'blocked':
      return 'turn-blocked'
    case 'max-tokens':
      return 'turn-max-tokens'
    case 'interrupted':
      return 'turn-interrupted'
    case 'forked':
      return 'turn-forked'
    default:
      // `completed` is filtered by the caller; any future reason is unknown.
      return 'turn-unknown'
  }
}

/**
 * Map one durable Session read failure to the actionable recovery reason.
 *
 * A read that cannot be opened or parsed is never treated as absent evidence:
 * that would let recovery replay work against a session it could not inspect.
 * @param error - caught persistence failure.
 * @returns the reason and message, or `undefined` for an unexpected failure.
 */
function persistenceFailure(
  error: unknown,
): { readonly reason: RecoveryReason; readonly detail: string } | undefined {
  const name = error instanceof Error ? error.name : ''
  const reason: RecoveryReason | undefined = name === 'SessionAlreadyOwnedError'
    ? 'session-writer-held'
    : name === 'SessionFormatUnsupportedError'
      ? 'session-format-unsupported'
      : name === 'SessionPersistenceCorruptionError'
        ? 'session-corrupt'
        : undefined
  if (reason === undefined) return undefined
  return { reason, detail: messageOf(error) }
}

/**
 * Test one error for the store's revision-CAS refusal.
 * @param error - caught failure.
 * @returns whether it is a retryable revision conflict.
 */
function isRevisionConflict(error: unknown): boolean {
  return error instanceof OrchestratorError && error.code === 'revision-conflict'
}

/**
 * Render one contained failure without leaking record content.
 * @param error - caught failure.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
