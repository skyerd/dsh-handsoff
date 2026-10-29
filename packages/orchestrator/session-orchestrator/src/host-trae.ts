/**
 * The Trae host conversation adapter.
 *
 * Trae is an IDE, not a conversation host for other processes. Its launcher
 * (`trae-cn.exe`) opens folders, files and extensions; its bundled `ai-agent`
 * module serves Trae's own agent over a private local socket with no published
 * session, workspace or prompt protocol. The `trae` model provider used by DSH
 * is a model route, not a Trae session API: it cannot create, list, open or
 * observe a Trae conversation.
 *
 * Every capability is therefore disabled with the concrete missing surface.
 * This adapter never pretends that opening a folder or selecting a model in
 * Trae is the same operation as owning a conversation.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/host-trae
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  capabilityReport,
  failedCapability,
  unsupportedCapability,
} from './host-session.ts'
import type {
  HostCapabilityState,
  HostCreateSessionRequest,
  HostModelSelection,
  HostSessionAdapter,
  HostSessionCapability,
  HostSessionCapabilityReport,
  HostSessionListener,
  HostSessionRef,
  HostSessionResult,
  HostSessionUsage,
  HostWorkspace,
} from './host-session.ts'

/** Stable reason every conversation operation is unavailable in Trae. */
const NO_CONVERSATION_API =
  'Trae exposes an IDE launcher and a private ai-agent socket, but no public conversation, workspace or prompt protocol'

/** Capability map shared by an installed and an absent Trae installation. */
function traeStates(available: boolean): Record<HostSessionCapability, HostCapabilityState> {
  const reason = available
    ? NO_CONVERSATION_API
    : 'Trae is not installed on this machine, so no host conversation surface exists to verify'
  return {
    listWorkspaces: { status: 'unsupported', reason: `${reason}; the launcher only opens a folder in the IDE` },
    createSession: { status: 'unsupported', reason },
    sendPrompt: { status: 'unsupported', reason },
    openSession: {
      status: 'unsupported',
      reason: `${reason}; opening a file or folder in the IDE is not opening an agent conversation`,
    },
    subscribeEvents: { status: 'unsupported', reason },
    getUsage: { status: 'unsupported', reason },
    selectModel: {
      status: 'unsupported',
      reason: `${reason}; the DSH "trae" model provider selects a model route, not a Trae conversation model`,
    },
    listModels: {
      status: 'unsupported',
      reason: `${reason}; the DSH "trae" model provider is not a Trae conversation model catalog`,
    },
    skills: {
      status: 'unsupported',
      reason: `${reason}; skills are composed by the DSH agent preset, which Trae does not expose`,
    },
    permissions: {
      status: 'unsupported',
      reason: `${reason}; Trae exposes no permission policy for a conversation`,
    },
    compaction: {
      status: 'unsupported',
      reason: `${reason}; context handling stays inside the private ai-agent socket`,
    },
  }
}

/**
 * The Trae adapter reports disabled capabilities and performs no side effect.
 *
 * It exists so a capability matrix can name the host honestly instead of
 * omitting it; an omitted host would read as "not tried", not "unsupported".
 */
export class TraeHostSessionAdapter implements HostSessionAdapter {
  readonly host = 'trae' as const
  readonly displayName = 'Trae'
  private readonly installed: boolean

  /**
   * @param options - whether the Trae installation was found.
   */
  constructor(options: { readonly installed: boolean }) {
    this.installed = options.installed
  }

  /** Complete disabled matrix for the Trae IDE. */
  capabilities(): HostSessionCapabilityReport {
    return capabilityReport(this.host, this.displayName, traeStates(this.installed), this.installed)
  }

  /** Disabled: no public workspace listing. */
  async listWorkspaces(): Promise<HostSessionResult<readonly HostWorkspace[]>> {
    return unsupportedCapability(this.host, 'listWorkspaces', this.reason('listWorkspaces'))
  }

  /** Disabled: no public conversation creation. */
  async createSession(_request: HostCreateSessionRequest): Promise<HostSessionResult<HostSessionRef>> {
    return unsupportedCapability(this.host, 'createSession', this.reason('createSession'))
  }

  /** Disabled: no public prompt delivery. */
  async sendPrompt(_sessionId: string, _prompt: string): Promise<HostSessionResult<void>> {
    return unsupportedCapability(this.host, 'sendPrompt', this.reason('sendPrompt'))
  }

  /** Disabled: no stable conversation route. */
  async openSession(_sessionId: string): Promise<HostSessionResult<{ readonly route: string }>> {
    return unsupportedCapability(this.host, 'openSession', this.reason('openSession'))
  }

  /** Disabled: no public conversation event stream. */
  async subscribeEvents(
    _sessionId: string,
    _listener: HostSessionListener,
  ): Promise<HostSessionResult<() => void>> {
    return unsupportedCapability(this.host, 'subscribeEvents', this.reason('subscribeEvents'))
  }

  /** Disabled: no public usage endpoint. */
  async getUsage(_sessionId: string): Promise<HostSessionResult<HostSessionUsage>> {
    return unsupportedCapability(this.host, 'getUsage', this.reason('getUsage'))
  }

  /** Disabled: no per-conversation model selection API. */
  async selectModel(
    _sessionId: string,
    _selection: HostModelSelection,
  ): Promise<HostSessionResult<void>> {
    return unsupportedCapability(this.host, 'selectModel', this.reason('selectModel'))
  }

  /** Read the recorded reason for one disabled capability. */
  private reason(capability: HostSessionCapability): string {
    const state = traeStates(this.installed)[capability]
    return state.status === 'unsupported' ? state.reason : NO_CONVERSATION_API
  }
}

/**
 * Locate a Trae CLI launcher on this machine.
 *
 * Discovery is read-only and deliberately broad enough for CN and
 * international installs; it does not start the IDE.
 * @param env - environment to inspect; defaults to `process.env`.
 * @returns the launcher path, or `undefined` when Trae is not installed.
 */
export function discoverTraeCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.TRAE_CLI
  if (explicit !== undefined && explicit.trim() !== '' && existsSync(explicit)) return explicit
  const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    join(local, 'Programs', 'Trae CN', 'bin', 'trae.cmd'),
    join(local, 'Programs', 'Trae', 'bin', 'trae.cmd'),
    join(local, 'Programs', 'Trae CN', 'Trae CN.exe'),
    join(local, 'Programs', 'Trae', 'Trae.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Build the Trae capability adapter, installed or not.
 * @param options - optional installed override, for tests and probes.
 * @returns the adapter with an honest disabled matrix.
 */
export function createTraeHostSessionAdapter(
  options: { readonly installed?: boolean } = {},
): TraeHostSessionAdapter {
  return new TraeHostSessionAdapter({ installed: options.installed ?? discoverTraeCli() !== undefined })
}

/** Re-export the failure helper so a host composition can keep one import. */
export { failedCapability }
