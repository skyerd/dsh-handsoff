/**
 * Adapter from the scheduler's launcher port to the run supervisor.
 *
 * The scheduler claims an attempt (`ready → starting`) before calling
 * {@link RunLauncher.launch}. This adapter forwards that already-claimed
 * attempt to {@link RunSupervisor.launch}, which creates the Session and
 * returns as soon as its handle is held. The scheduler then commits
 * `starting → running`; the agent itself continues in the background.
 *
 * This module never creates a Session directly, never resumes an operation and
 * never replays an uncertain attempt. Those decisions stay with the scheduler's
 * claim and the recovery reconciler respectively.
 */
import type {
  RunLauncher,
  RunLauncherRequest,
  RunLaunchOutcome,
} from './scheduler.ts'
import type { RunLaunchStart, RunStartRequest } from './supervisor.ts'

/** The supervisor seam a scheduler launcher needs. */
export interface LaunchSupervisor {
  /**
   * Start one scheduler-claimed run and return once its Session exists.
   * @param request - the starting run attempt.
   * @returns the held Session identity and the eventual settlement.
   */
  launch(request: RunStartRequest): Promise<RunLaunchStart>
}

/** Options for {@link SupervisorLauncher}. */
export interface SupervisorLauncherOptions {
  /** Supervisor that owns Session creation and the run lifecycle. */
  readonly supervisor: LaunchSupervisor
}

/** {@link RunLauncher} implemented by the live run supervisor. */
export class SupervisorLauncher implements RunLauncher {
  private readonly supervisor: LaunchSupervisor

  /**
   * @param options - the supervisor that owns Session creation.
   */
  constructor(options: SupervisorLauncherOptions) {
    this.supervisor = options.supervisor
  }

  /**
   * Launch one scheduler-claimed request.
   * @param request - the claimed run attempt.
   * @returns the live Session identity and route key for the scheduler commit.
   */
  async launch(request: RunLauncherRequest): Promise<RunLaunchOutcome> {
    const started = await this.supervisor.launch({
      run: request.run,
      task: request.task,
      operationId: request.operationId,
    })
    return {
      activeSessionId: started.sessionId,
      providerKey: request.providerKey,
    }
  }
}
