/**
 * Model inheritance across a pipeline, a task and a live conversation.
 *
 * A task inherits the pipeline route unless it pins its own. The resolution is
 * fixed when the Session is created; re-holding a conversation after a
 * completed turn keeps the route its own log already froze, so editing a task
 * or pipeline can never switch a live model.
 *
 * The host is the in-memory harness store plus the deterministic agent
 * launcher; no platform capability is simulated here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import { frozenModelOf, previousConversationModel, resolveTaskModel } from '../src/model-route.ts'
import { Scheduler } from '../src/scheduler.ts'
import { RunSupervisor } from '../src/supervisor.ts'
import type { OperationRecord, QueueRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { fakeLauncher } from './fake-launcher.ts'
import { event, FakeAgents, FakeDurability, humanMessage } from './fake-agent.ts'
import { FakeLiveSessions } from './recovery-fakes.ts'

const NOW = 2_000

/** One stored task that inherits by default. */
function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Task',
    prompt: 'Do the thing',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: 0.6,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 4,
      maxHandoffTokens: 8_000,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

/** One stored queue with an optional pipeline route. */
function queue(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    id: QueueId('queue-1'),
    title: 'Queue',
    taskOrder: [TaskId('task-1')],
    paused: false,
    state: 'running',
    revision: 0,
    ...overrides,
  }
}

/** One stored run attempt. */
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunId('run-task-1-1'),
    taskId: TaskId('task-1'),
    attempt: 1,
    state: 'ready',
    sessionLineage: [],
    generation: 0,
    workspaceKey: 'workspace-1:/work/one',
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** One planned initial-prompt operation. */
function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: OperationId('operation-1'),
    runId: RunId('run-task-1-1'),
    generation: 0,
    attempt: 1,
    kind: 'initial-prompt',
    phase: 'planned',
    requestHash: 'hash-a',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Unpause the host scheduler so dispatch is not masked by the global gate. */
async function unpause(h: Harness): Promise<void> {
  const settings = h.store.getSettings()
  await h.store.updateSettings(settings.revision, {
    ...settings,
    paused: false,
    revision: settings.revision + 1,
    updatedAt: NOW,
  })
}

/** Compose one scheduler over the harness store and the manual launcher. */
function schedulerOver(h: Harness, launcher: ReturnType<typeof fakeLauncher>): Scheduler {
  return new Scheduler({
    store: h.store,
    launcher,
    now: () => NOW,
    workspaceKeys: { resolve: () => ({ ok: true, workspaceKey: 'workspace-1:/work/one' }) },
  })
}

const openHarnesses: Harness[] = []

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()
    if (h !== undefined) await h.close()
  }
})

describe('route resolution', () => {
  it('prefers a pinned task route, then the pipeline route, then the previous conversation, then the host default', () => {
    const pipeline = queue({ model: { kind: 'fixed', provider: 'p', model: 'm' } })
    const previous = { kind: 'fixed' as const, provider: 'previous', model: 'previous-model' }
    expect(resolveTaskModel(task(), pipeline, previous)).toEqual({ kind: 'fixed', provider: 'p', model: 'm' })
    expect(resolveTaskModel(task({ model: { kind: 'fixed', provider: 'own', model: 'own-m' } }), pipeline, previous))
      .toEqual({ kind: 'fixed', provider: 'own', model: 'own-m' })
    expect(resolveTaskModel(task(), queue({ model: { kind: 'inherit' } }), previous))
      .toEqual(previous)
    expect(resolveTaskModel(task(), queue({ model: { kind: 'inherit' } })))
      .toEqual({ kind: 'inherit' })
    expect(resolveTaskModel(task(), undefined)).toEqual({ kind: 'inherit' })
  })

  it('reads the previous conversation route from its latest frozen snapshot', () => {
    const tasks = [task(), task({ id: TaskId('task-2'), dependsOn: [TaskId('task-1')] })]
    const pipeline = queue({ taskOrder: [TaskId('task-1'), TaskId('task-2')] })
    const runs = [run({
      state: 'succeeded',
      configSnapshot: {
        routeSource: 'completed-turn-header',
        provider: 'previous',
        model: 'previous-model',
        reasoningEffort: 'high',
        preset: { id: 'default' },
        capturedAt: NOW,
      },
    })]
    expect(previousConversationModel(tasks[1]!, pipeline, tasks, runs))
      .toEqual({ kind: 'fixed', provider: 'previous', model: 'previous-model', reasoningEffort: 'high' })
    expect(previousConversationModel(tasks[0]!, pipeline, tasks, runs)).toBeUndefined()

    const switched = [
      task({ model: { kind: 'fixed', provider: 'switched', model: 'switched-model' } }),
      tasks[1]!,
    ]
    expect(previousConversationModel(tasks[1]!, pipeline, switched, runs))
      .toEqual({ kind: 'fixed', provider: 'switched', model: 'switched-model' })
  })

  it('freezes the route a completed boundary already committed', () => {
    expect(frozenModelOf({
      routeSource: 'completed-turn-header',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
      preset: { id: 'default' },
      capturedAt: NOW,
    })).toEqual({ kind: 'fixed', provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})

describe('dispatch-time inheritance', () => {
  it('hands the pipeline route to a task that inherits it', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    await h.store.createQueue(queue({ model: { kind: 'fixed', provider: 'pipeline', model: 'pipeline-model' } }))
    await h.store.createTask(task())
    const launcher = fakeLauncher()
    const scheduler = schedulerOver(h, launcher)

    const tick = await scheduler.tick()
    expect(tick.started.map(start => String(start.taskId))).toEqual(['task-1'])
    expect(launcher.calls[0]?.request.task.model).toEqual({
      kind: 'fixed', provider: 'pipeline', model: 'pipeline-model',
    })
    expect(launcher.calls[0]?.request.providerKey).toBe('pipeline')
    expect(h.store.getRun(RunId('run-task-1-1'))?.providerKey).toBe('pipeline')

    await launcher.acceptAll()
    await scheduler.drain()
    await scheduler.close()
  })

  it('keeps a task route that overrides the pipeline route', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    await h.store.createQueue(queue({ model: { kind: 'fixed', provider: 'pipeline', model: 'pipeline-model' } }))
    await h.store.createTask(task({ model: { kind: 'fixed', provider: 'own', model: 'own-model' } }))
    const launcher = fakeLauncher()
    const scheduler = schedulerOver(h, launcher)

    await scheduler.tick()
    expect(launcher.calls[0]?.request.task.model).toEqual({
      kind: 'fixed', provider: 'own', model: 'own-model',
    })
    expect(launcher.calls[0]?.request.providerKey).toBe('own')

    await launcher.acceptAll()
    await scheduler.drain()
    await scheduler.close()
  })

  it('leaves the host default in charge when neither task nor pipeline pins a route', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    await h.store.createQueue(queue({ model: { kind: 'inherit' } }))
    await h.store.createTask(task())
    const launcher = fakeLauncher()
    const scheduler = schedulerOver(h, launcher)

    await scheduler.tick()
    expect(launcher.calls[0]?.request.task.model).toEqual({ kind: 'inherit' })
    expect(launcher.calls[0]?.request.providerKey).toBeUndefined()

    await launcher.acceptAll()
    await scheduler.drain()
    await scheduler.close()
  })

  it('inherits the route the previous task conversation actually used', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    const first = task({ model: { kind: 'fixed', provider: 'previous', model: 'previous-model', reasoningEffort: 'high' } })
    const second = task({ id: TaskId('task-2'), dependsOn: [TaskId('task-1')] })
    await h.store.createQueue(queue({ taskOrder: [first.id, second.id] }))
    await h.store.createTask(first)
    await h.store.createTask(second)
    await h.store.createRun(run({
      state: 'succeeded',
      activeSessionId: SessionId('session-run-task-1-1-0'),
      sessionLineage: [SessionId('session-run-task-1-1-0')],
      configSnapshot: {
        routeSource: 'completed-turn-header',
        provider: 'previous',
        model: 'previous-model',
        reasoningEffort: 'high',
        preset: { id: 'default' },
        capturedAt: NOW + 1,
      },
    }))
    const launcher = fakeLauncher()
    const scheduler = schedulerOver(h, launcher)

    const tick = await scheduler.tick()
    expect(tick.started.map(start => String(start.taskId))).toEqual(['task-2'])
    expect(launcher.calls[0]?.request.task.model).toEqual({
      kind: 'fixed', provider: 'previous', model: 'previous-model', reasoningEffort: 'high',
    })
    expect(launcher.calls[0]?.request.providerKey).toBe('previous')

    await launcher.acceptAll()
    await scheduler.drain()
    await scheduler.close()
  })
})

describe('creation-time model', () => {
  it('creates the Supervisor agent with the inherited pipeline route', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    await h.store.createQueue(queue({ model: { kind: 'fixed', provider: 'pipeline', model: 'pipeline-model' } }))
    const spec = task()
    await h.store.createTask(spec)
    const base = run()
    await h.store.createRun(base)
    const planned = operation()
    await h.store.planOperation(planned)
    const starting = await h.store.updateRun(base.id, 0, {
      ...base,
      state: 'starting',
      operationId: planned.id,
      revision: 1,
      updatedAt: NOW + 1,
    })
    const agents = new FakeAgents(h.ctx)
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: new FakeDurability(),
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => NOW,
    })
    try {
      const settlement = supervisor.start({ run: starting, task: spec, operationId: planned.id })
      const agent = await agents.waitForCreate()
      const prompt = await agent.waitForFollowup()
      await agent.waitForIdleWait()
      expect(agents.createOptions[0]?.agentOptions).toEqual({
        provider: 'pipeline', model: 'pipeline-model',
      })
      agent.emit(event('turn/start', 0, { turn: 1 }))
      agent.emit(event('user/message', 1, prompt))
      agent.emit(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
      agent.releaseIdle()
      expect(await settlement).toMatchObject({ state: 'succeeded' })
    } finally {
      for (const created of agents.created) created.releaseIdle()
      await supervisor.close()
    }
  })

  it('resolves and mounts a fixed agent preset on the created composition', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    await h.store.createQueue(queue())
    const spec = task({ preset: { kind: 'fixed', id: 'skills-preset' } })
    await h.store.createTask(spec)
    const base = run()
    await h.store.createRun(base)
    const planned = operation()
    await h.store.planOperation(planned)
    const starting = await h.store.updateRun(base.id, 0, {
      ...base,
      state: 'starting',
      operationId: planned.id,
      revision: 1,
      updatedAt: NOW + 1,
    })
    const calls: string[] = []
    const presets = {
      resolve: async (id: string) => { calls.push(`resolve:${id}`) },
      mount: async (_ctx: unknown, id: string) => { calls.push(`mount:${id}`) },
    }
    const agents = new FakeAgents(h.ctx)
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: new FakeDurability(),
      liveSessions: new FakeLiveSessions(),
      agents,
      presets,
      now: () => NOW,
    })
    try {
      const settlement = supervisor.start({ run: starting, task: spec, operationId: planned.id })
      const agent = await agents.waitForCreate()
      expect(calls).toEqual(['resolve:skills-preset'])
      const setup = agents.createOptions[0]?.setup
      expect(setup).toBeDefined()
      await setup?.(h.ctx, agent)
      expect(calls).toEqual(['resolve:skills-preset', 'mount:skills-preset'])
      const prompt = await agent.waitForFollowup()
      await agent.waitForIdleWait()
      agent.emit(event('turn/start', 0, { turn: 1 }))
      agent.emit(event('user/message', 1, prompt))
      agent.emit(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
      agent.releaseIdle()
      expect(await settlement).toMatchObject({ state: 'succeeded' })
    } finally {
      for (const created of agents.created) created.releaseIdle()
      await supervisor.close()
    }
  })

  it('re-holds a resumed conversation with its frozen route, not the edited pipeline route', async () => {
    const h = await harness()
    openHarnesses.push(h)
    await unpause(h)
    // The pipeline was edited to a new route after the conversation succeeded.
    await h.store.createQueue(queue({ model: { kind: 'fixed', provider: 'edited', model: 'edited-model' } }))
    const spec = task()
    await h.store.createTask(spec)
    const sessionId = SessionId('session-1')
    const recorded = run({
      state: 'running',
      activeSessionId: sessionId,
      sessionLineage: [sessionId],
      generation: 0,
      configSnapshot: {
        routeSource: 'completed-turn-header',
        provider: 'frozen',
        model: 'frozen-model',
        preset: { id: 'default' },
        capturedAt: NOW,
      },
    })
    await h.store.createRun(recorded)
    const claimed = operation({ phase: 'claimed', messageId: 'message-1' })
    await h.store.planOperation(claimed)
    const agents = new FakeAgents(h.ctx)
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: new FakeDurability(),
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => NOW,
    })
    try {
      await supervisor.resume({
        run: recorded,
        task: spec,
        operationId: claimed.id,
        sessionId,
        submitPrompt: false,
        progress: {
          accepted: [],
          endedTurns: [],
          lastSeq: 0,
          externalInput: false,
          pendingApprovals: [],
          runOwnedMessages: [],
        },
      })
      expect(agents.resumeOptions[0]?.agentOptions).toEqual({
        provider: 'frozen', model: 'frozen-model',
      })
      // Let the resumed observation reach a boundary so close() can await it.
      const resumed = await agents.waitForResume()
      await resumed.waitForIdleWait()
      resumed.emit(event('turn/start', 0, { turn: 1 }))
      resumed.emit(event('user/message', 1, humanMessage('resumed work')))
      resumed.emit(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
      resumed.releaseIdle()
    } finally {
      for (const resumed of agents.resumed) resumed.releaseIdle()
      await supervisor.close()
    }
  })
})
