/**
 * Run scheduling: global slots, workspace locks, concurrency groups, provider
 * quotas, start rollback and release.
 *
 * The scheduler owns no truth of its own. It reads the durable snapshot, asks
 * the planner what may start, decides whether capacity allows a start, writes
 * the transition, and only then launches. Every reservation is released in a
 * `finally`, so a launcher that rejects cannot leak a slot.
 *
 * Two rules are not negotiable here:
 *
 * - A workspace lock is keyed by the canonical key from
 *   {@link WorkspaceKeyResolver}, never by the raw `cwd` string a task carries.
 *   A task whose key cannot be canonicalized does not start.
 * - A task never starts twice. The durable `starting` transition is the
 *   authoritative claim: a concurrent tick loses the revision CAS and abandons
 *   the start before the launcher is called.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/scheduler
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { RunId } from './brand.ts'
import type { OperationId as OperationIdType, RunId as RunIdType, TaskId } from './brand.ts'
import type { GlobalSettings, OperationRecord, QueueRecord, RunRecord, TaskSpec } from './types.ts'
import { OrchestratorError } from './errors.ts'
import { MAX_CONCURRENT_RUNS } from './limits.ts'
import { initialPromptOperationId, initialPromptRequestHash } from './operation.ts'
import { resolveTaskModel } from './model-route.ts'
import { isActiveRunState, planReadyTasks } from './planner.ts'
import type { HumanSkip, PlannerReady } from './planner.ts'
import type { WorkspaceKeyResolver } from './workspace-key.ts'

/** The durable operations the scheduler needs; the store satisfies this structurally. */
export interface SchedulerStore {
  /**
   * Read every stored task.
   * @returns the current tasks.
   */
  listTasks(): readonly TaskSpec[]
  /**
   * Read every stored queue.
   * @returns the current queues.
   */
  listQueues(): readonly QueueRecord[]
  /**
   * Read every stored run.
   * @returns the current runs.
   */
  listRuns(): readonly RunRecord[]
  /**
   * Read the host-wide settings.
   * @returns the current settings.
   */
  getSettings(): GlobalSettings
  /**
   * Insert one run at revision 0.
   * @param record - The run to store.
   * @returns the stored run.
   */
  createRun(record: RunRecord): Promise<RunRecord>
  /**
   * Replace one run under revision CAS.
   * @param id - Run identity.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement record, whose revision is one past the expected one.
   * @returns the stored run.
   */
  updateRun(id: RunIdType, expectedRevision: number, next: RunRecord): Promise<RunRecord>
  /**
   * Record one operation idempotently by identity.
   * @param record - The operation to record.
   * @returns the stored operation.
   */
  planOperation(record: OperationRecord): Promise<OperationRecord>
  /**
   * Read one stored operation.
   * @param id - Operation identity.
   * @returns the stored operation, or undefined when it does not exist.
   */
  getOperation(id: OperationIdType): OperationRecord | undefined
  /**
   * Advance one operation phase under phase CAS.
   * @param id - Operation identity.
   * @param expectedPhase - Phase the caller last observed.
   * @param next - Replacement record.
   * @returns the stored operation.
   */
  advanceOperation(
    id: OperationIdType,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord>
}

/** One launch request handed to a {@link RunLauncher}. */
export interface RunLauncherRequest {
  /** The run attempt being started. */
  readonly run: RunRecord
  /** The task definition the run belongs to. */
  readonly task: TaskSpec
  /** Canonical workspace lock key the start holds. */
  readonly workspaceKey: string
  /** Provider route key the task pins, or `undefined` when it inherits one. */
  readonly providerKey: string | undefined
  /** Operation identity recorded for this start. */
  readonly operationId: OperationIdType
}

/** What a successful launch produced. */
export interface RunLaunchOutcome {
  /** Session created for the run. */
  readonly activeSessionId: SessionId
  /** Provider route key the session actually runs under, when known. */
  readonly providerKey: string | undefined
}

/** Creates the session a run drives. */
export interface RunLauncher {
  /**
   * Create the session for one run attempt.
   * @param request - The start request.
   * @returns the created session identity.
   */
  launch(request: RunLauncherRequest): Promise<RunLaunchOutcome>
}

/** A launch failure that states whether the start may be retried. */
export class LaunchFailure extends Error {
  /** Whether a later attempt may retry this start. */
  readonly retryable: boolean

  /**
   * @param message - Human-readable failure description.
   * @param retryable - Whether a later attempt may retry this start.
   */
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'LaunchFailure'
    this.retryable = retryable
  }
}

/** Why a ready task was not started in one tick. */
export type SchedulerSkipReason =
  | 'closed'
  | 'global-cap'
  | 'workspace-busy'
  | 'group-busy'
  | 'provider-quota'
  | 'invalid-workspace-key'
  | 'already-in-flight'
  | 'claim-lost'

/** One ready task that a tick left unstarted. */
export interface SchedulerSkip {
  /** Task that was not started. */
  readonly taskId: TaskId
  /** Why it was not started. */
  readonly reason: SchedulerSkipReason
}

/** One start a tick dispatched. */
export interface SchedulerStart {
  /** Run attempt that was started. */
  readonly runId: RunIdType
  /** Task that was started. */
  readonly taskId: TaskId
  /** Canonical workspace lock key the start holds. */
  readonly workspaceKey: string
}

/** One failure observed while settling a start. */
export interface SchedulerFailure {
  /** Run whose settlement failed. */
  readonly runId: RunIdType
  /** Error message recorded for the failure. */
  readonly message: string
}

/** Outcome of one scheduling tick. */
export interface SchedulerTickResult {
  /** Whether the host-wide pause suppressed the tick. */
  readonly paused: boolean
  /** Starts dispatched by this tick. */
  readonly started: readonly SchedulerStart[]
  /** Ready tasks this tick did not start. */
  readonly skipped: readonly SchedulerSkip[]
}

/** Read-only scheduler view for tests and diagnostics. */
export interface SchedulerSnapshot {
  /** Whether the scheduler has stopped accepting starts. */
  readonly closed: boolean
  /** Run identities currently in flight. */
  readonly inFlightRunIds: readonly RunIdType[]
  /** Workspace keys currently locked. */
  readonly lockedWorkspaceKeys: readonly string[]
  /** Concurrency groups currently held. */
  readonly heldConcurrencyGroups: readonly string[]
  /** Settlement failures recorded so far. */
  readonly failures: readonly SchedulerFailure[]
}

/** Everything the scheduler depends on. */
export interface SchedulerOptions {
  /** Durable store. */
  readonly store: SchedulerStore
  /** Creates sessions for started runs. */
  readonly launcher: RunLauncher
  /** Supplies canonical workspace lock keys. */
  readonly workspaceKeys: WorkspaceKeyResolver
  /** Clock for record timestamps; injected so tests are deterministic. */
  readonly now: () => number
  /**
   * Audited human skips, when a skip store exists.
   *
   * Omitted means no task is skipped: a task awaiting attention stays blocked
   * rather than being treated as a model success.
   */
  readonly humanSkips?: () => readonly HumanSkip[]
}

/** One in-flight start and the locks it holds. */
interface Reservation {
  readonly runId: RunIdType
  readonly taskId: TaskId
  readonly workspaceKey: string
  readonly providerKey: string | undefined
  readonly concurrencyGroup: string | undefined
}

/** Slots consumed by durable active runs plus this tick's dispatches. */
interface Usage {
  /** Active runs counted so far. */
  activeRuns: number
  /** Active runs per provider key. */
  readonly providerCounts: Map<string, number>
}

/** Workspace keys and concurrency groups currently locked. */
interface HeldLocks {
  /** Canonical workspace keys held by active runs or this tick's dispatches. */
  readonly workspaceKeys: Set<string>
  /** Concurrency groups held by active runs or this tick's dispatches. */
  readonly concurrencyGroups: Set<string>
}

/**
 * Count the slots and locks durable active runs already hold.
 *
 * Runs this scheduler dispatched are already stored as active, so a snapshot
 * includes them; only starts added later in the same tick are added by hand.
 * @param runs - The stored runs.
 * @returns the active run count and per-provider counts.
 */
function usageOf(runs: readonly RunRecord[]): Usage {
  const providerCounts = new Map<string, number>()
  let activeRuns = 0
  for (const run of runs) {
    if (!isActiveRunState(run.state)) continue
    activeRuns += 1
    if (run.providerKey !== undefined) {
      providerCounts.set(run.providerKey, (providerCounts.get(run.providerKey) ?? 0) + 1)
    }
  }
  return { activeRuns, providerCounts }
}

/**
 * Schedule run starts over a durable snapshot.
 *
 * `tick()` dispatches starts and returns without waiting for the launcher; each
 * dispatched start settles on its own and releases its locks in `finally`.
 * `drain()` waits for every in-flight start. `close()` refuses new starts and
 * lets in-flight ones settle, which is what an unload needs.
 */
export class Scheduler {
  private readonly store: SchedulerStore
  private readonly launcher: RunLauncher
  private readonly workspaceKeys: WorkspaceKeyResolver
  private readonly now: () => number
  private readonly humanSkips: () => readonly HumanSkip[]
  private readonly inFlight = new Map<RunIdType, Reservation>()
  private readonly inFlightTasks = new Set<TaskId>()
  private readonly failures: SchedulerFailure[] = []
  private readonly pending = new Set<Promise<void>>()
  private closed = false

  /**
   * @param options - Store, launcher, key resolver and clock.
   */
  constructor(options: SchedulerOptions) {
    this.store = options.store
    this.launcher = options.launcher
    this.workspaceKeys = options.workspaceKeys
    this.now = options.now
    this.humanSkips = options.humanSkips ?? (() => [])
  }

  /**
   * Plan and dispatch every start that current capacity allows.
   *
   * A host-wide pause or a closed scheduler dispatches nothing. Each start is
   * written as `starting` before the launcher is called, so a restart observes
   * the in-progress attempt instead of losing it.
   * @returns the dispatched starts and the ready tasks left unstarted.
   */
  async tick(): Promise<SchedulerTickResult> {
    if (this.closed) return { paused: false, started: [], skipped: [] }

    const settings = this.store.getSettings()
    if (settings.paused) return { paused: true, started: [], skipped: [] }

    const tasks = this.store.listTasks()
    const tasksById = new Map(tasks.map(task => [task.id, task]))
    const runs = this.store.listRuns()
    const queues = this.store.listQueues()
    const queuesById = new Map(queues.map(queue => [queue.id, queue]))
    const plan = planReadyTasks({
      tasks,
      queues,
      runs,
      skips: this.humanSkips(),
      globalPaused: false,
    })

    const usage = usageOf(runs)
    const held = this.heldLocks(runs, tasksById)
    const started: SchedulerStart[] = []
    const skipped: SchedulerSkip[] = []

    for (const entry of plan.ready) {
      if (this.closed) {
        skipped.push({ taskId: entry.taskId, reason: 'closed' })
        continue
      }
      const task = tasksById.get(entry.taskId)
      if (task === undefined) continue
      // Resolve inheritance once, before the Session exists: a fixed pipeline
      // route becomes this attempt's route, and later draft edits never switch
      // the conversation this launch creates.
      const routed = { ...task, model: resolveTaskModel(task, queuesById.get(task.queueId)) }

      const key = this.workspaceKeys.resolve(routed)
      if (!key.ok) {
        skipped.push({ taskId: entry.taskId, reason: 'invalid-workspace-key' })
        continue
      }

      const blocker = this.capacityBlocker(entry, routed, key.workspaceKey, settings, usage, held)
      if (blocker !== undefined) {
        skipped.push({ taskId: entry.taskId, reason: blocker })
        continue
      }

      const dispatched = await this.dispatch(routed, key.workspaceKey, usage, held)
      if (dispatched === undefined) {
        skipped.push({ taskId: entry.taskId, reason: 'claim-lost' })
        continue
      }
      started.push(dispatched)
    }

    return { paused: false, started, skipped }
  }

  /**
   * Wait for every in-flight start to settle.
   * @returns resolution after all launches settled and released their locks.
   */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
  }

  /**
   * Refuse new starts without cancelling in-flight ones.
   * @returns resolution after every in-flight start settled.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.drain()
  }

  /**
   * Read the current scheduler state.
   * @returns the in-flight runs, held locks and recorded failures.
   */
  snapshot(): SchedulerSnapshot {
    const reservations = [...this.inFlight.values()]
    return {
      closed: this.closed,
      inFlightRunIds: reservations.map(reservation => reservation.runId),
      lockedWorkspaceKeys: reservations.map(reservation => reservation.workspaceKey),
      heldConcurrencyGroups: reservations.flatMap(reservation =>
        reservation.concurrencyGroup === undefined ? [] : [reservation.concurrencyGroup]),
      failures: [...this.failures],
    }
  }

  /**
   * Decide whether capacity allows one start.
   * @param entry - Ready entry.
   * @param task - Task definition.
   * @param workspaceKey - Canonical lock key.
   * @param settings - Current host settings.
   * @param usage - Slot usage accumulated so far.
   * @param held - Workspace keys and concurrency groups currently locked.
   * @returns the skip reason, or `undefined` when the start may proceed.
   */
  private capacityBlocker(
    entry: PlannerReady,
    task: TaskSpec,
    workspaceKey: string,
    settings: GlobalSettings,
    usage: Usage,
    held: HeldLocks,
  ): SchedulerSkipReason | undefined {
    if (this.inFlightTasks.has(entry.taskId)) return 'already-in-flight'
    if (held.workspaceKeys.has(workspaceKey)) return 'workspace-busy'
    const group = task.concurrencyGroup
    if (group !== undefined && held.concurrencyGroups.has(group)) return 'group-busy'
    const providerKey = taskProviderKey(task)
    if (providerKey !== undefined) {
      const quota = settings.providerQuotas[providerKey]
      if (quota !== undefined && (usage.providerCounts.get(providerKey) ?? 0) >= quota) {
        return 'provider-quota'
      }
    }
    // The stored value may lower the deployment's cap but never raise it: eight
    // concurrent runs is the product ceiling and the settings page exposes no
    // control that could change it.
    const limit = Math.min(settings.maxConcurrentRuns, MAX_CONCURRENT_RUNS)
    if (usage.activeRuns >= limit) return 'global-cap'
    return undefined
  }

  /**
   * Persist and dispatch one start.
   * @param task - Task definition.
   * @param workspaceKey - Canonical lock key.
   * @param usage - Slot usage, updated for the dispatched start.
   * @param held - Workspace keys and groups, updated for the dispatched start.
   * @returns the dispatched start, or `undefined` when the claim was lost.
   */
  private async dispatch(
    task: TaskSpec,
    workspaceKey: string,
    usage: Usage,
    held: HeldLocks,
  ): Promise<SchedulerStart | undefined> {
    const providerKey = taskProviderKey(task)
    const run = await this.ensureRun(task, workspaceKey, providerKey)
    if (run.state !== 'ready') return undefined

    const operation = await this.ensureOperation(run)
    const starting = await this.markStarting(run, operation)
    if (starting === undefined) return undefined

    usage.activeRuns += 1
    if (providerKey !== undefined) {
      usage.providerCounts.set(providerKey, (usage.providerCounts.get(providerKey) ?? 0) + 1)
    }
    held.workspaceKeys.add(workspaceKey)
    if (task.concurrencyGroup !== undefined) held.concurrencyGroups.add(task.concurrencyGroup)

    const reservation: Reservation = {
      runId: starting.id,
      taskId: task.id,
      workspaceKey,
      providerKey,
      concurrencyGroup: task.concurrencyGroup,
    }
    this.inFlight.set(reservation.runId, reservation)
    this.inFlightTasks.add(reservation.taskId)

    const settled = this.settle(starting, task, operation, reservation)
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
    return { runId: starting.id, taskId: task.id, workspaceKey }
  }

  /**
   * Collect the workspace keys and concurrency groups durable active runs hold.
   *
   * A run stores its canonical workspace key, so a restart recovers those locks.
   * A concurrency group is derived from the task the active run belongs to,
   * because the group is a task property rather than a run property.
   * @param runs - The stored runs.
   * @param tasksById - Stored tasks by identity.
   * @returns the held locks.
   */
  private heldLocks(
    runs: readonly RunRecord[],
    tasksById: ReadonlyMap<TaskId, TaskSpec>,
  ): HeldLocks {
    const workspaceKeys = new Set<string>()
    const concurrencyGroups = new Set<string>()
    for (const run of runs) {
      if (!isActiveRunState(run.state)) continue
      workspaceKeys.add(run.workspaceKey)
      const group = tasksById.get(run.taskId)?.concurrencyGroup
      if (group !== undefined) concurrencyGroups.add(group)
    }
    return { workspaceKeys, concurrencyGroups }
  }

  /**
   * Read or create the run attempt for a ready task.
   *
   * A task whose latest attempt is `ready` or already active reuses that
   * attempt: only a settled attempt is followed by a new one. Attempt identity
   * is deterministic, so two concurrent ticks create the same record and the
   * store's identity check keeps exactly one of them.
   * @param task - Task definition.
   * @param workspaceKey - Canonical lock key.
   * @param providerKey - Provider route key.
   * @returns the stored run attempt in its current state.
   */
  private async ensureRun(
    task: TaskSpec,
    workspaceKey: string,
    providerKey: string | undefined,
  ): Promise<RunRecord> {
    const latest = this.latestRun(task.id)
    if (latest !== undefined && (latest.state === 'ready' || isActiveRunState(latest.state))) {
      return latest
    }

    const now = this.now()
    const attempt = this.nextAttempt(task.id)
    const record: RunRecord = {
      id: RunId(`run-${task.id}-${attempt}`),
      taskId: task.id,
      attempt,
      state: 'ready',
      sessionLineage: [],
      generation: 0,
      workspaceKey,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      ...(providerKey === undefined ? {} : { providerKey }),
    }
    try {
      return await this.store.createRun(record)
    } catch (error) {
      // A concurrent tick created the same deterministic attempt first.
      const created = this.store.listRuns().find(run => run.id === record.id)
      if (created !== undefined) return created
      throw error
    }
  }

  /**
   * Read the highest-attempt run for a task.
   * @param taskId - Task identity.
   * @returns the latest attempt, or `undefined` before any attempt.
   */
  private latestRun(taskId: TaskId): RunRecord | undefined {
    let latest: RunRecord | undefined
    for (const run of this.store.listRuns()) {
      if (run.taskId !== taskId) continue
      if (latest === undefined || run.attempt > latest.attempt) latest = run
    }
    return latest
  }

  /**
   * Count the next attempt number for a task.
   * @param taskId - Task identity.
   * @returns one past the highest stored attempt, or 1 before any attempt.
   */
  private nextAttempt(taskId: TaskId): number {
    let highest = 0
    for (const run of this.store.listRuns()) {
      if (run.taskId === taskId && run.attempt > highest) highest = run.attempt
    }
    return highest + 1
  }

  /**
   * Read or record the operation for one run attempt.
   * @param run - The run attempt.
   * @returns the stored operation.
   */
  private async ensureOperation(run: RunRecord): Promise<OperationRecord> {
    const now = this.now()
    return await this.store.planOperation({
      id: initialPromptOperationId(run),
      runId: run.id,
      generation: run.generation,
      attempt: run.attempt,
      kind: 'initial-prompt',
      phase: 'planned',
      requestHash: initialPromptRequestHash(run),
      createdAt: now,
      updatedAt: now,
    })
  }

  /**
   * Claim one run attempt by moving it from `ready` to `starting`.
   *
   * The revision CAS is the claim: a tick that loses it must not launch.
   * @param run - The ready run attempt.
   * @param operation - The operation recorded for this start.
   * @returns the stored starting run, or `undefined` when another tick claimed it.
   */
  private async markStarting(
    run: RunRecord,
    operation: OperationRecord,
  ): Promise<RunRecord | undefined> {
    try {
      return await this.store.updateRun(run.id, run.revision, {
        ...run,
        state: 'starting',
        operationId: operation.id,
        revision: run.revision + 1,
        updatedAt: this.now(),
      })
    } catch (error) {
      if (error instanceof Error) return undefined
      throw error
    }
  }

  /**
   * Launch one start and settle its outcome, releasing its locks in `finally`.
   *
   * A failed launch and a failed `running` write both leave the attempt durably
   * `starting`, so both roll back through the same revision. A failed operation
   * advance happens after the run is durably `running`; it is recorded for
   * reconciliation rather than rolling a live session back.
   * @param run - The starting run attempt.
   * @param task - Task definition.
   * @param operation - Operation recorded for this start.
   * @param reservation - Locks the start holds.
   * @returns resolution after the run settled and its locks were released.
   */
  private async settle(
    run: RunRecord,
    task: TaskSpec,
    operation: OperationRecord,
    reservation: Reservation,
  ): Promise<void> {
    try {
      let outcome: RunLaunchOutcome
      try {
        outcome = await this.launcher.launch({
          run,
          task,
          workspaceKey: reservation.workspaceKey,
          providerKey: reservation.providerKey,
          operationId: operation.id,
        })
      } catch (error) {
        await this.settleFailure(run, error)
        return
      }

      try {
        await this.markRunning(run, outcome)
      } catch (error) {
        await this.settleFailure(run, error)
        return
      }

      try {
        await this.markOperationCreated(operation)
      } catch (error) {
        this.recordFailure(run.id, error)
      }
    } finally {
      this.release(reservation)
    }
  }

  /**
   * Record a failure that must be reconciled rather than rolled back.
   * @param runId - The affected run.
   * @param error - The failure.
   * @returns nothing.
   */
  private recordFailure(runId: RunIdType, error: unknown): void {
    this.failures.push({
      runId,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * Record a successful start as `running`.
   * @param run - The starting run attempt.
   * @param outcome - Session identity produced by the launcher.
   * @returns resolution after the running state is durable.
   */
  private async markRunning(run: RunRecord, outcome: RunLaunchOutcome): Promise<void> {
    await this.store.updateRun(run.id, run.revision, {
      ...run,
      state: 'running',
      activeSessionId: outcome.activeSessionId,
      sessionLineage: [...run.sessionLineage, outcome.activeSessionId],
      generation: run.sessionLineage.length,
      revision: run.revision + 1,
      updatedAt: this.now(),
      ...(outcome.providerKey === undefined ? {} : { providerKey: outcome.providerKey }),
    })
  }

  /**
   * Advance the operation past session creation.
   * @param operation - The planned operation.
   * @returns resolution after the phase is durable.
   */
  private async markOperationCreated(operation: OperationRecord): Promise<void> {
    const current = this.store.getOperation(operation.id)
    if (current === undefined) {
      throw new OrchestratorError('not-found', `operation '${operation.id}' is not stored`)
    }
    if (current.phase !== 'planned') {
      // A launcher that owns prompt submission may already have advanced the
      // operation. Session creation is still durable; no second advance is due.
      if (
        current.phase === 'session-created'
        || current.phase === 'submitted'
        || current.phase === 'claimed'
      ) {
        return
      }
      throw new OrchestratorError(
        'invalid-transition',
        `operation '${operation.id}' is '${current.phase}'; session creation cannot be recorded`,
      )
    }
    await this.store.advanceOperation(operation.id, 'planned', {
      ...operation,
      phase: 'session-created',
      updatedAt: this.now(),
    })
  }

  /**
   * Roll a failed start back to `ready`, or record it as `needs-attention`.
   * @param run - The starting run attempt.
   * @param error - The launch or persistence failure.
   * @returns resolution after the failure state is durable.
   */
  private async settleFailure(run: RunRecord, error: unknown): Promise<void> {
    const retryable = error instanceof LaunchFailure && error.retryable
    const message = error instanceof Error ? error.message : String(error)
    try {
      await this.store.updateRun(run.id, run.revision, {
        ...run,
        state: retryable ? 'ready' : 'needs-attention',
        revision: run.revision + 1,
        updatedAt: this.now(),
        lastError: {
          code: error instanceof LaunchFailure ? 'launch-failed' : 'launch-error',
          message,
          retryable,
        },
      })
    } catch (rollbackError) {
      this.recordFailure(run.id, rollbackError)
    }
  }

  /**
   * Release the locks one start held.
   * @param reservation - The reservation to release.
   * @returns nothing.
   */
  private release(reservation: Reservation): void {
    this.inFlight.delete(reservation.runId)
    this.inFlightTasks.delete(reservation.taskId)
  }
}

/**
 * Derive the provider route key a task pins, if any.
 * @param task - Task definition.
 * @returns the pinned provider key, or `undefined` when the route is inherited.
 */
export function taskProviderKey(task: TaskSpec): string | undefined {
  return task.model.kind === 'fixed' ? task.model.provider : undefined
}
