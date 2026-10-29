/**
 * The host seam a queue passes through to reach one conversation.
 *
 * The orchestrator owns queues, scheduling, recovery, health gates and pipeline
 * templates. Those records describe work, not a particular agent runtime. A
 * host session adapter turns one record operation into one host capability:
 * list real Workspaces, create a conversation, deliver a prompt, open the
 * conversation, observe its events, read its usage and select its model.
 *
 * A capability is either `supported` or `unsupported` with a reason. An adapter
 * never answers a disabled capability with a fabricated success: every method
 * checks its own report first and returns `unsupported` without side effects.
 * The distinction matters because a queue that cannot create a real Session
 * must stop, not pretend it dispatched one.
 *
 * Adapters are pure ports. They hold no scheduler, no timer and no durable
 * record; the shared orchestrator drivers below this seam remain the only
 * implementation of queue, recovery, health and template behavior.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/host-session
 */

/** One host that can own a conversation. */
export type HostSessionKind = 'dsh' | 'workbuddy' | 'trae'

/**
 * The complete capability vocabulary a task may use.
 *
 * The first seven are conversation operations. The last four are host features
 * a task's editor may expose: a creation-time model catalog, skill composition
 * through the session's agent preset, the host permission policy and automatic
 * context compaction. A feature a host does not expose stays disabled with its
 * reason; a queue never imitates it.
 */
export const HOST_SESSION_CAPABILITIES = [
  'listWorkspaces',
  'createSession',
  'sendPrompt',
  'openSession',
  'subscribeEvents',
  'getUsage',
  'selectModel',
  'listModels',
  'skills',
  'permissions',
  'compaction',
] as const

/** One operation in {@link HOST_SESSION_CAPABILITIES}. */
export type HostSessionCapability = (typeof HOST_SESSION_CAPABILITIES)[number]

/** Whether one adapter can perform one capability, and why not when disabled. */
export type HostCapabilityState =
  | {
    readonly status: 'supported'
    /**
     * Concrete boundary of the support, when the method is narrower than its
     * name suggests (for example a model selected before a Session starts).
     */
    readonly detail?: string
  }
  | {
    readonly status: 'unsupported'
    /** Stable, concrete reason the capability is disabled in this host. */
    readonly reason: string
  }

/** One host's capability matrix. */
export interface HostSessionCapabilityReport {
  /** Host identity, stable across releases. */
  readonly host: HostSessionKind
  /** Product name a settings page may show. */
  readonly displayName: string
  /** Whether the host installation was found on this machine. */
  readonly available: boolean
  /**
   * Whether this adapter can be the execution backend for a queue.
   *
   * This is deliberately narrower than "some capabilities are supported": a
   * queue needs `createSession`, `sendPrompt` and `subscribeEvents` together.
   */
  readonly runnable: boolean
  /** One state per capability in {@link HOST_SESSION_CAPABILITIES}. */
  readonly capabilities: Readonly<Record<HostSessionCapability, HostCapabilityState>>
}

/** One workspace a host conversation can join. */
export interface HostWorkspace {
  /** Stable host identity. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Canonical directory the conversation starts in. */
  readonly path: string
}

/** A model route in the host's own vocabulary. */
export interface HostModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One conversation identity returned by {@link HostSessionAdapter.createSession}. */
export interface HostSessionRef {
  /** Stable conversation identity. */
  readonly sessionId: string
  /** Workspace the conversation belongs to, when the host records one. */
  readonly workspaceId?: string
  /** Same-origin route that opens the conversation, when the host exposes one. */
  readonly route?: string
  /** Model route the conversation was created with. */
  readonly model?: HostModelSelection
}

/** Request to create one host conversation. */
export interface HostCreateSessionRequest {
  /**
   * Caller-chosen identity. The queue supplies its attempt identity so a
   * restart can reconcile the same conversation; omitted means the adapter
   * mints one.
   */
  readonly sessionId?: string
  /** Registered workspace the conversation must join. */
  readonly workspaceId?: string
  /** Canonical directory when the host accepts one without a workspace record. */
  readonly cwd?: string
  /** First user prompt. */
  readonly prompt: string
  /** Model route for this conversation. */
  readonly model?: HostModelSelection
}

/** Token and context facts one host can report for a conversation. */
export interface HostSessionUsage {
  /** Input tokens billed for the conversation, when the host reports them. */
  readonly inputTokens?: number
  /** Output tokens billed for the conversation, when the host reports them. */
  readonly outputTokens?: number
  /** Cached input tokens, when the host reports them. */
  readonly cachedInputTokens?: number
  /** Total tokens retained or billed, when the host reports them. */
  readonly totalTokens?: number
  /** Model context window, when the host reports it. */
  readonly contextWindow?: number
  /** Provider credits consumed, when the host reports a credit balance. */
  readonly credits?: number
  /**
   * Whether `totalTokens` is an estimate rather than measured usage.
   *
   * A consumer that presents cost or context pressure must keep the difference
   * visible; an estimate is never labelled as measured.
   */
  readonly estimated?: boolean
}

/** One observable fact from a host conversation. */
export type HostSessionEvent =
  | { readonly type: 'turn/start'; readonly at: number }
  | { readonly type: 'assistant/text'; readonly text: string; readonly at: number }
  | { readonly type: 'tool'; readonly name: string; readonly ok: boolean; readonly at: number }
  | { readonly type: 'turn/end'; readonly reason?: string; readonly at: number }
  | { readonly type: 'error'; readonly message: string; readonly at: number }

/** Receives every {@link HostSessionEvent} of one conversation until disposed. */
export type HostSessionListener = (event: HostSessionEvent) => void

/** Stable failure of one adapter operation. */
export interface HostSessionFailure {
  /** Capability that was invoked. */
  readonly capability: HostSessionCapability
  /** Host that refused it. */
  readonly host: HostSessionKind
  /** Why the operation produced no value. */
  readonly reason:
    | 'unsupported'
    | 'unknown-session'
    | 'unknown-workspace'
    | 'host-unavailable'
    | 'host-failed'
    | 'invalid-request'
  /** Human-readable detail; never a fabricated success. */
  readonly detail: string
}

/** Result of one adapter operation. */
export type HostSessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: HostSessionFailure }

/**
 * The uniform host conversation seam.
 *
 * Implementations are ordinary objects, not Cordis services: a host composes
 * one adapter and passes it to the queue's execution driver. `capabilities()`
 * is the single authority for which methods may be called.
 */
export interface HostSessionAdapter {
  /** Host identity. */
  readonly host: HostSessionKind
  /** Product name a settings page may show. */
  readonly displayName: string
  /**
   * Report every capability this adapter really exposes.
   * @returns the capability matrix for this host.
   */
  capabilities(): HostSessionCapabilityReport
  /**
   * List the host Workspaces a conversation may join.
   * @returns the workspace list, or an explicit unsupported failure.
   */
  listWorkspaces(): Promise<HostSessionResult<readonly HostWorkspace[]>>
  /**
   * Create one conversation in a workspace.
   * @param request - identity, workspace, first prompt and model.
   * @returns the new conversation, or an explicit failure.
   */
  createSession(request: HostCreateSessionRequest): Promise<HostSessionResult<HostSessionRef>>
  /**
   * Deliver one user prompt to an existing conversation.
   * @param sessionId - conversation identity.
   * @param prompt - exact user text.
   * @returns resolution after the host accepted the prompt.
   */
  sendPrompt(sessionId: string, prompt: string): Promise<HostSessionResult<void>>
  /**
   * Produce a route that opens an existing conversation.
   * @param sessionId - conversation identity.
   * @returns the same-origin route, or an explicit failure.
   */
  openSession(sessionId: string): Promise<HostSessionResult<{ readonly route: string }>>
  /**
   * Observe one conversation until the returned disposer is called.
   * @param sessionId - conversation identity.
   * @param listener - receives every host event.
   * @returns the disposer, or an explicit failure.
   */
  subscribeEvents(
    sessionId: string,
    listener: HostSessionListener,
  ): Promise<HostSessionResult<() => void>>
  /**
   * Read usage for one conversation.
   * @param sessionId - conversation identity.
   * @returns the host's usage facts, or an explicit failure.
   */
  getUsage(sessionId: string): Promise<HostSessionResult<HostSessionUsage>>
  /**
   * Select the model one conversation uses.
   * @param sessionId - conversation identity.
   * @param selection - provider, model and optional reasoning effort.
   * @returns resolution after the host accepted the selection.
   */
  selectModel(
    sessionId: string,
    selection: HostModelSelection,
  ): Promise<HostSessionResult<void>>
}

/**
 * Build the stable failure one disabled capability returns.
 * @param host - host that disables it.
 * @param capability - disabled operation.
 * @param reason - why the host cannot perform it.
 * @returns an unsupported result with no side effect.
 */
export function unsupportedCapability<T>(
  host: HostSessionKind,
  capability: HostSessionCapability,
  reason: string,
): HostSessionResult<T> {
  return {
    ok: false,
    failure: {
      capability,
      host,
      reason: 'unsupported',
      detail: reason,
    },
  }
}

/**
 * Build one failed result.
 * @param host - host that failed.
 * @param capability - operation that failed.
 * @param reason - stable failure family.
 * @param detail - concrete diagnostic.
 * @returns a failed result.
 */
export function failedCapability<T>(
  host: HostSessionKind,
  capability: HostSessionCapability,
  reason: HostSessionFailure['reason'],
  detail: string,
): HostSessionResult<T> {
  return { ok: false, failure: { capability, host, reason, detail } }
}

/**
 * Build one successful result.
 * @param value - operation value.
 * @returns a successful result.
 */
export function succeeded<T>(value: T): HostSessionResult<T> {
  return { ok: true, value }
}

/**
 * Report whether one capability is supported by a matrix.
 * @param report - host matrix.
 * @param capability - capability to test.
 * @returns the supported state, or `undefined` when disabled.
 */
export function supportedState(
  report: HostSessionCapabilityReport,
  capability: HostSessionCapability,
): Extract<HostCapabilityState, { status: 'supported' }> | undefined {
  const state = report.capabilities[capability]
  return state.status === 'supported' ? state : undefined
}

/**
 * Build one capability matrix from per-capability states.
 * @param host - host identity.
 * @param displayName - product name.
 * @param capabilities - complete state map.
 * @param available - whether the host installation exists on this machine.
 * @returns the matrix, with `runnable` derived from the queue's required trio.
 */
export function capabilityReport(
  host: HostSessionKind,
  displayName: string,
  capabilities: Readonly<Record<HostSessionCapability, HostCapabilityState>>,
  available = true,
): HostSessionCapabilityReport {
  const required: readonly HostSessionCapability[] = ['createSession', 'sendPrompt', 'subscribeEvents']
  const runnable = available && required.every(capability => capabilities[capability].status === 'supported')
  return { host, displayName, available, runnable, capabilities }
}

/**
 * One same-origin route that opens a conversation by identity.
 * @param sessionId - conversation identity.
 * @returns the encoded route.
 */
export function sessionOpenRoute(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`
}
