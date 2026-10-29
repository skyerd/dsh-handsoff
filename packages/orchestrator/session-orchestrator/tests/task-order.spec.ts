/** Ordered-list dependency derivation and legacy-data audit. */
import { describe, expect, it } from 'vitest'
import { deriveTaskDependencies, effectiveParallelIds, taskListIssues } from '../src/task-order.ts'

describe('ordered task list', () => {
  it('derives a serial chain by default', () => {
    const dependencies = deriveTaskDependencies(['t1', 't2', 't3'], new Set())
    expect([...dependencies]).toEqual([
      ['t1', []],
      ['t2', ['t1']],
      ['t3', ['t2']],
    ])
  })

  it('lets one marker join the previous group and waits on the whole group after it', () => {
    const dependencies = deriveTaskDependencies(['t1', 't2', 't3', 't4'], new Set(['t2']))
    expect([...dependencies]).toEqual([
      ['t1', []],
      ['t2', []],
      ['t3', ['t1', 't2']],
      ['t4', ['t3']],
    ])
  })

  it('ignores a marker on the first item', () => {
    expect(effectiveParallelIds(['t1', 't2'], new Set(['t1', 't2'])))
      .toEqual(new Set(['t2']))
    expect(deriveTaskDependencies(['t1', 't2'], new Set(['t1', 't2'])).get('t2')).toEqual([])
  })

  it('reports dangling, repeated, self and cyclic legacy dependencies', () => {
    const issues = taskListIssues([
      { id: 't1', dependsOn: ['missing'] },
      { id: 't2', dependsOn: ['t1', 't1'] },
      { id: 't3', dependsOn: ['t3'] },
      { id: 't4', dependsOn: ['t5'] },
      { id: 't5', dependsOn: ['t4'] },
    ])
    expect(issues).toEqual([
      { kind: 'missing-dependency', taskId: 't1', dependencyId: 'missing' },
      { kind: 'duplicate-dependency', taskId: 't2', dependencyId: 't1' },
      { kind: 'self-dependency', taskId: 't3', dependencyId: 't3' },
      { kind: 'cycle', taskId: 't4' },
      { kind: 'cycle', taskId: 't5' },
    ])
  })
})
