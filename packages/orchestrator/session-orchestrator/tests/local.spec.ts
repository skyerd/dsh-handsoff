/**
 * Host-local wiring: the scheduler adapter and the recovery gate over one run
 * supervisor. Every Session is a fake agent; no model work runs here.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import { SupervisorLauncher } from '../src/launcher.ts'
import { LocalSessionOrchestrator } from '../src/local.ts'
import { SessionOrchestratorController } from '../src/remote.ts'
import { RunSupervisor } from '../src/supervisor.ts'
import type { RunLaunchStart, RunSettlement, RunStartRequest } from '../src/supervisor.ts'
import {
  FakeDurableSessions,
  FakeLiveSessions,
  operationFixture,
  runFixture,
  taskFixture,
} from './recovery-fakes.ts'
import { FakeAgents, FakeDurability } from './fake-agent.ts'
import { harness } from './harness.ts'

function settlement(sessionId: SessionId): RunSettlement {
  return {
    runId: runFixture().id,
    state: 'needs-attention',
    reason: 'restart-uncertain',
    committed: true,
    sessionId,
    acceptedTurnEndSeq: undefined,
    turns: 0,
    duplicates: 0,
    flushParticipated: false,
    disposeError: undefined,
    detail: 'fixture',
  }
}

/** A completed settlement for a launched fake attempt. */
function completedSettlement(runId: RunId, sessionId: SessionId): RunSettlement {
  return {
    runId,
    state: 'succeeded',
    reason: 'completed',
    committed: true,
    sessionId,
    acceptedTurnEndSeq: undefined,
    turns: 1,
    duplicates: 0,
    flushParticipated: true,
    disposeError: undefined,
    detail: undefined,
  }
}

/**
 * Compose a local orchestrator whose store owns one audited skip for task A.
 * Task B depends on A, so only the default skip-ledger wiring can start B.
 */
async function skipLedgerFixture(
  options: { readonly newerAttempt?: boolean; readonly viaController?: boolean } = {},
) {
  const h = await harness()
  const taskA = taskFixture({
    id: TaskId('task-a'),
    title: 'Task A',
    workspaceId: 'workspace-a',
    cwd: '/work/a',
  })
  const taskB = taskFixture({
    id: TaskId('task-b'),
    title: 'Task B',
    dependsOn: [taskA.id],
    workspaceId: 'workspace-b',
    cwd: '/work/b',
  })
  await h.store.createQueue({
    id: QueueId('queue-1'),
    title: 'Queue',
    taskOrder: [taskA.id, taskB.id],
    paused: false,
    state: 'idle',
    revision: 0,
  })
  await h.store.createTask(taskA)
  await h.store.createTask(taskB)
  const runA = runFixture({
    id: RunId('run-task-a-1'),
    taskId: taskA.id,
    attempt: 1,
    state: 'needs-attention',
    workspaceKey: 'workspace-a:/work/a',
  })
  await h.store.createRun(runA)
  if (options.viaController === true) {
    const controller = new SessionOrchestratorController(h.ctx, {})
    await controller.skipTask({
      runId: runA.id,
      expectedRevision: 0,
      actor: 'alice',
      reason: 'handled manually',
    }, new AbortController().signal)
  } else {
    await h.store.recordSkip({
      taskId: taskA.id,
      runId: runA.id,
      actor: 'alice',
      reason: 'handled manually',
      decidedAt: 10_000,
      runRevision: 0,
    })
  }
  if (options.newerAttempt === true) {
    await h.store.createRun(runFixture({
      id: RunId('run-task-a-2'),
      taskId: taskA.id,
      attempt: 2,
      state: 'needs-attention',
      workspaceKey: 'workspace-a:/work/a',
    }))
  }
  const initial = h.store.getSettings()
  await h.store.updateSettings(initial.revision, {
    ...initial,
    paused: false,
    revision: initial.revision + 1,
    updatedAt: 10_000,
  })

  const launched: RunStartRequest[] = []
  const supervisor = new RunSupervisor({
    ctx: h.ctx,
    store: h.store,
    sessions: new FakeDurability(),
    liveSessions: new FakeLiveSessions(),
    agents: new FakeAgents(h.ctx),
    now: () => 10_000,
  })
  supervisor.launch = async (request: RunStartRequest): Promise<RunLaunchStart> => {
    launched.push(request)
    const sessionId = SessionId(`session-${request.run.id}`)
    return {
      runId: request.run.id,
      sessionId,
      settlement: Promise.resolve(completedSettlement(request.run.id, sessionId)),
    }
  }
  const local = new LocalSessionOrchestrator({
    store: h.store,
    supervisor,
    durableSessions: new FakeDurableSessions(),
    sessions: new FakeLiveSessions(),
    hostInstanceId: 'host-a',
    now: () => 10_000,
    workspaceKeys: {
      resolve: task => ({ ok: true, workspaceKey: `workspace-key:${task.id}` }),
    },
  })
  return { h, local, launched, taskA, taskB }
}

describe('SupervisorLauncher', () => {
  it('forwards the claimed attempt and returns the held Session to the scheduler', async () => {
    const run = runFixture({ state: 'starting' })
    const task = taskFixture()
    const held: SessionId = SessionId('session-held')
    const launch = vi.fn(async (_request: RunStartRequest): Promise<RunLaunchStart> => ({
      runId: run.id,
      sessionId: held,
      settlement: Promise.resolve(settlement(held)),
    }))
    const launcher = new SupervisorLauncher({ supervisor: { launch } })

    const outcome = await launcher.launch({
      run,
      task,
      workspaceKey: 'workspace-key',
      providerKey: 'fixture',
      operationId: operationFixture(run).id,
    })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      run,
      task,
      operationId: operationFixture(run).id,
    })
    expect(outcome).toEqual({ activeSessionId: held, providerKey: 'fixture' })
  })
})

describe('LocalSessionOrchestrator', () => {
  it('keeps the scheduler closed before reconcile, then launches exactly one Session', async () => {
    const h = await harness()
    const task = taskFixture()
    const queue = {
      id: QueueId('queue-1'),
      title: 'Queue',
      taskOrder: [task.id],
      paused: false,
      state: 'idle' as const,
      revision: 0,
    }
    await h.store.createQueue(queue)
    await h.store.createTask(task)
    const run = runFixture({ state: 'ready', workspaceKey: 'workspace-key' })
    const operation = operationFixture(run)
    await h.store.planOperation(operation)
    await h.store.createRun(run)
    const initial = h.store.getSettings()
    await h.store.updateSettings(initial.revision, {
      ...initial,
      paused: false,
      revision: initial.revision + 1,
      updatedAt: 10_000,
    })

    const durable = new FakeDurableSessions()
    const live = new FakeLiveSessions()
    const agents = new FakeAgents(h.ctx)
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: new FakeDurability(),
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => 10_000,
    })
    const local = new LocalSessionOrchestrator({
      store: h.store,
      supervisor,
      durableSessions: durable,
      sessions: live,
      hostInstanceId: 'host-a',
      now: () => 10_000,
    })

    try {
      const closed = await local.tick()
      expect(closed.ran).toBe(false)
      expect(h.store.getRun(run.id)?.state).toBe('ready')
      expect(agents.created).toHaveLength(0)

      expect((await local.reconcile()).schedulerOpen).toBe(true)
      expect(local.schedulerOpen).toBe(true)

      const first = await local.tick()
      expect(first.ran).toBe(true)
      expect(first.result?.started).toHaveLength(1)
      await local.scheduler.drain()
      expect(agents.created).toHaveLength(1)
      await agents.created[0]!.waitForIdleWait()
      const launched = h.store.getRun(run.id)
      expect(launched).toMatchObject({
        state: 'running',
        activeSessionId: SessionId('session-run-1-0'),
      })

      const second = await local.tick()
      await local.scheduler.drain()
      expect(second.result?.started).toHaveLength(0)
      expect(agents.created).toHaveLength(1)

      for (const agent of agents.created) agent.releaseIdle()
      await supervisor.whenSettled(run.id)
    } finally {
      await local.close()
      await h.close()
    }
  })

  it('reads the store skip ledger by default and starts the dependent task', async () => {
    const fixture = await skipLedgerFixture()
    try {
      const result = await fixture.local.scheduler.tick()
      expect(result.started.map(start => start.taskId)).toEqual([fixture.taskB.id])
      expect(fixture.launched.map(request => request.task.id)).toEqual([fixture.taskB.id])
    } finally {
      await fixture.local.close()
      await fixture.h.close()
    }
  })

  it('propagates a Remote skipTask decision into the default scheduler ledger', async () => {
    const fixture = await skipLedgerFixture({ viaController: true })
    try {
      const result = await fixture.local.scheduler.tick()
      expect(result.started.map(start => start.taskId)).toEqual([fixture.taskB.id])
      expect(fixture.launched.map(request => request.task.id)).toEqual([fixture.taskB.id])
    } finally {
      await fixture.local.close()
      await fixture.h.close()
    }
  })

  it('does not apply a skip recorded against an older attempt', async () => {
    const fixture = await skipLedgerFixture({ newerAttempt: true })
    try {
      const result = await fixture.local.scheduler.tick()
      expect(result.started).toEqual([])
      expect(fixture.launched).toEqual([])
      expect(fixture.h.store.listSkips()).toHaveLength(1)
    } finally {
      await fixture.local.close()
      await fixture.h.close()
    }
  })

  it('unloads scheduler, then supervisor, then the domain', async () => {
    const h = await harness()
    const order: string[] = []
    const agents = new FakeAgents(h.ctx)
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: new FakeDurability(),
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => 10_000,
    })
    const local = new LocalSessionOrchestrator({
      store: h.store,
      supervisor,
      durableSessions: new FakeDurableSessions(),
      sessions: new FakeLiveSessions(),
      hostInstanceId: 'host-a',
      now: () => 10_000,
      closeDomain: async () => {
        order.push('domain')
        await h.store.close()
      },
    })
    const schedulerClose = local.scheduler.close.bind(local.scheduler)
    local.scheduler.close = async () => {
      order.push('scheduler')
      await schedulerClose()
    }
    const supervisorClose = supervisor.close.bind(supervisor)
    supervisor.close = async () => {
      order.push('supervisor')
      await supervisorClose()
    }

    await local.close()
    expect(order).toEqual(['scheduler', 'supervisor', 'domain'])
    await h.close()
  })
})
