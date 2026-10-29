import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HostSessionRegistry, HostSessionUnavailableError, createDefaultHostSessionRegistry } from '../src/host-registry.ts'
import { createDshHostSessionAdapter } from '../src/host-dsh.ts'
import type { DshHostWorkspace, DshHostWorkspaces } from '../src/host-dsh.ts'
import { WorkBuddyHostSessionAdapter } from '../src/host-workbuddy.ts'
import type { WorkBuddyRunHandle, WorkBuddyStreamRunner } from '../src/host-workbuddy.ts'
import { createTraeHostSessionAdapter } from '../src/host-trae.ts'
import type { HostSessionEvent } from '../src/host-session.ts'
import { event, FakeAgents } from './fake-agent.ts'
import { FakeLiveSessions } from './recovery-fakes.ts'
import { FakeTokenMeter } from './fake-token-meter.ts'

/** One workspace double that records attach calls. */
function workspace(id = 'ws-1'): DshHostWorkspace & { attached: SessionId[] } {
  const attached: SessionId[] = []
  return {
    id,
    name: 'Harness project',
    path: 'C:/work/harness',
    attached,
    attachSession: async (sessionId: SessionId) => { attached.push(sessionId) },
  }
}

/** Workspace registry double over one workspace. */
function workspaces(...items: readonly DshHostWorkspace[]): DshHostWorkspaces {
  return {
    list: () => items,
    get: id => items.find(item => item.id === id),
  }
}

/** A CLI runner that replays fixed NDJSON lines after the turn was accepted. */
function runnerOf(
  lines: readonly string[],
  code = 0,
  seen: string[][] = [],
): WorkBuddyStreamRunner {
  return (args) => {
    seen.push([...args])
    const stream = async function* (): AsyncIterable<string> {
      for (const line of lines) yield line
    }
    const handle: WorkBuddyRunHandle = {
      lines: stream(),
      completion: Promise.resolve({ code, stdout: lines.join('\n'), stderr: code === 0 ? '' : 'failed' }),
      kill: () => {},
    }
    return handle
  }
}

/** NDJSON lines of one successful WorkBuddy turn. */
const WORKBUDDY_TURN = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wb-1' }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10 },
  }),
]

describe('DshHostSessionAdapter', () => {
  it('creates a real Agent, joins the workspace and delivers the first prompt', async () => {
    const ctx = new Context()
    const agents = new FakeAgents(ctx)
    const ws = workspace()
    const live = new FakeLiveSessions()
    const adapter = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      workspaces: workspaces(ws),
      liveSessions: live,
      openRoute: id => `/session/${id}`,
    })

    const created = await adapter.createSession({
      sessionId: 'session-host-1',
      workspaceId: 'ws-1',
      prompt: 'implement the parser',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    })

    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value).toMatchObject({
      sessionId: 'session-host-1',
      workspaceId: 'ws-1',
      route: '/session/session-host-1',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(ws.attached.map(id => String(id))).toEqual(['session-host-1'])
    const agent = agents.created[0]
    expect(agent).toBeDefined()
    expect(agent?.followups).toHaveLength(1)
    expect(agent?.followups[0]?.content).toEqual([{ type: 'text', text: 'implement the parser' }])
    expect(agents.createOptions[0]?.agentOptions).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('reports unknown workspaces and disabled optional seams without inventing success', async () => {
    const ctx = new Context()
    const agents = new FakeAgents(ctx)
    const adapter = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      workspaces: workspaces(workspace()),
    })

    const unknown = await adapter.createSession({ workspaceId: 'missing', prompt: 'x' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.failure.reason).toBe('unknown-workspace')

    const open = await adapter.openSession('session-1')
    expect(open).toEqual({
      ok: false,
      failure: {
        capability: 'openSession',
        host: 'dsh',
        reason: 'unsupported',
        detail: 'the host exposes no same-origin Session route',
      },
    })
    const usage = await adapter.getUsage('session-1')
    expect(usage.ok).toBe(false)
    if (!usage.ok) expect(usage.failure.reason).toBe('unsupported')
  })

  it('maps Session events and reads measured usage', async () => {
    const ctx = new Context()
    const agents = new FakeAgents(ctx)
    const live = new FakeLiveSessions()
    const meter = new FakeTokenMeter()
    meter.setReading(900, 'usage')
    const adapter = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      liveSessions: live,
      meter,
    })
    const created = await adapter.createSession({ sessionId: 'session-host-2', cwd: 'C:/work', prompt: 'go' })
    expect(created.ok).toBe(true)
    const agent = agents.created[0]
    if (agent === undefined) throw new Error('the adapter did not create an agent')
    live.put(agent.session)

    const events: HostSessionEvent[] = []
    const subscription = await adapter.subscribeEvents('session-host-2', emitted => { events.push(emitted) })
    expect(subscription.ok).toBe(true)
    agent.emit(event('turn/start', 1, { turn: 0 }))
    agent.emit(event('tool/call', 2, {
      turn: 0,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'bash',
      arguments: '{}',
    }))
    agent.emit(event('tool/result', 3, {
      turn: 0,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }))
    expect(events.map(e => e.type)).toEqual(['turn/start', 'tool'])
    expect(events[1]).toMatchObject({ type: 'tool', name: 'bash', ok: true })

    const usage = await adapter.getUsage('session-host-2')
    expect(usage).toMatchObject({ ok: true, value: { totalTokens: 900, estimated: false } })
  })

  it('selects a model before creation and refuses to switch a live one', async () => {
    const ctx = new Context()
    const agents = new FakeAgents(ctx)
    const adapter = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
    })
    const selected = await adapter.selectModel('session-host-3', { provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(selected.ok).toBe(true)
    const created = await adapter.createSession({ sessionId: 'session-host-3', cwd: 'C:/work', prompt: 'go' })
    expect(created.ok).toBe(true)
    expect(agents.createOptions[0]?.agentOptions).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    const liveSwitch = await adapter.selectModel('session-host-3', { provider: 'deepseek', model: 'other' })
    expect(liveSwitch.ok).toBe(false)
    if (!liveSwitch.ok) expect(liveSwitch.failure.reason).toBe('unsupported')
  })

  it('reports only the host features the composition mounted', async () => {
    const ctx = new Context()
    const agents = new FakeAgents(ctx)
    const bare = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
    })
    expect(bare.capabilities().capabilities).toMatchObject({
      listModels: { status: 'unsupported', reason: 'the host mounted no LLM model catalog service' },
      skills: { status: 'unsupported', reason: 'the host mounted no agent preset registry to compose skills' },
      permissions: { status: 'unsupported', reason: 'the host mounted no permission preset service' },
      compaction: { status: 'unsupported', reason: 'the host mounted no context compaction service' },
    })

    const mounted = createDshHostSessionAdapter({
      agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      support: { modelCatalog: true, skills: true, permissions: true, compaction: true },
    })
    expect(mounted.capabilities().capabilities).toMatchObject({
      listModels: { status: 'supported' },
      skills: { status: 'supported' },
      permissions: { status: 'supported' },
      compaction: { status: 'supported' },
    })
  })
})

describe('WorkBuddyHostSessionAdapter', () => {
  it('drives the real CLI flags, buffers events and reads usage', async () => {
    const seen: string[][] = []
    const adapter = new WorkBuddyHostSessionAdapter({
      cliPath: '/fake/codebuddy.mjs',
      run: runnerOf(WORKBUDDY_TURN, 0, seen),
    })
    const created = await adapter.createSession({
      sessionId: 'wb-1',
      cwd: 'C:/work',
      prompt: 'implement it',
      model: { provider: 'codebuddy', model: 'deepseek-v3-2-volc' },
    })
    expect(created.ok).toBe(true)
    const args = seen[0] ?? []
    expect(args).toContain('--session-id')
    expect(args).toContain('wb-1')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--model')
    expect(args).toContain('deepseek-v3-2-volc')
    expect(args.at(-1)).toBe('implement it')

    const events: HostSessionEvent[] = []
    const subscription = await adapter.subscribeEvents('wb-1', emitted => { events.push(emitted) })
    expect(subscription.ok).toBe(true)
    expect(events.map(event => event.type)).toEqual(['turn/start', 'assistant/text', 'assistant/text', 'turn/end'])

    const usage = await adapter.getUsage('wb-1')
    expect(usage).toMatchObject({
      ok: true,
      value: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 10, totalTokens: 160 },
    })
  })

  it('resumes a known conversation and reports disabled list/open honestly', async () => {
    const seen: string[][] = []
    const adapter = new WorkBuddyHostSessionAdapter({
      cliPath: '/fake/codebuddy.mjs',
      run: runnerOf(WORKBUDDY_TURN, 0, seen),
    })
    await adapter.createSession({ sessionId: 'wb-2', cwd: 'C:/work', prompt: 'one' })
    const sent = await adapter.sendPrompt('wb-2', 'two')
    expect(sent.ok).toBe(true)
    expect(seen[1]).toContain('--resume')
    expect(seen[1]).toContain('wb-2')

    const listed = await adapter.listWorkspaces()
    expect(listed.ok).toBe(false)
    if (!listed.ok) expect(listed.failure.reason).toBe('unsupported')
    const opened = await adapter.openSession('wb-2')
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.failure.reason).toBe('unsupported')
  })

  it('fails a running turn instead of pretending it completed', async () => {
    const adapter = new WorkBuddyHostSessionAdapter({
      cliPath: '/fake/codebuddy.mjs',
      run: runnerOf([], 2),
    })
    const created = await adapter.createSession({ sessionId: 'wb-3', cwd: 'C:/work', prompt: 'fail' })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.failure.reason).toBe('host-failed')
  })
})

describe('TraeHostSessionAdapter', () => {
  it('disables every conversation capability with the missing surface', async () => {
    const adapter = createTraeHostSessionAdapter({ installed: true })
    const report = adapter.capabilities()
    expect(report).toMatchObject({ host: 'trae', available: true, runnable: false })
    expect(Object.values(report.capabilities).every(state => state.status === 'unsupported')).toBe(true)
    const calls = [
      adapter.listWorkspaces(),
      adapter.createSession({ prompt: 'x' }),
      adapter.sendPrompt('s', 'x'),
      adapter.openSession('s'),
      adapter.subscribeEvents('s', () => {}),
      adapter.getUsage('s'),
      adapter.selectModel('s', { provider: 'p', model: 'm' }),
    ]
    const results = await Promise.all(calls)
    expect(results.every(result => !result.ok && result.failure.reason === 'unsupported')).toBe(true)
  })
})

describe('HostSessionRegistry', () => {
  it('reports the primary first and refuses a host without the queue trio', () => {
    const ctx = new Context()
    const dsh = createDshHostSessionAdapter({
      agents: new FakeAgents(ctx),
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
    })
    const trae = createTraeHostSessionAdapter({ installed: true })
    const registry = new HostSessionRegistry({ adapters: [trae, dsh], primary: 'dsh' })
    expect(registry.reports().map(report => report.host)).toEqual(['dsh', 'trae'])
    expect(registry.requireRunnable('dsh')).toBe(dsh)
    expect(() => registry.requireRunnable('trae')).toThrow(HostSessionUnavailableError)
    try {
      registry.requireRunnable('trae')
    } catch (error) {
      expect(error).toBeInstanceOf(HostSessionUnavailableError)
      if (error instanceof HostSessionUnavailableError) {
        expect(error.reason).toContain('createSession')
        expect(error.reason).toContain('no public conversation')
      }
    }
  })

  it('builds DSH plus the Trae report and only adds WorkBuddy when its CLI exists', () => {
    const ctx = new Context()
    const registry = createDefaultHostSessionRegistry({
      dsh: {
        agents: new FakeAgents(ctx),
        events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      },
      env: {},
      includeTrae: true,
    })
    expect(registry.reports().map(report => report.host)).toEqual(['dsh', 'trae'])
  })

  it('never reports a fake runnable WorkBuddy without its CLI', () => {
    const ctx = new Context()
    const registry = createDefaultHostSessionRegistry({
      dsh: {
        agents: new FakeAgents(ctx),
        events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      },
      env: {},
      includeWorkBuddy: true,
    })
    expect(registry.reports().some(report => report.host === 'workbuddy')).toBe(false)
  })

  it('keeps DSH as the queue backend while WorkBuddy stays partial and Trae stays disabled', () => {
    const ctx = new Context()
    const dsh = createDshHostSessionAdapter({
      agents: new FakeAgents(ctx),
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
    })
    const workbuddy = new WorkBuddyHostSessionAdapter({ cliPath: 'C:/fake/codebuddy.mjs' })
    const trae = createTraeHostSessionAdapter({ installed: true })
    const registry = new HostSessionRegistry({ adapters: [dsh, workbuddy, trae], primary: 'dsh' })
    expect(registry.reports()[0]?.host).toBe('dsh')

    const workbuddyReport = registry.reports().find(report => report.host === 'workbuddy')
    expect(workbuddyReport?.capabilities.createSession.status).toBe('supported')
    expect(workbuddyReport?.capabilities.openSession.status).toBe('unsupported')
    expect(workbuddyReport?.capabilities.listWorkspaces.status).toBe('unsupported')

    const traeReport = registry.reports().find(report => report.host === 'trae')
    expect(traeReport?.runnable).toBe(false)
    expect(Object.values(traeReport?.capabilities ?? {}).every(state => state.status === 'unsupported')).toBe(true)
  })
})
