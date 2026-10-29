/**
 * Safe Turn handoff execution: freeze the parent boundary, create a fresh
 * successor Session, persist lineage and deliver exactly one recall message.
 *
 * This module owns sections 9–11 only. It never calls a model, never registers
 * a model tool and never writes a summary: the successor's first user message
 * is either the fixed structured brief or the exact projection of the last
 * complete Turn. Durable facts are read and written through the orchestration
 * Storage Domain; every run/operation transition is a revision or phase CAS.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/handoff
 */

import { createHash } from 'node:crypto'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import {
  ReasoningEffortId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  deriveEventMessage,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { OperationId, RunId } from './brand.ts'
import { OrchestratorError } from './errors.ts'
import type { SessionOrchestratorMessageSource } from './message-source.ts'
import {
  DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS,
  DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS,
  estimatePressureBudget,
} from './pressure.ts'
import type { PressureBudget, PressureTokenMeter } from './pressure.ts'
import type {
  ConfigRouteSource,
  EffectiveConfigSnapshot,
  HandoffMode,
  HandoffPolicy,
  HandoffRecord,
  OperationRecord,
  PresetRef,
  RunRecord,
  TaskSpec,
} from './types.ts'

/** Reserved preset id recorded only when the host owns preset composition. */
export const HOST_DEFAULT_PRESET_ID = 'host-default'

/** Stable reasons a handoff did not begin. */
export type HandoffBlockReason =
  | 'handoff-disabled'
  | 'generation-exhausted'
  | 'paused'
  | 'cancelled'
  | 'external-input'
  | 'pressure-not-pending'
  | 'session-mismatch'
  | 'turn-not-closed'
  | 'turn-not-completed'
  | 'budget-unavailable'
  | 'handoff-in-flight'
  | 'already-settled'

/** Stable reasons a claimed handoff stopped after its first durable write. */
export type HandoffFailureReason =
  | 'model-unavailable'
  | 'quiescence-failed'
  | 'flush-failed'
  | 'create-failed'
  | 'handoff-uncertain'

/** Terminal shape of one handoff attempt. */
export type HandoffStatus = 'handed-off' | 'blocked' | 'needs-attention' | 'in-flight'

/** Every non-completed handoff reason, whether blocked before or after claim. */
export type HandoffStopReason = HandoffBlockReason | HandoffFailureReason

/** One explicit configuration degradation, never a fabricated full copy. */
export type HandoffConfigDegradation =
  | 'preset-host-default'
  | 'preset-revision-unavailable'
  | 'sampling-fields-not-freezable'

/** Preset identity used for the successor and where it was read. */
export interface HandoffPresetInheritance {
  /** Preset id, or the explicit `host-default` sentinel. */
  readonly id: string
  /** Revision only when a public source exposed one. */
  readonly revision?: number
  /** Public source of the id. */
  readonly source: 'session-header' | 'task-fixed' | 'prior-snapshot' | 'host-default'
}

/** Configuration actually frozen for the successor. */
export interface HandoffConfigInheritance {
  /** Route snapshot persisted with the handoff. */
  readonly route: EffectiveConfigSnapshot
  /** Options passed to `agents.create`; unsupported sampling fields are not invented. */
  readonly agentOptions: AgentOptions
  /** Preset identity and its honest source. */
  readonly preset: HandoffPresetInheritance
  /** Permission policy is inherited from the host preset, never cloned. */
  readonly permissions: { readonly source: 'host-preset'; readonly copied: false }
  /** Skills remain owned by the preset composition, never copied. */
  readonly skills: { readonly source: 'preset'; readonly copied: false }
  /** Explicit gaps in what public APIs can preserve. */
  readonly degradations: readonly HandoffConfigDegradation[]
}

/** Tool state admitted by the handoff brief. */
export type HandoffToolStatus = 'settled' | 'running-known' | 'unknown'

/** One tool call visible in the last complete Turn. */
export interface HandoffToolFact {
  /** Correlating provider call id. */
  readonly callId: string
  /** Tool name as requested by the model. */
  readonly name: string
  /** Only this three-value vocabulary is reported. */
  readonly status: HandoffToolStatus
  /** Bounded verbatim result summary when settled. */
  readonly result?: string
}

/** A background job a host explicitly knows to be running. */
export interface HandoffBackgroundJob {
  /** Tool name or job label. */
  readonly name: string
  /** Correlating tool call id, when known. */
  readonly callId?: string
  /** Bounded host-authored detail. */
  readonly detail?: string
}

/** A normally closed Turn boundary and its official projection. */
export interface HandoffCompleteTurn {
  /** Session-local Turn number. */
  readonly turn: number
  /** `turn/start` sequence. */
  readonly startSeq: SessionSeq
  /** `turn/end` sequence. */
  readonly endSeq: SessionSeq
  /** Official projection of message events in this Turn, in surface order. */
  readonly messages: readonly Message[]
  /** Last non-empty assistant text, bounded for the brief. */
  readonly assistantExcerpt: string
  /** Calls paired with results without deleting either side. */
  readonly tools: readonly HandoffToolFact[]
  /** True only when every call has exactly one result and vice versa. */
  readonly pairingComplete: boolean
}

/** Durable Turn facts read from one Session. */
export interface HandoffSessionFacts {
  /** Whether the latest Turn is open, complete, aborted or absent. */
  readonly boundary: 'complete' | 'open' | 'not-completed' | 'none'
  /** Number of the currently open Turn, when one exists. */
  readonly openTurn?: number
  /** Normally closed Turns in log order. */
  readonly completeTurns: readonly HandoffCompleteTurn[]
  /** Latest complete Turn, present only when the latest boundary is complete. */
  readonly lastCompleteTurn?: HandoffCompleteTurn
}

/** Narrow store port used by the handoff transaction. */
export interface HandoffStore {
  /** Read a run, or `undefined` when it does not exist. */
  getRun(id: RunId): RunRecord | undefined
  /** Read a task, or `undefined` when it does not exist. */
  getTask(id: TaskSpec['id']): TaskSpec | undefined
  /** Read an operation, or `undefined` when it does not exist. */
  getOperation(id: OperationId): OperationRecord | undefined
  /** Idempotently plan an operation keyed by its identity. */
  planOperation(record: OperationRecord): Promise<OperationRecord>
  /** Compare-and-swap an operation by its durable phase. */
  advanceOperation(
    id: OperationId,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord>
  /** Read the handoff produced by one operation. */
  getHandoff(id: OperationId): HandoffRecord | undefined
  /** Persist one completed handoff. */
  recordHandoff(record: HandoffRecord): Promise<HandoffRecord>
  /** Compare-and-swap a replacement run record. */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord>
}

/** Narrow durability port for parent freeze and child acceptance. */
export interface HandoffDurability {
  /** Flush one Session; `false` means no listener confirmed durability. */
  flush(session: Session): boolean | Promise<boolean>
}

/** Narrow agent port: only `create` exists, so a parent can never be resumed. */
export interface HandoffAgents {
  /** Create a fresh successor Session by identity. */
  create(options: CreateAgentOptions): Promise<AgentHandle>
}

/** A model route a host may expose only when no durable route exists. */
export interface HandoffRuntimeModel {
  /** Registered provider id. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
  /** Optional reasoning effort. */
  readonly reasoningEffort?: string
  /** Optional output-token control supported by `agents.create`. */
  readonly maxTokens?: number
}

/** Constructor inputs for {@link HandoffManager}. */
export interface HandoffManagerOptions {
  /** Authoritative records and CAS transitions. */
  readonly store: HandoffStore
  /** Parent freeze and child acceptance durability. */
  readonly sessions: HandoffDurability
  /** Fresh-session factory. */
  readonly agents: HandoffAgents
  /** Message pricing used by the shared pressure budget. */
  readonly tokenMeter: PressureTokenMeter
  /** Clock for durable timestamps; defaults to `Date.now`. */
  readonly now?: () => number
  /** CAS retries on concurrent run/operation writes; defaults to 3. */
  readonly writeAttempts?: number
  /** Fixed structured-brief reserve, independent of the last-turn reserve. */
  readonly structuredBriefReserveTokens?: number
  /** Last-complete-turn reserve, independent of the brief reserve. */
  readonly lastCompleteTurnReserveTokens?: number
  /** Last-resort route read only when no header or prior snapshot exists. */
  readonly currentModel?: () => HandoffRuntimeModel | undefined
  /** Host-known running jobs; absent means every unmatched call stays `unknown`. */
  readonly backgroundJobs?: (session: Session) => readonly HandoffBackgroundJob[]
}

/** One execution request inside an already closed Turn. */
export interface HandoffExecutionRequest {
  /** Run whose pressure decision requests the handoff. */
  readonly runId: RunId
  /** Parent Session whose durable log is the source of truth. */
  readonly sourceSession: Session
  /** Optional live parent; when supplied, the manager waits for quiescence. */
  readonly sourceAgent?: Agent
  /** Explicit workspace override; otherwise the parent header or task cwd wins. */
  readonly cwd?: string
  /** Human input that arrived outside the claimed Turn; blocks the handoff. */
  readonly externalInput?: boolean
}

/** Public result of one execution attempt. */
export interface HandoffResult {
  /** Attempts are run-scoped. */
  readonly runId: RunId
  /** Terminal shape. */
  readonly status: HandoffStatus
  /** Stable reason for the shape. */
  readonly reason: HandoffStopReason | 'completed'
  /** Latest run after the attempt. */
  readonly run?: RunRecord
  /** Operation created or observed by the attempt. */
  readonly operation?: OperationRecord
  /** Completed handoff, present only after durable success. */
  readonly handoff?: HandoffRecord
  /** Fresh successor identity, present once claimed. */
  readonly childSessionId?: SessionId
  /** Body mode actually delivered. */
  readonly mode?: HandoffMode
  /** Normalized body hash persisted with the handoff. */
  readonly bodyHash?: string
  /** Selected body price. */
  readonly bodyTokens?: number
  /** Both mode prices and any token fallback. */
  readonly budget?: PressureBudget
  /** Honest configuration inheritance, including explicit gaps. */
  readonly config?: HandoffConfigInheritance
  /** Reason the last-turn body was replaced before delivery. */
  readonly bodyFallbackReason?: 'tool-pairing-incomplete' | 'last-turn-unavailable'
}

/**
 * Validate the durable handoff policy before any state changes.
 * @param policy - Persisted task policy.
 * @throws RangeError when a ratio, cap or mode is outside the public contract.
 */
export function validateHandoffPolicy(policy: HandoffPolicy): void {
  if (!Number.isFinite(policy.ratio) || policy.ratio < 0.5 || policy.ratio > 0.95) {
    throw new RangeError('handoff ratio must be within 0.5..0.95')
  }
  if (policy.mode !== 'structured-brief' && policy.mode !== 'last-complete-turn') {
    throw new RangeError('handoff mode must be structured-brief or last-complete-turn')
  }
  if (policy.boundary !== 'completed-turn') {
    throw new RangeError('handoff boundary must be completed-turn')
  }
  if (!Number.isSafeInteger(policy.maxGenerations) || policy.maxGenerations < 1) {
    throw new RangeError('maxGenerations must be a positive integer')
  }
  if (!Number.isSafeInteger(policy.maxHandoffTokens) || policy.maxHandoffTokens < 1) {
    throw new RangeError('maxHandoffTokens must be a positive integer')
  }
}

/**
 * Canonical body text: LF newlines, no trailing blanks, no outer whitespace.
 * @param text - rendered handoff body.
 * @returns the canonical body used for hashing and delivery.
 */
export function normalizeHandoffBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim()
}

/**
 * SHA-256 of the normalized first user message body.
 * @param text - rendered handoff body.
 * @returns the hex digest of its canonical text.
 */
export function handoffBodyHash(text: string): string {
  return createHash('sha256').update(normalizeHandoffBody(text), 'utf8').digest('hex')
}

/**
 * Deterministic successor identity for a run generation and attempt.
 * @param runId - parent run identity.
 * @param attempt - run attempt number.
 * @param generation - handoff generation number.
 * @returns the successor Session identity.
 */
export function handoffTargetSessionId(
  runId: RunId,
  attempt: number,
  generation: number,
): SessionId {
  return SessionId(`session-${runId}-${attempt}-${generation}`)
}

/**
 * Deterministic operation identity for one handoff generation.
 * @param runId - parent run identity.
 * @param attempt - run attempt number.
 * @param generation - handoff generation number.
 * @returns the handoff operation identity.
 */
export function handoffOperationId(
  runId: RunId,
  attempt: number,
  generation: number,
): OperationId {
  return `handoff-operation-${runId}-${attempt}-${generation}` as OperationId
}

/**
 * Stable operation request hash covering source, target, boundary and body.
 * @param input - source, target, cut point and body identity.
 * @returns the hex digest that detects a conflicting replay.
 */
export function handoffRequestHash(input: {
  readonly runId: RunId
  readonly attempt: number
  readonly generation: number
  readonly sourceSessionId: SessionId
  readonly targetSessionId: SessionId
  readonly sourceSeq: SessionLogOffset
  readonly bodyHash: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.runId,
    input.attempt,
    input.generation,
    input.sourceSessionId,
    input.targetSessionId,
    input.sourceSeq,
    input.bodyHash,
  ]), 'utf8').digest('hex')
}

/**
 * Read the latest Turn boundary and its official message projection.
 * @param session - Parent Session whose durable log is authoritative.
 * @param jobs - Host-known running jobs; omitted calls remain `unknown`.
 * @returns Latest boundary plus every normally closed Turn.
 */
export function inspectHandoffSession(
  session: Session,
  jobs: readonly HandoffBackgroundJob[] = [],
): HandoffSessionFacts {
  const completeTurns: HandoffCompleteTurn[] = []
  let openTurn: { readonly turn: number; readonly startSeq: SessionSeq } | undefined
  let sawTurnEnd = false
  let latestEndComplete = false
  let interruptedTail = false

  for (let index = 0; index < session.seq; index += 1) {
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      openTurn = { turn: event.data.turn, startSeq: event.seq }
      interruptedTail = false
      continue
    }
    if (event.type !== 'turn/end') {
      if (openTurn === undefined && sawTurnEnd && isTurnTailEvent(event.type)) {
        interruptedTail = true
      }
      continue
    }
    if (openTurn === undefined) continue
    const complete = event.data.reason.kind === 'completed'
    sawTurnEnd = true
    latestEndComplete = complete
    if (complete) {
      completeTurns.push(buildCompleteTurn(session, openTurn.turn, openTurn.startSeq, event.seq, jobs))
    }
    openTurn = undefined
    interruptedTail = false
  }

  if (openTurn !== undefined) {
    return { boundary: 'open', openTurn: openTurn.turn, completeTurns }
  }
  if (!sawTurnEnd) return { boundary: 'none', completeTurns }
  if (!latestEndComplete || interruptedTail) return { boundary: 'not-completed', completeTurns }
  const lastCompleteTurn = completeTurns[completeTurns.length - 1]
  return {
    boundary: 'complete',
    completeTurns,
    ...(lastCompleteTurn === undefined ? {} : { lastCompleteTurn }),
  }
}

/**
 * Whether an event after the latest `turn/end` leaves an interrupted tail.
 *
 * Request metadata (`request/header`, `request/context`) and the inherited-seed
 * marker produce no model-visible history and can legally follow a closed Turn.
 * Every other non-Turn event outside a Turn means an unsettled attempt, step,
 * tool call or unclaimed message; plugin-merged event types are treated the
 * same way because this module cannot know their settlement semantics.
 *
 * @param type - Appended event type, never `turn/start` or `turn/end`.
 * @returns True when the event invalidates the closed-Turn boundary.
 */
function isTurnTailEvent(type: SessionEvent['type']): boolean {
  return type !== 'request/header'
    && type !== 'request/context'
    && type !== 'session/end-seed'
}

function buildCompleteTurn(
  session: Session,
  turn: number,
  startSeq: SessionSeq,
  endSeq: SessionSeq,
  jobs: readonly HandoffBackgroundJob[],
): HandoffCompleteTurn {
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    if (seq < startSeq || seq > endSeq) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message !== null && (
      message.role === 'user' || message.role === 'assistant' || message.role === 'tool'
    )) {
      messages.push(message)
    }
  }

  const calls = new Map<string, { readonly name: string }>()
  const results = new Map<string, { readonly message: ToolResultMessage }>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') calls.set(block.id, { name: block.name })
      }
    } else if (message.role === 'tool') {
      results.set(message.toolCallId, { message })
    }
  }

  const tools: HandoffToolFact[] = []
  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (result !== undefined) {
      const summary = contentText(result.message.content)
      tools.push({
        callId,
        name: call.name,
        status: 'settled',
        ...(summary.length === 0 ? {} : { result: boundText(summary, 300) }),
      })
      continue
    }
    const job = jobs.find(candidate => candidate.callId === callId || candidate.name === call.name)
    tools.push({
      callId,
      name: call.name,
      status: job === undefined ? 'unknown' : 'running-known',
    })
  }

  const pairingComplete = calls.size === results.size
    && [...calls.keys()].every(callId => results.has(callId))
    && [...results.keys()].every(callId => calls.has(callId))

  return {
    turn,
    startSeq,
    endSeq,
    messages,
    assistantExcerpt: assistantExcerpt(messages),
    tools,
    pairingComplete,
  }
}

/** Input for the fixed structured-brief template. */
export interface StructuredBriefInput {
  /** Persisted task. */
  readonly task: TaskSpec
  /** Run being handed off. */
  readonly run: RunRecord
  /** Parent Session identity. */
  readonly sourceSessionId: SessionId
  /** Frozen parent log boundary. */
  readonly sourceSeq: SessionLogOffset
  /** Successor generation. */
  readonly generation: number
  /** Workspace the successor will use. */
  readonly cwd: string | undefined
  /** Durable Turn facts. */
  readonly facts: HandoffSessionFacts
  /** Host-known running jobs; absent entries stay `unknown`. */
  readonly backgroundJobs?: readonly HandoffBackgroundJob[]
}

/**
 * Render the exact structured brief template from durable facts.
 * @param input - Task, boundary and Turn facts.
 * @returns The human-readable recall body; never a model-written summary.
 */
export function renderStructuredBrief(input: StructuredBriefInput): string {
  const last = input.facts.lastCompleteTurn
  const completed = input.facts.completeTurns.length === 0
    ? 'none-recorded'
    : input.facts.completeTurns
      .map(turn => `turn ${turn.turn} (seq ${turn.startSeq}..${turn.endSeq})`)
      .join('; ')
  const settled = last?.tools.filter(tool => tool.status === 'settled') ?? []
  const unresolved = last?.tools.filter(tool => tool.status !== 'settled') ?? []
  const jobs = input.backgroundJobs ?? []
  const jobFacts = jobs.length === 0
    ? 'unknown'
    : jobs
      .map(job => `${job.name}${job.callId === undefined ? '' : ` (${job.callId})`} running`)
      .join('; ')

  return normalizeHandoffBody([
    '[SESSION HANDOFF]',
    '原任务：',
    input.task.prompt,
    '',
    '编排信息：',
    `- Run: ${input.run.id}`,
    `- 来源 Session: ${input.sourceSessionId}`,
    `- 来源截止 seq: ${input.sourceSeq}`,
    `- 交接代数: ${input.generation}`,
    `- 工作区: ${input.cwd ?? input.task.cwd}`,
    '',
    '可确认的事实：',
    `- 已完成 Turn：${completed}`,
    `- 本 Turn 内已 settle 的工具结果：${
      settled.length === 0
        ? 'none-recorded'
        : settled
          .map(tool => `${tool.name} (${tool.callId}) -> ${tool.result ?? 'settled'}`)
          .join('; ')
    }`,
    '- 日志明确记录的交付物：none-known',
    '',
    '未决或未知：',
    `- 跨 Turn 后台工作：${jobFacts}`,
    `- 无法从日志确认的事项：unknown${
      unresolved.length === 0
        ? ''
        : `; 未结算工具调用 ${unresolved
          .map(tool => `${tool.name} (${tool.callId}) -> ${tool.status}`)
          .join('; ')}`
    }`,
    '',
    '最近完整助手输出：',
    last?.assistantExcerpt.length === 0 || last === undefined
      ? 'none'
      : last.assistantExcerpt,
    '',
    '继续要求：',
    '基于上述事实和工作区实际状态继续原任务。',
    '不要假设 unknown 项已完成；先核实再行动，避免重复副作用。',
  ].join('\n'))
}

/** Input for the newest complete Turn projection. */
export interface LastCompleteTurnBodyInput {
  /** Run being handed off. */
  readonly runId: RunId
  /** Parent Session identity. */
  readonly sourceSessionId: SessionId
  /** Frozen parent log boundary. */
  readonly sourceSeq: SessionLogOffset
  /** Successor generation. */
  readonly generation: number
  /** Workspace the successor will use. */
  readonly cwd: string | undefined
  /** Exact complete Turn projection. */
  readonly turn: HandoffCompleteTurn
}

/**
 * Render the newest complete Turn with pairing and order preserved.
 * @param input - Exact projection and recall source.
 * @returns One user-message body; no tool call or result is dropped.
 */
export function renderLastCompleteTurn(input: LastCompleteTurnBodyInput): string {
  const lines: string[] = [
    '[SESSION HANDOFF — LAST COMPLETE TURN]',
    '',
    'Recall source:',
    `- Run: ${input.runId}`,
    `- Handoff generation: ${input.generation}`,
    `- Source session: ${input.sourceSessionId}`,
    `- Source seq: ${input.sourceSeq}`,
    `- Source Turn: ${input.turn.turn} (seq ${input.turn.startSeq}..${input.turn.endSeq})`,
    `- Workspace: ${input.cwd ?? 'none-recorded'}`,
    '',
    'The following projection preserves user, assistant and tool messages in their original order.',
    '',
  ]

  for (const message of input.turn.messages) {
    if (message.role === 'user') {
      lines.push('[user]', contentText(message.content), '')
    } else if (message.role === 'assistant') {
      lines.push('[assistant]', ...renderAssistantContent(message), '')
    } else if (message.role === 'tool') {
      lines.push(
        `[tool-result ${message.toolCallId}${message.isError === true ? ' error' : ''}]`,
        contentText(message.content),
        '',
      )
    }
  }

  lines.push(
    'Continue the task from this state. Keep every tool pairing above intact.',
  )
  return normalizeHandoffBody(lines.join('\n'))
}

/** Manager for one safe sequential Turn handoff transaction. */
export class HandoffManager {
  private readonly store: HandoffStore
  private readonly sessions: HandoffDurability
  private readonly agents: HandoffAgents
  private readonly tokenMeter: PressureTokenMeter
  private readonly now: () => number
  private readonly writeAttempts: number
  private readonly structuredBriefReserveTokens: number
  private readonly lastCompleteTurnReserveTokens: number
  private readonly currentModel: (() => HandoffRuntimeModel | undefined) | undefined
  private readonly backgroundJobs: ((session: Session) => readonly HandoffBackgroundJob[]) | undefined

  /**
   * Construct a manager over explicit public ports.
   * @param options - Store, durability, agent factory, pricing and clock ports.
   */
  constructor(options: HandoffManagerOptions) {
    this.store = options.store
    this.sessions = options.sessions
    this.agents = options.agents
    this.tokenMeter = options.tokenMeter
    this.now = options.now ?? Date.now
    this.writeAttempts = options.writeAttempts ?? 3
    this.structuredBriefReserveTokens = options.structuredBriefReserveTokens
      ?? DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS
    this.lastCompleteTurnReserveTokens = options.lastCompleteTurnReserveTokens
      ?? DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS
    this.currentModel = options.currentModel
    this.backgroundJobs = options.backgroundJobs
  }

  /**
   * Execute at most one handoff for the run's pending pressure decision.
   *
   * The operation phase is the restart authority: once a child is recorded,
   * another call can never create a second child or a second first message.
   *
   * @param request - Closed parent Turn and optional quiescence handle.
   * @returns The durable outcome, including explicit blocked/degraded reasons.
   */
  async handoff(request: HandoffExecutionRequest): Promise<HandoffResult> {
    const initial = this.requireRun(request.runId)
    const task = this.requireTask(initial.taskId)
    validateHandoffPolicy(task.handoff)

    const preflight = this.preflight(initial, task, request)
    if (preflight !== undefined) return preflight

    const jobs = this.jobsFor(request.sourceSession)
    const firstFacts = inspectHandoffSession(request.sourceSession, jobs)
    const boundaryBlock = boundaryFailure(firstFacts)
    if (boundaryBlock !== undefined) {
      return {
        runId: request.runId,
        status: 'blocked',
        reason: boundaryBlock,
        run: initial,
      }
    }

    const firstConfig = this.resolveConfig(initial, task, request.sourceSession)
    if (firstConfig === undefined) {
      return await this.needsAttention(
        request.runId,
        'model-unavailable',
        'No durable model route is available for the successor.',
        initial,
      )
    }

    const claimed = await this.claim(request, firstFacts)
    if ('status' in claimed) return claimed

    let stage: 'quiescence' | 'flush-parent' | 'config' | 'plan' | 'create' | 'submit' | 'flush-child' | 'commit'
      = 'quiescence'
    let operation: OperationRecord | undefined
    let child: AgentHandle | undefined
    let message: UserMessage | undefined

    try {
      if (request.sourceAgent !== undefined) await request.sourceAgent.whenIdle()
      stage = 'flush-parent'
      if (!await this.sessions.flush(request.sourceSession)) {
        throw new HandoffFailure('flush-failed', 'The parent Session flush had no durable listener.')
      }

      const sourceSeq = request.sourceSession.seq
      const facts = inspectHandoffSession(request.sourceSession, jobs)
      const afterWaitBlock = boundaryFailure(facts)
      if (afterWaitBlock !== undefined) {
        throw new HandoffFailure(afterWaitBlock, 'The parent Turn stopped being a complete boundary.')
      }

      stage = 'config'
      const config = this.resolveConfig(claimed.run, task, request.sourceSession)
      if (config === undefined) {
        throw new HandoffFailure('model-unavailable', 'No durable model route is available for the successor.')
      }
      const lastCompleteTurn = facts.lastCompleteTurn
      if (lastCompleteTurn === undefined) {
        throw new HandoffFailure('turn-not-closed', 'No complete Turn is available to project.')
      }

      const cwd = request.cwd ?? request.sourceSession.header.cwd ?? task.cwd
      const operationId = handoffOperationId(claimed.run.id, claimed.run.attempt, claimed.targetGeneration)
      const body = this.planBody(
        task,
        claimed.run,
        request.sourceSession.id,
        sourceSeq,
        claimed.targetGeneration,
        cwd,
        facts,
        operationId,
        jobs,
      )

      stage = 'plan'
      operation = await this.planOperation(
        claimed.run,
        operationId,
        request.sourceSession.id,
        claimed.targetSessionId,
        sourceSeq,
        body.bodyHash,
      )
      if (operation.phase !== 'planned') {
        throw new HandoffFailure(
          'handoff-uncertain',
          `Operation '${operation.id}' is already in phase '${operation.phase}'.`,
        )
      }

      stage = 'create'
      child = await this.agents.create(this.createOptions(
        claimed.targetSessionId,
        cwd,
        config,
        request.sourceSession,
      ))
      if (child.agent.id !== claimed.targetSessionId || child.agent.session.id !== claimed.targetSessionId) {
        throw new HandoffFailure(
          'handoff-uncertain',
          'The agent factory returned a different Session identity than requested.',
        )
      }

      operation = await this.advanceOperation(operation, 'session-created', {
        targetSessionId: claimed.targetSessionId,
      })

      stage = 'submit'
      message = createUserMessage({
        content: [{ type: 'text', text: body.text }],
        source: this.orchestratorSource(operation),
      })
      operation = await this.advanceOperation(operation, 'submitted', {
        messageId: message.id,
      })
      await child.agent.followup(message)

      stage = 'flush-child'
      if (!await this.sessions.flush(child.agent.session)) {
        throw new HandoffFailure('flush-failed', 'The successor Session flush had no durable listener.')
      }

      stage = 'commit'
      const handoff = await this.recordHandoff({
        generation: claimed.targetGeneration,
        runId: claimed.run.id,
        sourceSessionId: request.sourceSession.id,
        targetSessionId: claimed.targetSessionId,
        operationId,
        sourceSeq,
        bodyHash: body.bodyHash,
        mode: body.mode,
        configSnapshot: config.route,
        ...(body.bodyTokens === undefined ? {} : { bodyTokens: body.bodyTokens }),
        createdAt: this.now(),
      })
      const committedRun = await this.switchRun(
        claimed.run,
        claimed.targetSessionId,
        operation,
        message.id,
        config.route,
      )
      const settled = await this.settleOperation(operation)

      return {
        runId: claimed.run.id,
        status: 'handed-off',
        reason: 'completed',
        run: committedRun,
        operation: settled ?? operation,
        handoff,
        childSessionId: claimed.targetSessionId,
        mode: body.mode,
        bodyHash: body.bodyHash,
        ...(body.bodyTokens === undefined ? {} : { bodyTokens: body.bodyTokens }),
        budget: body.budget,
        config,
        ...(body.fallbackReason === undefined ? {} : { bodyFallbackReason: body.fallbackReason }),
      }
    } catch (error) {
      const stageReason = error instanceof HandoffFailure ? error.code : failureForStage(stage)
      const reason = child !== undefined && stageReason === 'create-failed'
        ? 'handoff-uncertain'
        : stageReason
      const diagnostic = error instanceof Error ? error.message : String(error)
      const uncertain = operation === undefined
        ? undefined
        : await this.markOperationUncertain(operation, claimed.targetSessionId, message?.id)
      const failedRun = await this.markNeedsAttention(claimed.run.id, reason, diagnostic)
      return {
        runId: claimed.run.id,
        status: 'needs-attention',
        reason,
        run: failedRun ?? claimed.run,
        ...(uncertain === undefined ? {} : { operation: uncertain }),
        ...(child === undefined ? {} : { childSessionId: claimed.targetSessionId }),
        ...(message === undefined ? {} : { bodyHash: handoffBodyHash(messageText(message)) }),
        config: firstConfig,
      }
    }
  }

  private preflight(
    run: RunRecord,
    task: TaskSpec,
    request: HandoffExecutionRequest,
  ): HandoffResult | undefined {
    const blocked = (reason: HandoffBlockReason): HandoffResult => ({
      runId: run.id,
      status: 'blocked',
      reason,
      run,
    })

    if (!task.handoff.enabled) return blocked('handoff-disabled')
    if (run.generation >= task.handoff.maxGenerations) return blocked('generation-exhausted')
    if (run.state === 'handing-off') return blocked('handoff-in-flight')
    if (run.state === 'paused') return blocked('paused')
    if (run.state === 'cancelled') return blocked('cancelled')
    if (run.state !== 'running' && run.state !== 'handoff-pending') return blocked('already-settled')
    if (request.externalInput === true) return blocked('external-input')
    if (run.state === 'running' && run.pressure?.decision !== 'handoff-pending') {
      return blocked('pressure-not-pending')
    }
    if (run.activeSessionId !== request.sourceSession.id) return blocked('session-mismatch')
    if (!run.sessionLineage.includes(request.sourceSession.id)) return blocked('session-mismatch')
    return undefined
  }

  private async claim(
    request: HandoffExecutionRequest,
    facts: HandoffSessionFacts,
  ): Promise<{ readonly run: RunRecord; readonly targetGeneration: number; readonly targetSessionId: SessionId }
    | HandoffResult> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const current = this.requireRun(request.runId)
      const currentTask = this.requireTask(current.taskId)
      const preflight = this.preflight(current, currentTask, request)
      if (preflight !== undefined) return preflight
      const boundaryBlock = boundaryFailure(facts)
      if (boundaryBlock !== undefined) {
        return { runId: current.id, status: 'blocked', reason: boundaryBlock, run: current }
      }

      const targetGeneration = current.generation + 1
      const targetSessionId = handoffTargetSessionId(
        current.id,
        current.attempt,
        targetGeneration,
      )
      const operationId = handoffOperationId(current.id, current.attempt, targetGeneration)
      const next: RunRecord = {
        ...current,
        state: 'handing-off',
        generation: targetGeneration,
        sessionLineage: [...current.sessionLineage, targetSessionId],
        operationId,
        revision: current.revision + 1,
        updatedAt: this.now(),
      }
      try {
        const claimed = await this.store.updateRun(current.id, current.revision, next)
        return { run: claimed, targetGeneration, targetSessionId }
      } catch (error) {
        if (!isRetryable(error)) throw error
      }
    }
    throw new OrchestratorError(
      'revision-conflict',
      `run '${request.runId}' could not be claimed after ${this.writeAttempts} attempts`,
    )
  }

  private planBody(
    task: TaskSpec,
    run: RunRecord,
    sourceSessionId: SessionId,
    sourceSeq: SessionLogOffset,
    generation: number,
    cwd: string,
    facts: HandoffSessionFacts,
    operationId: OperationId,
    jobs: readonly HandoffBackgroundJob[],
  ): HandoffBodyPlan {
    const briefText = renderStructuredBrief({
      task,
      run,
      sourceSessionId,
      sourceSeq,
      generation,
      cwd,
      facts,
      backgroundJobs: jobs,
    })
    const source = this.bodySource(operationId, run, generation)
    const briefMessage = createUserMessage({
      content: [{ type: 'text', text: briefText }],
      source,
    })

    const last = facts.lastCompleteTurn
    const useLast = task.handoff.mode === 'last-complete-turn'
      && last !== undefined
      && last.pairingComplete
    const lastText = useLast
      ? renderLastCompleteTurn({ runId: run.id, sourceSessionId, sourceSeq, generation, cwd, turn: last })
      : undefined
    const lastMessage = lastText === undefined
      ? undefined
      : createUserMessage({ content: [{ type: 'text', text: lastText }], source })

    const budget = estimatePressureBudget(
      task.handoff.mode,
      {
        structuredBrief: [briefMessage],
        ...(lastMessage === undefined ? {} : { lastCompleteTurn: [lastMessage] }),
      },
      this.tokenMeter,
      {
        structuredBriefReserveTokens: this.structuredBriefReserveTokens,
        lastCompleteTurnReserveTokens: this.lastCompleteTurnReserveTokens,
        maxTokens: task.handoff.maxHandoffTokens,
      },
    )

    if (lastText === undefined && task.handoff.mode === 'last-complete-turn') {
      const fallbackBudget = estimatePressureBudget(
        'structured-brief',
        { structuredBrief: [briefMessage] },
        this.tokenMeter,
        {
          structuredBriefReserveTokens: this.structuredBriefReserveTokens,
          lastCompleteTurnReserveTokens: this.lastCompleteTurnReserveTokens,
          maxTokens: task.handoff.maxHandoffTokens,
        },
      )
      if (fallbackBudget === undefined || !fallbackBudget.selected.withinMax) {
        throw new HandoffFailure('budget-unavailable', 'The structured brief exceeds maxHandoffTokens.')
      }
      return {
        mode: 'structured-brief',
        text: briefText,
        message: briefMessage,
        bodyHash: handoffBodyHash(briefText),
        bodyTokens: fallbackBudget.selected.bodyTokens,
        budget: fallbackBudget,
        fallbackReason: last === undefined ? 'last-turn-unavailable' : 'tool-pairing-incomplete',
      }
    }

    if (budget === undefined || !budget.selected.withinMax) {
      throw new HandoffFailure('budget-unavailable', 'The selected handoff body exceeds maxHandoffTokens.')
    }
    if (budget.selected.mode === 'structured-brief') {
      return {
        mode: 'structured-brief',
        text: briefText,
        message: briefMessage,
        bodyHash: handoffBodyHash(briefText),
        bodyTokens: budget.selected.bodyTokens,
        budget,
      }
    }
    return {
      mode: 'last-complete-turn',
      text: lastText ?? briefText,
      message: lastMessage ?? briefMessage,
      bodyHash: handoffBodyHash(lastText ?? briefText),
      bodyTokens: budget.selected.bodyTokens,
      budget,
    }
  }

  private async planOperation(
    run: RunRecord,
    operationId: OperationId,
    sourceSessionId: SessionId,
    targetSessionId: SessionId,
    sourceSeq: SessionLogOffset,
    bodyHash: string,
  ): Promise<OperationRecord> {
    const requestHash = handoffRequestHash({
      runId: run.id,
      attempt: run.attempt,
      generation: run.generation,
      sourceSessionId,
      targetSessionId,
      sourceSeq,
      bodyHash,
    })
    const now = this.now()
    const planned: OperationRecord = {
      id: operationId,
      runId: run.id,
      generation: run.generation,
      attempt: run.attempt,
      kind: 'handoff',
      sourceSessionId,
      phase: 'planned',
      requestHash,
      createdAt: now,
      updatedAt: now,
    }
    const operation = await this.store.planOperation(planned)
    if (operation.requestHash !== requestHash) {
      throw new OrchestratorError(
        'operation-hash-conflict',
        `operation '${operationId}' has a different request hash`,
      )
    }
    return operation
  }

  private async advanceOperation(
    current: OperationRecord,
    phase: 'session-created' | 'submitted',
    additions: { readonly targetSessionId?: SessionId; readonly messageId?: string },
  ): Promise<OperationRecord> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const latest = this.store.getOperation(current.id) ?? current
      if (latest.phase !== 'planned' && latest.phase !== 'session-created') return latest
      const next: OperationRecord = {
        ...latest,
        ...(additions.targetSessionId === undefined ? {} : { targetSessionId: additions.targetSessionId }),
        ...(additions.messageId === undefined ? {} : { messageId: additions.messageId }),
        phase,
        updatedAt: this.now(),
      }
      try {
        return await this.store.advanceOperation(latest.id, latest.phase, next)
      } catch (error) {
        if (!isRetryable(error)) throw error
      }
    }
    throw new OrchestratorError(
      'revision-conflict',
      `operation '${current.id}' could not advance after ${this.writeAttempts} attempts`,
    )
  }

  private createOptions(
    targetSessionId: SessionId,
    cwd: string,
    config: HandoffConfigInheritance,
    source: Session,
  ): CreateAgentOptions {
    const preset = config.preset.source === 'host-default' ? undefined : config.preset.id
    const meta: NonNullable<CreateAgentOptions['meta']> = {
      cwd,
      parentSession: source.id,
      ...(preset === undefined ? {} : { agentPreset: preset }),
    }
    return {
      sessionId: targetSessionId,
      meta,
      ...(Object.keys(config.agentOptions).length === 0 ? {} : { agentOptions: config.agentOptions }),
    }
  }

  private resolveConfig(
    run: RunRecord,
    task: TaskSpec,
    source: Session,
  ): HandoffConfigInheritance | undefined {
    const preset = this.resolvePreset(run, task, source)
    const degradations: HandoffConfigDegradation[] = []
    if (preset.source === 'host-default') degradations.push('preset-host-default')
    if (preset.source !== 'task-fixed' && preset.revision === undefined) {
      degradations.push('preset-revision-unavailable')
    }

    const presetRef: PresetRef = {
      id: preset.id,
      ...(preset.revision === undefined ? {} : { revision: preset.revision }),
    }
    const capturedAt = this.now()

    if (task.model.kind === 'fixed') {
      return this.inheritance(
        'fixed-policy',
        task.model.provider,
        task.model.model,
        task.model.reasoningEffort,
        undefined,
        preset,
        presetRef,
        capturedAt,
        degradations,
      )
    }

    const header = source.requestHeader()
    if (header !== undefined && header.config.provider.length > 0 && header.config.model.length > 0) {
      if (header.config.temperature !== undefined || header.config.stop !== undefined) {
        degradations.push('sampling-fields-not-freezable')
      }
      return this.inheritance(
        'completed-turn-header',
        header.config.provider,
        header.config.model,
        header.config.reasoningEffort,
        header.config.maxTokens,
        preset,
        presetRef,
        capturedAt,
        degradations,
      )
    }

    if (run.configSnapshot !== undefined) {
      return this.inheritance(
        run.configSnapshot.routeSource,
        run.configSnapshot.provider,
        run.configSnapshot.model,
        run.configSnapshot.reasoningEffort,
        undefined,
        preset,
        presetRef,
        capturedAt,
        degradations,
      )
    }

    let runtime: HandoffRuntimeModel | undefined
    try {
      runtime = this.currentModel?.()
    } catch {
      runtime = undefined
    }
    if (runtime === undefined || runtime.provider.length === 0 || runtime.model.length === 0) {
      return undefined
    }
    return this.inheritance(
      'runtime-fallback',
      runtime.provider,
      runtime.model,
      runtime.reasoningEffort,
      runtime.maxTokens,
      preset,
      presetRef,
      capturedAt,
      degradations,
    )
  }

  private inheritance(
    routeSource: ConfigRouteSource,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
    maxTokens: number | undefined,
    preset: HandoffPresetInheritance,
    presetRef: PresetRef,
    capturedAt: number,
    degradations: readonly HandoffConfigDegradation[],
  ): HandoffConfigInheritance {
    const route: EffectiveConfigSnapshot = {
      routeSource,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      preset: presetRef,
      capturedAt,
    }
    const agentOptions: AgentOptions = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    return {
      route,
      agentOptions,
      preset,
      permissions: { source: 'host-preset', copied: false },
      skills: { source: 'preset', copied: false },
      degradations,
    }
  }

  private resolvePreset(run: RunRecord, task: TaskSpec, source: Session): HandoffPresetInheritance {
    if (task.preset.kind === 'fixed') {
      return { id: task.preset.id, source: 'task-fixed' }
    }
    const sessionPreset = source.header.agentPreset
    if (sessionPreset !== undefined && sessionPreset.length > 0) {
      return { id: sessionPreset, source: 'session-header' }
    }
    const prior = run.configSnapshot?.preset
    if (prior !== undefined && prior.id !== HOST_DEFAULT_PRESET_ID) {
      return {
        id: prior.id,
        ...(prior.revision === undefined ? {} : { revision: prior.revision }),
        source: 'prior-snapshot',
      }
    }
    return { id: HOST_DEFAULT_PRESET_ID, source: 'host-default' }
  }

  private bodySource(
    operationId: OperationId,
    run: RunRecord,
    generation: number,
  ): SessionOrchestratorMessageSource {
    return {
      kind: 'session-orchestrator',
      operationId,
      runId: run.id,
      generation,
      attempt: run.attempt,
      form: 'recall',
    }
  }

  private orchestratorSource(operation: OperationRecord): SessionOrchestratorMessageSource {
    return {
      kind: 'session-orchestrator',
      operationId: operation.id,
      runId: operation.runId,
      generation: operation.generation,
      attempt: operation.attempt,
      form: 'recall',
    }
  }

  private async recordHandoff(record: HandoffRecord): Promise<HandoffRecord> {
    const existing = this.store.getHandoff(record.operationId)
    if (existing !== undefined) {
      if (sameHandoff(existing, record)) return existing
      throw new HandoffFailure('handoff-uncertain', 'The operation already recorded a different handoff.')
    }
    try {
      return await this.store.recordHandoff(record)
    } catch (error) {
      if (!(error instanceof OrchestratorError) || error.code !== 'already-exists') throw error
      const raced = this.store.getHandoff(record.operationId)
      if (raced !== undefined && sameHandoff(raced, record)) return raced
      throw new HandoffFailure('handoff-uncertain', 'The operation recorded a different handoff.')
    }
  }

  private async switchRun(
    claimed: RunRecord,
    targetSessionId: SessionId,
    operation: OperationRecord,
    messageId: string,
    configSnapshot: EffectiveConfigSnapshot,
  ): Promise<RunRecord> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const latest = this.requireRun(claimed.id)
      if (
        latest.state === 'running'
        && latest.activeSessionId === targetSessionId
        && latest.generation === claimed.generation
      ) {
        return latest
      }
      if (
        latest.state !== 'handing-off'
        || latest.operationId !== operation.id
        || latest.generation !== claimed.generation
      ) {
        throw new HandoffFailure('handoff-uncertain', 'The claimed run changed before the successor switch.')
      }
      const stripped = omitRunFields(latest, [
        'pressure',
        'claimedTurn',
        'acceptedTurnEndSeq',
        'lastError',
      ])
      const next: RunRecord = {
        ...stripped,
        state: 'running',
        activeSessionId: targetSessionId,
        generation: claimed.generation,
        sessionLineage: latest.sessionLineage,
        operationId: operation.id,
        submittedMessageId: messageId,
        configSnapshot,
        revision: latest.revision + 1,
        updatedAt: this.now(),
      }
      try {
        return await this.store.updateRun(latest.id, latest.revision, next)
      } catch (error) {
        if (!isRetryable(error)) throw error
      }
    }
    throw new OrchestratorError(
      'revision-conflict',
      `run '${claimed.id}' could not switch after ${this.writeAttempts} attempts`,
    )
  }

  private async settleOperation(operation: OperationRecord): Promise<OperationRecord | undefined> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const latest = this.store.getOperation(operation.id)
      if (latest === undefined) return undefined
      if (latest.phase === 'settled' || latest.phase === 'uncertain') return latest
      if (latest.phase !== 'submitted') return latest
      const next: OperationRecord = {
        ...latest,
        phase: 'settled',
        updatedAt: this.now(),
      }
      try {
        return await this.store.advanceOperation(latest.id, 'submitted', next)
      } catch (error) {
        if (!isRetryable(error)) return undefined
      }
    }
    return this.store.getOperation(operation.id)
  }

  private async markOperationUncertain(
    operation: OperationRecord,
    targetSessionId: SessionId,
    messageId: string | undefined,
  ): Promise<OperationRecord | undefined> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const latest = this.store.getOperation(operation.id)
      if (latest === undefined) return undefined
      if (latest.phase === 'settled' || latest.phase === 'uncertain') return latest
      if (latest.phase === 'claimed') return latest
      const next: OperationRecord = {
        ...latest,
        targetSessionId,
        ...(messageId === undefined ? {} : { messageId }),
        phase: 'uncertain',
        updatedAt: this.now(),
      }
      try {
        return await this.store.advanceOperation(latest.id, latest.phase, next)
      } catch (error) {
        if (!isRetryable(error)) return this.store.getOperation(operation.id)
      }
    }
    return this.store.getOperation(operation.id)
  }

  private async needsAttention(
    runId: RunId,
    reason: HandoffStopReason,
    message: string,
    fallback: RunRecord,
  ): Promise<HandoffResult> {
    const run = await this.markNeedsAttention(runId, reason, message)
    return {
      runId,
      status: 'needs-attention',
      reason,
      run: run ?? fallback,
    }
  }

  private async markNeedsAttention(
    runId: RunId,
    reason: HandoffStopReason,
    message: string,
  ): Promise<RunRecord | undefined> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const latest = this.store.getRun(runId)
      if (latest === undefined) return undefined
      if (
        latest.state === 'succeeded'
        || latest.state === 'needs-attention'
        || latest.state === 'failed'
        || latest.state === 'cancelled'
      ) {
        return latest
      }
      if (
        latest.state !== 'handing-off'
        && latest.state !== 'running'
        && latest.state !== 'handoff-pending'
      ) {
        return latest
      }
      const next: RunRecord = {
        ...latest,
        state: 'needs-attention',
        lastError: { code: reason, message, retryable: true },
        revision: latest.revision + 1,
        updatedAt: this.now(),
      }
      try {
        return await this.store.updateRun(latest.id, latest.revision, next)
      } catch (error) {
        if (!isRetryable(error)) return latest
      }
    }
    return this.store.getRun(runId)
  }

  private jobsFor(session: Session): readonly HandoffBackgroundJob[] {
    if (this.backgroundJobs === undefined) return []
    const jobs = this.backgroundJobs(session)
    return jobs.map(job => ({
      name: job.name,
      ...(job.callId === undefined ? {} : { callId: job.callId }),
      ...(job.detail === undefined ? {} : { detail: boundText(job.detail, 200) }),
    }))
  }

  private requireRun(id: RunId): RunRecord {
    const run = this.store.getRun(id)
    if (run === undefined) throw new OrchestratorError('not-found', `run '${id}' does not exist`)
    return run
  }

  private requireTask(id: TaskSpec['id']): TaskSpec {
    const task = this.store.getTask(id)
    if (task === undefined) throw new OrchestratorError('not-found', `task '${id}' does not exist`)
    return task
  }
}

interface HandoffBodyPlan {
  readonly mode: HandoffMode
  readonly text: string
  readonly message: UserMessage
  readonly bodyHash: string
  readonly bodyTokens: number
  readonly budget: PressureBudget
  readonly fallbackReason?: 'tool-pairing-incomplete' | 'last-turn-unavailable'
}

class HandoffFailure extends Error {
  readonly code: HandoffStopReason

  constructor(code: HandoffStopReason, message: string) {
    super(message)
    this.name = 'HandoffFailure'
    this.code = code
  }
}

function boundaryFailure(facts: HandoffSessionFacts): HandoffBlockReason | undefined {
  if (facts.boundary === 'open') return 'turn-not-closed'
  if (facts.boundary === 'none') return 'turn-not-closed'
  if (facts.boundary === 'not-completed') return 'turn-not-completed'
  if (facts.lastCompleteTurn === undefined) return 'turn-not-closed'
  return undefined
}

function failureForStage(
  stage: 'quiescence' | 'flush-parent' | 'config' | 'plan' | 'create' | 'submit' | 'flush-child' | 'commit',
): HandoffFailureReason {
  if (stage === 'quiescence') return 'quiescence-failed'
  if (stage === 'flush-parent' || stage === 'flush-child') return 'flush-failed'
  if (stage === 'create') return 'create-failed'
  if (stage === 'config') return 'model-unavailable'
  return 'handoff-uncertain'
}

function isRetryable(error: unknown): boolean {
  return error instanceof OrchestratorError
    && (error.code === 'revision-conflict' || error.code === 'already-exists')
}

function sameHandoff(left: HandoffRecord, right: HandoffRecord): boolean {
  return left.operationId === right.operationId
    && left.runId === right.runId
    && left.generation === right.generation
    && left.sourceSessionId === right.sourceSessionId
    && left.targetSessionId === right.targetSessionId
    && left.sourceSeq === right.sourceSeq
    && left.bodyHash === right.bodyHash
    && left.mode === right.mode
}

type OptionalRunField = 'pressure' | 'claimedTurn' | 'acceptedTurnEndSeq' | 'lastError'

function omitRunFields(run: RunRecord, fields: readonly OptionalRunField[]): RunRecord {
  const copy: Record<string, unknown> = { ...run }
  for (const field of fields) delete copy[field]
  return copy as unknown as RunRecord
}

function boundText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function contentText(content: readonly ContentBlock[]): string {
  const pieces: string[] = []
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.text.length > 0) pieces.push(block.text)
    } else if (block.type === 'image') {
      pieces.push(`[image attachment ${block.attachment.name ?? block.attachment.attachmentId}]`)
    } else if (block.type === 'file') {
      pieces.push(`[file attachment ${block.attachment.name}]`)
    } else if (block.type === 'tool-call') {
      pieces.push(`[tool-call ${block.name} ${block.id}] ${block.arguments}`)
    }
  }
  return pieces.join('\n')
}

function assistantExcerpt(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = assistantText(message)
    if (text.length > 0) return boundText(text, 2000)
  }
  return ''
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is ContentBlock & { readonly type: 'text'; readonly text: string } => (
      block.type === 'text'
    ))
    .map(block => block.text)
    .join('\n')
}

function renderAssistantContent(message: AssistantMessage): readonly string[] {
  const lines: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) lines.push(block.text)
    } else if (block.type === 'reasoning') {
      if (block.text.length > 0) lines.push('[reasoning]', block.text)
    } else if (block.type === 'tool-call') {
      lines.push(`[tool-call ${block.name} ${block.id}]`, block.arguments)
    } else if (block.type === 'image') {
      lines.push(`[image attachment ${block.attachment.name ?? block.attachment.attachmentId}]`)
    } else if (block.type === 'file') {
      lines.push(`[file attachment ${block.attachment.name}]`)
    }
  }
  if (lines.length === 0) lines.push('none-recorded')
  return lines
}

function messageText(message: UserMessage): string {
  return contentText(message.content)
}
