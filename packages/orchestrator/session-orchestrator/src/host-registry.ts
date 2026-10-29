/**
 * The host conversation registry.
 *
 * One registry names every host this build knows, the capability matrix each
 * host really exposes, and which adapter a queue may use. The queue itself
 * owns one registry; it does not branch into three schedulers, three recovery
 * paths or three template builders.
 *
 * The DSH adapter is the primary execution host. WorkBuddy is included only
 * when its headless CLI is installed, and Trae is always included so its
 * disabled capabilities are reported rather than silently omitted.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/host-registry
 */

import { createDshHostSessionAdapter } from './host-dsh.ts'
import type { DshHostSessionOptions } from './host-dsh.ts'
import { createTraeHostSessionAdapter, discoverTraeCli } from './host-trae.ts'
import { createWorkBuddyHostSessionAdapter, discoverWorkBuddyCli } from './host-workbuddy.ts'
import type { HostSessionAdapter, HostSessionCapabilityReport, HostSessionKind } from './host-session.ts'

/** Options one registry is composed with. */
export interface HostSessionRegistryOptions {
  /** Every adapter this host can report. */
  readonly adapters: readonly HostSessionAdapter[]
  /** Adapter a queue uses for real runs. */
  readonly primary: HostSessionKind
}

/** One adapter absent from the registry or unable to run a queue. */
export class HostSessionUnavailableError extends Error {
  /**
   * @param host - host that cannot run a queue.
   * @param reason - concrete reason.
   */
  constructor(
    readonly host: HostSessionKind,
    readonly reason: string,
  ) {
    super(`host session adapter '${host}' cannot run a queue: ${reason}`)
    this.name = 'HostSessionUnavailableError'
  }
}

/** The host adapters one orchestrator process reports and uses. */
export class HostSessionRegistry {
  private readonly adapters: ReadonlyMap<HostSessionKind, HostSessionAdapter>
  private readonly primaryKind: HostSessionKind

  /**
   * @param options - adapters and the primary execution host.
   */
  constructor(options: HostSessionRegistryOptions) {
    const map = new Map<HostSessionKind, HostSessionAdapter>()
    for (const adapter of options.adapters) map.set(adapter.host, adapter)
    this.adapters = map
    this.primaryKind = options.primary
  }

  /** Every capability matrix, primary first. */
  reports(): readonly HostSessionCapabilityReport[] {
    const primary = this.adapters.get(this.primaryKind)
    const rest = [...this.adapters.values()].filter(adapter => adapter.host !== this.primaryKind)
    return [
      ...(primary === undefined ? [] : [primary.capabilities()]),
      ...rest.map(adapter => adapter.capabilities()),
    ]
  }

  /**
   * Read one adapter.
   * @param host - host identity.
   * @returns the adapter, or `undefined` when this build does not know it.
   */
  get(host: HostSessionKind): HostSessionAdapter | undefined {
    return this.adapters.get(host)
  }

  /**
   * Require the queue's execution adapter.
   * @param host - host the queue must use; defaults to the primary.
   * @returns the runnable adapter.
   * @throws HostSessionUnavailableError when the host is absent or disabled.
   */
  requireRunnable(host: HostSessionKind = this.primaryKind): HostSessionAdapter {
    const adapter = this.adapters.get(host)
    if (adapter === undefined) {
      throw new HostSessionUnavailableError(host, 'no adapter is registered for this host')
    }
    const report = adapter.capabilities()
    if (!report.available) {
      throw new HostSessionUnavailableError(host, 'the host installation was not found')
    }
    if (!report.runnable) {
      const disabled = Object.entries(report.capabilities)
        .filter(([, state]) => state.status === 'unsupported')
        .map(([capability, state]) => `${capability}: ${state.status === 'unsupported' ? state.reason : ''}`)
      throw new HostSessionUnavailableError(
        host,
        `a queue needs createSession, sendPrompt and subscribeEvents; ${disabled.join('; ')}`,
      )
    }
    return adapter
  }
}

/** Options for {@link createDefaultHostSessionRegistry}. */
export interface DefaultHostSessionRegistryOptions {
  /** DSH adapter seams; the runtime always supplies these. */
  readonly dsh: DshHostSessionOptions
  /** Environment used for read-only host discovery; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Explicit WorkBuddy CLI entry; overrides discovery when non-empty. */
  readonly workbuddyCli?: string
  /** Explicit Trae launcher path; overrides discovery when non-empty. */
  readonly traeCli?: string
  /** Whether to include a discovered WorkBuddy adapter. Defaults to true. */
  readonly includeWorkBuddy?: boolean
  /** Whether to include the Trae report. Defaults to true. */
  readonly includeTrae?: boolean
}

/**
 * Build the standard registry: DSH primary, WorkBuddy when installed, Trae as
 * an explicitly disabled report.
 * @param options - DSH seams and discovery overrides.
 * @returns the registry.
 */
export function createDefaultHostSessionRegistry(
  options: DefaultHostSessionRegistryOptions,
): HostSessionRegistry {
  const env = options.env ?? process.env
  const adapters: HostSessionAdapter[] = [createDshHostSessionAdapter(options.dsh)]
  const configuredWorkBuddy = options.workbuddyCli?.trim() ?? ''
  const workbuddyCli = options.includeWorkBuddy === false
    ? undefined
    : configuredWorkBuddy === ''
      ? discoverWorkBuddyCli(env)
      : configuredWorkBuddy
  const workbuddy = workbuddyCli === undefined
    ? undefined
    : createWorkBuddyHostSessionAdapter({ cliPath: workbuddyCli })
  if (workbuddy !== undefined) adapters.push(workbuddy)
  if (options.includeTrae !== false) {
    const configuredTrae = options.traeCli?.trim() ?? ''
    adapters.push(createTraeHostSessionAdapter({
      installed: configuredTrae !== '' || discoverTraeCli(env) !== undefined,
    }))
  }
  return new HostSessionRegistry({ adapters, primary: 'dsh' })
}
