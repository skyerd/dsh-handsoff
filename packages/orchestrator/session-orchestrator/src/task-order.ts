/**
 * Ordered-task-list rules.
 *
 * A queue is an ordered list, not a user-authored DAG. Dependencies are derived
 * from the list position: a task waits for the whole preceding group, and a task
 * marked "run with the previous item" joins the group above it. Nothing here
 * calls a model, reads storage, or mutates a record; the Remote owner and the
 * settings page both use these pure functions as the single ordering rule.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/task-order
 */

/** One structural problem in a queue's derived task list. */
export type TaskListIssueKind =
  | 'missing-dependency'
  | 'duplicate-dependency'
  | 'self-dependency'
  | 'cycle'

/** One problem the start gate reports before a queue may run. */
export interface TaskListIssue {
  readonly kind: TaskListIssueKind
  readonly taskId: string
  readonly dependencyId?: string
}

/** The stored facts the ordering rules need. */
export interface OrderedTaskLike {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly parallelWithPrevious?: boolean | undefined
}

/**
 * Derive each task's dependency ids from list order and the parallel markers.
 *
 * A list position joins the preceding group only when it is marked
 * `parallelWithPrevious`; every member of a group waits for the entire previous
 * group. The first task always has no dependencies, and a marker on the first
 * task is ignored.
 * @param taskOrder - complete list order the queue exposes.
 * @param parallelWithPrevious - ids marked "run with the previous item".
 * @returns dependencies per ordered task id, in the same order.
 */
export function deriveTaskDependencies(
  taskOrder: readonly string[],
  parallelWithPrevious: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const dependencies = new Map<string, readonly string[]>()
  let previousGroup: readonly string[] = []
  let currentGroup: readonly string[] = []
  for (const [index, taskId] of taskOrder.entries()) {
    const joinsPrevious = index > 0
      && parallelWithPrevious.has(taskId)
      && currentGroup.length > 0
    if (!joinsPrevious) {
      previousGroup = currentGroup
      currentGroup = [taskId]
    } else {
      currentGroup = [...currentGroup, taskId]
    }
    dependencies.set(taskId, [...previousGroup])
  }
  return dependencies
}

/**
 * Mark the first list position serial, because it has no previous item.
 * @param taskOrder - complete list order.
 * @param parallelWithPrevious - ids marked "run with the previous item".
 * @returns the ids whose marker has effect.
 */
export function effectiveParallelIds(
  taskOrder: readonly string[],
  parallelWithPrevious: ReadonlySet<string>,
): ReadonlySet<string> {
  const first = taskOrder[0]
  if (first === undefined || !parallelWithPrevious.has(first)) return parallelWithPrevious
  const effective = new Set(parallelWithPrevious)
  effective.delete(first)
  return effective
}

/**
 * Audit the dependencies currently stored on one queue's tasks.
 *
 * This gate runs before a pipeline starts, so a task record written by an older
 * authoring flow (for example `dependsOn: ['t-1']` after that task was deleted)
 * refuses to start instead of blocking silently in the planner.
 * @param tasks - every task belonging to the queue.
 * @returns structural problems in stable task order.
 */
export function taskListIssues(tasks: readonly OrderedTaskLike[]): readonly TaskListIssue[] {
  const known = new Set(tasks.map(task => task.id))
  const issues: TaskListIssue[] = []
  for (const task of tasks) {
    const seen = new Set<string>()
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        issues.push({ kind: 'self-dependency', taskId: task.id, dependencyId })
        continue
      }
      if (seen.has(dependencyId)) {
        issues.push({ kind: 'duplicate-dependency', taskId: task.id, dependencyId })
        continue
      }
      seen.add(dependencyId)
      if (!known.has(dependencyId)) {
        issues.push({ kind: 'missing-dependency', taskId: task.id, dependencyId })
      }
    }
  }
  issues.push(...cycleIssues(tasks))
  return issues
}

/**
 * Find dependency cycles among the known tasks.
 * @param tasks - every task belonging to the queue.
 * @returns one issue per task that sits in a cycle.
 */
function cycleIssues(tasks: readonly OrderedTaskLike[]): readonly TaskListIssue[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const inCycle = new Set<string>()

  const visit = (taskId: string, path: readonly string[]): void => {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId)
      for (const member of start < 0 ? [taskId] : path.slice(start)) inCycle.add(member)
      return
    }
    visiting.add(taskId)
    const task = byId.get(taskId)
    for (const dependencyId of task?.dependsOn ?? []) {
      if (dependencyId !== taskId && byId.has(dependencyId)) visit(dependencyId, [...path, taskId])
    }
    visiting.delete(taskId)
    visited.add(taskId)
  }

  for (const task of tasks) visit(task.id, [])
  return [...inCycle].map(taskId => ({ kind: 'cycle', taskId }))
}
