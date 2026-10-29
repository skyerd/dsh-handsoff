/** Pure ready-set planning: DAG, diamond, failure, skip audit, priority stability. */
import { describe, expect, it } from 'vitest'
import { TaskId, QueueId, RunId } from '../src/brand.ts'
import { describeBlocker, isActiveRunState, isAuditedSkip, planReadyTasks } from '../src/planner.ts'
import type { HumanSkip, PlannerInput } from '../src/planner.ts'
import type { QueueRecord, RunRecord, RunState, TaskSpec } from '../src/types.ts'

/** A stored task with required fields, overridable per case. */
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

/** A stored queue with required fields, overridable per case. */
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

/** A stored run with required fields, overridable per case. */
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

/** A snapshot with defaults, overridable per case. */
function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    tasks: [],
    queues: [queue()],
    runs: [],
    skips: [],
    globalPaused: false,
    ...overrides,
  }
}

/** An audited skip decision for one task. */
function skip(taskId: string, runId = 'run-skip'): HumanSkip {
  return {
    taskId: TaskId(taskId),
    runId: RunId(runId),
    actor: 'operator-1',
    reason: 'Known-bad output accepted manually',
    decidedAt: 5_000,
  }
}

/** Ready task ids in planned order. */
function readyIds(plan: ReturnType<typeof planReadyTasks>): string[] {
  return plan.ready.map(entry => String(entry.taskId))
}

describe('planReadyTasks: dependency graph', () => {
  it('plans an independent task and holds its dependent until success', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({ tasks: [a, b] }))

    expect(readyIds(plan)).toEqual(['a'])
    expect(plan.blocked).toEqual([
      { taskId: TaskId('b'), blocker: { kind: 'dependency-pending', dependencyId: TaskId('a'), state: 'never-started' } },
    ])
  })

  it('starts a dependent once its dependency succeeded', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({
      tasks: [a, b],
      runs: [run({ id: RunId('run-a'), taskId: TaskId('a'), state: 'succeeded' })],
    }))

    expect(readyIds(plan)).toEqual(['b'])
    expect(plan.ready[0]?.unlockedBy).toBe('succeeded')
    // The succeeded task itself is not re-planned: a settled attempt dedupes it.
    expect(plan.blocked).toEqual([
      { taskId: TaskId('a'), blocker: { kind: 'already-succeeded', runId: RunId('run-a') } },
    ])
  })

  it('does not unlock a dependent when the dependency failed', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({
      tasks: [a, b],
      runs: [run({ id: RunId('run-a'), taskId: TaskId('a'), state: 'failed' })],
    }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked).toContainEqual({
      taskId: TaskId('b'),
      blocker: { kind: 'dependency-pending', dependencyId: TaskId('a'), state: 'failed' },
    })
    const dependentBlocker = plan.blocked.find(entry => entry.taskId === TaskId('b'))?.blocker
    expect(dependentBlocker === undefined ? '' : describeBlocker(dependentBlocker))
      .toBe("dependency 'a' is failed")
  })

  it('starts a diamond join exactly once and only after both parents succeed', () => {
    const root = task({ id: TaskId('root') })
    const left = task({ id: TaskId('left'), dependsOn: [TaskId('root')] })
    const right = task({ id: TaskId('right'), dependsOn: [TaskId('root')] })
    const join = task({ id: TaskId('join'), dependsOn: [TaskId('left'), TaskId('right')] })
    const tasks = [root, left, right, join]

    const afterRoot = planReadyTasks(input({
      tasks,
      runs: [run({ id: RunId('run-root'), taskId: TaskId('root'), state: 'succeeded' })],
    }))
    expect(new Set(readyIds(afterRoot))).toEqual(new Set(['left', 'right']))
    expect(readyIds(afterRoot)).toHaveLength(2)

    const afterOneParent = planReadyTasks(input({
      tasks,
      runs: [
        run({ id: RunId('run-root'), taskId: TaskId('root'), state: 'succeeded' }),
        run({ id: RunId('run-left'), taskId: TaskId('left'), state: 'succeeded' }),
      ],
    }))
    expect(readyIds(afterOneParent)).toEqual(['right'])
    expect(afterOneParent.blocked).toContainEqual({
      taskId: TaskId('join'),
      blocker: { kind: 'dependency-pending', dependencyId: TaskId('right'), state: 'never-started' },
    })

    const afterBoth = planReadyTasks(input({
      tasks,
      runs: [
        run({ id: RunId('run-root'), taskId: TaskId('root'), state: 'succeeded' }),
        run({ id: RunId('run-left'), taskId: TaskId('left'), state: 'succeeded' }),
        run({ id: RunId('run-right'), taskId: TaskId('right'), state: 'succeeded' }),
      ],
    }))
    expect(readyIds(afterBoth)).toEqual(['join'])
  })

  it('reports a dependency cycle and plans none of its members', () => {
    const a = task({ id: TaskId('a'), dependsOn: [TaskId('b')] })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({ tasks: [a, b] }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.diagnostics).toContainEqual({
      kind: 'dependency-cycle',
      members: [TaskId('a'), TaskId('b')],
    })
    for (const entry of plan.blocked) {
      expect(entry.blocker.kind).toBe('dependency-cycle')
    }
  })

  it('blocks on a missing dependency instead of starting the task', () => {
    const orphan = task({ id: TaskId('orphan'), dependsOn: [TaskId('absent')] })
    const plan = planReadyTasks(input({ tasks: [orphan] }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked[0]?.blocker).toEqual({ kind: 'dependency-missing', dependencyId: TaskId('absent') })
    expect(plan.diagnostics).toContainEqual({
      kind: 'missing-dependency',
      taskId: TaskId('orphan'),
      dependencyId: TaskId('absent'),
    })
  })
})

describe('planReadyTasks: human skip is not model success', () => {
  it('unlocks a dependent through an audited skip and labels the cause', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({
      tasks: [a, b],
      runs: [run({ id: RunId('run-a'), taskId: TaskId('a'), state: 'needs-attention' })],
      skips: [skip('a', 'run-a')],
    }))

    expect(readyIds(plan)).toEqual(['b'])
    expect(plan.ready[0]?.unlockedBy).toBe('human-skip')
    expect(plan.skipped).toEqual([{ taskId: TaskId('a'), skip: skip('a', 'run-a') }])
  })

  it('refuses a skip without a complete audit trail and blocks the dependent', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const unaudited = { ...skip('a', 'run-a'), reason: '   ' }
    const plan = planReadyTasks(input({
      tasks: [a, b],
      runs: [run({ id: RunId('run-a'), taskId: TaskId('a'), state: 'needs-attention' })],
      skips: [unaudited],
    }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.blocked).toContainEqual({ taskId: TaskId('a'), blocker: { kind: 'skip-unaudited' } })
    expect(plan.blocked).toContainEqual({
      taskId: TaskId('b'),
      blocker: { kind: 'dependency-skip-unaudited', dependencyId: TaskId('a') },
    })
    expect(plan.diagnostics).toContainEqual({ kind: 'unaudited-skip', skip: unaudited })
  })

  it('rejects a skip with a non-integer decision time', () => {
    expect(isAuditedSkip(skip('a'))).toBe(true)
    expect(isAuditedSkip({ ...skip('a'), decidedAt: 1.5 })).toBe(false)
    expect(isAuditedSkip({ ...skip('a'), actor: '' })).toBe(false)
    expect(isAuditedSkip({ ...skip('a'), decidedAt: -1 })).toBe(false)
  })

  it('never treats a needs-attention dependency as satisfied without a skip', () => {
    const a = task({ id: TaskId('a') })
    const b = task({ id: TaskId('b'), dependsOn: [TaskId('a')] })
    const plan = planReadyTasks(input({
      tasks: [a, b],
      runs: [run({ id: RunId('run-a'), taskId: TaskId('a'), state: 'needs-attention' })],
    }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked).toContainEqual({
      taskId: TaskId('b'),
      blocker: { kind: 'dependency-needs-attention', dependencyId: TaskId('a') },
    })
  })
})

describe('planReadyTasks: stable priority order', () => {
  it('orders by priority, then queue position, then task id, regardless of input order', () => {
    const tasks = [
      task({ id: TaskId('low'), priority: 0 }),
      // The second and third list positions join the first group so this case
      // exercises priority order rather than the default serial queue rule,
      // which is covered separately.
      task({ id: TaskId('high-b'), priority: 5, parallelWithPrevious: true }),
      task({ id: TaskId('high-a'), priority: 5, parallelWithPrevious: true }),
      task({ id: TaskId('high-c'), priority: 5 }),
    ]
    const order = [TaskId('high-c'), TaskId('high-b'), TaskId('high-a')]
    const plan = planReadyTasks(input({
      tasks,
      queues: [queue({ taskOrder: order })],
    }))

    expect(readyIds(plan)).toEqual(['high-c', 'high-b', 'high-a', 'low'])
    expect(plan.ready.map(entry => entry.queueOrder)).toEqual([0, 1, 2, -1])

    const reversed = planReadyTasks(input({
      tasks: [...tasks].reverse(),
      queues: [queue({ taskOrder: order })],
    }))
    expect(readyIds(reversed)).toEqual(readyIds(plan))
  })

  it('breaks a full tie by task id so an unchanged snapshot is stable', () => {
    const plan = planReadyTasks(input({
      tasks: [
        task({ id: TaskId('b'), priority: 1 }),
        task({ id: TaskId('a'), priority: 1 }),
      ],
      queues: [queue()],
    }))
    expect(readyIds(plan)).toEqual(['a', 'b'])
  })
})

describe('planReadyTasks: gates', () => {
  it('reports no ready tasks while the host-wide pause is engaged', () => {
    const plan = planReadyTasks(input({ tasks: [task()], globalPaused: true }))

    expect(plan.paused).toBe(true)
    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked[0]?.blocker).toEqual({ kind: 'global-paused' })
  })

  it('blocks a task in a paused queue and in an unknown queue', () => {
    const plan = planReadyTasks(input({
      tasks: [task({ id: TaskId('a') }), task({ id: TaskId('b'), queueId: QueueId('queue-2') })],
      queues: [queue({ paused: true })],
    }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked).toContainEqual({ taskId: TaskId('a'), blocker: { kind: 'queue-paused', queueId: QueueId('queue-1') } })
    expect(plan.blocked).toContainEqual({ taskId: TaskId('b'), blocker: { kind: 'unknown-queue', queueId: QueueId('queue-2') } })
  })

  it('blocks a disabled task', () => {
    const plan = planReadyTasks(input({ tasks: [task({ enabled: false })] }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.blocked[0]?.blocker).toEqual({ kind: 'disabled' })
  })
})

describe('planReadyTasks: run snapshot', () => {
  it('reports an active run and does not re-plan its task', () => {
    const plan = planReadyTasks(input({
      tasks: [task()],
      runs: [run({ id: RunId('run-live'), state: 'running' })],
    }))

    expect(readyIds(plan)).toEqual([])
    expect(plan.active).toEqual([{ taskId: TaskId('task-1'), runId: RunId('run-live'), state: 'running' }])
    expect(plan.blocked).toEqual([])
  })

  it('blocks a task whose attempt already settled and reports the terminal state', () => {
    for (const state of ['failed', 'cancelled', 'paused'] as const) {
      const plan = planReadyTasks(input({
        tasks: [task()],
        runs: [run({ id: RunId('run-done'), state })],
      }))
      expect(readyIds(plan)).toEqual([])
      expect(plan.blocked[0]?.blocker).toEqual({ kind: 'attempt-settled', runId: RunId('run-done'), state })
    }
  })

  it('blocks a needs-attention run and a succeeded run', () => {
    const attention = planReadyTasks(input({
      tasks: [task()],
      runs: [run({ id: RunId('run-x'), state: 'needs-attention' })],
    }))
    expect(attention.blocked[0]?.blocker).toEqual({ kind: 'needs-attention', runId: RunId('run-x') })

    const succeeded = planReadyTasks(input({
      tasks: [task()],
      runs: [run({ id: RunId('run-y'), state: 'succeeded' })],
    }))
    expect(succeeded.blocked[0]?.blocker).toEqual({ kind: 'already-succeeded', runId: RunId('run-y') })
  })

  it('plans the newest attempt and marks it a retry', () => {
    const plan = planReadyTasks(input({
      tasks: [task()],
      runs: [
        run({ id: RunId('run-1'), attempt: 1, state: 'failed', updatedAt: 1_000 }),
        run({ id: RunId('run-2'), attempt: 2, state: 'ready', updatedAt: 2_000 }),
      ],
    }))

    expect(readyIds(plan)).toEqual(['task-1'])
    expect(plan.ready[0]?.retry).toBe(true)
  })

  it('reports orphan runs and duplicate tasks as diagnostics', () => {
    const plan = planReadyTasks(input({
      tasks: [task({ id: TaskId('a') }), task({ id: TaskId('a') })],
      runs: [run({ id: RunId('run-ghost'), taskId: TaskId('ghost') })],
    }))

    expect(plan.diagnostics).toContainEqual({ kind: 'duplicate-task', taskId: TaskId('a') })
    expect(plan.diagnostics).toContainEqual({
      kind: 'orphan-run',
      runId: RunId('run-ghost'),
      taskId: TaskId('ghost'),
    })
  })
})

describe('planner predicates', () => {
  it('classifies every run state as active or not', () => {
    const active: RunState[] = ['starting', 'running', 'handoff-pending', 'handing-off']
    const inactive: RunState[] = ['ready', 'succeeded', 'needs-attention', 'paused', 'cancelled', 'failed']
    for (const state of active) expect(isActiveRunState(state)).toBe(true)
    for (const state of inactive) expect(isActiveRunState(state)).toBe(false)
  })
})
