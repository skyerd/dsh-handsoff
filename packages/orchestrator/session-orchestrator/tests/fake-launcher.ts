/** A deterministic `RunLauncher` whose launches the test resolves or rejects by hand. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { RunLauncher, RunLauncherRequest, RunLaunchOutcome } from '../src/scheduler.ts'
import { LaunchFailure } from '../src/scheduler.ts'

/** One launch the fake recorded, in call order. */
export interface FakeLaunch {
  /** The request the scheduler handed over. */
  readonly request: RunLauncherRequest
  /** Session identity this launch resolves to when the test accepts it. */
  readonly sessionId: SessionId
}

/** A launcher whose every call waits for the test to accept or reject it. */
export interface FakeLauncher extends RunLauncher {
  /** Every launch recorded so far, in call order; the array is replaced, never mutated. */
  readonly calls: readonly FakeLaunch[]
  /** Every action recorded so far, in call order; the array is replaced, never mutated. */
  readonly actions: readonly string[]
  /** Number of launches still waiting for a verdict. */
  readonly pendingCount: number
  /** Accept one launch, resolving it with the recorded session identity. */
  readonly accept: (index?: number) => Promise<void>
  /** Accept every waiting launch. */
  readonly acceptAll: () => Promise<void>
  /** Reject one launch with a retryable failure. */
  readonly rejectRetryable: (message: string, index?: number) => Promise<void>
  /** Reject one launch with a permanent failure. */
  readonly rejectPermanent: (message: string, index?: number) => Promise<void>
}

/** One waiting launch. */
interface Pending {
  readonly call: FakeLaunch
  readonly resolve: (outcome: RunLaunchOutcome) => void
  readonly reject: (error: unknown) => void
}

/**
 * Build a launcher the test drives explicitly.
 *
 * Nothing here depends on timers or real sessions: a launch stays pending until
 * the test accepts or rejects it, so lock and slot assertions are exact.
 * @returns the fake launcher.
 */
export function fakeLauncher(): FakeLauncher {
  let calls: readonly FakeLaunch[] = []
  let actions: readonly string[] = []
  const pending: Pending[] = []

  const record = (action: string): void => {
    actions = [...actions, action]
  }

  const launcher: RunLauncher = {
    launch(request: RunLauncherRequest): Promise<RunLaunchOutcome> {
      const call: FakeLaunch = {
        request,
        sessionId: makeSessionId(`session-${request.run.id}`),
      }
      calls = [...calls, call]
      record(`launch:${request.task.id}`)
      return new Promise<RunLaunchOutcome>((resolve, reject) => {
        pending.push({ call, resolve, reject })
      })
    },
  }

  const take = (index?: number): Pending => {
    const at = index ?? 0
    const entry = pending[at]
    if (entry === undefined) {
      throw new Error(`no pending launch at index ${at}; pending=${pending.length}`)
    }
    pending.splice(at, 1)
    return entry
  }

  const accept = async (index?: number): Promise<void> => {
    const entry = take(index)
    record(`accept:${entry.call.request.task.id}`)
    entry.resolve({
      activeSessionId: entry.call.sessionId,
      providerKey: entry.call.request.providerKey,
    })
    await Promise.resolve()
  }

  const acceptAll = async (): Promise<void> => {
    while (pending.length > 0) await accept()
  }

  const reject = async (error: unknown, index?: number): Promise<void> => {
    const entry = take(index)
    record(`reject:${entry.call.request.task.id}`)
    entry.reject(error)
    await Promise.resolve()
  }

  return {
    launch: launcher.launch,
    get calls() {
      return calls
    },
    get actions() {
      return actions
    },
    get pendingCount() {
      return pending.length
    },
    accept,
    acceptAll,
    rejectRetryable: (message: string, index?: number) => reject(new LaunchFailure(message, true), index),
    rejectPermanent: (message: string, index?: number) => reject(new LaunchFailure(message, false), index),
  }
}
