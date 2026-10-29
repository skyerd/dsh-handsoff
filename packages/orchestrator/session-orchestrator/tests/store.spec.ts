/** Authoritative record validation, revision CAS, FIFO ordering, restart and close semantics. */
import { describe, expect, it } from 'vitest'
import { OrchestratorError } from '../src/errors.ts'
import { INITIAL_GLOBAL_SETTINGS, sessionOrchestratorDomain } from '../src/storage.ts'
import type { GlobalSettings, OperationRecord, QueueRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import { harness } from './harness.ts'

/** A stored task with the required fields, overridable per case. */
function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'First task',
    prompt: 'Do the first thing',
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

/** A stored queue with the required fields, overridable per case. */
function queue(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    id: QueueId('queue-1'),
    title: 'Queue one',
    taskOrder: [],
    paused: false,
    state: 'idle',
    revision: 0,
    ...overrides,
  }
}

/** A stored run with the required fields, overridable per case. */
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
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** A stored operation with the required fields, overridable per case. */
function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: OperationId('operation-1'),
    runId: RunId('run-1'),
    generation: 0,
    attempt: 1,
    kind: 'initial-prompt',
    phase: 'planned',
    requestHash: 'hash-a',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe('schema validation', () => {
  it('accepts a valid task and rejects an invalid one', () => {
    expect(sessionOrchestratorDomain.tables.tasks.valueSchema.safeParse(task()).success).toBe(true)
    expect(sessionOrchestratorDomain.tables.tasks.valueSchema.safeParse({
      ...task(),
      handoff: { ...task().handoff, ratio: 0.99 },
    }).success).toBe(false)
  })

  it('rejects a self-dependency and an unknown field', () => {
    expect(sessionOrchestratorDomain.tables.tasks.valueSchema.safeParse(
      task({ dependsOn: [TaskId('task-1')] }),
    ).success).toBe(false)
    expect(sessionOrchestratorDomain.tables.tasks.valueSchema.safeParse(
      { ...task(), unexpected: true },
    ).success).toBe(false)
  })

  it('rejects a run whose generation does not index its lineage', () => {
    expect(sessionOrchestratorDomain.tables.runs.valueSchema.safeParse(run()).success).toBe(true)
    expect(sessionOrchestratorDomain.tables.runs.valueSchema.safeParse(
      run({ sessionLineage: [], generation: 1 }),
    ).success).toBe(false)
  })

  it('rejects an invalid global settings value', () => {
    expect(sessionOrchestratorDomain.global?.schema.safeParse(INITIAL_GLOBAL_SETTINGS).success).toBe(true)
    expect(sessionOrchestratorDomain.global?.schema.safeParse({
      ...INITIAL_GLOBAL_SETTINGS,
      maxConcurrentRuns: 0,
    }).success).toBe(false)
  })
})

describe('store writes', () => {
  it('stores a task and reads it back', async () => {
    const { store, close } = await harness()
    try {
      const stored = await store.createTask(task())
      expect(stored.revision).toBe(0)
      expect(store.getTask(TaskId('task-1'))?.title).toBe('First task')
      expect(store.listTasks()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('rejects a duplicate task id', async () => {
    const { store, close } = await harness()
    try {
      await store.createTask(task())
      await expect(store.createTask(task())).rejects.toMatchObject({ code: 'already-exists' })
    } finally {
      await close()
    }
  })

  it('rejects a task created above revision 0', async () => {
    const { store, close } = await harness()
    try {
      await expect(store.createTask(task({ revision: 3 }))).rejects.toMatchObject({
        code: 'invalid-transition',
      })
    } finally {
      await close()
    }
  })

  it('replaces a task under revision CAS', async () => {
    const { store, close } = await harness()
    try {
      await store.createTask(task())
      const next = task({ title: 'Renamed', revision: 1 })
      const stored = await store.updateTask(TaskId('task-1'), 0, next)
      expect(stored.title).toBe('Renamed')
      expect(store.getTask(TaskId('task-1'))?.revision).toBe(1)
    } finally {
      await close()
    }
  })

  it('rejects a stale revision and leaves the record unchanged', async () => {
    const { store, close } = await harness()
    try {
      await store.createTask(task())
      await store.updateTask(TaskId('task-1'), 0, task({ title: 'Second', revision: 1 }))
      await expect(
        store.updateTask(TaskId('task-1'), 0, task({ title: 'Third', revision: 1 })),
      ).rejects.toBeInstanceOf(OrchestratorError)
      expect(store.getTask(TaskId('task-1'))?.title).toBe('Second')
    } finally {
      await close()
    }
  })

  it('rejects an update of a missing record', async () => {
    const { store, close } = await harness()
    try {
      await expect(
        store.updateQueue(QueueId('missing'), 0, queue({ id: QueueId('missing'), revision: 1 })),
      ).rejects.toMatchObject({ code: 'not-found' })
    } finally {
      await close()
    }
  })

  it('applies queued writes in submission order', async () => {
    const { store, close } = await harness()
    try {
      await store.createTask(task())
      const writes = [0, 1, 2, 3, 4].map(index =>
        store.updateTask(TaskId('task-1'), index, task({ title: `edit-${index + 1}`, revision: index + 1 })))
      await Promise.all(writes)
      expect(store.getTask(TaskId('task-1'))?.title).toBe('edit-5')
      expect(store.getTask(TaskId('task-1'))?.revision).toBe(5)
    } finally {
      await close()
    }
  })
})

describe('run transitions', () => {
  it('moves a run through starting and running', async () => {
    const { store, close } = await harness()
    try {
      await store.createRun(run())
      await store.updateRun(RunId('run-1'), 0, run({ state: 'starting', revision: 1 }))
      await store.updateRun(RunId('run-1'), 1, run({ state: 'running', revision: 2 }))
      expect(store.getRun(RunId('run-1'))?.state).toBe('running')
    } finally {
      await close()
    }
  })

  it('rejects a second concurrent transition of the same run', async () => {
    const { store, close } = await harness()
    try {
      await store.createRun(run())
      const first = store.updateRun(RunId('run-1'), 0, run({ state: 'starting', revision: 1 }))
      const second = store.updateRun(RunId('run-1'), 0, run({ state: 'cancelled', revision: 1 }))
      await first
      await expect(second).rejects.toMatchObject({ code: 'revision-conflict' })
      expect(store.getRun(RunId('run-1'))?.state).toBe('starting')
    } finally {
      await close()
    }
  })
})

describe('operation identity', () => {
  it('treats the same id with the same hash as one operation', async () => {
    const { store, close } = await harness()
    try {
      const planned = await store.planOperation(operation())
      const repeated = await store.planOperation(operation({ phase: 'submitted' }))
      expect(repeated).toEqual(planned)
      expect(store.listOperations()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('rejects the same id with a different hash', async () => {
    const { store, close } = await harness()
    try {
      await store.planOperation(operation())
      await expect(store.planOperation(operation({ requestHash: 'hash-b' }))).rejects.toMatchObject({
        code: 'operation-hash-conflict',
      })
    } finally {
      await close()
    }
  })

  it('advances an operation only from the expected phase', async () => {
    const { store, close } = await harness()
    try {
      await store.planOperation(operation())
      await store.advanceOperation(OperationId('operation-1'), 'planned', operation({ phase: 'submitted' }))
      expect(store.getOperation(OperationId('operation-1'))?.phase).toBe('submitted')
      await expect(
        store.advanceOperation(OperationId('operation-1'), 'planned', operation({ phase: 'settled' })),
      ).rejects.toMatchObject({ code: 'revision-conflict' })
    } finally {
      await close()
    }
  })
})

describe('global settings', () => {
  it('serves the declared initial value before the first write', async () => {
    const { store, close } = await harness()
    try {
      expect(store.getSettings()).toEqual(INITIAL_GLOBAL_SETTINGS)
    } finally {
      await close()
    }
  })

  it('replaces settings under revision CAS', async () => {
    const { store, close } = await harness()
    try {
      const next: GlobalSettings = {
        ...INITIAL_GLOBAL_SETTINGS,
        paused: false,
        maxConcurrentRuns: 8,
        revision: 1,
        updatedAt: 2_000,
      }
      await store.updateSettings(0, next)
      expect(store.getSettings().maxConcurrentRuns).toBe(8)
      await expect(store.updateSettings(0, { ...next, revision: 1 })).rejects.toMatchObject({
        code: 'revision-conflict',
      })
    } finally {
      await close()
    }
  })
})

describe('restart and close', () => {
  it('recovers stored records after a restart', async () => {
    const first = await harness()
    try {
      await first.store.createTask(task())
      await first.store.createRun(run())
      await first.store.planOperation(operation())
      await first.store.updateSettings(0, { ...INITIAL_GLOBAL_SETTINGS, paused: false, revision: 1, updatedAt: 5 })
    } finally {
      await first.close()
    }
    const second = await harness(first.pool)
    try {
      expect(second.store.getTask(TaskId('task-1'))?.title).toBe('First task')
      expect(second.store.getRun(RunId('run-1'))?.state).toBe('ready')
      expect(second.store.getOperation(OperationId('operation-1'))?.phase).toBe('planned')
      expect(second.store.getSettings().paused).toBe(false)
    } finally {
      await second.close()
    }
  })

  it('opens a version-1 medium that predates the warden review ledger', async () => {
    const first = await harness()
    try {
      await first.store.createTask(task())
      await first.store.recordWardenAudit({
        id: 'wa-run-1-g0-1',
        runId: RunId('run-1'),
        taskId: TaskId('task-1'),
        generation: 0,
        mode: 'rule-fallback',
        verdict: 'continue',
        reason: 'healthy',
        error: 'timeout',
        createdAt: 1_000,
      })
    } finally {
      await first.close()
    }
    // A medium written before the ledger existed has no `warden_audits` table.
    first.pool.media.get('session_orchestrator')?.tables.delete('warden_audits')
    const second = await harness(first.pool)
    try {
      expect(second.store.getTask(TaskId('task-1'))?.title).toBe('First task')
      expect(second.store.listWardenAudits()).toEqual([])
    } finally {
      await second.close()
    }
  })

  it('refuses to open a domain holding a corrupted authoritative record', async () => {
    const first = await harness()
    try {
      await first.store.createTask(task())
    } finally {
      await first.close()
    }
    const medium = first.pool.media.get('session_orchestrator')
    const records = medium?.tables.get('tasks')
    records?.set('task-1', { ...task(), title: '' })
    await expect(harness(first.pool)).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('drains queued writes and then rejects new writes', async () => {
    const { store, pool, close } = await harness()
    await store.createTask(task())
    const pending = store.updateTask(TaskId('task-1'), 0, task({ title: 'drained', revision: 1 }))
    const closing = store.close()
    await expect(store.updateTask(TaskId('task-1'), 1, task({ title: 'late', revision: 2 })))
      .rejects.toMatchObject({ code: 'closed' })
    await pending
    await closing
    const stored = pool.media.get('session_orchestrator')?.tables.get('tasks')?.get('task-1') as
      | TaskSpec
      | undefined
    expect(stored?.title).toBe('drained')
    expect(() => store.getTask(TaskId('task-1'))).toThrow('not open')
    await close()
  })

  it('shares one teardown across repeated close calls', async () => {
    const { store, close } = await harness()
    const first = store.close()
    const second = store.close()
    expect(first).toBe(second)
    await first
    await close()
  })
})

describe('HandsOff naming compatibility', () => {
  it('keeps the legacy storage domain name so old queues and interventions still open', () => {
    expect(sessionOrchestratorDomain.name).toBe('session_orchestrator')
    expect(sessionOrchestratorDomain.version).toBe(1)
  })
})
