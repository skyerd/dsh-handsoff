/**
 * Deterministic seams for recovery tests.
 *
 * The doubles cover only the read/write boundaries the recovery manager uses;
 * they never perform model work and never append Session events on their own.
 */
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, Session as SessionClass, SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SchedulerTickResult } from '../src/scheduler.ts'
import { RecoveryManager } from '../src/recovery.ts'
import type {
  DurableSessionHandle,
  DurableSessionReader,
  RecoveryScheduler,
  RecoverySessionDirectory,
  RecoveryStore,
  RecoverySupervisor,
} from '../src/recovery.ts'
import type { RunResumeRequest, RunResumeStart, RunSettlement } from '../src/supervisor.ts'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import type { GlobalSettings, OperationRecord, RunRecord, TaskSpec } from '../src/schema.ts'
import type SessionOrchestrator from '../src/store.ts'
import { initialPromptOperationId, initialPromptRequestHash } from '../src/operation.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { event } from './fake-agent.ts'

/** Fixed clock used by every recovery fixture. */
export const NOW = 10_000

/** Create an error that looks like a persisted-session failure by name. */
export function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** In-memory durable Session log store. */
export class FakeDurableSessions implements DurableSessionReader {
  readonly logs = new Map<SessionId, SessionEvent[]>()
  readonly openFailures = new Map<SessionId, Error>()
  readonly opens: Array<{ id: SessionId; access: 'read' }> = []
  private gate: Promise<void> | undefined
  private gateStarted = false
  private readonly gateWatchers: Array<() => void> = []

  /** Hold the next open until the returned function is called. */
  holdNextOpen(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.gateStarted = false
    return () => {
      this.gate = undefined
      release()
    }
  }

  /** Wait until an open has parked on the gate. */
  async waitForOpenStart(): Promise<void> {
    if (this.gateStarted) return
    await new Promise<void>((resolve) => this.gateWatchers.push(resolve))
  }

  /** Store one session log, replacing any previous value. */
  put(id: SessionId, events: readonly SessionEvent[]): void {
    this.logs.set(id, [...events])
  }

  /** Append one event to a stored log. */
  append(id: SessionId, event: SessionEvent): void {
    const events = this.logs.get(id)
    if (events === undefined) throw new Error(`no log for '${id}'`)
    events.push(event)
  }

  /** Make the next read of one session fail with a named persistence error. */
  failOpen(id: SessionId, error: Error): void {
    this.openFailures.set(id, error)
  }

  async open(id: SessionId, access: 'read'): Promise<DurableSessionHandle> {
    this.opens.push({ id, access })
    const gate = this.gate
    if (gate !== undefined) {
      this.gateStarted = true
      for (const wake of this.gateWatchers.splice(0)) wake()
      await gate
    }
    const failure = this.openFailures.get(id)
    if (failure !== undefined) throw failure
    const events = this.logs.get(id)
    if (events === undefined) {
      throw namedError('SessionPersistenceNotFoundError', `session '${id}' is not stored`)
    }
    return {
      id,
      header: {
        version: SESSION_FORMAT_VERSION,
        id,
        createdAt: NOW,
        isSeeded: false,
      },
      read: async (offset = 0) => ({
        events: events.filter(event => event.seq >= offset),
      }),
      close: async () => {},
    }
  }
}

/** Live-session directory double. */
export class FakeLiveSessions implements RecoverySessionDirectory {
  private readonly live = new Map<SessionId, Session>()

  /** Register one live session. */
  put(session: Session): void {
    this.live.set(session.id, session)
  }

  get(id: SessionId): Session | undefined {
    return this.live.get(id)
  }
}

/** Recovery supervisor double that records every resume request. */
export class FakeRecoverySupervisor implements RecoverySupervisor {
  readonly requests: RunResumeRequest[] = []
  closeCalls = 0
  resumeError: Error | undefined

  async resume(request: RunResumeRequest): Promise<RunResumeStart> {
    if (this.resumeError !== undefined) throw this.resumeError
    this.requests.push(request)
    return {
      runId: request.run.id,
      sessionId: request.sessionId,
      settlement: Promise.resolve(settlementFor(request)),
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

/** Build one fulfilled settlement for a resume request. */
function settlementFor(request: RunResumeRequest): RunSettlement {
  return {
    runId: request.run.id,
    state: 'needs-attention',
    reason: 'restart-uncertain',
    committed: true,
    sessionId: request.sessionId,
    acceptedTurnEndSeq: undefined,
    turns: request.progress.accepted.length,
    duplicates: 0,
    flushParticipated: false,
    disposeError: undefined,
    detail: 'recovery fixture',
  }
}

/** Scheduler double that counts gated ticks and closes. */
export class FakeRecoveryScheduler implements RecoveryScheduler {
  tickCalls = 0
  closeCalls = 0
  snapshotAtClose: number | undefined

  async tick(): Promise<SchedulerTickResult> {
    this.tickCalls += 1
    return { paused: false, started: [], skipped: [] }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.snapshotAtClose = this.tickCalls
  }
}

/** Build one valid task for recovery fixtures. */
export function taskFixture(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Task one',
    prompt: 'do the durable work',
    workspaceId: 'workspace-1',
    cwd: 'C:\\workspace',
    preset: { kind: 'inherit' },
    model: { kind: 'fixed', provider: 'fixture', model: 'fixture-model' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: false,
      ratio: 0.8,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 1,
      maxHandoffTokens: 1_000,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

/** Build one valid run record. */
export function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  const run: RunRecord = {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    attempt: 1,
    state: 'running',
    sessionLineage: [],
    generation: 0,
    workspaceKey: 'workspace-key',
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
  return run
}

/** Build the canonical initial-prompt operation for a run. */
export function operationFixture(
  run: RunRecord,
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  return {
    id: initialPromptOperationId(run),
    runId: run.id,
    generation: run.generation,
    attempt: run.attempt,
    kind: 'initial-prompt',
    phase: 'planned',
    requestHash: initialPromptRequestHash(run),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Settings owned by one host. */
export function settingsFixture(hostInstanceId: string, overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    schemaVersion: 1,
    paused: false,
    maxConcurrentRuns: 1,
    providerQuotas: {},
    hostInstanceId,
    revision: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Derive the session identity a fresh attempt would create. */
export function sessionFixture(run: RunRecord): SessionId {
  return sessionIdOf(`session-${run.id}-${run.generation}`)
}

/** Build the persistent source for one operation. */
export function sourceFor(run: RunRecord, operation: OperationRecord): UserMessage['source'] {
  return {
    kind: 'session-orchestrator',
    operationId: operation.id,
    runId: run.id,
    generation: operation.generation,
    attempt: operation.attempt,
  }
}

/** Build a prompt message naming one operation. */
export function promptMessage(run: RunRecord, operation: OperationRecord, text = 'prompt'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: sourceFor(run, operation),
  })
}

/** Build a message that claims an operation but carries another run identity. */
export function mismatchedMessage(operationId: OperationId): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'wrong run' }],
    source: {
      kind: 'session-orchestrator',
      operationId,
      runId: RunId('run-other'),
      generation: 0,
      attempt: 0,
    },
  })
}

/** Build a human message. */
export function humanPrompt(text = 'human'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Build the sequence of one completed turn carrying a prompt. */
export function completedTurnEvents(
  startSeq: number,
  turn: number,
  message: UserMessage,
): SessionEvent[] {
  return [
    event('turn/start', startSeq, { turn }),
    event('user/message', startSeq + 1, message),
    event('turn/end', startSeq + 2, { turn, reason: { kind: 'completed' } }),
  ]
}

/** One fully seeded recovery fixture. */
export interface RecoveryCase {
  /** Real store harness over the memory domain. */
  readonly h: Harness
  /** Store service. */
  readonly store: SessionOrchestrator
  /** Store seam handed to recovery (a fault wrapper in crash tests). */
  readonly recoveryStore: RecoveryStore
  /** Durable Session logs. */
  readonly durable: FakeDurableSessions
  /** Live Session directory. */
  readonly live: FakeLiveSessions
  /** Supervisor double. */
  readonly supervisor: FakeRecoverySupervisor
  /** Scheduler double. */
  readonly scheduler: FakeRecoveryScheduler
  /** Manager under test. */
  readonly recovery: RecoveryManager
  /** Seeded run. */
  readonly run: RunRecord
  /** Seeded operation, when one exists. */
  readonly operation: OperationRecord | undefined
  /** Seeded session identity. */
  readonly sessionId: SessionId
  /** Close the store and backend. */
  readonly close: () => Promise<void>
}

/** Options for one recovery fixture. */
export interface RecoveryCaseOptions {
  /** Run record to store. */
  readonly run: RunRecord
  /** Operation to store, or `false` for none. */
  readonly operation?: OperationRecord | false
  /** Durable events for the run's session. */
  readonly events?: readonly SessionEvent[]
  /** Explicit durable sessions, for handoff cases with several logs. */
  readonly sessions?: ReadonlyArray<{ readonly id: SessionId; readonly events: readonly SessionEvent[] }>
  /** Record the session as missing instead of seeding it. */
  readonly omitSession?: boolean
  /** Mark the session as writer-held. */
  readonly writerHeld?: boolean
  /** Register the same session as live under another owner. */
  readonly live?: boolean
  /** Replace global settings before recovery. */
  readonly settingsHost?: string
  /** Overall recovery timeout. */
  readonly leaseTtlMs?: number
  /** Clock override. */
  readonly now?: () => number
  /** Domain close step observed by the unload order. */
  readonly closeDomain?: () => Promise<void>
  /** Wrap the real store to inject crash points. */
  readonly wrapStore?: (store: SessionOrchestrator) => RecoveryStore
}

/**
 * Seed one recovery case over the real domain store.
 * @param options - records and durable Session state.
 * @returns the wired fixture.
 */
export async function recoveryCase(options: RecoveryCaseOptions): Promise<RecoveryCase> {
  const h = await harness()
  const task = taskFixture()
  await h.store.createTask(task)
  const operation = options.operation === false
    ? undefined
    : options.operation ?? operationFixture(options.run)
  if (operation !== undefined) await h.store.planOperation(operation)
  await h.store.createRun(options.run)

  const sessionId = options.run.activeSessionId ?? sessionFixture(options.run)
  const durable = new FakeDurableSessions()
  if (options.sessions !== undefined) {
    for (const entry of options.sessions) durable.put(entry.id, entry.events)
  } else if (options.omitSession !== true) {
    durable.put(sessionId, options.events ?? [])
  }
  const live = new FakeLiveSessions()
  if (options.live === true) {
    live.put(SessionClass.create(sessionId))
  }
  if (options.settingsHost !== undefined) {
    const settings = h.store.getSettings()
    await h.store.updateSettings(settings.revision, {
      ...settings,
      hostInstanceId: options.settingsHost,
      revision: settings.revision + 1,
      updatedAt: NOW,
    })
  }

  const supervisor = new FakeRecoverySupervisor()
  if (options.writerHeld === true) {
    // A read handle stays legal while a writer owns the log; only `resume()`
    // must fail with `SessionAlreadyOwnedError`.
    supervisor.resumeError = namedError(
      'SessionAlreadyOwnedError',
      `session '${sessionId}' is held for write elsewhere`,
    )
  }
  const scheduler = new FakeRecoveryScheduler()
  const recoveryStore = options.wrapStore === undefined ? h.store : options.wrapStore(h.store)
  const recovery = new RecoveryManager({
    store: recoveryStore,
    durableSessions: durable,
    sessions: live,
    supervisor,
    scheduler,
    hostInstanceId: 'host-a',
    now: options.now ?? (() => NOW),
    leaseTtlMs: options.leaseTtlMs ?? 1_000,
    ...(options.closeDomain !== undefined ? { closeDomain: options.closeDomain } : {}),
  })
  return {
    h,
    store: h.store,
    recoveryStore,
    durable,
    live,
    supervisor,
    scheduler,
    recovery,
    run: options.run,
    operation,
    sessionId,
    close: h.close,
  }
}

/** Build one running run with its session already adopted. */
export function runningRun(
  sessionId: SessionId,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return runFixture({
    state: 'running',
    activeSessionId: sessionId,
    sessionLineage: [sessionId],
    ...overrides,
  })
}

/** Build one starting run with no session yet. */
export function startingRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return runFixture({
    state: 'starting',
    sessionLineage: [],
    ...overrides,
  })
}

export function failedTurnEvents(
  startSeq: number,
  turn: number,
  message: UserMessage,
): SessionEvent[] {
  return [
    event('turn/start', startSeq, { turn }),
    event('user/message', startSeq + 1, message),
    event('turn/end', startSeq + 2, {
      turn,
      reason: { kind: 'error', error: { code: 'provider-error', message: 'boom' } },
    }),
  ]
}
