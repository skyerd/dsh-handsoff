/**
 * Product scheduling rules for the queue pipeline.
 *
 * These cases pin the behaviour the HandsOff UI promises: one queue runs
 * serially unless the author explicitly joins a group, eight runs is the hard
 * global ceiling, a settled predecessor that did not complete blocks its
 * successors, a paused task never harms an unrelated branch, and starting a
 * queue clears the host pause before it claims to run.
 *
 * The scheduler and planner are pure/deterministic over a real in-memory store,
 * so the mock is the launcher: no model is called and every start stays under
 * the test's control.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import { planReadyTasks } from '../src/planner.ts'
import type { PlannerInput, PlannerOutput } from '../src/planner.ts'
import { Scheduler } from '../src/scheduler.ts'
import { SessionOrchestratorController } from '../src/remote.ts'
import { createWorkspaceKeyResolver } from '../src/workspace-key.ts'
import type { QueueRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { fakeLauncher } from './fake-launcher.ts'

const NOW = 2_000

/** One stored task with the required fields, overridable per case. */
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
      ratio: 0.88,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 20,
      maxHandoffTokens: 4096,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

/** One stored queue with the required fields, overridable per case. */
function queue(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    id: QueueId('queue-1'),
    title: 'Queue',
    taskOrder: [],
    paused: false,
    state: 'running',
    revision: 0,
    ...overrides,
  }
}

/** One stored run with the required fields, overridable per case. */
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunId('run-1'),
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

/** Plan one snapshot with the defaults every case shares. */
function plan(overrides: Partial<PlannerInput> = {}): PlannerOutput {
  return planReadyTasks({
    tasks: [],
    queues: [queue()],
    runs: [],
    skips: [],
    globalPaused: false,
    ...overrides,
  })
}

/** Ready task ids in planned order. */
function readyIds(output: PlannerOutput): string[] {
  return output.ready.map(entry => String(entry.taskId))
}

const openHarnesses: Harness[] = []

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()
    if (h !== undefined) await h.close()
  }
})

describe('queue order', () => {
  it('starts two list-ordered tasks serially and only after the first succeeded', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b') })
    const tasks = [a, b]
    const queues = [queue({ taskOrder: [a.id, b.id] })]

    const first = plan({ tasks, queues })
    expect(readyIds(first)).toEqual(['a'])
    expect(first.blocked).toContainEqual({
      taskId: b.id,
      blocker: { kind: 'dependency-pending', dependencyId: a.id, state: 'never-started' },
    })

    const after = plan({
      tasks,
      queues,
      runs: [run({ id: RunId('run-a-1'), taskId: a.id, state: 'succeeded' })],
    })
    expect(readyIds(after)).toEqual(['b'])
  })

  it('keeps a parallel sibling running when the task before it paused', () => {
    const a = task({ id: TaskId('a') })
    const branch = task({ id: TaskId('branch'), parallelWithPrevious: true })
    const later = task({ id: TaskId('later') })
    const queues = [queue({ taskOrder: [a.id, branch.id, later.id] })]

    const output = plan({
      tasks: [a, branch, later],
      queues,
      runs: [run({ id: RunId('run-a-1'), taskId: a.id, state: 'paused' })],
    })

    expect(readyIds(output)).toEqual(['branch'])
    expect(output.blocked).toContainEqual({
      taskId: later.id,
      blocker: { kind: 'dependency-pending', dependencyId: a.id, state: 'paused' },
    })
    // `branch` joined the first group, so the paused task is not its predecessor.
    expect(output.blocked.some(entry => entry.taskId === branch.id)).toBe(false)
  })

  it('does not launch successors of a failed, paused or needs-attention task', () => {
    for (const state of ['failed', 'paused', 'cancelled'] as const) {
      const a = task({ id: TaskId('a') })
      const b = task({ id: TaskId('b') })
      const output = plan({
        tasks: [a, b],
        queues: [queue({ taskOrder: [a.id, b.id] })],
        runs: [run({ id: RunId('run-a-1'), taskId: a.id, state })],
      })
      expect(readyIds(output)).toEqual([])
      expect(output.blocked).toContainEqual({
        taskId: b.id,
        blocker: { kind: 'dependency-pending', dependencyId: a.id, state },
      })
    }

    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b') })
    const attention = plan({
      tasks: [a, b],
      queues: [queue({ taskOrder: [a.id, b.id] })],
      runs: [run({ id: RunId('run-a-1'), taskId: a.id, state: 'needs-attention' })],
    })
    expect(readyIds(attention)).toEqual([])
    expect(attention.blocked).toContainEqual({
      taskId: b.id,
      blocker: { kind: 'dependency-needs-attention', dependencyId: a.id },
    })
  })
})

describe('deferred hand-over', () => {
  it('does not release the original successor until every derived child succeeded', () => {
    const parent = task({ id: TaskId('parent') })
    const child = task({
      id: TaskId('parent-c1'),
      parentTaskId: parent.id,
      dependsOn: [parent.id],
      cwd: '/work/child',
    })
    const successor = task({
      id: TaskId('successor'),
      dependsOn: [parent.id],
      cwd: '/work/successor',
    })
    const tasks = [parent, child, successor]
    const queues = [queue({ taskOrder: [parent.id, child.id, successor.id] })]

    const parentDeferred = plan({
      tasks,
      queues,
      runs: [run({ id: RunId('run-parent-1'), taskId: parent.id, state: 'deferred' })],
    })
    // The derived child runs because of the hand-over; the original successor
    // waits for it.
    expect(readyIds(parentDeferred)).toEqual(['parent-c1'])
    expect(parentDeferred.blocked).toContainEqual({
      taskId: successor.id,
      blocker: {
        kind: 'dependency-deferred-incomplete',
        dependencyId: parent.id,
        pending: [child.id],
      },
    })

    const childDone = plan({
      tasks,
      queues,
      runs: [
        run({ id: RunId('run-parent-1'), taskId: parent.id, state: 'deferred' }),
        run({ id: RunId('run-parent-c1-1'), taskId: child.id, state: 'succeeded' }),
      ],
    })
    expect(readyIds(childDone)).toEqual(['successor'])
  })

  it('keeps a deferred task terminal when no child was derived', () => {
    const parent = task({ id: TaskId('parent') })
    const successor = task({ id: TaskId('successor') })
    const output = plan({
      tasks: [parent, successor],
      queues: [queue({ taskOrder: [parent.id, successor.id] })],
      runs: [run({ id: RunId('run-parent-1'), taskId: parent.id, state: 'deferred' })],
    })

    expect(readyIds(output)).toEqual([])
    expect(output.blocked).toContainEqual({
      taskId: successor.id,
      blocker: {
        kind: 'dependency-deferred-incomplete',
        dependencyId: parent.id,
        pending: [],
      },
    })
  })
})

describe('paused and aborted sources', () => {
  it('blocks a dependent whose source queue was aborted', () => {
    const source = task({ id: TaskId('source'), queueId: QueueId('queue-source') })
    const dependent = task({ id: TaskId('dependent'), dependsOn: [source.id] })
    const output = plan({
      tasks: [source, dependent],
      queues: [
        queue({ id: QueueId('queue-source'), state: 'aborted', paused: true }),
        queue(),
      ],
    })

    expect(readyIds(output)).toEqual([])
    expect(output.blocked).toContainEqual({
      taskId: dependent.id,
      blocker: { kind: 'dependency-aborted', dependencyId: source.id },
    })
  })

  it('does not harm an unrelated parallel branch when one task is paused', () => {
    const paused = task({ id: TaskId('paused'), queueId: QueueId('queue-1') })
    const dependent = task({
      id: TaskId('dependent'),
      queueId: QueueId('queue-1'),
      dependsOn: [paused.id],
    })
    const unrelated = task({ id: TaskId('unrelated'), queueId: QueueId('queue-2') })
    const output = plan({
      tasks: [paused, dependent, unrelated],
      queues: [
        queue({ taskOrder: [paused.id, dependent.id] }),
        queue({ id: QueueId('queue-2') }),
      ],
      runs: [run({ id: RunId('run-paused-1'), taskId: paused.id, state: 'paused' })],
    })

    expect(readyIds(output)).toEqual(['unrelated'])
    expect(output.blocked).toContainEqual({
      taskId: dependent.id,
      blocker: { kind: 'dependency-pending', dependencyId: paused.id, state: 'paused' },
    })
  })
})

describe('global scheduling limits', () => {
  it('runs at most eight tasks even when the stored setting asks for more', async () => {
    const h = await harness()
    openHarnesses.push(h)
    const initial = h.store.getSettings()
    await h.store.updateSettings(initial.revision, {
      ...initial,
      paused: false,
      maxConcurrentRuns: 100,
      revision: initial.revision + 1,
      updatedAt: NOW,
    })
    await h.store.createQueue(queue({ taskOrder: [] }))
    const tasks = Array.from({ length: 10 }, (_, index) =>
      task({ id: TaskId(`task-${index}`), cwd: `/work/${index}` }))
    for (const item of tasks) await h.store.createTask(item)

    const launcher = fakeLauncher()
    const scheduler = new Scheduler({
      store: h.store,
      launcher,
      workspaceKeys: createWorkspaceKeyResolver('linux'),
      now: () => NOW,
    })

    const result = await scheduler.tick()
    expect(result.started).toHaveLength(8)
    expect(result.skipped.every(skip => skip.reason === 'global-cap')).toBe(true)
    expect(launcher.pendingCount).toBe(8)
  })

  it('reuses the durable run after a restart and never creates a second attempt', async () => {
    const first = await harness()
    openHarnesses.push(first)
    const initial = first.store.getSettings()
    await first.store.updateSettings(initial.revision, {
      ...initial,
      paused: false,
      revision: initial.revision + 1,
      updatedAt: NOW,
    })
    await first.store.createQueue(queue({ taskOrder: [TaskId('a'), TaskId('b')] }))
    await first.store.createTask(task({ id: TaskId('a'), cwd: '/work/a' }))
    await first.store.createTask(task({ id: TaskId('b'), cwd: '/work/b' }))

    const launcher = fakeLauncher()
    const scheduler = new Scheduler({
      store: first.store,
      launcher,
      workspaceKeys: createWorkspaceKeyResolver('linux'),
      now: () => NOW,
    })
    await scheduler.tick()
    expect(first.store.listRuns()).toHaveLength(1)
    await launcher.acceptAll()
    await scheduler.drain()

    // Reopen the same medium: this is a host restart, not a fresh pipeline.
    await first.close()
    openHarnesses.pop()
    const second = await harness(first.pool)
    openHarnesses.push(second)

    const secondLauncher = fakeLauncher()
    const restarted = new Scheduler({
      store: second.store,
      launcher: secondLauncher,
      workspaceKeys: createWorkspaceKeyResolver('linux'),
      now: () => NOW,
    })
    await restarted.tick()
    expect(secondLauncher.calls).toHaveLength(0)
    expect(second.store.listRuns()).toHaveLength(1)

    const live = second.store.listRuns()[0]
    expect(live?.state).toBe('running')
    if (live === undefined) throw new Error('the durable run disappeared')
    await second.store.updateRun(live.id, live.revision, {
      ...live,
      state: 'succeeded',
      revision: live.revision + 1,
      updatedAt: NOW + 1,
    })

    await restarted.tick()
    const runs = second.store.listRuns()
    expect(runs).toHaveLength(2)
    expect(runs.map(candidate => candidate.id)).toEqual([
      RunId('run-a-1'),
      RunId('run-b-1'),
    ])
    expect(secondLauncher.calls.map(call => call.request.task.id)).toEqual([TaskId('b')])
  })
})

describe('pipeline route authoring', () => {
  it('stores the pipeline route and leaves every stage inheriting it', async () => {
    const h = await harness()
    openHarnesses.push(h)
    const controller = new SessionOrchestratorController(h.ctx, {})
    const created = await controller.createPipelineTemplate({
      expectedRevision: 0,
      queueId: 'q-route',
      brief: 'Build the parser',
      workspaceId: 'workspace-1',
      cwd: '/work/one',
      model: { kind: 'fixed', provider: 'pipeline', model: 'pipeline-model' },
    }, new AbortController().signal)

    expect(created.queue.model).toEqual({ kind: 'fixed', provider: 'pipeline', model: 'pipeline-model' })
    expect(created.tasks).toHaveLength(4)
    expect(created.tasks.every(task => task.model.kind === 'inherit')).toBe(true)

    const stored = h.store.getQueue(QueueId('q-route'))
    if (stored === undefined) throw new Error('the template queue disappeared')
    const updated = await controller.updateQueue({
      queueId: 'q-route',
      expectedRevision: stored.revision,
      draft: {
        id: 'q-route',
        title: stored.title,
        taskOrder: [...stored.taskOrder],
        paused: true,
        model: { kind: 'inherit' },
      },
    }, new AbortController().signal)
    expect(updated.queue.model).toEqual({ kind: 'inherit' })
  })
})

describe('start pipeline', () => {
  it('clears the host pause, marks the queue running and ticks before returning', async () => {
    const h = await harness()
    openHarnesses.push(h)
    let ticks = 0
    const launcher = fakeLauncher()
    const scheduler = new Scheduler({
      store: h.store,
      launcher,
      workspaceKeys: createWorkspaceKeyResolver('linux'),
      now: () => NOW,
    })
    h.ctx.provide('sessionOrchestratorRuntime', {
      tick: async (): Promise<void> => {
        ticks += 1
        await scheduler.tick()
      },
    })
    await h.store.createQueue(queue({
      taskOrder: [TaskId('task-1')],
      paused: true,
      state: 'idle',
    }))
    await h.store.createTask(task({ id: TaskId('task-1'), cwd: '/work/one' }))
    expect(h.store.getSettings().paused).toBe(true)

    const controller = new SessionOrchestratorController(h.ctx, {})
    const started = await controller.startQueue({
      queueId: 'queue-1',
      expectedRevision: 0,
    }, new AbortController().signal)

    expect(started.queue.state).toBe('running')
    expect(started.queue.paused).toBe(false)
    expect(h.store.getSettings().paused).toBe(false)
    expect(ticks).toBe(1)
    expect(h.store.getQueue(QueueId('queue-1'))?.state).toBe('running')
    expect(h.store.getQueue(QueueId('queue-1'))?.paused).toBe(false)
    // The kick dispatched before the call returned: a queue that says `running`
    // is never quietly waiting for the next interval.
    expect(h.store.listRuns().map(run => run.id)).toEqual([RunId('run-task-1-1')])
    expect(h.store.listRuns()[0]?.state).toBe('starting')
    expect(launcher.pendingCount).toBe(1)

    // A repeated click adopts the same running state and the same attempt.
    await controller.startQueue({
      queueId: 'queue-1',
      expectedRevision: started.queue.revision,
    }, new AbortController().signal)
    expect(h.store.listRuns()).toHaveLength(1)
    expect(ticks).toBe(2)
    expect(launcher.pendingCount).toBe(1)
  })
})
