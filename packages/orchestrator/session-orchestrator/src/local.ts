/**
 * Host-local composition of the durable store, scheduler, supervisor and
 * recovery reconciler.
 *
 * The order is deliberate: recovery is constructed over the same scheduler it
 * gates, so a tick cannot dispatch before reconciliation opens the gate. The
 * unload order is also owned by recovery: close scheduler, close supervisor,
 * then close the storage domain. This class adds no registrations, no context
 * keys and no timers; the host drives `reconcile()`, `tick()` and `close()`.
 */
import type { RunSupervisor } from './supervisor.ts'
import type {
  DurableSessionReader,
  RecoveryManagerOptions,
  RecoveryReport,
  RecoverySessionDirectory,
  RecoveryState,
  RecoveryStore,
  RecoveryUnloadReport,
} from './recovery.ts'
import { RecoveryManager } from './recovery.ts'
import type {
  SchedulerOptions,
  SchedulerStore,
  SchedulerTickResult,
} from './scheduler.ts'
import { Scheduler } from './scheduler.ts'
import { SupervisorLauncher } from './launcher.ts'
import type { WorkspaceKeyResolver } from './workspace-key.ts'
import { createWorkspaceKeyResolver } from './workspace-key.ts'
import type { HumanSkip } from './planner.ts'
import type { TaskId } from './brand.ts'
import type { RunRecord } from './types.ts'

/** Durable record surface assembled by one host. */
export interface LocalSessionOrchestratorStore extends SchedulerStore, RecoveryStore {
  /**
   * Audited human skips, when the store owns a skip ledger.
   *
   * A host store without this method contributes no skips, so a task awaiting
   * attention stays blocked instead of being treated as a model success.
   */
  readonly listSkips?: () => readonly HumanSkip[]
}

/** Durable record surface plus the final domain close. */
export interface LocalSessionOrchestratorDomain extends LocalSessionOrchestratorStore {
  /** Drain writes and close the storage domain. */
  close(): Promise<void>
}

/** Options for {@link LocalSessionOrchestrator}. */
export interface LocalSessionOrchestratorOptions {
  /** Unified durable store. Pass `ctx.sessionOrchestrator`. */
  readonly store: LocalSessionOrchestratorDomain
  /** The host's single run supervisor. */
  readonly supervisor: RunSupervisor
  /** Durable Session logs. Pass `ctx.sessionPersistence`. */
  readonly durableSessions: DurableSessionReader
  /** Live sessions. Pass `ctx.sessions`. */
  readonly sessions: RecoverySessionDirectory
  /** Stable identity of this host; must match the durable host claim. */
  readonly hostInstanceId: string
  /** Workspace lock keys; defaults to the host platform's resolver. */
  readonly workspaceKeys?: WorkspaceKeyResolver
  /** Shared clock for scheduler and recovery records. */
  readonly now?: () => number
  /**
   * Audited human skips; omitted means the store's own skip ledger is read.
   *
   * The default reader keeps only skips whose run is the task's latest attempt,
   * so an audit record cannot keep a task skipped after a newer attempt exists.
   */
  readonly humanSkips?: SchedulerOptions['humanSkips']
  /** How long a reconciliation lease is claimed for. */
  readonly leaseTtlMs?: number
  /** How many CAS retries one record write may take. */
  readonly writeAttempts?: number
  /**
   * Last unload step. Defaults to `store.close()` so orchestration resources
   * always settle before the storage domain its records live in.
   */
  readonly closeDomain?: () => Promise<void>
}

/**
 * Read the store's latest-attempt skip ledger.
 *
 * A skip is an audit record, not a permanent task flag: once a newer attempt
 * exists the older skip no longer applies, while the record itself stays in
 * `listSkips()` for the audit surface. A store without a ledger contributes no
 * skips, so a task awaiting attention stays blocked.
 * @param store - orchestration store that may expose a skip ledger.
 * @returns the audited skips whose run is still the latest attempt of its task.
 */
function latestAttemptSkips(store: LocalSessionOrchestratorStore): readonly HumanSkip[] {
  const readSkips = store.listSkips
  if (readSkips === undefined) return []
  const latest = new Map<TaskId, RunRecord>()
  for (const run of store.listRuns()) {
    const current = latest.get(run.taskId)
    if (current === undefined || supersedes(run, current)) latest.set(run.taskId, run)
  }
  return readSkips.call(store).filter(skip => latest.get(skip.taskId)?.id === skip.runId)
}

/**
 * Decide whether one attempt supersedes another.
 *
 * Mirrors the planner's ordering (attempt, then updatedAt, then id) so the skip
 * filter and the plan always name the same latest run.
 * @param candidate - the candidate attempt.
 * @param current - the attempt currently held as latest.
 * @returns whether the candidate is the newer attempt.
 */
function supersedes(candidate: RunRecord, current: RunRecord): boolean {
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  return candidate.id > current.id
}

/**
 * One host's local scheduler/recovery wiring.
 *
 * This is a plain composition object, not a Cordis service: it invents no
 * context key. The host passes the real `ctx.sessionOrchestrator`,
 * `ctx.sessionPersistence`, `ctx.sessions` and its `RunSupervisor`.
 */
export class LocalSessionOrchestrator {
  /** Scheduler-to-supervisor adapter. */
  readonly launcher: SupervisorLauncher
  /** Scheduler gated by recovery. */
  readonly scheduler: Scheduler
  /** Startup reconciliation and unload owner. */
  readonly recovery: RecoveryManager

  /**
   * @param options - durable seams, host identity and optional tuning.
   */
  constructor(options: LocalSessionOrchestratorOptions) {
    const now = options.now ?? (() => Date.now())
    const humanSkips = options.humanSkips ?? (() => latestAttemptSkips(options.store))
    this.launcher = new SupervisorLauncher({ supervisor: options.supervisor })
    this.scheduler = new Scheduler({
      store: options.store,
      launcher: this.launcher,
      workspaceKeys: options.workspaceKeys ?? createWorkspaceKeyResolver(),
      now,
      humanSkips,
    })
    const recoveryOptions: RecoveryManagerOptions = {
      store: options.store,
      durableSessions: options.durableSessions,
      sessions: options.sessions,
      supervisor: options.supervisor,
      scheduler: this.scheduler,
      hostInstanceId: options.hostInstanceId,
      now,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(options.writeAttempts !== undefined ? { writeAttempts: options.writeAttempts } : {}),
      closeDomain: options.closeDomain ?? (() => options.store.close()),
    }
    this.recovery = new RecoveryManager(recoveryOptions)
  }

  /** Current recovery lifecycle. */
  get state(): RecoveryState {
    return this.recovery.state
  }

  /** Whether reconciliation has opened the scheduler gate. */
  get schedulerOpen(): boolean {
    return this.recovery.schedulerOpen
  }

  /** Last completed reconciliation report, when any. */
  get report(): RecoveryReport | undefined {
    return this.recovery.report
  }

  /**
   * Reconcile durable runs before any scheduling tick.
   * @returns the completed reconciliation report.
   */
  async reconcile(): Promise<RecoveryReport> {
    return await this.recovery.reconcile()
  }

  /**
   * Run one scheduler tick, gated by recovery.
   * @returns `ran: false` until reconciliation opens the gate.
   */
  async tick(): Promise<{ readonly ran: boolean; readonly result?: SchedulerTickResult }> {
    return await this.recovery.tick()
  }

  /**
   * Unload orchestration resources and the storage domain.
   * @returns the unload report from recovery.
   */
  async close(): Promise<RecoveryUnloadReport> {
    return await this.recovery.close()
  }
}
