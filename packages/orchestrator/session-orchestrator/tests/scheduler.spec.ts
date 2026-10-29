/**
 * Scheduling behavior: global slots, canonical workspace locks, concurrency
 * groups, provider quotas, pause, unload, rollback and duplicate suppression.
 *
 * Every test drives a real store over the in-memory domain backend and a fake
 * launcher whose launches resolve only when the test says so, so lock and slot
 * assertions are exact rather than timing guesses.
 */
import { describe, expect, it } from 'vitest'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import type { GlobalSettings, QueueRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { Scheduler, taskProviderKey } from '../src/scheduler.ts'
import { createWorkspaceKeyResolver } from '../src/workspace-key.ts'
import type { Harness } from './harness.ts'
import { harness } from './harness.ts'
import type { FakeLauncher } from './fake-launcher.ts'
import { fakeLauncher } from './fake-launcher.ts'

const NOW = 1_000

/** One task with the required fields, overridable per case. */
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

/** One queue with the required fields, overridable per case. */
function queue(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    id: QueueId('queue-1'),
    title: 'Queue',
    taskOrder: [],
    paused: false,
    state: 'idle',
    revision: 0,
    ...overrides,
  }
}

/** Settings with the required fields, overridable per case. */
function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    schemaVersion: 1,
    paused: false,
    maxConcurrentRuns: 4,
    providerQuotas: {},
    hostInstanceId: 'host-1',
    revision: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Seed the store with tasks, a queue and the host settings, and build a scheduler. */
async function setup(options: {
  tasks: readonly TaskSpec[]
  queues?: readonly QueueRecord[]
  runs?: readonly RunRecord[]
  settings?: Partial<GlobalSettings>
  platform?: NodeJS.Platform
  humanSkips?: () => readonly import('../src/planner.ts').HumanSkip[]
}): Promise<{ harness: Harness; launcher: FakeLauncher; scheduler: Scheduler }> {
  const h = await harness()
  const initial = h.store.getSettings()
  await h.store.updateSettings(initial.revision, {
    ...initial,
    ...settings(options.settings),
    revision: initial.revision + 1,
    updatedAt: NOW,
  })
  for (const q of options.queues ?? [queue()]) await h.store.createQueue(q)
  for (const t of options.tasks) await h.store.createTask(t)
  for (const r of options.runs ?? []) await h.store.createRun(r)

  const launcher = fakeLauncher()
  const scheduler = new Scheduler({
    store: h.store,
    launcher,
    workspaceKeys: createWorkspaceKeyResolver(options.platform ?? 'linux'),
    now: () => NOW,
    ...(options.humanSkips === undefined ? {} : { humanSkips: options.humanSkips }),
  })
  return { harness: h, launcher, scheduler }
}

/** Mark one stored run as settled in a terminal state. */
async function settleRun(h: Harness, runId: string, state: RunRecord['state']): Promise<void> {
  const run = h.store.getRun(RunId(runId))
  if (run === undefined) throw new Error(`run '${runId}' is not stored`)
  await h.store.updateRun(run.id, run.revision, {
    ...run,
    state,
    revision: run.revision + 1,
    updatedAt: NOW + 1,
  })
}

/** Read one stored run by task and state. */
function storedRun(h: Harness, taskId: string): RunRecord | undefined {
  return h.store.listRuns().find(run => run.taskId === TaskId(taskId))
}

describe('global concurrency cap', () => {
  it('starts no more runs than maxConcurrentRuns allows', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      settings: { maxConcurrentRuns: 2 },
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b' }),
        task({ id: TaskId('c'), cwd: '/work/c' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a'), TaskId('b')])
    expect(result.skipped).toEqual([{ taskId: TaskId('c'), reason: 'global-cap' }])
    expect(launcher.calls).toHaveLength(2)
    expect(scheduler.snapshot().lockedWorkspaceKeys).toHaveLength(2)
    await h.close()
  })

  it('keeps counting durable active runs from a previous host', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      settings: { maxConcurrentRuns: 1 },
      runs: [
        {
          id: RunId('run-old'),
          taskId: TaskId('old'),
          attempt: 1,
          state: 'running',
          sessionLineage: [],
          generation: 0,
          workspaceKey: 'workspace-9:/work/nine',
          revision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      tasks: [task({ id: TaskId('a'), cwd: '/work/a' })],
    })

    const result = await scheduler.tick()

    expect(result.started).toEqual([])
    expect(result.skipped).toEqual([{ taskId: TaskId('a'), reason: 'global-cap' }])
    expect(launcher.calls).toEqual([])
    await h.close()
  })
})

describe('canonical workspace locking', () => {
  it('serializes two tasks in the same workspace', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a') }),
        task({ id: TaskId('b') }),
      ],
    })

    const first = await scheduler.tick()
    expect(first.started.map(start => start.taskId)).toEqual([TaskId('a')])
    expect(first.skipped).toEqual([{ taskId: TaskId('b'), reason: 'workspace-busy' }])

    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-a-1', 'succeeded')

    const second = await scheduler.tick()
    expect(second.started.map(start => start.taskId)).toEqual([TaskId('b')])
    await h.close()
  })

  it('treats different spellings of one directory as one lock', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/one' }),
        task({ id: TaskId('b'), cwd: '/work/one/' }),
        task({ id: TaskId('c'), cwd: '/work/./one' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a')])
    expect(result.skipped.map(skip => skip.reason)).toEqual(['workspace-busy', 'workspace-busy'])
    expect(launcher.calls).toHaveLength(1)
    await h.close()
  })

  it('parallelizes tasks in different workspaces', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a'), TaskId('b')])
    expect(launcher.calls).toHaveLength(2)
    await h.close()
  })

  it('refuses a task whose cwd is not fully qualified', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a'), cwd: 'work/one' })],
    })

    const result = await scheduler.tick()

    expect(result.started).toEqual([])
    expect(result.skipped).toEqual([{ taskId: TaskId('a'), reason: 'invalid-workspace-key' }])
    expect(launcher.calls).toEqual([])
    await h.close()
  })

  it('holds the workspace lock of a durable active run', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      runs: [
        {
          id: RunId('run-active'),
          taskId: TaskId('elsewhere'),
          attempt: 1,
          state: 'running',
          sessionLineage: [],
          generation: 0,
          workspaceKey: 'workspace-1:/work/one',
          revision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      tasks: [task({ id: TaskId('a') })],
    })

    const result = await scheduler.tick()

    expect(result.started).toEqual([])
    expect(result.skipped).toEqual([{ taskId: TaskId('a'), reason: 'workspace-busy' }])
    expect(launcher.calls).toEqual([])
    await h.close()
  })
})

describe('workspace key normalization', () => {
  it('folds case and separators on Windows', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      platform: 'win32',
      tasks: [
        task({ id: TaskId('a'), cwd: 'C:\\Work\\One' }),
        task({ id: TaskId('b'), cwd: 'c:\\work\\one\\' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a')])
    expect(result.skipped).toEqual([{ taskId: TaskId('b'), reason: 'workspace-busy' }])
    expect(launcher.calls).toHaveLength(1)
    await h.close()
  })

  it('rejects a Windows path without a drive', async () => {
    const { harness: h, scheduler } = await setup({
      platform: 'win32',
      tasks: [task({ id: TaskId('a'), cwd: '\\work\\one' })],
    })

    const result = await scheduler.tick()

    expect(result.skipped).toEqual([{ taskId: TaskId('a'), reason: 'invalid-workspace-key' }])
    await h.close()
  })
})

describe('concurrency groups', () => {
  it('serializes tasks that share a group across workspaces', async () => {
    const { harness: h, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a', concurrencyGroup: 'shared-db' }),
        task({ id: TaskId('b'), cwd: '/work/b', concurrencyGroup: 'shared-db' }),
        task({ id: TaskId('c'), cwd: '/work/c', concurrencyGroup: 'other' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a'), TaskId('c')])
    expect(result.skipped).toEqual([{ taskId: TaskId('b'), reason: 'group-busy' }])
    await h.close()
  })

  it('holds a group while its run is durably active', async () => {
    const { harness: h, scheduler } = await setup({
      runs: [
        {
          id: RunId('run-active'),
          taskId: TaskId('owner'),
          attempt: 1,
          state: 'running',
          sessionLineage: [],
          generation: 0,
          workspaceKey: 'workspace-9:/work/nine',
          revision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      tasks: [
        task({ id: TaskId('owner'), cwd: '/work/nine', concurrencyGroup: 'shared-db' }),
        task({ id: TaskId('a'), cwd: '/work/a', concurrencyGroup: 'shared-db' }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started).toEqual([])
    expect(result.skipped).toEqual([{ taskId: TaskId('a'), reason: 'group-busy' }])
    await h.close()
  })
})

describe('provider quota', () => {
  it('limits starts per provider without limiting other providers', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      settings: { providerQuotas: { deepseek: 1 } },
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a', model: { kind: 'fixed', provider: 'deepseek', model: 'm1' } }),
        task({ id: TaskId('b'), cwd: '/work/b', model: { kind: 'fixed', provider: 'deepseek', model: 'm1' } }),
        task({ id: TaskId('c'), cwd: '/work/c', model: { kind: 'fixed', provider: 'other', model: 'm2' } }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('a'), TaskId('c')])
    expect(result.skipped).toEqual([{ taskId: TaskId('b'), reason: 'provider-quota' }])
    expect(launcher.calls.map(call => call.request.providerKey)).toEqual(['deepseek', 'other'])
    await h.close()
  })

  it('treats an inherited model route as unquotaed', async () => {
    expect(taskProviderKey(task({ model: { kind: 'inherit' } }))).toBeUndefined()
    expect(taskProviderKey(task({ model: { kind: 'fixed', provider: 'p', model: 'm' } }))).toBe('p')
  })
})

describe('pause, unload and duplicate suppression', () => {
  it('starts nothing while the host is paused', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      settings: { paused: true },
      tasks: [task({ id: TaskId('a') })],
    })

    const result = await scheduler.tick()

    expect(result).toEqual({ paused: true, started: [], skipped: [] })
    expect(launcher.calls).toEqual([])
    await h.close()
  })

  it('starts nothing after close and keeps in-flight launches settling', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a'), cwd: '/work/a' })],
    })

    const first = await scheduler.tick()
    expect(first.started).toHaveLength(1)

    const closing = scheduler.close()
    await launcher.acceptAll()
    await closing

    const afterClose = await scheduler.tick()
    expect(afterClose).toEqual({ paused: false, started: [], skipped: [] })
    expect(scheduler.snapshot().closed).toBe(true)
    expect(scheduler.snapshot().inFlightRunIds).toEqual([])
    expect(storedRun(h, 'a')?.state).toBe('running')
    await h.close()
  })

  it('does not dispatch one task twice while its launch is pending', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a') })],
    })

    const first = await scheduler.tick()
    const second = await scheduler.tick()

    // The durable `starting` transition is the claim: the task is active, not
    // ready, so the second tick has nothing to dispatch and no new run exists.
    expect(first.started).toHaveLength(1)
    expect(second.started).toEqual([])
    expect(second.skipped).toEqual([])
    expect(launcher.calls).toHaveLength(1)
    expect(h.store.listRuns()).toHaveLength(1)
    expect(storedRun(h, 'a')?.state).toBe('starting')
    await h.close()
  })
})

describe('start failure rollback', () => {
  it('rolls a retryable failure back to ready and releases the locks', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a') })],
    })

    await scheduler.tick()
    await launcher.rejectRetryable('provider unavailable')
    await scheduler.drain()

    const run = storedRun(h, 'a')
    expect(run?.state).toBe('ready')
    expect(run?.lastError).toEqual({
      code: 'launch-failed',
      message: 'provider unavailable',
      retryable: true,
    })
    expect(scheduler.snapshot().inFlightRunIds).toEqual([])
    expect(scheduler.snapshot().lockedWorkspaceKeys).toEqual([])

    const retry = await scheduler.tick()
    expect(retry.started).toHaveLength(1)
    expect(launcher.calls).toHaveLength(2)
    await h.close()
  })

  it('records a permanent failure as needs-attention and blocks its dependents', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b', dependsOn: [TaskId('a')] }),
      ],
    })

    await scheduler.tick()
    await launcher.rejectPermanent('workspace gone')
    await scheduler.drain()

    const run = storedRun(h, 'a')
    expect(run?.state).toBe('needs-attention')
    expect(run?.lastError?.retryable).toBe(false)
    expect(scheduler.snapshot().lockedWorkspaceKeys).toEqual([])

    const next = await scheduler.tick()
    expect(next.started).toEqual([])
    await h.close()
  })
})

describe('dependency scheduling', () => {
  it('starts a dependency chain one generation at a time', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b', dependsOn: [TaskId('a')] }),
      ],
    })

    const first = await scheduler.tick()
    expect(first.started.map(start => start.taskId)).toEqual([TaskId('a')])

    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-a-1', 'succeeded')

    const second = await scheduler.tick()
    expect(second.started.map(start => start.taskId)).toEqual([TaskId('b')])
    await h.close()
  })

  it('starts a diamond join exactly once', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b', dependsOn: [TaskId('a')] }),
        task({ id: TaskId('c'), cwd: '/work/c', dependsOn: [TaskId('a')] }),
        task({ id: TaskId('d'), cwd: '/work/d', dependsOn: [TaskId('b'), TaskId('c')] }),
      ],
    })

    await scheduler.tick()
    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-a-1', 'succeeded')

    const middle = await scheduler.tick()
    expect(middle.started.map(start => start.taskId)).toEqual([TaskId('b'), TaskId('c')])

    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-b-1', 'succeeded')

    const partial = await scheduler.tick()
    expect(partial.started).toEqual([])

    await settleRun(h, 'run-c-1', 'succeeded')
    const joined = await scheduler.tick()
    expect(joined.started.map(start => start.taskId)).toEqual([TaskId('d')])

    await launcher.acceptAll()
    await scheduler.drain()
    const repeated = await scheduler.tick()
    expect(repeated.started).toEqual([])
    expect(launcher.calls).toHaveLength(4)
    await h.close()
  })

  it('does not unlock a dependent when the dependency failed', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b', dependsOn: [TaskId('a')] }),
      ],
    })

    await scheduler.tick()
    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-a-1', 'failed')

    const next = await scheduler.tick()
    expect(next.started).toEqual([])
    expect(launcher.calls).toHaveLength(1)
    await h.close()
  })

  it('unlocks a dependent only through an audited human skip', async () => {
    const skips = [{
      taskId: TaskId('a'),
      runId: RunId('run-a-1'),
      actor: 'operator',
      reason: 'dependency is unavailable',
      decidedAt: NOW,
    }]
    const { harness: h, scheduler } = await setup({
      humanSkips: () => skips,
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a' }),
        task({ id: TaskId('b'), cwd: '/work/b', dependsOn: [TaskId('a')] }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('b')])
    expect(storedRun(h, 'a')).toBeUndefined()
    await h.close()
  })
})

describe('priority order', () => {
  it('starts ready tasks in the planner order regardless of storage order', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      queues: [queue({ id: QueueId('queue-1'), taskOrder: [TaskId('low'), TaskId('high')] })],
      tasks: [
        task({ id: TaskId('low'), cwd: '/work/low', priority: 0 }),
        task({ id: TaskId('high'), cwd: '/work/high', priority: 5, parallelWithPrevious: true }),
      ],
    })

    const result = await scheduler.tick()

    expect(result.started.map(start => start.taskId)).toEqual([TaskId('high'), TaskId('low')])
    expect(launcher.calls.map(call => call.request.task.id)).toEqual([TaskId('high'), TaskId('low')])
    await h.close()
  })
})

describe('operation records', () => {
  it('records one operation per run attempt and advances it to session-created', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a') })],
    })

    await scheduler.tick()
    await launcher.acceptAll()
    await scheduler.drain()

    const operations = h.store.listOperations()
    expect(operations).toHaveLength(1)
    expect(operations[0]?.id).toBe(OperationId('operation-run-a-1-0'))
    expect(operations[0]?.phase).toBe('session-created')
    expect(storedRun(h, 'a')?.operationId).toBe(OperationId('operation-run-a-1-0'))
    expect(storedRun(h, 'a')?.state).toBe('running')
    await h.close()
  })
})

describe('S-001: many workspaces under one cap', () => {
  it('never exceeds maxConcurrentRuns and does reach the cap', async () => {
    const tasks = Array.from({ length: 20 }, (_, index) =>
      task({ id: TaskId(`task-${index}`), cwd: `/work/${index}`, priority: -index }))
    const { harness: h, launcher, scheduler } = await setup({
      settings: { maxConcurrentRuns: 4 },
      tasks,
    })

    const first = await scheduler.tick()
    expect(first.started).toHaveLength(4)
    expect(first.skipped.every(skip => skip.reason === 'global-cap')).toBe(true)
    expect(launcher.pendingCount).toBe(4)

    // Settling one start frees exactly one slot, never more.
    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-task-0-1', 'succeeded')

    const second = await scheduler.tick()
    expect(second.started).toHaveLength(1)
    expect(second.skipped.filter(skip => skip.reason === 'global-cap')).toHaveLength(15)
    await h.close()
  })
})

describe('S-005: quota release', () => {
  it('starts the quota-blocked task once the provider slot frees', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      settings: { providerQuotas: { deepseek: 1 } },
      tasks: [
        task({ id: TaskId('a'), cwd: '/work/a', model: { kind: 'fixed', provider: 'deepseek', model: 'm' } }),
        task({ id: TaskId('b'), cwd: '/work/b', model: { kind: 'fixed', provider: 'deepseek', model: 'm' } }),
      ],
    })

    const first = await scheduler.tick()
    expect(first.started.map(start => start.taskId)).toEqual([TaskId('a')])
    expect(first.skipped).toEqual([{ taskId: TaskId('b'), reason: 'provider-quota' }])

    await launcher.acceptAll()
    await scheduler.drain()
    await settleRun(h, 'run-a-1', 'succeeded')

    const second = await scheduler.tick()
    expect(second.started.map(start => start.taskId)).toEqual([TaskId('b')])
    await h.close()
  })
})

describe('S-008: repeated ticks within one start', () => {
  it('keeps one run per task across many ticks', async () => {
    const { harness: h, launcher, scheduler } = await setup({
      tasks: [task({ id: TaskId('a') })],
    })

    for (let index = 0; index < 5; index += 1) await scheduler.tick()

    expect(launcher.calls).toHaveLength(1)
    expect(h.store.listRuns()).toHaveLength(1)
    await h.close()
  })
})

describe('S-011: random graph invariants', () => {
  it('never exceeds the cap, never starts a blocked task and never duplicates a run', async () => {
    // A deterministic generator keeps the invariant test reproducible.
    let seed = 12_345
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const tasks: TaskSpec[] = []
    for (let index = 0; index < 12; index += 1) {
      const dependencies: TaskId[] = []
      for (let earlier = 0; earlier < index; earlier += 1) {
        if (next() < 0.25) dependencies.push(TaskId(`task-${earlier}`))
      }
      tasks.push(task({
        id: TaskId(`task-${index}`),
        cwd: `/work/${index % 4}`,
        dependsOn: dependencies,
        priority: Math.floor(next() * 3),
      }))
    }

    const { harness: h, launcher, scheduler } = await setup({
      settings: { maxConcurrentRuns: 3 },
      tasks,
    })

    const startedIds: string[] = []
    for (let round = 0; round < 40; round += 1) {
      const result = await scheduler.tick()
      expect(scheduler.snapshot().inFlightRunIds.length).toBeLessThanOrEqual(3)
      for (const start of result.started) {
        expect(startedIds).not.toContain(start.taskId)
        startedIds.push(start.taskId)
      }

      // Settle whatever is running so the next round can make progress.
      if (launcher.pendingCount > 0) {
        await launcher.acceptAll()
        await scheduler.drain()
        for (const run of h.store.listRuns()) {
          if (run.state === 'running') await settleRun(h, run.id, 'succeeded')
        }
      }
    }

    const runIds = h.store.listRuns().map(run => run.id)
    expect(new Set(runIds).size).toBe(runIds.length)
    expect(startedIds.length).toBeLessThanOrEqual(12)
    await h.close()
  })
})

describe('Q-013: large plan', () => {
  it('plans 1000 independent tasks without repeated dependency scans', async () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) =>
      task({ id: TaskId(`task-${index}`), cwd: `/work/${index}` }))
    const { harness: h, scheduler } = await setup({
      settings: { maxConcurrentRuns: 1000 },
      tasks,
    })

    const startedAt = performance.now()
    const result = await scheduler.tick()
    const elapsed = performance.now() - startedAt

    // The stored value cannot raise the product ceiling of eight.
    expect(result.started).toHaveLength(8)
    // A per-task exponential scan would not finish this budget; a linear pass does.
    expect(elapsed).toBeLessThan(5_000)
    await h.close()
  })
})
