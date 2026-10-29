/** Pure graph, board, chain, audit, retry, and pressure projections. */

import { describe, expect, it } from 'vitest'
import {
  BOARD_COLUMN_ORDER, boardColumnOf, buildBoard, buildHandoffChains, buildTaskGraph, canCancelRun,
  canRetryRun, canSkipRun, deriveAuditEvents, latestRunOf, pinnedRouteOf, pressureReading, quotaEntries,
  runStateTone,
} from '../../src/client/model.ts'
import { frame, handoff, queue, run, settings, taskSummary } from './fixtures.client.ts'

describe('task graph', () => {
  it('orders by queue order and layers dependencies', () => {
    const q = queue({ taskOrder: ['t3', 't1', 't2'] })
    const tasks = [
      taskSummary({ id: 't1', title: 'One' }),
      taskSummary({ id: 't2', title: 'Two', dependsOn: ['t1'] }),
      taskSummary({ id: 't3', title: 'Three', dependsOn: ['t1', 't2'] }),
    ]
    const graph = buildTaskGraph(q, tasks)
    expect(graph.order).toEqual(['t3', 't1', 't2'])
    expect(graph.edges).toEqual([
      { from: 't1', to: 't3' },
      { from: 't1', to: 't2' },
      { from: 't2', to: 't3' },
    ])
    expect(graph.layers).toEqual([['t1'], ['t2'], ['t3']])
    expect(graph.issues).toEqual([])
    expect(graph.nodes.map(node => [node.id, node.layer])).toEqual([['t3', 2], ['t1', 0], ['t2', 1]])
  })

  it('reports missing, duplicate, self, and cyclic dependencies without inventing edges', () => {
    const tasks = [
      taskSummary({ id: 'a', dependsOn: ['missing', 'missing'] }),
      taskSummary({ id: 'b', dependsOn: ['b'] }),
      taskSummary({ id: 'c', dependsOn: ['d'] }),
      taskSummary({ id: 'd', dependsOn: ['c'] }),
    ]
    const graph = buildTaskGraph(queue({ taskOrder: ['a', 'b', 'c', 'd'] }), tasks)
    expect(graph.issues).toEqual([
      { kind: 'missing-dependency', taskId: 'a', dependencyId: 'missing' },
      { kind: 'duplicate-dependency', taskId: 'a', dependencyId: 'missing' },
      { kind: 'self-dependency', taskId: 'b', dependencyId: 'b' },
      { kind: 'cycle', taskId: 'c' },
      { kind: 'cycle', taskId: 'd' },
    ])
    expect(graph.edges).toEqual([{ from: 'c', to: 'd' }, { from: 'd', to: 'c' }])
    expect(graph.nodes.find(node => node.id === 'c')?.layer).toBe(-1)
    expect(graph.nodes.find(node => node.id === 'a')?.layer).toBe(0)
  })

  it('groups by queue and ignores tasks of another queue', () => {
    const graph = buildTaskGraph(queue(), [
      taskSummary({ id: 't1', queueId: 'q1' }),
      taskSummary({ id: 'x1', queueId: 'q2', title: 'Other' }),
    ])
    expect(graph.order).toEqual(['t1'])
    expect(graph.nodes.map(node => node.id)).toEqual(['t1'])
  })
})

describe('task board', () => {
  it('keeps every task, including one with no attempt, in the fixed status order', () => {
    expect(BOARD_COLUMN_ORDER).toEqual(['running', 'attention', 'waiting', 'paused', 'settled'])
    expect(boardColumnOf('ready')).toBe('waiting')
    expect(boardColumnOf('starting')).toBe('running')
    expect(boardColumnOf('running')).toBe('running')
    expect(boardColumnOf('handoff-pending')).toBe('running')
    expect(boardColumnOf('handing-off')).toBe('running')
    expect(boardColumnOf('needs-attention')).toBe('attention')
    expect(boardColumnOf('paused')).toBe('paused')
    expect(boardColumnOf('succeeded')).toBe('settled')
    expect(boardColumnOf('failed')).toBe('settled')
    expect(boardColumnOf('cancelled')).toBe('settled')
    expect(runStateTone('succeeded')).toBe('done')
    expect(runStateTone('needs-attention')).toBe('warning')
    expect(runStateTone('running')).toBe('ongoing')
    expect(runStateTone('failed')).toBe('error')
    expect(runStateTone('ready')).toBe('idle')

    const tasks = [
      taskSummary({ id: 't-running', title: 'Running task' }),
      taskSummary({ id: 't-attention', title: 'Attention task' }),
      taskSummary({ id: 't-fresh', title: 'Fresh task' }),
      taskSummary({ id: 't-paused', title: 'Paused task' }),
      taskSummary({ id: 't-ended', title: 'Ended task' }),
    ]
    const view = buildBoard(tasks, [
      run({ id: 'r-running', taskId: 't-running', state: 'running' }),
      run({ id: 'r-attention', taskId: 't-attention', state: 'needs-attention' }),
      run({ id: 'r-paused', taskId: 't-paused', state: 'paused' }),
      run({ id: 'r-ended', taskId: 't-ended', state: 'succeeded' }),
    ])
    expect(view.columns.running.map(entry => entry.task.id)).toEqual(['t-running'])
    expect(view.columns.attention.map(entry => entry.task.id)).toEqual(['t-attention'])
    expect(view.columns.waiting.map(entry => entry.task.id)).toEqual(['t-fresh'])
    expect(view.columns.paused.map(entry => entry.task.id)).toEqual(['t-paused'])
    expect(view.columns.settled.map(entry => entry.task.id)).toEqual(['t-ended'])
    expect(view.counts).toEqual({ running: 1, attention: 1, waiting: 1, paused: 1, settled: 1 })
    expect(view.active).toBe(1)
  })

  it('uses the newest attempt and sorts rows by recent activity', () => {
    const newer = run({ id: 'r-new', attempt: 2, state: 'running', updatedAt: 10 })
    const older = run({ id: 'r-old', attempt: 1, state: 'succeeded', updatedAt: 99 })
    expect(latestRunOf([older, newer], 't1')).toBe(newer)

    const view = buildBoard(
      [taskSummary({ id: 't1' }), taskSummary({ id: 't2', title: 'Two' })],
      [
        older,
        newer,
        run({ id: 'r2', taskId: 't2', state: 'running', updatedAt: 20 }),
      ],
    )
    expect(view.columns.running.map(entry => entry.run?.id)).toEqual(['r2', 'r-new'])
    expect(view.columns.settled).toHaveLength(0)
  })

  it('allows retry on a skipped run but not a second skip', () => {
    const skipped = run({ skipped: true, state: 'needs-attention' })
    expect(canRetryRun(skipped)).toBe(true)
    expect(canSkipRun(skipped)).toBe(false)
    expect(canCancelRun(skipped.state)).toBe(true)
    expect(canRetryRun(run({ state: 'running' }))).toBe(false)
  })
})

describe('handoff chains and audit', () => {
  it('joins lineage, active session, and handoff generations', () => {
    const record = handoff()
    const entity = run({
      activeSession: { sessionId: 's1', linkable: true, openState: 'ready' },
      sessionLineage: [{ sessionId: 's0', linkable: false, openState: 'unsupported' }, { sessionId: 's1', linkable: true, openState: 'ready' }],
    })
    const chains = buildHandoffChains([entity], [record])
    expect(chains).toHaveLength(1)
    expect(chains[0]?.sessions).toEqual(['s0', 's1', 's2'])
    expect(chains[0]?.links).toEqual([{ handoff: record, parentSession: 's1', childSession: 's2' }])
  })

  it('projects only facts the snapshot carries and never invents actor or reason', () => {
    const events = deriveAuditEvents(
      [run({
        skipped: true,
        lastError: { code: 'turn-failed', retryable: true },
        operation: { id: 'op-1', phase: 'uncertain' },
        pressure: {
          provider: 'p', model: 'm', totalTokens: 10,
          baselineKind: 'estimated', threshold: 0.88, routeFingerprint: 'f', measuredAt: 2_500,
          decision: 'no-handoff',
        },
      })],
      [handoff()],
    )
    const kinds = events.map(event => event.kind)
    expect(kinds).toEqual([
      'handoff', 'pressure', 'run-updated', 'human-skip', 'operation-phase', 'run-error', 'run-created',
    ])
    expect(events.some(event => 'actor' in event || 'reason' in event)).toBe(false)
  })
})

describe('pressure and quotas', () => {
  it('marks an estimated baseline and preserves unknown windows', () => {
    const reading = pressureReading(run({
      pressure: {
        provider: 'p', model: 'm', totalTokens: 100,
        baselineKind: 'estimated', threshold: 0.88, routeFingerprint: 'f', measuredAt: 3_000,
        decision: 'handoff-pending', blockedBy: 'below-threshold',
      },
    }))
    expect(reading).toEqual({
      tokens: 100,
      estimated: true,
      baselineKind: 'estimated',
      threshold: 0.88,
      decision: 'handoff-pending',
      blockedBy: 'below-threshold',
    })
    expect(pressureReading(run())).toBeUndefined()
  })

  it('sorts provider quotas by name', () => {
    expect(quotaEntries({ zeta: 1, alpha: 2 })).toEqual([['alpha', 2], ['zeta', 1]])
    expect(quotaEntries(settings({ providerQuotas: {} }).providerQuotas)).toEqual([])
    expect(frame().queues.map(item => item.id)).toEqual(['q1'])
  })
})

describe('pinned route', () => {
  it('pins the deployment default rather than the first advertised route', () => {
    const choices = [
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { provider: 'trae', model: 'deepseek-v4.1-flash', isDefault: true },
    ]
    expect(pinnedRouteOf(choices)?.provider).toBe('trae')
  })

  it('falls back to the first route when the host names no default', () => {
    const choices = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }]
    expect(pinnedRouteOf(choices)?.provider).toBe('a')
    expect(pinnedRouteOf([])).toBeUndefined()
  })
})
