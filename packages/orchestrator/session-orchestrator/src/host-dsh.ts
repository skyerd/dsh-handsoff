/**
 * The DeepSeek Harness host conversation adapter.
 *
 * This adapter is a thin facade over the services the harness already owns:
 * the Workspace registry, `ctx.agents`, the live Session directory, durable
 * Session events, the token meter and the same-origin Session route. It adds no
 * scheduler, no timer and no durable record; a queue that uses it still runs
 * through the shared scheduler, recovery manager, health gates and pipeline
 * templates.
 *
 * Every method that depends on an optional service reports `unsupported` when
 * that service is absent. A host without `workspaceRegistry` therefore cannot
 * list Workspaces, and a headless host without a Web server cannot open a
 * conversation; neither is answered with an invented success.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/host-dsh
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import {
  capabilityReport,
  failedCapability,
  sessionOpenRoute,
  succeeded,
  supportedState,
  unsupportedCapability,
} from './host-session.ts'
import type {
  HostCapabilityState,
  HostCreateSessionRequest,
  HostModelSelection,
  HostSessionAdapter,
  HostSessionCapability,
  HostSessionCapabilityReport,
  HostSessionEvent,
  HostSessionListener,
  HostSessionRef,
  HostSessionResult,
  HostSessionUsage,
  HostWorkspace,
} from './host-session.ts'

/** One registered Workspace a DSH conversation can join. */
export interface DshHostWorkspace extends HostWorkspace {
  /**
   * Record a live Session in this Workspace's ordered account.
   * @param sessionId - live session to attach.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>
}

/** Workspace registry face the adapter needs; `ctx.workspaceRegistry` satisfies it. */
export interface DshHostWorkspaces {
  /**
   * List registered Workspaces.
   * @returns Workspaces in the registry's order.
   */
  list(): readonly DshHostWorkspace[]
  /**
   * Resolve one registered Workspace.
   * @param id - Workspace identity stored on the task.
   * @returns the Workspace, or `undefined` when it was deleted.
   */
  get(id: string): DshHostWorkspace | undefined
}

/** Agent creation face the adapter needs; `ctx.agents` satisfies it. */
export interface DshHostAgents {
  /**
   * Create one owned agent on a caller-supplied session id.
   * @param options - identity, metadata and per-agent options.
   * @returns the owned handle after creation completes.
   */
  create(options: CreateAgentOptions): Promise<AgentHandle>
}

/** Live Session directory needed to read usage. */
export interface DshHostLiveSessions {
  /**
   * Resolve one live Session.
   * @param id - session identity.
   * @returns the live Session, or `undefined` when this process does not hold it.
   */
  get(id: SessionId): Session | undefined
}

/** Token meter face the adapter needs; `ctx.tokenMeter` satisfies it. */
export interface DshHostTokenMeter {
  /**
   * Measure one live Session.
   * @param session - session to measure.
   * @returns the total and the baseline kind that produced it.
   */
  measure(session: Session): {
    readonly totalTokens: number
    readonly baseline: { readonly kind: 'none' | 'estimated' | 'usage' }
  }
}

/** Session event source the adapter needs; `ctx.on('session/event', ...)` satisfies it. */
export interface DshHostEventSource {
  /**
   * Observe durable Session events.
   * @param listener - receives every Session event with its Session.
   * @returns the disposer.
   */
  onSessionEvent(listener: (session: Session, event: SessionEvent) => void): () => void
}

/** Host default model selection; `ctx.agentDefaultModel` satisfies it. */
export interface DshHostDefaultModel {
  /**
   * Read the host's current default route.
   * @returns provider, model and optional reasoning effort.
   */
  currentSelection(): HostModelSelection
}

/**
 * Host features the composition actually mounted.
 *
 * The runtime derives these four facts once from the host Context and hands
 * them to the adapter. The adapter never probes a service itself: a missing
 * fact stays disabled with its reason, so a composition without the service
 * cannot advertise a feature it does not have.
 */
export interface DshHostFeatureSupport {
  /** The host advertises a model catalog a task editor may choose from. */
  readonly modelCatalog: boolean
  /** An agent preset registry composes skills for a new session. */
  readonly skills: boolean
  /** A permission preset service governs the session's permission policy. */
  readonly permissions: boolean
  /** A compaction service compacts context at pressure. */
  readonly compaction: boolean
}

/** Options one DSH adapter is composed with. */
export interface DshHostSessionOptions {
  /** Agent creation seam; pass `ctx.agents` in production. */
  readonly agents: DshHostAgents
  /** Session event source; pass `ctx.on('session/event', ...)`. */
  readonly events: DshHostEventSource
  /** Optional workspace registry; absent disables workspace listing and binding. */
  readonly workspaces?: DshHostWorkspaces
  /** Optional live Session directory; absent disables usage reads. */
  readonly liveSessions?: DshHostLiveSessions
  /** Optional token meter; absent disables usage reads. */
  readonly meter?: DshHostTokenMeter
  /** Optional same-origin route builder; absent disables opening a conversation. */
  readonly openRoute?: (sessionId: string) => string
  /** Optional host default route, used when neither the request nor a selection names one. */
  readonly defaultModel?: DshHostDefaultModel
  /**
   * Host features the composition mounted.
   *
   * Absent means none of them can be verified, so each stays disabled with its
   * reason instead of being assumed supported.
   */
  readonly support?: DshHostFeatureSupport
  /** Clock for event timestamps; defaults to `Date.now`. */
  readonly now?: () => number
  /** Session identity minter; defaults to a random identity with a `host-` prefix. */
  readonly newSessionId?: () => string
}

/** Flatten assistant content into text. */
function contentText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Map one DSH Session event to the host event vocabulary.
 * @param event - durable Session event.
 * @param now - timestamp attached to the mapped event.
 * @param toolNames - call identity to tool name, filled by `tool/call` and drained by `tool/result`.
 * @returns the mapped event, or `undefined` when the host vocabulary has no counterpart.
 */
function hostEventOf(
  event: SessionEvent,
  now: number,
  toolNames: Map<string, string>,
): HostSessionEvent | undefined {
  switch (event.type) {
    case 'turn/start':
      return { type: 'turn/start', at: now }
    case 'assistant/message': {
      const text = contentText(event.data.message.content).trim()
      return text === '' ? undefined : { type: 'assistant/text', text, at: now }
    }
    case 'turn/end':
      return { type: 'turn/end', reason: event.data.reason.kind, at: now }
    case 'tool/call':
      toolNames.set(event.data.callId, event.data.name)
      return undefined
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const name = toolNames.get(callId) ?? 'tool'
      toolNames.delete(callId)
      return { type: 'tool', name, ok: event.data.message.isError !== true, at: now }
    }
    default:
      return undefined
  }
}

/** Build agent options from one model route. */
function agentOptionsOf(selection: HostModelSelection | undefined): AgentOptions {
  if (selection === undefined) return {}
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}

/** One owned conversation held by this adapter. */
interface HeldSession {
  readonly handle: AgentHandle
}

/**
 * The DSH host adapter.
 *
 * The adapter holds the handles it creates; it never resumes or disposes a
 * handle created elsewhere. A caller that needs cross-restart behavior uses
 * the orchestrator's durable run records, not this in-process map.
 */
export class DshHostSessionAdapter implements HostSessionAdapter {
  readonly host = 'dsh' as const
  readonly displayName = 'DeepSeek Harness'
  private readonly options: DshHostSessionOptions
  private readonly now: () => number
  private readonly newSessionId: () => string
  private readonly held = new Map<string, HeldSession>()
  private readonly pendingModels = new Map<string, HostModelSelection>()

  /**
   * @param options - real DSH services and optional capability sources.
   */
  constructor(options: DshHostSessionOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.newSessionId = options.newSessionId ?? (() => `host-${randomUUID()}`)
  }

  /** Complete capability matrix derived from the services actually supplied. */
  capabilities(): HostSessionCapabilityReport {
    const support = this.options.support
    const states: Record<HostSessionCapability, HostCapabilityState> = {
      listWorkspaces: this.options.workspaces === undefined
        ? { status: 'unsupported', reason: 'the host mounted no Workspace registry' }
        : { status: 'supported', detail: 'registered Workspaces only' },
      createSession: { status: 'supported', detail: 'creates one real Agent and delivers the first prompt' },
      sendPrompt: { status: 'supported' },
      openSession: this.options.openRoute === undefined
        ? { status: 'unsupported', reason: 'the host exposes no same-origin Session route' }
        : { status: 'supported', detail: 'same-origin /session/<id> redirect' },
      subscribeEvents: { status: 'supported', detail: 'durable Session events of this process' },
      getUsage: this.options.meter === undefined || this.options.liveSessions === undefined
        ? { status: 'unsupported', reason: 'the host mounted no live Session directory or token meter' }
        : { status: 'supported', detail: 'measured or estimated as the meter reports' },
      selectModel: {
        status: 'supported',
        detail: 'applied to the next createSession for that identity; a live Session cannot switch model',
      },
      listModels: support?.modelCatalog === true
        ? { status: 'supported', detail: 'the host model catalog a task editor may choose from' }
        : { status: 'unsupported', reason: 'the host mounted no LLM model catalog service' },
      skills: support?.skills === true
        ? {
          status: 'supported',
          detail: 'skills follow the agent preset fixed at session creation; a separate per-task skill list is not applied',
        }
        : { status: 'unsupported', reason: 'the host mounted no agent preset registry to compose skills' },
      permissions: support?.permissions === true
        ? {
          status: 'supported',
          detail: 'the host permission preset governs the session; a task inherits it and cannot widen it',
        }
        : { status: 'unsupported', reason: 'the host mounted no permission preset service' },
      compaction: support?.compaction === true
        ? { status: 'supported', detail: 'the host compacts context automatically when pressure asks for it' }
        : { status: 'unsupported', reason: 'the host mounted no context compaction service' },
    }
    return capabilityReport(this.host, this.displayName, states)
  }

  /** List registered Workspaces, or report the registry is absent. */
  async listWorkspaces(): Promise<HostSessionResult<readonly HostWorkspace[]>> {
    const report = this.capabilities()
    if (supportedState(report, 'listWorkspaces') === undefined) {
      return unsupportedCapability(
        this.host,
        'listWorkspaces',
        report.capabilities.listWorkspaces.status === 'unsupported'
          ? report.capabilities.listWorkspaces.reason
          : 'the host mounted no Workspace registry',
      )
    }
    return succeeded((this.options.workspaces?.list() ?? []).map(workspace => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
    })))
  }

  /** Create one real Agent, join its Workspace and deliver the first prompt. */
  async createSession(request: HostCreateSessionRequest): Promise<HostSessionResult<HostSessionRef>> {
    const capability = 'createSession'
    if (request.prompt.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'a host session needs a non-empty first prompt')
    }
    const workspace = request.workspaceId === undefined
      ? undefined
      : this.options.workspaces?.get(request.workspaceId)
    if (request.workspaceId !== undefined && workspace === undefined) {
      return failedCapability(
        this.host,
        capability,
        'unknown-workspace',
        `workspace '${request.workspaceId}' is not registered`,
      )
    }
    const cwd = workspace?.path ?? request.cwd
    if (cwd === undefined || cwd.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'no workspace path or cwd to create the session in')
    }
    const sessionId = brandSessionId(request.sessionId ?? this.newSessionId())
    const selected = request.model
      ?? this.pendingModels.get(sessionId)
      ?? this.options.defaultModel?.currentSelection()
    this.pendingModels.delete(sessionId)
    let handle: AgentHandle
    try {
      handle = await this.options.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: agentOptionsOf(selected),
      })
    } catch (error) {
      return failedCapability(
        this.host,
        capability,
        'host-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        await handle.dispose()
        return failedCapability(
          this.host,
          capability,
          'host-failed',
          `the session could not join workspace '${workspace.id}': ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.held.set(sessionId, { handle })
    const delivered = await this.sendPrompt(sessionId, request.prompt)
    if (!delivered.ok) {
      this.held.delete(sessionId)
      await handle.dispose()
      return { ok: false, failure: delivered.failure }
    }
    return succeeded({
      sessionId,
      ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
      ...(this.options.openRoute === undefined ? {} : { route: this.options.openRoute(sessionId) }),
      ...(selected === undefined ? {} : { model: selected }),
    })
  }

  /** Deliver one prompt to a held conversation. */
  async sendPrompt(sessionId: string, prompt: string): Promise<HostSessionResult<void>> {
    const capability = 'sendPrompt'
    if (prompt.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'a prompt cannot be empty')
    }
    const held = this.held.get(sessionId)
    if (held === undefined) {
      return failedCapability(
        this.host,
        capability,
        'unknown-session',
        `this adapter holds no live handle for session '${sessionId}'`,
      )
    }
    try {
      const message: UserMessage = createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      held.handle.agent.followup(message)
      return succeeded(undefined)
    } catch (error) {
      return failedCapability(
        this.host,
        capability,
        'host-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Produce the same-origin route that opens a conversation. */
  async openSession(sessionId: string): Promise<HostSessionResult<{ readonly route: string }>> {
    const report = this.capabilities()
    const state = supportedState(report, 'openSession')
    if (state === undefined || this.options.openRoute === undefined) {
      return unsupportedCapability(
        this.host,
        'openSession',
        state?.detail ?? (report.capabilities.openSession.status === 'unsupported'
          ? report.capabilities.openSession.reason
          : 'the host exposes no same-origin Session route'),
      )
    }
    return succeeded({ route: this.options.openRoute(sessionId) })
  }

  /** Observe durable Session events for one conversation. */
  async subscribeEvents(
    sessionId: string,
    listener: HostSessionListener,
  ): Promise<HostSessionResult<() => void>> {
    const report = this.capabilities()
    if (supportedState(report, 'subscribeEvents') === undefined) {
      return unsupportedCapability(
        this.host,
        'subscribeEvents',
        report.capabilities.subscribeEvents.status === 'unsupported'
          ? report.capabilities.subscribeEvents.reason
          : 'the host exposes no Session event source',
      )
    }
    const toolNames = new Map<string, string>()
    const unsubscribe = this.options.events.onSessionEvent((session, event) => {
      if (session.id !== sessionId) return
      const mapped = hostEventOf(event, this.now(), toolNames)
      if (mapped !== undefined) listener(mapped)
    })
    return succeeded(unsubscribe)
  }

  /** Read the live Session's measured or estimated usage. */
  async getUsage(sessionId: string): Promise<HostSessionResult<HostSessionUsage>> {
    const report = this.capabilities()
    const state = supportedState(report, 'getUsage')
    if (state === undefined || this.options.meter === undefined || this.options.liveSessions === undefined) {
      return unsupportedCapability(
        this.host,
        'getUsage',
        state?.detail ?? (report.capabilities.getUsage.status === 'unsupported'
          ? report.capabilities.getUsage.reason
          : 'the host mounted no live Session directory or token meter'),
      )
    }
    const session = this.options.liveSessions.get(brandSessionId(sessionId))
    if (session === undefined) {
      return failedCapability(
        this.host,
        'getUsage',
        'unknown-session',
        `this host holds no live session '${sessionId}'`,
      )
    }
    const measured = this.options.meter.measure(session)
    return succeeded({
      totalTokens: measured.totalTokens,
      estimated: measured.baseline.kind !== 'usage',
    })
  }

  /** Select the model a future conversation will use. */
  async selectModel(
    sessionId: string,
    selection: HostModelSelection,
  ): Promise<HostSessionResult<void>> {
    const capability = 'selectModel'
    if (selection.provider.trim() === '' || selection.model.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'provider and model must be non-empty')
    }
    if (this.held.has(sessionId)) {
      return unsupportedCapability(
        this.host,
        capability,
        'this Session is already live; its model was fixed at creation',
      )
    }
    this.pendingModels.set(sessionId, selection)
    return succeeded(undefined)
  }
}

/**
 * Build a DSH adapter over the services one host already owns.
 * @param options - agent, event, workspace, usage and route seams.
 * @returns the adapter.
 */
export function createDshHostSessionAdapter(options: DshHostSessionOptions): DshHostSessionAdapter {
  return new DshHostSessionAdapter(options)
}

/** Re-export the route helper so hosts that build their own links stay aligned. */
export { sessionOpenRoute }
