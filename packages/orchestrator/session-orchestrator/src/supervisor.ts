/**
 * Run supervisor: the in-process lifecycle controller for one orchestrated run.
 *
 * One supervisor instance owns one run attempt from session creation through
 * prompt submission, claim, turn settlement, quiescence, durability, the
 * terminal run transition, and handle disposal. It never calls a model, never
 * registers a model tool and never summarizes: the agent loop owns the
 * conversation, and this controller only observes durable Session facts and
 * commits run state.
 *
 * The durable Operation record — not the submitted `MessageId` — is the
 * reconciliation authority. The `operationId` is written into the persistent
 * `MessageSource` of the submitted prompt before `followup()` is called, so a
 * restart can decide from durable facts whether work was submitted, claimed or
 * settled without ever replaying a prompt.
 *
 * Completion is never inferred from a single `whenIdle()` resolution or from
 * `followup()` returning: the controller re-converges after every wait and only
 * stamps success once the accepted turn ended normally, no run-owned work is
 * still queued, no external input arrived and the required Session events are
 * durable.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/supervisor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
// The approval events join `SessionEventMap` only when this declaration module
// is part of the program; the supervisor reads them to detect a run that is
// waiting for a human decision.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { OperationId, RunId } from './brand.ts'
import { OrchestratorError } from './errors.ts'
import { frozenModelOf, resolveTaskModel } from './model-route.ts'
import type { SessionOrchestratorMessageSource } from './message-source.ts'
import type { OperationRecord, QueueRecord, RunRecord, TaskSpec } from './schema.ts'

/** Persisted run, queue and operation state the supervisor advances under CAS. */
export interface SupervisorStore {
  /**
   * Read one stored run.
   * @param id - run identity.
   * @returns the stored run, or `undefined` when absent.
   */
  getRun(id: RunId): RunRecord | undefined
  /**
   * Read one stored queue, when the store exposes queues.
   *
   * The supervisor uses it only to resolve the pipeline route a task inherits.
   * A store without queues keeps the legacy task-only resolution.
   * @param id - queue identity.
   * @returns the stored queue, or `undefined` when absent.
   */
  getQueue?(id: TaskSpec['queueId']): QueueRecord | undefined
  /**
   * Replace one run under revision CAS.
   * @param id - run identity.
   * @param expectedRevision - revision the caller last observed.
   * @param next - replacement record, at exactly `expectedRevision + 1`.
   * @returns the stored run.
   */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord>
  /**
   * Read one stored operation.
   * @param id - operation identity.
   * @returns the stored operation, or `undefined` when absent.
   */
  getOperation(id: OperationId): OperationRecord | undefined
  /**
   * Advance one operation phase under phase CAS.
   * @param id - operation identity.
   * @param expectedPhase - phase the caller last observed.
   * @param next - replacement record.
   * @returns the stored operation.
   */
  advanceOperation(
    id: OperationId,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord>
}

/**
 * The durability checkpoint the supervisor waits for before claiming success.
 *
 * `SessionStore.flush(session)` satisfies this. The port is narrower than the
 * whole store because a per-run controller must not be able to create, resume
 * or drop sessions.
 */
export interface SessionDurability {
  /**
   * Await the durability listeners for one session.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated.
   */
  flush(session: Session): Promise<boolean>
}

/** The agent-creation capability the supervisor needs; `ctx.agents` satisfies it. */
export interface SupervisorAgents {
  /**
   * Create one owned agent on a caller-supplied session id.
   * @param options - identity, metadata, per-agent options and setup.
   * @returns the owned handle after creation completes.
   */
  create(options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Resume one owned agent on a persisted session.
   *
   * Required by recovery; `ctx.agents` provides it. It is optional in this port
   * so the scheduler-only supervisor composition stays usable, but a resume
   * call without it fails loudly instead of pretending to hold a handle.
   * @param options - persisted identity and per-agent options.
   * @returns the owned handle after the persisted log was opened and repaired.
   */
  resume?(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Live Session directory needed to refuse a second owner. */
export interface SupervisorLiveSessions {
  /**
   * Resolve one live Session.
   * @param id - the session identity to look up.
   * @returns the live Session, or undefined when it is not loaded here.
   */
  get(id: SessionId): Session | undefined
}

/** One real host Workspace a task session must join. */
export interface SupervisorWorkspace {
  /** Canonical directory a session created here must report as its cwd. */
  readonly path: string
  /**
   * Record the session in this Workspace's ordered account.
   * @param sessionId - live session to attach.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>
}

/** Workspace registry face the supervisor needs; `ctx.workspaceRegistry` satisfies it. */
export interface SupervisorWorkspaces {
  /**
   * Resolve one registered Workspace.
   * @param id - Workspace identity stored on the task.
   * @returns the Workspace, or undefined when it was deleted.
   */
  get(id: string): SupervisorWorkspace | undefined
}

/** Agent preset registry face the supervisor needs; `ctx.agentPresets` satisfies it. */
export interface SupervisorPresets {
  /**
   * Resolve one declared preset before an Agent is created.
   * @param id - preset identity stored on the task.
   * @returns resolution after the preset exists and is usable.
   */
  resolve(id: string): Promise<unknown>
  /**
   * Mount one preset's composition on a new Agent's scoped context.
   * @param ctx - the Agent setup context.
   * @param id - preset identity stored on the task.
   * @returns resolution after the composition is bound.
   */
  mount(ctx: Context, id: string): Promise<unknown>
}

/** Dependencies one run supervisor is composed with. */
export interface RunSupervisorOptions {
  /** Context that dispatches the Session events this controller observes. */
  readonly ctx: Context
  /** Durable run and operation records. */
  readonly store: SupervisorStore
  /** Durability checkpoint awaited before the success commit. */
  readonly sessions: SessionDurability
  /** Live Session directory used to refuse a second owner; pass `ctx.sessions`. */
  readonly liveSessions: SupervisorLiveSessions
  /** Agent creation seam; pass `ctx.agents` in production. */
  readonly agents: SupervisorAgents
  /**
   * Optional real Workspace registry, resolved once at composition time.
   *
   * Prefer {@link workspaceSource} in a live host: a service read at composition
   * time can still be absent because Cordis starts entries concurrently and
   * publishes a service only after its own initialization finished.
   */
  readonly workspaces?: SupervisorWorkspaces
  /**
   * Resolve the real Workspace registry at the moment a Session is created.
   *
   * The source is re-read for every launch and resume, so a composition that
   * mounts the registry after this supervisor was composed still attaches each
   * Session to the selected Workspace. Takes precedence over
   * {@link workspaces}; `undefined` keeps the legacy cwd-only behavior for a
   * host that mounted no registry at all.
   */
  readonly workspaceSource?: () => SupervisorWorkspaces | undefined
  /**
   * Optional agent preset registry. Production passes `ctx.agentPresets`; a
   * fixed preset is then resolved before creation and mounted on the Agent's
   * scoped composition, so its skills really apply to the Session.
   */
  readonly presets?: SupervisorPresets
  /** Clock used for record timestamps; defaults to `Date.now`. */
  readonly now?: () => number
  /** How many quiescence rounds a run may take before it needs attention. */
  readonly convergenceRounds?: number
  /** How many revision-CAS retries one run write may take. */
  readonly writeAttempts?: number
}

/** One live, orchestrator-owned agent handle for a run. */
export interface RunHandle {
  /** Run this handle drives. */
  readonly runId: RunId
  /** Live session the agent owns. */
  readonly sessionId: SessionId
  /** Operation whose prompt this agent carries. */
  readonly operationId: OperationId
  /** Owned agent plus its teardown capability. */
  readonly handle: AgentHandle
}

/**
 * How this process relates to one run's live agent.
 *
 * Only an `owned` run has a handle and may be disposed here. An `observed` run
 * was created or is driven by another owner (for example a Web controller), so
 * the supervisor must stop orchestrating it and must never tear it down.
 */
export type RunOwnership = 'owned' | 'observed'

/**
 * In-process table of the run handles this process owns.
 *
 * Handles are a capability: the table is the only place a run's disposer is
 * reachable, so a run without an entry can never be disposed by this process.
 * The table is deliberately memory-only; the durable Domain stores only the
 * session identity and the ownership is re-derived on restart.
 */
export class RunHandleTable {
  private readonly entries = new Map<RunId, RunHandle>()

  /**
   * Hold one newly created handle.
   * @param entry - the owned handle.
   * @throws OrchestratorError with `already-exists` when the run is already held.
   */
  hold(entry: RunHandle): void {
    if (this.entries.has(entry.runId)) {
      throw new OrchestratorError('already-exists', `run '${entry.runId}' already has a live handle`)
    }
    this.entries.set(entry.runId, entry)
  }

  /**
   * Read one held handle.
   * @param runId - run identity.
   * @returns the held handle, or `undefined` when this process does not own it.
   */
  get(runId: RunId): RunHandle | undefined {
    return this.entries.get(runId)
  }

  /**
   * Take ownership of one handle, removing it from the table.
   * @param runId - run identity.
   * @returns the handle, or `undefined` when absent.
   */
  take(runId: RunId): RunHandle | undefined {
    const entry = this.entries.get(runId)
    this.entries.delete(runId)
    return entry
  }

  /**
   * Classify this process's relationship to one run.
   * @param runId - run identity.
   * @returns `owned` when the table holds a handle, `observed` otherwise.
   */
  ownership(runId: RunId): RunOwnership {
    return this.entries.has(runId) ? 'owned' : 'observed'
  }

  /** Number of handles currently held. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Snapshot every held handle.
   * @returns a fresh array in insertion order.
   */
  list(): readonly RunHandle[] {
    return [...this.entries.values()]
  }
}

/** Terminal state one supervised run reaches. */
export type RunSettlementState = 'succeeded' | 'needs-attention' | 'failed' | 'cancelled'

/**
 * Stable reason a run reached its settlement state.
 *
 * `completed` is the only success reason. `needs-attention` reasons describe a
 * run that stopped at a human boundary and must not auto-advance; `failed`
 * reasons describe a turn or durability failure; `cancelled` describes an
 * explicit cancellation.
 */
export type RunSettlementReason =
  | 'completed'
  | 'external-input'
  | 'awaiting-approval'
  | 'queued-work'
  | 'turn-error'
  | 'turn-aborted'
  | 'turn-blocked'
  | 'turn-max-tokens'
  | 'turn-interrupted'
  | 'turn-forked'
  | 'turn-unknown'
  | 'turn-missing'
  | 'message-source-mismatch'
  | 'flush-failed'
  | 'restart-uncertain'
  | 'already-settled'
  | 'cancelled'
  | 'closed'

/** Result of supervising one run attempt to its settlement point. */
export interface RunSettlement {
  /** Run that settled. */
  readonly runId: RunId
  /** Terminal state the run reached. */
  readonly state: RunSettlementState
  /** Stable reason for the state. */
  readonly reason: RunSettlementReason
  /** Whether the terminal state was durably written to the run record. */
  readonly committed: boolean
  /** Session the run drove, when one was created. */
  readonly sessionId: SessionId | undefined
  /** Seq of the last accepted `turn/end`, when one was accepted. */
  readonly acceptedTurnEndSeq: number | undefined
  /** Number of run-owned turns accepted. */
  readonly turns: number
  /** Duplicate durable events ignored during the run. */
  readonly duplicates: number
  /** Whether the flush checkpoint had a durability listener participating. */
  readonly flushParticipated: boolean
  /** Handle disposal failure, when teardown failed after settlement. */
  readonly disposeError: string | undefined
  /** Human-readable failure detail, when one exists. */
  readonly detail: string | undefined
}

/**
 * What the supervisor needs to know about one run attempt.
 *
 * Structurally a subset of the scheduler's `RunLauncherRequest`, so a launcher
 * adapter can forward that request unchanged.
 */
export interface RunStartRequest {
  /** The run attempt being started. */
  readonly run: RunRecord
  /** The task definition the run belongs to. */
  readonly task: TaskSpec
  /** Operation identity recorded for this start. */
  readonly operationId: OperationId
}

/** One accepted run-owned turn reconstructed from a durable Session log. */
export interface RunAcceptedTurn {
  /** Turn number the agent assigned. */
  readonly turn: number
  /** Sequence number of its `turn/end`. */
  readonly seq: number
  /** Why the turn closed. */
  readonly reason: TurnEndReason
}

/**
 * Progress recovery already reconstructed from the durable Session log.
 *
 * The supervisor seeds its live observation with these facts, then continues
 * from `lastSeq`; it never re-reads or re-submits the prompt. `submitPrompt`
 * is a recovery decision, not a message identity: the supervisor still skips
 * the submission when the replayed log already holds run-owned input.
 */
export interface RunResumeProgress {
  /** Prompt identity linked to the operation, from the log or the record. */
  readonly messageId?: MessageId
  /** Turn that claimed the prompt, when the log shows the claim. */
  readonly claimedTurn?: number
  /** Run-owned turns that already closed. */
  readonly accepted: readonly RunAcceptedTurn[]
  /** Every closed turn in the log, so duplicates stay deduplicated. */
  readonly endedTurns: readonly { readonly turn: number; readonly seq: number }[]
  /** Run-owned turn still open when the crash happened. */
  readonly openTurn?: number
  /** Last durable Session sequence number already accounted for. */
  readonly lastSeq: number
  /** Whether input from a non-run source arrived after our prompt. */
  readonly externalInput: boolean
  /** Approvals still unanswered in the log. */
  readonly pendingApprovals: readonly { readonly id: string; readonly toolName: string }[]
  /** Every run-owned message identity found in the log. */
  readonly runOwnedMessages: readonly string[]
}

/** One recovery-driven resume of a run whose session already exists. */
export interface RunResumeRequest extends RunStartRequest {
  /** Session the resumed agent owns. */
  readonly sessionId: SessionId
  /** Durable progress reconstructed before the resume. */
  readonly progress: RunResumeProgress
  /**
   * Whether this resume may submit the prompt.
   *
   * True only when the durable log holds no run-owned message and the operation
   * has no submission intent. The supervisor re-checks the replayed log and
   * skips submission if run-owned input appeared while resuming.
   */
  readonly submitPrompt: boolean
}

/** Handle ownership taken by one recovery resume. */
export interface RunResumeStart {
  /** Run whose handle is now held by this process. */
  readonly runId: RunId
  /** Session the held agent owns. */
  readonly sessionId: SessionId
  /** Settlement that resolves once the resumed run reaches its boundary. */
  readonly settlement: Promise<RunSettlement>
}

/**
 * Handle ownership taken by one scheduler launch.
 *
 * A scheduler launch must return once the Session exists, because the scheduler
 * commits `starting → running` from that identity. The returned settlement
 * resolves later at the run's terminal boundary; it is never awaited by the
 * scheduler, so a live run does not hold a scheduling slot until it finishes.
 */
export interface RunLaunchStart {
  /** Run whose handle is now held by this process. */
  readonly runId: RunId
  /** Session the launched agent owns. */
  readonly sessionId: SessionId
  /** Settlement that resolves once the launched run reaches its boundary. */
  readonly settlement: Promise<RunSettlement>
}

/** Run states that need no further supervision. */
const TERMINAL_RUN_STATES: ReadonlySet<RunRecord['state']> = new Set([
  'succeeded',
  'needs-attention',
  'paused',
  'deferred',
  'cancelled',
  'failed',
])

/** Durable run state each settlement state maps to. */
const RUN_STATE_BY_SETTLEMENT: Readonly<Record<RunSettlementState, RunRecord['state']>> = {
  succeeded: 'succeeded',
  'needs-attention': 'needs-attention',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Mutable per-run observation state built from durable Session events. */
interface RunObservation {
  readonly runId: RunId
  readonly operationId: OperationId
  readonly sessionId: SessionId
  readonly agent: Agent
  readonly accepted: RunAcceptedTurn[]
  readonly endedTurns: Map<number, number>
  readonly runTurns: Set<number>
  readonly runOwnedMessages: Set<string>
  readonly pendingApprovals: Map<string, string>
  messageId: MessageId | undefined
  claimedTurn: number | undefined
  openTurn: number | undefined
  lastSeq: number
  duplicates: number
  externalInput: boolean
  cancelled: boolean
  configSnapshot: NonNullable<RunRecord['configSnapshot']> | undefined
}

/** One created agent plus the listeners that observe it. */
interface OpenedRun {
  /** Live observation for the created agent. */
  readonly observation: RunObservation
  /** Listener teardowns installed for this run. */
  readonly unwinds: readonly (() => void)[]
}

/** What one quiescence probe observed. */
export interface RunProbe {
  /** Run-owned messages still waiting in the inbox. */
  readonly pendingRunWork: number
  /** Whether input from a source other than this run arrived. */
  readonly externalInput: boolean
  /** Whether an approval request is still unanswered. */
  readonly awaitingApproval: boolean
  /** Turn that is still open, when the agent is mid-turn. */
  readonly openTurn: number | undefined
}

/**
 * One single-run lifecycle controller.
 *
 * The controller is deliberately not a Cordis Service: it is a per-operation
 * controller composed with explicit dependencies, so a wiring layer can own
 * exactly one instance per host without giving it ambient authority. Its only
 * ambient dependency is the Context it observes Session events on.
 */
export class RunSupervisor {
  private readonly ctx: Context
  private readonly store: SupervisorStore
  private readonly sessions: SessionDurability
  private readonly liveSessions: SupervisorLiveSessions
  private readonly agents: SupervisorAgents
  private readonly workspaces: SupervisorWorkspaces | undefined
  private readonly workspaceSource: (() => SupervisorWorkspaces | undefined) | undefined
  private readonly presets: SupervisorPresets | undefined
  private readonly now: () => number
  private readonly convergenceRounds: number
  private readonly writeAttempts: number

  /** Handles this process owns, keyed by run. */
  private readonly handles = new RunHandleTable()

  /** Runs currently being supervised in this process. */
  private readonly active = new Map<RunId, RunObservation>()

  /** Settlement promise per in-flight run. */
  private readonly settlements = new Map<RunId, Promise<RunSettlement>>()

  private closing = false
  private closingPromise: Promise<void> | undefined

  /**
   * @param options - explicit dependencies and tuning.
   */
  constructor(options: RunSupervisorOptions) {
    this.ctx = options.ctx
    this.store = options.store
    this.sessions = options.sessions
    this.liveSessions = options.liveSessions
    this.agents = options.agents
    this.workspaces = options.workspaces
    this.workspaceSource = options.workspaceSource
    this.presets = options.presets
    this.now = options.now ?? (() => Date.now())
    this.convergenceRounds = options.convergenceRounds ?? 8
    this.writeAttempts = options.writeAttempts ?? 3
  }

  /** Handles this process currently owns. */
  get ownedHandles(): RunHandleTable {
    return this.handles
  }

  /**
   * Classify this process's ownership of one run.
   * @param runId - run identity.
   * @returns `owned` when a live handle is held, `observed` otherwise.
   */
  ownershipOf(runId: RunId): RunOwnership {
    return this.handles.ownership(runId)
  }

  /**
   * Supervise one run attempt from session creation to disposal.
   *
   * Failures before the prompt is submitted reject: nothing durable was
   * claimed yet, so the caller (the scheduler) rolls the attempt back. Once the
   * prompt is submitted every failure is committed as a terminal run state and
   * returned as a settlement; it is never thrown and never replayed.
   * @param request - the run attempt to supervise.
   * @returns the settlement the run reached.
   * @throws OrchestratorError when the supervisor is closing, the run is
   * already supervised, the run is unknown or in a state that cannot start.
   */
  async start(request: RunStartRequest): Promise<RunSettlement> {
    if (this.closing) {
      throw new OrchestratorError('closed', 'the run supervisor is closing')
    }
    const { run, operationId } = request
    if (this.active.has(run.id)) {
      throw new OrchestratorError('already-exists', `run '${run.id}' is already supervised`)
    }
    const stored = this.store.getRun(run.id)
    if (stored === undefined) {
      throw new OrchestratorError('not-found', `run '${run.id}' is not stored`)
    }
    if (TERMINAL_RUN_STATES.has(stored.state)) {
      return storedSettlement(stored)
    }
    if (stored.state === 'ready') {
      throw new OrchestratorError(
        'invalid-transition',
        `run '${run.id}' is 'ready'; a start must claim it first`,
      )
    }
    const operation = this.store.getOperation(operationId)
    if (operation === undefined) {
      throw new OrchestratorError('not-found', `operation '${operationId}' is not stored`)
    }
    if (operation.phase === 'settled') {
      return storedSettlement(stored)
    }
    if (operation.phase === 'submitted' || operation.phase === 'claimed' || operation.phase === 'uncertain') {
      return await this.markUncertain(stored, operation)
    }

    const sessionId = sessionIdFor(stored)
    if (operation.phase === 'session-created' && this.liveSessions.get(sessionId) !== undefined) {
      return await this.markUncertain(stored, operation)
    }

    const opened = await this.openObservation(request.task, stored, operation, sessionId)
    const settlement = this.executeOpened(request, stored, operation, opened, 'throw')
    this.settlements.set(run.id, settlement)
    try {
      return await settlement
    } finally {
      this.settlements.delete(run.id)
    }
  }

  /**
   * Start one scheduler-claimed run and return as soon as its Session exists.
   *
   * Unlike {@link start}, this method does not await the run's settlement: the
   * scheduler needs the Session identity to commit `starting → running`, while
   * the agent continues in the background. Only an operation still at
   * `planned` may be launched; a session-created, submitted, claimed or
   * uncertain operation is refused rather than resumed or replayed.
   *
   * A failure after Session creation but before prompt submission cannot be
   * rolled back to `ready` by the scheduler, because the Session already exists.
   * It is committed as `needs-attention: restart-uncertain` instead, so a
   * restart reconciles the evidence and never submits a second prompt.
   * @param request - the starting run attempt.
   * @returns the held Session identity plus the eventual settlement.
   * @throws OrchestratorError when closing, already supervised, unknown, not
   * claimed by the scheduler, or past the `planned` operation phase; agent
   * creation failures propagate so the scheduler can roll the attempt back.
   */
  async launch(request: RunStartRequest): Promise<RunLaunchStart> {
    if (this.closing) {
      throw new OrchestratorError('closed', 'the run supervisor is closing')
    }
    const { run, operationId } = request
    if (this.active.has(run.id)) {
      throw new OrchestratorError('already-exists', `run '${run.id}' is already supervised`)
    }
    const stored = this.store.getRun(run.id)
    if (stored === undefined) {
      throw new OrchestratorError('not-found', `run '${run.id}' is not stored`)
    }
    if (TERMINAL_RUN_STATES.has(stored.state)) {
      throw new OrchestratorError(
        'invalid-transition',
        `run '${run.id}' is '${stored.state}'; a launch cannot reopen it`,
      )
    }
    if (stored.state !== 'starting') {
      throw new OrchestratorError(
        'invalid-transition',
        `run '${run.id}' is '${stored.state}'; a launch requires the scheduler's starting claim`,
      )
    }
    const operation = this.store.getOperation(operationId)
    if (operation === undefined) {
      throw new OrchestratorError('not-found', `operation '${operationId}' is not stored`)
    }
    if (operation.phase !== 'planned') {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${operationId}' is '${operation.phase}'; a launch never replays past planned`,
      )
    }

    const sessionId = sessionIdFor(stored)
    if (this.liveSessions.get(sessionId) !== undefined) {
      throw new OrchestratorError(
        'invalid-transition',
        `session '${sessionId}' is already live; a launch cannot create a second owner`,
      )
    }

    const opened = await this.openObservation(request.task, stored, operation, sessionId)
    const settlement = this.executeOpened(request, stored, operation, opened, 'settle')
    this.settlements.set(run.id, settlement)
    void settlement.then(
      () => this.settlements.delete(run.id),
      () => this.settlements.delete(run.id),
    )
    return {
      runId: run.id,
      sessionId: opened.observation.sessionId,
      settlement,
    }
  }

  /**
   * Re-hold one run whose session already exists and continue its supervision.
   *
   * Recovery calls this only after it decided from the durable log that the
   * session is this operation's and that resuming is safe. The method resolves
   * as soon as the handle is held; the returned `settlement` resolves when the
   * run reaches its boundary. Nothing is resubmitted unless `submitPrompt` is
   * true and the replayed log still holds no run-owned message.
   * @param request - the session, operation and durable progress to adopt.
   * @returns the held handle's run/session identities plus its settlement.
   * @throws OrchestratorError when closing, already supervised, unknown or
   * terminal; agent resume failures (including writer-held) propagate unchanged.
   */
  async resume(request: RunResumeRequest): Promise<RunResumeStart> {
    if (this.closing) {
      throw new OrchestratorError('closed', 'the run supervisor is closing')
    }
    const { run, operationId, sessionId, progress } = request
    if (this.active.has(run.id)) {
      throw new OrchestratorError('already-exists', `run '${run.id}' is already supervised`)
    }
    const stored = this.store.getRun(run.id)
    if (stored === undefined) {
      throw new OrchestratorError('not-found', `run '${run.id}' is not stored`)
    }
    if (TERMINAL_RUN_STATES.has(stored.state) || stored.state === 'ready') {
      throw new OrchestratorError(
        'invalid-transition',
        `run '${run.id}' is '${stored.state}'; it cannot be resumed`,
      )
    }
    const operation = this.store.getOperation(operationId)
    if (operation === undefined) {
      throw new OrchestratorError('not-found', `operation '${operationId}' is not stored`)
    }
    if (operation.phase === 'settled') {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${operationId}' is already settled`,
      )
    }
    if (this.agents.resume === undefined) {
      throw new OrchestratorError(
        'unsupported',
        'the agent registry does not expose resume(); recovery cannot re-hold the handle',
      )
    }

    const workspace = this.resolveWorkspace(request.task)
    // A resumed conversation keeps the route a completed boundary froze. Only a
    // run without that snapshot may resolve the task/pipeline policy, and even
    // then the route is fixed before the handle is re-held.
    const model = run.configSnapshot === undefined
      ? resolveTaskModel(request.task, this.store.getQueue?.(request.task.queueId))
      : frozenModelOf(run.configSnapshot)
    const agentOptions: AgentOptions = {}
    if (model.kind === 'fixed') {
      agentOptions.provider = model.provider
      agentOptions.model = model.model
      if (model.reasoningEffort !== undefined) {
        agentOptions.reasoningEffort = ReasoningEffortId(model.reasoningEffort)
      }
    }

    // Buffer every event for this session while resume opens and repairs the
    // log. Recovery observed no live writer, so nothing can append between its
    // durable read and this subscription; from here on nothing is missed.
    const buffered: SessionEvent[] = []
    let observation: RunObservation | undefined
    const unsubscribe = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (session.id !== sessionId) return
      if (observation === undefined) {
        buffered.push(event)
        return
      }
      this.onSessionEvent(observation, event)
    })

    let created: AgentHandle
    const presetId = request.task.preset.kind === 'fixed' ? request.task.preset.id : undefined
    const presets = this.presets
    try {
      if (presetId !== undefined && presets !== undefined) await presets.resolve(presetId)
      created = await this.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        ...(presetId !== undefined && presets !== undefined
          ? {
            setup: async (agentCtx: Context): Promise<void> => {
              await presets.mount(agentCtx, presetId)
            },
          }
          : {}),
      })
    } catch (error) {
      unsubscribe()
      throw error
    }

    const entry: RunHandle = {
      runId: run.id,
      sessionId,
      operationId: operation.id,
      handle: created,
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        await disposeEntry(entry)
        unsubscribe()
        throw new OrchestratorError(
          'invalid-transition',
          `session '${sessionId}' could not join workspace '${request.task.workspaceId}'`,
          { cause: error },
        )
      }
    }
    this.handles.hold(entry)

    observation = seedObservation(stored, operation, created.agent, progress)
    for (const event of buffered) {
      if (event.seq > observation.lastSeq) this.onSessionEvent(observation, event)
    }
    buffered.length = 0
    this.active.set(run.id, observation)

    const settlement = this.executeResumed(observation, request.task, operation, request.submitPrompt, unsubscribe)
    this.settlements.set(run.id, settlement)
    void settlement.finally(() => this.settlements.delete(run.id))
    return { runId: run.id, sessionId, settlement }
  }

  /**
   * Await the settlement of one in-flight run.
   * @param runId - run identity.
   * @returns the settlement, or `undefined` when the run is not in flight here.
   */
  async whenSettled(runId: RunId): Promise<RunSettlement | undefined> {
    return await this.settlements.get(runId)
  }

  /**
   * Cancel one in-flight run without discarding unrelated pending input.
   * @param runId - run identity.
   * @returns whether a live run was cancelled.
   */
  cancel(runId: RunId): boolean {
    const observation = this.active.get(runId)
    if (observation === undefined) return false
    observation.cancelled = true
    observation.agent.cancel({ kind: 'user' })
    return true
  }

  /**
   * Stop accepting new runs and await every in-flight settlement, then dispose
   * any handle that a crashed settlement left behind.
   *
   * Running model work is not force-killed: an in-flight run settles through
   * its own boundary, and only its own terminal transition disposes the handle.
   * @returns resolution after this supervisor owns no live run.
   */
  async close(): Promise<void> {
    if (this.closingPromise !== undefined) return await this.closingPromise
    this.closing = true
    this.closingPromise = (async () => {
      await Promise.allSettled([...this.settlements.values()])
      for (const entry of this.handles.list()) {
        const taken = this.handles.take(entry.runId)
        if (taken !== undefined) await disposeEntry(taken)
      }
    })()
    return await this.closingPromise
  }

  /**
   * Resolve the task's real Workspace before a Session is created.
   *
   * When the registry is mounted, a stale or hand-typed workspace id is a hard
   * pre-submission failure: creating a Session outside every Workspace is the
   * exact behavior this gate exists to prevent. A composition without the
   * registry keeps the legacy cwd-only path for tests and headless hosts. The
   * registry is read through {@link currentWorkspaces} rather than a value
   * captured at composition, because a live host may mount it later.
   * @param task - task whose workspace must be resolved.
   * @returns the Workspace, or undefined when no registry is mounted.
   * @throws OrchestratorError when the registry is mounted and the id is unknown.
   */
  private resolveWorkspace(task: RunStartRequest['task']): SupervisorWorkspace | undefined {
    if (task.prompt.trim() === '') {
      throw new OrchestratorError(
        'invalid-transition',
        `task '${task.id}' has no prompt; refusing to create an empty session`,
      )
    }
    const workspaces = this.currentWorkspaces()
    if (workspaces === undefined) return undefined
    const workspace = workspaces.get(task.workspaceId)
    if (workspace === undefined) {
      throw new OrchestratorError(
        'not-found',
        `workspace '${task.workspaceId}' is not registered; refusing to create an unowned session`,
      )
    }
    return workspace
  }

  /**
   * Read the Workspace registry a launch must validate against.
   *
   * A source is preferred over the static composition value: Cordis starts
   * profile entries concurrently, so the registry may be published after this
   * supervisor was built. Re-reading it per attempt means the very first task
   * launched after startup still joins the Workspace the user selected.
   * @returns the registry as it exists now, or undefined when none is mounted.
   */
  private currentWorkspaces(): SupervisorWorkspaces | undefined {
    return this.workspaceSource === undefined ? this.workspaces : this.workspaceSource()
  }

  /**
   * Create the agent and install its observation without submitting anything.
   * @param task - the task whose model/preset select the agent.
   * @param run - the stored run, the durable authority for this attempt.
   * @param operation - the stored operation at `planned` or `session-created`.
   * @param sessionId - the session this attempt drives.
   * @returns the agent observation plus listener teardowns.
   */
  private async openObservation(
    task: RunStartRequest['task'],
    run: RunRecord,
    operation: OperationRecord,
    sessionId: SessionId,
  ): Promise<OpenedRun> {
    const workspace = this.resolveWorkspace(task)
    const model = resolveTaskModel(task, this.store.getQueue?.(task.queueId))
    const agentOptions: AgentOptions = {}
    if (model.kind === 'fixed') {
      agentOptions.provider = model.provider
      agentOptions.model = model.model
      if (model.reasoningEffort !== undefined) {
        agentOptions.reasoningEffort = ReasoningEffortId(model.reasoningEffort)
      }
    }
    const presetId = task.preset.kind === 'fixed' ? task.preset.id : undefined
    const presets = this.presets
    if (presetId !== undefined && presets !== undefined) await presets.resolve(presetId)
    const setup = presetId !== undefined && presets !== undefined
      ? async (agentCtx: Context): Promise<void> => { await presets.mount(agentCtx, presetId) }
      : undefined

    // A failure here leaves no handle behind; the caller still owns rollback.
    const created = await this.agents.create({
      sessionId,
      meta: {
        cwd: workspace?.path ?? task.cwd,
        ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      },
      agentOptions,
      ...(setup === undefined ? {} : { setup }),
    })

    const staged: RunHandle = {
      runId: run.id,
      sessionId,
      operationId: operation.id,
      handle: created,
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(created.agent.session.id)
      } catch (error) {
        await disposeEntry(staged)
        throw new OrchestratorError(
          'invalid-transition',
          `session '${created.agent.session.id}' could not join workspace '${task.workspaceId}'`,
          { cause: error },
        )
      }
    }

    const entry: RunHandle = staged
    this.handles.hold(entry)

    const agent = created.agent
    const observation: RunObservation = {
      runId: run.id,
      operationId: operation.id,
      sessionId: agent.session.id,
      agent,
      accepted: [],
      endedTurns: new Map(),
      runTurns: new Set(),
      runOwnedMessages: new Set(),
      pendingApprovals: new Map(),
      messageId: undefined,
      claimedTurn: undefined,
      openTurn: undefined,
      lastSeq: -1,
      duplicates: 0,
      externalInput: false,
      cancelled: false,
      configSnapshot: undefined,
    }
    this.active.set(run.id, observation)

    const unwinds: Array<() => void> = [
      this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (session.id !== observation.sessionId) return
        this.onSessionEvent(observation, event)
      }),
    ]
    return { observation, unwinds }
  }

  /**
   * Run the full lifecycle for one already-opened attempt.
   * @param request - the run attempt.
   * @param run - the stored run, the durable authority for this attempt.
   * @param operation - the stored operation at `planned` or `session-created`.
   * @param opened - the created agent and listener teardowns.
   * @param preSubmissionFailure - throw for `start()`, settle for `launch()`.
   * @returns the settlement the run reached.
   */
  private async executeOpened(
    request: RunStartRequest,
    run: RunRecord,
    operation: OperationRecord,
    opened: OpenedRun,
    preSubmissionFailure: 'throw' | 'settle',
  ): Promise<RunSettlement> {
    const { task } = request
    const { observation, unwinds } = opened
    const agent = observation.agent

    let submitted = false
    let settlement: RunSettlement
    try {
      await this.recordSessionCreated(operation, observation.sessionId)

      const source: SessionOrchestratorMessageSource = {
        kind: 'session-orchestrator',
        operationId: operation.id,
        runId: run.id,
        generation: run.generation,
        attempt: run.attempt,
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: task.prompt }],
        source,
      })
      observation.messageId = message.id

      // Persist the durable intent (target session plus message identity) before
      // the prompt can reach the agent: after this point the operation record is
      // the restart link, whatever happens to the live process.
      await this.recordSubmittedIntent(operation.id, message.id)

      agent.followup(message)
      submitted = true

      await this.recordOperationSubmitted(operation.id, message.id)
      await this.recordRunProgress(observation, (current) => ({
        ...current,
        ...(message.id !== undefined ? { submittedMessageId: message.id } : {}),
      }))

      settlement = await this.supervise(observation, task)
    } catch (error) {
      if (!submitted) {
        // Nothing was submitted. Release the created handle; `start()` may still
        // roll the attempt back, while `launch()` must commit the durable outcome
        // because the scheduler has already been told the Session exists.
        const disposeError = await this.releaseHandle(observation)
        if (preSubmissionFailure === 'throw') throw error
        settlement = await this.settlePreSubmissionFailure(observation, error, disposeError)
      } else {
        settlement = await this.settleInternalFailure(observation, error)
      }
    } finally {
      for (const unwind of unwinds) unwind()
      this.active.delete(run.id)
    }

    if (settlement.state === 'needs-attention') {
      // A human boundary or a failed durability checkpoint keeps the live agent:
      // disposing it would drop pending input or an open approval, and the run
      // may be resumed or inspected by the next block. `close()` owns teardown.
      return settlement
    }
    const disposeError = await this.releaseHandle(observation)
    return disposeError === undefined ? settlement : { ...settlement, disposeError }
  }

  /**
   * Commit the only safe outcome for a launched Session whose prompt never
   * reached the agent: the Session exists, so the attempt cannot return to
   * `ready` and must never be submitted again by this process.
   * @param observation - the run observation whose handle was released.
   * @param error - the pre-submission failure.
   * @param disposeError - handle-release error, when releasing also failed.
   * @returns a `needs-attention` settlement.
   */
  private async settlePreSubmissionFailure(
    observation: RunObservation,
    error: unknown,
    disposeError: string | undefined,
  ): Promise<RunSettlement> {
    const detail = error instanceof Error ? error.message : String(error)
    const current = this.store.getRun(observation.runId)
    if (current === undefined) {
      return {
        runId: observation.runId,
        state: 'needs-attention',
        reason: 'restart-uncertain',
        committed: false,
        sessionId: observation.sessionId,
        acceptedTurnEndSeq: undefined,
        turns: observation.accepted.length,
        duplicates: observation.duplicates,
        flushParticipated: false,
        disposeError,
        detail,
      }
    }
    try {
      const settled = await this.settleStored(current, 'needs-attention', 'restart-uncertain')
      return { ...settled, sessionId: observation.sessionId, disposeError, detail }
    } catch (settleError) {
      const suffix = settleError instanceof Error ? settleError.message : String(settleError)
      return {
        runId: observation.runId,
        state: 'needs-attention',
        reason: 'restart-uncertain',
        committed: false,
        sessionId: observation.sessionId,
        acceptedTurnEndSeq: undefined,
        turns: observation.accepted.length,
        duplicates: observation.duplicates,
        flushParticipated: false,
        disposeError,
        detail: `${detail}; durable settlement also failed: ${suffix}`,
      }
    }
  }

  /**
   * Continue a resumed run from its replayed durable progress.
   *
   * A resumed run never rejects its settlement: a failure after the handle is
   * re-held becomes `needs-attention: restart-uncertain`, because recovery must
   * not guess whether re-submitting would duplicate work. Only a failure before
   * any new submission releases the handle and still reports the same boundary.
   * @param observation - observation seeded with durable progress.
   * @param task - task definition the run belongs to.
   * @param operation - operation this session carries.
   * @param submitPrompt - whether recovery allows one submission.
   * @param unsubscribe - removes the buffering Session listener.
   * @returns the settlement the resumed run reached.
   */
  private async executeResumed(
    observation: RunObservation,
    task: TaskSpec,
    operation: OperationRecord,
    submitPrompt: boolean,
    unsubscribe: () => void,
  ): Promise<RunSettlement> {
    let canSubmit = submitPrompt
      && observation.runOwnedMessages.size === 0
      && observation.messageId === undefined
      && operation.messageId === undefined
      && operation.phase !== 'submitted'
      && operation.phase !== 'claimed'
      && operation.phase !== 'uncertain'
    let submitted = false
    let settlement: RunSettlement
    try {
      if (canSubmit) {
        await this.recordSessionCreated(operation, observation.sessionId)
        const source: SessionOrchestratorMessageSource = {
          kind: 'session-orchestrator',
          operationId: operation.id,
          runId: observation.runId,
          generation: operation.generation,
          attempt: operation.attempt,
        }
        const message = createUserMessage({
          content: [{ type: 'text', text: task.prompt }],
          source,
        })
        observation.messageId = message.id
        await this.recordSubmittedIntent(operation.id, message.id)
        observation.agent.followup(message)
        submitted = true
        await this.recordOperationSubmitted(operation.id, message.id)
        await this.recordRunProgress(observation, current => ({
          ...current,
          submittedMessageId: message.id,
        }))
      } else {
        // The log is the authority: adopt its message identity instead of
        // resubmitting, and repair the operation phase the crash left behind.
        const messageId = observation.messageId
        if (messageId !== undefined) {
          if (operation.phase === 'planned') {
            await this.recordSessionCreated(operation, observation.sessionId)
          }
          const current = this.store.getOperation(operation.id)
          if (current?.phase === 'session-created' && current.messageId === undefined) {
            await this.recordSubmittedIntent(operation.id, messageId)
            await this.recordOperationSubmitted(operation.id, messageId)
          }
          await this.recordRunProgress(observation, record => ({
            ...record,
            submittedMessageId: messageId,
            ...(observation.claimedTurn !== undefined
              ? { claimedTurn: observation.claimedTurn }
              : {}),
          }))
        }
        canSubmit = false
      }
      settlement = await this.supervise(observation, task)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!submitted) {
        const released = await this.releaseHandle(observation)
        const current = this.store.getRun(observation.runId)
        settlement = current === undefined
          ? {
              runId: observation.runId,
              state: 'needs-attention',
              reason: 'restart-uncertain',
              committed: false,
              sessionId: observation.sessionId,
              acceptedTurnEndSeq: undefined,
              turns: observation.accepted.length,
              duplicates: observation.duplicates,
              flushParticipated: false,
              disposeError: released,
              detail,
            }
          : await this.settleStored(current, 'needs-attention', 'restart-uncertain')
        if (released !== undefined && settlement.disposeError === undefined) {
          settlement = { ...settlement, disposeError: released, detail }
        }
      } else {
        settlement = await this.settle(observation, 'needs-attention', 'restart-uncertain', detail)
      }
    } finally {
      unsubscribe()
      this.active.delete(observation.runId)
    }

    if (settlement.state === 'needs-attention') return settlement
    const disposeError = await this.releaseHandle(observation)
    return disposeError === undefined ? settlement : { ...settlement, disposeError }
  }

  /**
   * Wait for every run-owned turn, re-converging after each wait, then decide
   * the settlement from durable turn reasons and the durability checkpoint.
   * @param observation - live observation state.
   * @param task - task definition the run belongs to.
   * @returns the settlement the run reached.
   */
  private async supervise(observation: RunObservation, task: TaskSpec): Promise<RunSettlement> {
    const agent = observation.agent
    let rounds = 0
    for (;;) {
      // A resolved idle is not completion: always wait again before deciding.
      await agent.whenIdle()
      if (observation.cancelled) {
        return await this.settle(observation, 'cancelled', 'cancelled', undefined)
      }
      if (rounds >= this.convergenceRounds) {
        return await this.settle(observation, 'needs-attention', 'queued-work', undefined)
      }
      rounds += 1
      const probe = await this.probe(observation)
      if (probe === undefined) continue
      if (probe.externalInput) {
        // Never cancel the human's input and never auto-advance past it.
        return await this.settle(observation, 'needs-attention', 'external-input', undefined)
      }
      if (probe.awaitingApproval) {
        return await this.settle(observation, 'needs-attention', 'awaiting-approval', undefined)
      }
      if (probe.openTurn !== undefined) continue
      if (probe.pendingRunWork > 0) continue
      if (observation.accepted.length === 0) {
        return await this.settle(observation, 'failed', 'turn-missing', undefined)
      }
      break
    }

    if (observation.cancelled) {
      return await this.settle(observation, 'cancelled', 'cancelled', undefined)
    }
    const failed = observation.accepted.find(entry => entry.reason.kind !== 'completed')
    if (failed !== undefined) {
      const reason = turnFailureReason(failed.reason)
      const detail = failed.reason.kind === 'error'
        ? `${failed.reason.error.code}: ${failed.reason.error.message}`
        : failed.reason.kind
      return await this.settle(observation, 'failed', reason, detail)
    }

    await this.recordClaimed(observation)
    observation.configSnapshot = this.captureConfigSnapshot(observation, task)

    let flushParticipated = false
    try {
      flushParticipated = await this.sessions.flush(agent.session)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return await this.settle(observation, 'needs-attention', 'flush-failed', detail)
    }

    const last = observation.accepted[observation.accepted.length - 1]
    if (last === undefined) {
      return await this.settle(observation, 'failed', 'turn-missing', undefined)
    }
    return await this.settle(observation, 'succeeded', 'completed', undefined, flushParticipated)
  }

  /**
   * Probe the agent's quiescent state from its true idle phase.
   * @param observation - live observation state.
   * @returns what the probe observed, or `undefined` when another maintenance
   * task owns the agent and the caller must wait again.
   */
  private async probe(observation: RunObservation): Promise<RunProbe | undefined> {
    try {
      return await observation.agent.runMaintenance(async (signal) => {
        if (signal.aborted) {
          throw new OrchestratorError('closed', 'the run supervisor is closing')
        }
        const inbox = observation.agent.inbox
        const pending: readonly UserMessage[] = [...inbox.nextTurn, ...inbox.nextStep]
        return {
          pendingRunWork: pending.filter(message => isRunOwned(message, observation.operationId)).length,
          externalInput: observation.externalInput
            || pending.some(message => message.source.kind === 'user'),
          awaitingApproval: observation.pendingApprovals.size > 0,
          openTurn: observation.openTurn,
        }
      })
    } catch {
      // The probe only rejects when turn-driving or another maintenance task
      // owns the agent, or when the agent was cancelled mid-probe; either way
      // the caller waits again rather than stamping completion.
      return undefined
    }
  }

  /**
   * Record one durable Session event for this run.
   * @param observation - live observation state.
   * @param event - the committed event, delivered post-commit.
   * @returns nothing.
   */
  private onSessionEvent(observation: RunObservation, event: SessionEvent): void {
    const seq = event.seq
    if (seq <= observation.lastSeq) {
      observation.duplicates += 1
      return
    }
    observation.lastSeq = seq
    switch (event.type) {
      case 'turn/start': {
        observation.openTurn = event.data.turn
        return
      }
      case 'turn/end': {
        this.onTurnEnd(observation, event.data.turn, event.data.reason, seq)
        return
      }
      case 'user/message': {
        this.onUserMessage(observation, event.data, seq)
        return
      }
      case 'approval/asked': {
        observation.pendingApprovals.set(String(event.data.id), event.data.toolName)
        return
      }
      case 'approval/decided': {
        observation.pendingApprovals.delete(String(event.data.id))
        return
      }
      default:
        return
    }
  }

  /**
   * Link one durable `user/message` to its claiming turn.
   * @param observation - live observation state.
   * @param message - the message that entered the surface.
   * @param seq - its durable sequence number.
   * @returns nothing.
   */
  private onUserMessage(observation: RunObservation, message: UserMessage, seq: number): void {
    void seq
    if (isRunOwned(message, observation.operationId)) {
      observation.runOwnedMessages.add(message.id)
      if (observation.openTurn !== undefined) observation.runTurns.add(observation.openTurn)
      if (message.id === observation.messageId) {
        observation.claimedTurn = observation.openTurn
      }
      return
    }
    if (message.source.kind === 'user') {
      // A human message arrived while this run holds the session: the run stops
      // at a human boundary; the input itself is never cancelled or consumed.
      observation.externalInput = true
    }
  }

  /**
   * Accept one durable `turn/end`, deduplicating repeated emissions.
   * @param observation - live observation state.
   * @param turn - the turn that closed.
   * @param reason - why it closed.
   * @param seq - its durable sequence number.
   * @returns nothing.
   */
  private onTurnEnd(
    observation: RunObservation,
    turn: number,
    reason: TurnEndReason,
    seq: number,
  ): void {
    if (observation.endedTurns.has(turn)) {
      observation.duplicates += 1
      return
    }
    observation.endedTurns.set(turn, seq)
    if (observation.openTurn === turn) observation.openTurn = undefined
    if (!observation.runTurns.has(turn)) return
    observation.accepted.push({ turn, seq, reason })
  }

  /**
   * Durably record the session created for this attempt.
   * @param operation - the stored operation at `planned` or `session-created`.
   * @param sessionId - the created session.
   * @returns resolution after the phase is durable.
   */
  private async recordSessionCreated(
    operation: OperationRecord,
    sessionId: SessionId,
  ): Promise<void> {
    const current = this.store.getOperation(operation.id)
    if (current === undefined) {
      throw new OrchestratorError('not-found', `operation '${operation.id}' disappeared`)
    }
    if (current.phase === 'planned') {
      await this.store.advanceOperation(current.id, 'planned', {
        ...current,
        phase: 'session-created',
        targetSessionId: sessionId,
        updatedAt: this.now(),
      })
      return
    }
    if (current.phase !== 'session-created') {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${current.id}' is in phase '${current.phase}', not 'planned'`,
      )
    }
    if (current.targetSessionId !== sessionId) {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${current.id}' targets session '${current.targetSessionId}'`,
      )
    }
  }

  /**
   * Durably record the submitted message identity before the agent can see it.
   * @param operationId - operation identity.
   * @param messageId - identity of the prompt that will be submitted.
   * @returns resolution after the message identity is durable.
   */
  private async recordSubmittedIntent(operationId: OperationId, messageId: MessageId): Promise<void> {
    const current = this.store.getOperation(operationId)
    if (current === undefined) {
      throw new OrchestratorError('not-found', `operation '${operationId}' disappeared`)
    }
    if (current.phase !== 'session-created') {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${operationId}' is in phase '${current.phase}', not 'session-created'`,
      )
    }
    await this.store.advanceOperation(operationId, 'session-created', {
      ...current,
      messageId,
      updatedAt: this.now(),
    })
  }

  /**
   * Advance the operation after `followup()` returned.
   * @param operationId - operation identity.
   * @param messageId - identity of the submitted prompt.
   * @returns resolution after the phase is durable.
   */
  private async recordOperationSubmitted(
    operationId: OperationId,
    messageId: MessageId,
  ): Promise<void> {
    const current = this.store.getOperation(operationId)
    if (current === undefined) {
      throw new OrchestratorError('not-found', `operation '${operationId}' disappeared`)
    }
    if (current.phase === 'submitted') return
    if (current.phase !== 'session-created') {
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${operationId}' is in phase '${current.phase}', not 'session-created'`,
      )
    }
    await this.store.advanceOperation(operationId, 'session-created', {
      ...current,
      phase: 'submitted',
      messageId,
      updatedAt: this.now(),
    })
  }

  /**
   * Advance the operation once the submitted prompt is claimed by a turn.
   * @param observation - live observation state.
   * @returns resolution after the phase is durable.
   */
  private async recordClaimed(observation: RunObservation): Promise<void> {
    const current = this.store.getOperation(observation.operationId)
    if (current === undefined || current.phase !== 'submitted') return
    await this.store.advanceOperation(observation.operationId, 'submitted', {
      ...current,
      phase: 'claimed',
      updatedAt: this.now(),
    })
  }

  /**
   * Mark a run whose operation was already submitted before this process
   * started as `uncertain`, and never replay it.
   * @param run - the stored run.
   * @param operation - the stored operation past submission.
   * @returns the settlement describing the refusal.
   */
  private async markUncertain(run: RunRecord, operation: OperationRecord): Promise<RunSettlement> {
    try {
      await this.store.advanceOperation(operation.id, operation.phase, {
        ...operation,
        phase: 'uncertain',
        updatedAt: this.now(),
      })
    } catch {
      // The phase may have moved while this process was deciding; the durable
      // record already says the work may have reached the agent.
    }
    return await this.settleStored(run, 'needs-attention', 'restart-uncertain')
  }

  /**
   * Convert one unexpected post-submission failure into a durable settlement.
   * @param observation - live observation state.
   * @param error - the failure.
   * @returns the settlement the run reached.
   */
  private async settleInternalFailure(
    observation: RunObservation,
    error: unknown,
  ): Promise<RunSettlement> {
    const detail = error instanceof Error ? error.message : String(error)
    return await this.settle(observation, 'failed', 'turn-unknown', detail)
  }

  /**
   * Commit one terminal run state and describe the settlement.
   * @param observation - live observation state.
   * @param state - settlement state.
   * @param reason - stable settlement reason.
   * @param detail - human-readable failure detail, when one exists.
   * @param flushParticipated - whether a durability listener joined the flush.
   * @returns the settlement the run reached.
   */
  private async settle(
    observation: RunObservation,
    state: RunSettlementState,
    reason: RunSettlementReason,
    detail: string | undefined,
    flushParticipated = false,
  ): Promise<RunSettlement> {
    const accepted = observation.accepted[observation.accepted.length - 1]
    const committed = await this.commitRunState(
      observation.runId,
      state,
      reason,
      detail,
      observation,
    )
    return {
      runId: observation.runId,
      state,
      reason,
      committed,
      sessionId: observation.sessionId,
      acceptedTurnEndSeq: accepted?.seq,
      turns: observation.accepted.length,
      duplicates: observation.duplicates,
      flushParticipated,
      disposeError: undefined,
      detail,
    }
  }

  /**
   * Commit a terminal state for a run that is not observed in this process.
   * @param run - the stored run.
   * @param state - settlement state.
   * @param reason - stable settlement reason.
   * @returns the settlement describing the stored run.
   */
  private async settleStored(
    run: RunRecord,
    state: RunSettlementState,
    reason: RunSettlementReason,
  ): Promise<RunSettlement> {
    const committed = await this.commitRunState(run.id, state, reason, undefined, undefined)
    return {
      runId: run.id,
      state,
      reason,
      committed,
      sessionId: run.activeSessionId,
      acceptedTurnEndSeq: run.acceptedTurnEndSeq,
      turns: run.claimedTurn === undefined ? 0 : 1,
      duplicates: 0,
      flushParticipated: false,
      disposeError: undefined,
      detail: run.lastError?.message,
    }
  }

  /**
   * Write one terminal run state under revision CAS.
   *
   * A run already in a terminal state is left untouched: a duplicate settlement
   * must never overwrite the state that was committed first.
   * @param runId - run identity.
   * @param state - settlement state.
   * @param reason - stable settlement reason.
   * @param detail - failure detail, when one exists.
   * @param observation - live observation state, when this process observed the run.
   * @returns whether this call committed the state.
   */
  private async commitRunState(
    runId: RunId,
    state: RunSettlementState,
    reason: RunSettlementReason,
    detail: string | undefined,
    observation: RunObservation | undefined,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const current = this.store.getRun(runId)
      if (current === undefined) return false
      if (TERMINAL_RUN_STATES.has(current.state)) return false
      const accepted = observation?.accepted[observation.accepted.length - 1]
      const next: RunRecord = {
        ...current,
        state: RUN_STATE_BY_SETTLEMENT[state],
        revision: current.revision + 1,
        updatedAt: this.now(),
        ...(observation !== undefined ? { operationId: observation.operationId } : {}),
        ...(observation?.claimedTurn !== undefined
          ? { claimedTurn: observation.claimedTurn }
          : {}),
        ...(accepted !== undefined ? { acceptedTurnEndSeq: accepted.seq } : {}),
        ...(observation?.configSnapshot !== undefined
          ? { configSnapshot: observation.configSnapshot }
          : {}),
        ...(state === 'failed'
          ? { lastError: { code: reason, message: detail ?? reason, retryable: false } }
          : {}),
      }
      try {
        await this.store.updateRun(current.id, current.revision, next)
        return true
      } catch (error) {
        if (!(error instanceof OrchestratorError) || error.code !== 'revision-conflict') throw error
      }
    }
    return false
  }

  /**
   * Write a non-terminal run checkpoint under revision CAS.
   *
   * A run that is still `starting` is owned by the scheduler's launch CAS, so a
   * progress write is skipped there; a terminal run is never reopened.
   * @param observation - live observation state.
   * @param mutate - builds the replacement record from the current one.
   * @returns resolution after the checkpoint is durable or deliberately skipped.
   */
  private async recordRunProgress(
    observation: RunObservation,
    mutate: (current: RunRecord) => RunRecord,
  ): Promise<void> {
    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const current = this.store.getRun(observation.runId)
      if (current === undefined) return
      if (current.state === 'starting' || TERMINAL_RUN_STATES.has(current.state)) return
      const next: RunRecord = {
        ...mutate(current),
        revision: current.revision + 1,
        updatedAt: this.now(),
      }
      try {
        await this.store.updateRun(current.id, current.revision, next)
        return
      } catch (error) {
        if (!(error instanceof OrchestratorError) || error.code !== 'revision-conflict') throw error
      }
    }
  }

  /**
   * Capture the effective model route this run actually used.
   *
   * The route is read at the success boundary, after the accepted turn closed,
   * so a completed turn's durable request header wins over a runtime fallback.
   * @param observation - live observation state.
   * @param task - task definition the run belongs to.
   * @returns the captured snapshot, or `undefined` when the route is unknown.
   */
  private captureConfigSnapshot(
    observation: RunObservation,
    task: TaskSpec,
  ): NonNullable<RunRecord['configSnapshot']> | undefined {
    const session = observation.agent.session
    const context = session.requestContext()
    if (context === undefined) return undefined
    const presetId = task.preset.kind === 'fixed'
      ? task.preset.id
      : session.header.agentPreset
    if (presetId === undefined) return undefined
    const header = session.requestHeader()
    const reasoningEffort = observation.agent.options.reasoningEffort
    return {
      routeSource: header === undefined ? 'runtime-fallback' : 'completed-turn-header',
      provider: context.provider,
      model: context.model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      preset: { id: presetId },
      capturedAt: this.now(),
    }
  }

  /**
   * Dispose the handle this process owns for one run.
   *
   * Only a held handle can be disposed, so a run this process merely observed is
   * never torn down. The durable Session survives disposal.
   * @param observation - live observation state.
   * @returns the disposal failure message, or `undefined` on success.
   */
  private async releaseHandle(observation: RunObservation): Promise<string | undefined> {
    const entry = this.handles.take(observation.runId)
    if (entry === undefined) return undefined
    try {
      await entry.handle.dispose()
      return undefined
    } catch (error) {
      // Disposal already failed at its own boundary; the run state stays
      // committed and the failure is reported instead of being retried.
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/** The session a new or resumed attempt targets. */
function sessionIdFor(run: RunRecord): SessionId {
  return run.activeSessionId ?? SessionId(`session-${run.id}-${run.generation}`)
}

/**
 * Build the live observation for a resumed run from durable progress.
 *
 * The operation record and the log each carry a prompt identity. The log wins
 * when present; the record is only the intended identity. Neither is used to
 * decide that work was submitted — that decision belongs to recovery's source
 * scan, and the supervisor only accepts turn ends whose message source names
 * this operation.
 * @param run - the durable run being resumed.
 * @param operation - the operation this session carries.
 * @param agent - the resumed agent.
 * @param progress - durable facts already reconstructed.
 * @returns observation seeded at the durable end of the log.
 */
function seedObservation(
  run: RunRecord,
  operation: OperationRecord,
  agent: Agent,
  progress: RunResumeProgress,
): RunObservation {
  const accepted = [...progress.accepted]
  const runTurns = new Set<number>(accepted.map(entry => entry.turn))
  if (progress.openTurn !== undefined) runTurns.add(progress.openTurn)
  const messageId = progress.messageId
    ?? (operation.messageId !== undefined ? MessageId(operation.messageId) : undefined)
  return {
    runId: run.id,
    operationId: operation.id,
    sessionId: agent.session.id,
    agent,
    accepted,
    endedTurns: new Map(progress.endedTurns.map(entry => [entry.turn, entry.seq])),
    runTurns,
    runOwnedMessages: new Set(progress.runOwnedMessages),
    pendingApprovals: new Map(progress.pendingApprovals.map(entry => [entry.id, entry.toolName])),
    messageId,
    claimedTurn: progress.claimedTurn,
    openTurn: progress.openTurn,
    lastSeq: progress.lastSeq,
    duplicates: 0,
    externalInput: progress.externalInput,
    cancelled: false,
    configSnapshot: undefined,
  }
}

/**
 * Describe an already-terminal stored run as a settlement.
 * @param run - the terminal run record.
 * @returns the settlement the stored state describes.
 */
function storedSettlement(run: RunRecord): RunSettlement {
  const state: RunSettlementState = run.state === 'succeeded'
    ? 'succeeded'
    : run.state === 'failed'
      ? 'failed'
      : run.state === 'cancelled'
        ? 'cancelled'
        : 'needs-attention'
  return {
    runId: run.id,
    state,
    reason: state === 'succeeded'
      ? 'completed'
      : state === 'failed'
        ? 'turn-unknown'
        : state === 'cancelled'
          ? 'cancelled'
          : 'already-settled',
    committed: false,
    sessionId: run.activeSessionId,
    acceptedTurnEndSeq: run.acceptedTurnEndSeq,
    turns: run.claimedTurn === undefined ? 0 : 1,
    duplicates: 0,
    flushParticipated: false,
    disposeError: undefined,
    detail: run.lastError?.message,
  }
}

/**
 * Map one durable turn-end reason to the run settlement reason it implies.
 *
 * `TurnEndReasonMap` is merge-extensible, so an unknown kind falls through to
 * `turn-unknown` rather than asserting exhaustiveness.
 * @param reason - the durable turn-end reason.
 * @returns the settlement reason for a failed run.
 */
function turnFailureReason(reason: TurnEndReason): RunSettlementReason {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
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
      return 'turn-unknown'
  }
}

/**
 * Test whether one message was submitted by the given operation.
 * @param message - the message to classify.
 * @param operationId - operation identity to match.
 * @returns whether the message belongs to that operation.
 */
function isRunOwned(message: UserMessage, operationId: OperationId): boolean {
  const source = message.source
  if (source.kind !== 'session-orchestrator') return false
  return source.operationId === operationId
}

/**
 * Dispose one held entry, containing the teardown failure.
 * @param entry - the owned handle to tear down.
 * @returns resolution after disposal settled.
 */
async function disposeEntry(entry: RunHandle): Promise<void> {
  await Promise.allSettled([entry.handle.dispose()])
}
