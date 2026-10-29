/**
 * The WorkBuddy host conversation adapter.
 *
 * WorkBuddy ships a real headless CLI (`codebuddy --print`) that can create or
 * resume a conversation by identity, stream structured events, select a model
 * and report usage. This adapter drives that CLI as a subprocess; it does not
 * read WorkBuddy's private SQLite state and does not start the desktop's
 * password-protected HTTP server.
 *
 * Two capabilities are deliberately disabled:
 *
 * - `listWorkspaces`: the CLI accepts `--add-dir` but exposes no workspace
 *   listing. WorkBuddy's REST endpoint requires the desktop's host-issued
 *   password, so the adapter refuses rather than guessing directories.
 * - `openSession`: the CLI can resume a conversation in an interactive
 *   terminal (`--resume`), but exposes no stable GUI route. Spawning a TUI from
 *   a scheduler is not an "open conversation" a user can use.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/host-workbuddy
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  capabilityReport,
  failedCapability,
  succeeded,
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

/** Result of one finished CLI process. */
export interface WorkBuddyCommandResult {
  /** Process exit code; `-1` when it was terminated by a signal. */
  readonly code: number
  /** Complete standard output. */
  readonly stdout: string
  /** Complete standard error. */
  readonly stderr: string
}

/** One running CLI process whose stdout arrives line by line. */
export interface WorkBuddyRunHandle {
  /** Newline-delimited stdout chunks. */
  readonly lines: AsyncIterable<string>
  /** Process completion. */
  readonly completion: Promise<WorkBuddyCommandResult>
  /** Ask the process to stop. */
  kill(): void
}

/** Options one CLI invocation receives. */
export interface WorkBuddyRunOptions {
  /** Working directory the agent starts in. */
  readonly cwd?: string
  /** Cancellation signal. */
  readonly signal?: AbortSignal
}

/** Spawns one WorkBuddy CLI process. Replaceable in tests. */
export type WorkBuddyStreamRunner = (
  args: readonly string[],
  options: WorkBuddyRunOptions,
) => WorkBuddyRunHandle

/** Maximum events retained for a late subscriber of one conversation. */
const EVENT_BUFFER_LIMIT = 2_000

/** One conversation this adapter has driven. */
interface WorkBuddySession {
  readonly listener: Set<HostSessionListener>
  readonly pendingModel: HostModelSelection | undefined
  /** Retained events, so a subscriber attached after a run still sees its turn. */
  readonly buffered: readonly HostSessionEvent[]
  usage: HostSessionUsage | undefined
  active: boolean
}

/** Options one WorkBuddy adapter is composed with. */
export interface WorkBuddyHostSessionOptions {
  /** Path to `codebuddy-lite-wb.mjs` (or another compatible CLI entry). */
  readonly cliPath: string
  /** Process runner; defaults to a real `node` subprocess. */
  readonly run?: WorkBuddyStreamRunner
  /** Clock for event timestamps; defaults to `Date.now`. */
  readonly now?: () => number
  /** Session identity minter; defaults to a `workbuddy-` prefixed random id. */
  readonly newSessionId?: () => string
  /** Default model route, when neither the request nor a selection names one. */
  readonly defaultModel?: HostModelSelection
}

/** Whether a parsed JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite number from one object field. */
function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const found = value[key]
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

/** Read a non-empty string from one object field. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key]
  return typeof found === 'string' && found !== '' ? found : undefined
}

/** Flatten one streamed assistant message into text. */
function assistantText(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'text') continue
    const text = stringField(block, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** Read usage from one `result` event. */
function usageOf(event: Record<string, unknown>): HostSessionUsage | undefined {
  const usage = event.usage
  if (!isRecord(usage)) return undefined
  const inputTokens = numberField(usage, 'input_tokens')
  const outputTokens = numberField(usage, 'output_tokens')
  const cachedInputTokens = numberField(usage, 'cache_read_input_tokens')
  const totalTokens = inputTokens === undefined && outputTokens === undefined
    ? undefined
    : (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0)
  const credits = numberField(event, 'credits') ?? numberField(usage, 'credits')
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && credits === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(credits === undefined ? {} : { credits }),
  }
}

/** One parsed stream line: events to emit and usage to retain. */
interface ParsedLine {
  readonly events: readonly HostSessionEvent[]
  readonly usage?: HostSessionUsage
}

/** Parse one NDJSON line from `--output-format stream-json`. */
function parseStreamLine(line: string, now: number): ParsedLine | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const type = stringField(parsed, 'type')
  if (type === 'assistant') {
    const message = parsed.message
    if (!isRecord(message)) return undefined
    const text = assistantText(message)
    return text === ''
      ? undefined
      : { events: [{ type: 'assistant/text', text, at: now }] }
  }
  if (type === 'result') {
    const usage = usageOf(parsed)
    const subtype = stringField(parsed, 'subtype')
    const isError = parsed.is_error === true || (subtype !== undefined && subtype !== 'success')
    const events: HostSessionEvent[] = []
    const result = stringField(parsed, 'result')
    if (isError) {
      events.push({ type: 'error', message: result ?? 'the WorkBuddy run failed', at: now })
    } else if (result !== undefined) {
      events.push({ type: 'assistant/text', text: result, at: now })
    }
    events.push({ type: 'turn/end', at: now })
    return { events, ...(usage === undefined ? {} : { usage }) }
  }
  if (type === 'system' && stringField(parsed, 'subtype') === 'init') {
    return { events: [{ type: 'turn/start', at: now }] }
  }
  if (type === 'user') {
    const message = parsed.message
    if (!isRecord(message) || !Array.isArray(message.content)) return undefined
    const events: HostSessionEvent[] = []
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const name = stringField(block, 'tool_use_id') ?? 'tool'
      events.push({ type: 'tool', name, ok: block.is_error !== true, at: now })
    }
    return events.length === 0 ? undefined : { events }
  }
  return undefined
}

/** Build CLI arguments for one turn. */
function turnArgs(
  sessionId: string,
  prompt: string,
  model: HostModelSelection | undefined,
  resume: boolean,
): readonly string[] {
  const args = [
    '--print',
    resume ? '--resume' : '--session-id',
    sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    ...(model === undefined ? [] : ['--model', model.model]),
    prompt,
  ]
  return args
}

/**
 * Start one real WorkBuddy CLI process.
 * @param cliPath - CLI entry passed to the current Node executable.
 * @param args - CLI arguments.
 * @param options - working directory and cancellation.
 * @returns the running process handle.
 */
function spawnWorkBuddy(
  cliPath: string,
  args: readonly string[],
  options: WorkBuddyRunOptions,
): WorkBuddyRunHandle {
  const child = spawn(process.execPath, [cliPath, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const completion = new Promise<WorkBuddyCommandResult>((resolve) => {
    child.stdout.on('data', (chunk: Buffer | string) => { stdoutChunks.push(String(chunk)) })
    child.stderr.on('data', (chunk: Buffer | string) => { stderrChunks.push(String(chunk)) })
    child.on('error', (error: Error) => {
      stderrChunks.push(error.message)
    })
    child.on('close', (code: number | null) => {
      lines.close()
      resolve({
        code: code ?? -1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      })
    })
    if (options.signal !== undefined) {
      const abort = (): void => { child.kill('SIGTERM') }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
  return {
    lines,
    completion,
    kill() { child.kill('SIGTERM') },
  }
}

/**
 * The WorkBuddy host adapter.
 *
 * One adapter may drive several conversations, but never two turns of the same
 * conversation at once: WorkBuddy persists a session through a resumable CLI
 * process, and a second concurrent run would interleave two writers.
 */
export class WorkBuddyHostSessionAdapter implements HostSessionAdapter {
  readonly host = 'workbuddy' as const
  readonly displayName = 'WorkBuddy'
  private readonly options: WorkBuddyHostSessionOptions
  private readonly run: WorkBuddyStreamRunner
  private readonly now: () => number
  private readonly newSessionId: () => string
  private readonly sessions = new Map<string, WorkBuddySession>()

  /**
   * @param options - CLI path, optional runner and model default.
   */
  constructor(options: WorkBuddyHostSessionOptions) {
    this.options = options
    this.run = options.run ?? ((args, runOptions) => spawnWorkBuddy(options.cliPath, args, runOptions))
    this.now = options.now ?? (() => Date.now())
    this.newSessionId = options.newSessionId ?? (() => `workbuddy-${randomUUID()}`)
  }

  /** Complete capability matrix for the headless WorkBuddy CLI. */
  capabilities(): HostSessionCapabilityReport {
    const states: Record<HostSessionCapability, HostCapabilityState> = {
      listWorkspaces: {
        status: 'unsupported',
        reason: 'the CLI exposes no workspace listing; the desktop REST listing requires the host-issued password',
      },
      createSession: { status: 'supported', detail: 'reserves the identity and creates the conversation by running its first prompt' },
      sendPrompt: { status: 'supported', detail: 'one resumable --print run per turn' },
      openSession: {
        status: 'unsupported',
        reason: 'the CLI can resume an interactive terminal, but exposes no stable GUI conversation route',
      },
      subscribeEvents: { status: 'supported', detail: 'stream-json events of runs this adapter starts' },
      getUsage: { status: 'supported', detail: 'usage reported by the last completed run' },
      selectModel: { status: 'supported', detail: 'applied to the next turn; a running turn cannot switch model' },
      listModels: {
        status: 'unsupported',
        reason: 'the CLI accepts --model but exposes no command that lists its available models',
      },
      skills: {
        status: 'unsupported',
        reason: 'the CLI exposes no agent preset or skill composition flag; the desktop composition owns skills',
      },
      permissions: {
        status: 'unsupported',
        reason: 'the CLI exposes no permission preset flag; approval policy belongs to the desktop session',
      },
      compaction: {
        status: 'unsupported',
        reason: 'the CLI exposes no compaction control or event; context management stays inside the CLI',
      },
    }
    return capabilityReport(this.host, this.displayName, states)
  }

  /** Disabled: the CLI has no workspace listing. */
  async listWorkspaces(): Promise<HostSessionResult<readonly HostWorkspace[]>> {
    return unsupportedCapability(
      this.host,
      'listWorkspaces',
      'the CLI exposes no workspace listing; the desktop REST listing requires the host-issued password',
    )
  }

  /** Reserve one conversation identity and run its first prompt. */
  async createSession(request: HostCreateSessionRequest): Promise<HostSessionResult<HostSessionRef>> {
    const capability = 'createSession'
    if (request.prompt.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'a WorkBuddy conversation needs a non-empty first prompt')
    }
    if (request.workspaceId !== undefined) {
      return failedCapability(
        this.host,
        capability,
        'invalid-request',
        'WorkBuddy selects its directory with --add-dir/cwd; workspace ids are not exposed by the CLI',
      )
    }
    const sessionId = request.sessionId ?? this.newSessionId()
    if (this.sessions.has(sessionId)) {
      return failedCapability(this.host, capability, 'host-failed', `session '${sessionId}' already exists in this adapter`)
    }
    const model = request.model ?? this.options.defaultModel
    this.sessions.set(sessionId, {
      listener: new Set(),
      pendingModel: model,
      buffered: [],
      usage: undefined,
      active: false,
    })
    const delivered = await this.runTurn(sessionId, request.prompt, request.cwd, false)
    if (!delivered.ok) {
      this.sessions.delete(sessionId)
      return { ok: false, failure: delivered.failure }
    }
    return succeeded({
      sessionId,
      ...(model === undefined ? {} : { model }),
    })
  }

  /** Run one resumable turn in an existing conversation. */
  async sendPrompt(sessionId: string, prompt: string): Promise<HostSessionResult<void>> {
    const capability = 'sendPrompt'
    if (prompt.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'a prompt cannot be empty')
    }
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      return failedCapability(this.host, capability, 'unknown-session', `session '${sessionId}' is not known to this adapter`)
    }
    return await this.runTurn(sessionId, prompt, undefined, true)
  }

  /** Disabled: the CLI exposes no stable GUI route. */
  async openSession(_sessionId: string): Promise<HostSessionResult<{ readonly route: string }>> {
    return unsupportedCapability(
      this.host,
      'openSession',
      'the CLI can resume an interactive terminal, but exposes no stable GUI conversation route',
    )
  }

  /** Observe the streamed events of runs this adapter starts. */
  async subscribeEvents(
    sessionId: string,
    listener: HostSessionListener,
  ): Promise<HostSessionResult<() => void>> {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = { listener: new Set(), pendingModel: undefined, buffered: [], usage: undefined, active: false }
      this.sessions.set(sessionId, session)
    }
    session.listener.add(listener)
    for (const event of session.buffered) listener(event)
    return succeeded(() => { session.listener.delete(listener) })
  }

  /** Read usage reported by the last completed run. */
  async getUsage(sessionId: string): Promise<HostSessionResult<HostSessionUsage>> {
    const session = this.sessions.get(sessionId)
    if (session?.usage === undefined) {
      return failedCapability(
        this.host,
        'getUsage',
        'unknown-session',
        `no completed run has reported usage for session '${sessionId}'`,
      )
    }
    return succeeded(session.usage)
  }

  /** Select the model for the next turn. */
  async selectModel(
    sessionId: string,
    selection: HostModelSelection,
  ): Promise<HostSessionResult<void>> {
    const capability = 'selectModel'
    if (selection.provider.trim() === '' || selection.model.trim() === '') {
      return failedCapability(this.host, capability, 'invalid-request', 'provider and model must be non-empty')
    }
    const session = this.sessions.get(sessionId)
    if (session?.active === true) {
      return unsupportedCapability(this.host, capability, 'a WorkBuddy turn is running; its model cannot change mid-turn')
    }
    if (session === undefined) {
      this.sessions.set(sessionId, {
        listener: new Set(),
        pendingModel: selection,
        buffered: [],
        usage: undefined,
        active: false,
      })
      return succeeded(undefined)
    }
    this.sessions.set(sessionId, { ...session, pendingModel: selection })
    return succeeded(undefined)
  }

  /** Run one turn and fan its parsed events out to subscribers. */
  private async runTurn(
    sessionId: string,
    prompt: string,
    cwd: string | undefined,
    resume: boolean,
  ): Promise<HostSessionResult<void>> {
    const capability = 'sendPrompt'
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      return failedCapability(this.host, capability, 'unknown-session', `session '${sessionId}' is not known to this adapter`)
    }
    if (session.active) {
      return failedCapability(this.host, capability, 'host-failed', `session '${sessionId}' already has a running turn`)
    }
    const model = session.pendingModel ?? this.options.defaultModel
    const active: WorkBuddySession = { ...session, active: true }
    this.sessions.set(sessionId, active)
    const handle = this.run(turnArgs(sessionId, prompt, model, resume), {
      ...(cwd === undefined ? {} : { cwd }),
    })
    let usage: HostSessionUsage | undefined
    const emit = (event: HostSessionEvent): void => {
      const current = this.sessions.get(sessionId) ?? active
      const buffered = [...current.buffered, event].slice(-EVENT_BUFFER_LIMIT)
      this.sessions.set(sessionId, { ...current, buffered })
      for (const listener of current.listener) listener(event)
    }
    try {
      for await (const line of handle.lines) {
        const parsed = parseStreamLine(line, this.now())
        if (parsed === undefined) continue
        if (parsed.usage !== undefined) usage = parsed.usage
        for (const event of parsed.events) emit(event)
      }
      const result = await handle.completion
      const current = this.sessions.get(sessionId) ?? active
      this.sessions.set(sessionId, {
        ...current,
        active: false,
        ...(usage === undefined ? {} : { usage }),
      })
      if (result.code !== 0) {
        const message = result.stderr.trim() === '' ? `WorkBuddy exited with code ${result.code}` : result.stderr.trim()
        emit({ type: 'error', message, at: this.now() })
        return failedCapability(this.host, capability, 'host-failed', message)
      }
      return succeeded(undefined)
    } catch (error) {
      const current = this.sessions.get(sessionId) ?? active
      this.sessions.set(sessionId, { ...current, active: false })
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', message, at: this.now() })
      return failedCapability(this.host, capability, 'host-failed', message)
    } finally {
      handle.kill()
    }
  }
}

/**
 * Locate the WorkBuddy headless CLI on this machine.
 *
 * The explicit environment variable wins; otherwise common per-user install
 * roots are checked. No directory is assumed to exist.
 * @param env - environment to inspect; defaults to `process.env`.
 * @returns the CLI entry path, or `undefined` when WorkBuddy is not installed.
 */
export function discoverWorkBuddyCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.WORKBUDDY_CLI
  if (explicit !== undefined && explicit.trim() !== '' && existsSync(explicit)) return explicit
  const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    join(local, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'),
    join(local, 'Programs', 'CodeBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Build a WorkBuddy adapter when the CLI exists.
 * @param options - optional overrides; the CLI path is discovered when omitted.
 * @returns the adapter, or `undefined` when WorkBuddy is not installed.
 */
export function createWorkBuddyHostSessionAdapter(
  options: Partial<WorkBuddyHostSessionOptions> = {},
): WorkBuddyHostSessionAdapter | undefined {
  const cliPath = options.cliPath ?? discoverWorkBuddyCli()
  if (cliPath === undefined || cliPath.trim() === '') return undefined
  return new WorkBuddyHostSessionAdapter({ ...options, cliPath })
}
