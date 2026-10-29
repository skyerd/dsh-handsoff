/**
 * Pure ready-set planning over one durable snapshot.
 *
 * The planner answers one question: given the stored tasks, queues, runs and the
 * human decisions recorded against them, which runs may start now and in what
 * order? It performs no IO, emits no events and holds no state between calls, so
 * the same snapshot always produces the same plan.
 *
 * A task unlocks a downstream task only when its work is complete: `succeeded`,
 * or `deferred` with every derived child task complete. A human skip unlocks it
 * too, but the ready entry records `unlockedBy: 'human-skip'` so no consumer can
 * mistake a human decision for model success. `needs-attention`, `failed`,
 * `cancelled` and `paused` never unlock anything on their own.
 *
 * A queue is an ordered list, so a task also waits for the whole preceding
 * group in its queue's `taskOrder`. A task marked `parallelWithPrevious` joins
 * the previous group and is therefore not blocked by a sibling in that group;
 * every later group still waits for all of them.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/planner
 */

import { assertNever } from './never.ts'
import { TaskId } from './brand.ts'
import type { QueueId, RunId } from './brand.ts'
import { deriveTaskDependencies } from './task-order.ts'
import type { QueueRecord, RunRecord, RunState, TaskSpec } from './types.ts'

/**
 * A recorded human decision to skip one `needs-attention` run.
 *
 * The audit fields are required: a skip that does not name its actor, reason and
 * decision time is not a decision, and the planner refuses to act on it.
 */
export interface HumanSkip {
  /** Task the skip applies to. */
  readonly taskId: TaskId
  /** The run whose failure or blocked state the human skipped. */
  readonly runId: RunId
  /** Human identity that made the decision; non-empty after trimming. */
  readonly actor: string
  /** Why the task was skipped; non-empty after trimming. */
  readonly reason: string
  /** Epoch milliseconds of the decision. */
  readonly decidedAt: number
}

/** One immutable snapshot the planner reasons over. */
export interface PlannerInput {
  /** Every stored task. */
  readonly tasks: readonly TaskSpec[]
  /** Every stored queue. */
  readonly queues: readonly QueueRecord[]
  /** Every stored run attempt, including settled attempts. */
  readonly runs: readonly RunRecord[]
  /** Human skip decisions; only audited ones affect the plan. */
  readonly skips: readonly HumanSkip[]
  /** Whether the host-wide pause is engaged. */
  readonly globalPaused: boolean
}

/** Why one task may not start yet. */
export type PlannerBlocker =
  | { readonly kind: 'global-paused' }
  | { readonly kind: 'unknown-queue'; readonly queueId: QueueId }
  | { readonly kind: 'queue-paused'; readonly queueId: QueueId }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'skip-unaudited' }
  | { readonly kind: 'dependency-cycle'; readonly members: readonly TaskId[] }
  | { readonly kind: 'dependency-missing'; readonly dependencyId: TaskId }
  | { readonly kind: 'dependency-skip-unaudited'; readonly dependencyId: TaskId }
  | {
    readonly kind: 'dependency-pending'
    readonly dependencyId: TaskId
    readonly state: RunState | 'never-started'
  }
  | { readonly kind: 'dependency-needs-attention'; readonly dependencyId: TaskId }
  | { readonly kind: 'dependency-aborted'; readonly dependencyId: TaskId }
  | {
    /**
     * The dependency ended by handing its remainder to child tasks, but at
     * least one of those children has not succeeded yet. A `deferred` attempt
     * never releases an original successor on its own.
     */
    readonly kind: 'dependency-deferred-incomplete'
    readonly dependencyId: TaskId
    /** Direct children still incomplete; empty when no child was derived. */
    readonly pending: readonly TaskId[]
  }
  | { readonly kind: 'run-active'; readonly runId: RunId; readonly state: RunState }
  | { readonly kind: 'needs-attention'; readonly runId: RunId }
  | { readonly kind: 'already-succeeded'; readonly runId: RunId }
  | { readonly kind: 'attempt-settled'; readonly runId: RunId; readonly state: RunState }

/** One task that may start now. */
export interface PlannerReady {
  /** Task to start. */
  readonly taskId: TaskId
  /** Queue the task belongs to. */
  readonly queueId: QueueId
  /** Task priority; larger values start first. */
  readonly priority: number
  /** Position of the task in its queue's `taskOrder`, or -1 when unlisted. */
  readonly queueOrder: number
  /** What made every dependency satisfied. */
  readonly unlockedBy: 'no-dependencies' | 'succeeded' | 'human-skip'
  /** Whether the stored run is a retry attempt rather than a first attempt. */
  readonly retry: boolean
}

/** One task that may not start yet, with the reason. */
export interface PlannerBlocked {
  /** Task that may not start. */
  readonly taskId: TaskId
  /** Reason it may not start. */
  readonly blocker: PlannerBlocker
}

/** One task whose run is already active and therefore neither ready nor blocked. */
export interface PlannerActive {
  /** Task that is already active. */
  readonly taskId: TaskId
  /** Active run. */
  readonly runId: RunId
  /** Active run state. */
  readonly state: RunState
}

/** One task a human explicitly skipped; never planned as ready. */
export interface PlannerSkipped {
  /** Task that was skipped. */
  readonly taskId: TaskId
  /** Audit record of the decision. */
  readonly skip: HumanSkip
}

/** One inconsistent snapshot the planner reports but does not repair. */
export type PlannerDiagnostic =
  | { readonly kind: 'duplicate-task'; readonly taskId: TaskId }
  | { readonly kind: 'orphan-run'; readonly runId: RunId; readonly taskId: TaskId }
  | { readonly kind: 'missing-dependency'; readonly taskId: TaskId; readonly dependencyId: TaskId }
  | { readonly kind: 'dependency-cycle'; readonly members: readonly TaskId[] }
  | { readonly kind: 'unaudited-skip'; readonly skip: HumanSkip }

/** The complete plan for one snapshot. */
export interface PlannerOutput {
  /** Ready tasks in start order: priority, then queue position, then ids. */
  readonly ready: readonly PlannerReady[]
  /** Tasks that may not start, in task-input order. */
  readonly blocked: readonly PlannerBlocked[]
  /** Tasks with an active run, in task-input order. */
  readonly active: readonly PlannerActive[]
  /** Tasks a human skipped, in task-input order. */
  readonly skipped: readonly PlannerSkipped[]
  /** Snapshot inconsistencies the planner observed. */
  readonly diagnostics: readonly PlannerDiagnostic[]
  /** Whether the plan is suppressed by the host-wide pause. */
  readonly paused: boolean
}

/** Run states that mean the run owns a slot right now. */
export type ActiveRunState = 'starting' | 'running' | 'handoff-pending' | 'handing-off'

/**
 * Test whether a run state holds a concurrency slot.
 * @param state - The run state to classify.
 * @returns Whether the state is an active state.
 */
export function isActiveRunState(state: RunState): state is ActiveRunState {
  switch (state) {
    case 'starting':
    case 'running':
    case 'handoff-pending':
    case 'handing-off':
      return true
    case 'ready':
    case 'succeeded':
    case 'needs-attention':
    case 'paused':
    case 'deferred':
    case 'cancelled':
    case 'failed':
      return false
    default:
      return assertNever(state, 'run state')
  }
}

/**
 * Test whether a human skip carries a complete audit record.
 * @param skip - The recorded decision.
 * @returns Whether actor, reason and decision time are all present and valid.
 */
export function isAuditedSkip(skip: HumanSkip): boolean {
  return skip.actor.trim() !== ''
    && skip.reason.trim() !== ''
    && Number.isInteger(skip.decidedAt)
    && skip.decidedAt >= 0
}

/**
 * Render one blocker as a stable, human-readable phrase.
 *
 * The switch is exhaustive over the closed {@link PlannerBlocker} union, so a
 * blocker added later fails to compile until it is described here.
 * @param blocker - The blocker to describe.
 * @returns A stable phrase naming the blocker.
 */
export function describeBlocker(blocker: PlannerBlocker): string {
  switch (blocker.kind) {
    case 'global-paused':
      return 'host-wide pause is engaged'
    case 'unknown-queue':
      return `queue '${blocker.queueId}' is not stored`
    case 'queue-paused':
      return `queue '${blocker.queueId}' is paused`
    case 'disabled':
      return 'task is disabled'
    case 'skip-unaudited':
      return 'task has a skip record without a complete audit trail'
    case 'dependency-cycle':
      return `dependency cycle: ${blocker.members.join(' -> ')}`
    case 'dependency-missing':
      return `dependency '${blocker.dependencyId}' is not stored`
    case 'dependency-skip-unaudited':
      return `dependency '${blocker.dependencyId}' has an unaudited skip`
    case 'dependency-pending':
      return `dependency '${blocker.dependencyId}' is ${blocker.state}`
    case 'dependency-needs-attention':
      return `dependency '${blocker.dependencyId}' needs attention`
    case 'dependency-aborted':
      return `dependency '${blocker.dependencyId}' belongs to an aborted queue`
    case 'dependency-deferred-incomplete':
      return blocker.pending.length === 0
        ? `dependency '${blocker.dependencyId}' was deferred without derived children`
        : `dependency '${blocker.dependencyId}' was deferred and its children are not all succeeded: ${blocker.pending.join(', ')}`
    case 'run-active':
      return `run '${blocker.runId}' is ${blocker.state}`
    case 'needs-attention':
      return `run '${blocker.runId}' needs attention`
    case 'already-succeeded':
      return `run '${blocker.runId}' already succeeded`
    case 'attempt-settled':
      return `run '${blocker.runId}' settled as ${blocker.state}; a retry needs a new attempt`
    default:
      return assertNever(blocker, 'planner blocker')
  }
}

/**
 * Plan the ready set for one snapshot.
 * @param input - The snapshot to plan over; it is never mutated.
 * @returns The plan, including blockers, diagnostics and the pause flag.
 */
export function planReadyTasks(input: PlannerInput): PlannerOutput {
  const diagnostics: PlannerDiagnostic[] = []

  const tasks = new Map<TaskId, TaskSpec>()
  for (const task of input.tasks) {
    if (tasks.has(task.id)) {
      diagnostics.push({ kind: 'duplicate-task', taskId: task.id })
      continue
    }
    tasks.set(task.id, task)
  }

  const queues = new Map<QueueId, QueueRecord>()
  for (const queue of input.queues) {
    if (!queues.has(queue.id)) queues.set(queue.id, queue)
  }

  const latestRuns = latestRunPerTask(input.runs, tasks, diagnostics)

  const queueDependencies = new Map<QueueId, ReadonlyMap<TaskId, readonly TaskId[]>>()
  for (const queue of queues.values()) {
    const parallel = new Set<TaskId>()
    for (const taskId of queue.taskOrder) {
      if (tasks.get(taskId)?.parallelWithPrevious === true) parallel.add(taskId)
    }
    const derived = new Map<TaskId, readonly TaskId[]>()
    for (const [taskId, dependencies] of deriveTaskDependencies(queue.taskOrder, parallel)) {
      derived.set(TaskId(taskId), dependencies.map(TaskId))
    }
    queueDependencies.set(queue.id, derived)
  }

  const children = new Map<TaskId, TaskId[]>()
  for (const task of tasks.values()) {
    if (task.parentTaskId === undefined) continue
    const siblings = children.get(TaskId(task.parentTaskId))
    if (siblings === undefined) children.set(TaskId(task.parentTaskId), [task.id])
    else siblings.push(task.id)
  }

  const auditedSkips = new Map<TaskId, HumanSkip>()
  const unauditedSkips = new Set<TaskId>()
  for (const skip of input.skips) {
    if (isAuditedSkip(skip)) {
      if (!auditedSkips.has(skip.taskId)) auditedSkips.set(skip.taskId, skip)
      continue
    }
    unauditedSkips.add(skip.taskId)
    diagnostics.push({ kind: 'unaudited-skip', skip })
  }

  const cycleMembers = findCycleMembers(tasks)
  for (const members of cycleMembers) {
    diagnostics.push({ kind: 'dependency-cycle', members })
  }
  const inCycle = new Set<TaskId>()
  for (const members of cycleMembers) {
    for (const member of members) inCycle.add(member)
  }

  const ready: PlannerReady[] = []
  const blocked: PlannerBlocked[] = []
  const active: PlannerActive[] = []
  const skipped: PlannerSkipped[] = []
  const indexes: PlanIndexes = {
    paused: input.globalPaused,
    inCycle,
    cycleMembers,
    queues,
    queueDependencies,
    children,
    tasks,
    latestRuns,
    auditedSkips,
    unauditedSkips,
    diagnostics,
  }

  for (const task of tasks.values()) {
    const queue = queues.get(task.queueId)
    const latest = latestRuns.get(task.id)
    const blocker = classify(task, queue, latest, indexes)

    if (blocker === undefined) {
      ready.push({
        taskId: task.id,
        queueId: task.queueId,
        priority: task.priority,
        queueOrder: queue === undefined ? -1 : queue.taskOrder.indexOf(task.id),
        unlockedBy: unlockedBy(dependencyIds(task, indexes), latestRuns, auditedSkips),
        retry: latest !== undefined,
      })
      continue
    }

    if (blocker.kind === 'skip-applied') {
      skipped.push({ taskId: task.id, skip: blocker.skip })
      continue
    }
    if (blocker.kind === 'run-active') {
      active.push({ taskId: task.id, runId: blocker.runId, state: blocker.state })
      continue
    }
    blocked.push({ taskId: task.id, blocker: blocker.blocker })
  }

  ready.sort(compareReady)

  return {
    ready,
    blocked,
    active,
    skipped,
    diagnostics,
    paused: input.globalPaused,
  }
}

/** Classification result: no blocker means ready. */
type Classification =
  | { readonly kind: 'skip-applied'; readonly skip: HumanSkip }
  | { readonly kind: 'run-active'; readonly runId: RunId; readonly state: RunState }
  | { readonly kind: 'blocked'; readonly blocker: PlannerBlocker }

/** Snapshot indexes the per-task classification reads. */
interface PlanIndexes {
  readonly paused: boolean
  readonly inCycle: ReadonlySet<TaskId>
  readonly cycleMembers: readonly (readonly TaskId[])[]
  readonly queues: ReadonlyMap<QueueId, QueueRecord>
  /** Dependencies derived from each queue's ordered list. */
  readonly queueDependencies: ReadonlyMap<QueueId, ReadonlyMap<TaskId, readonly TaskId[]>>
  /** Direct children per parent task, derived from `parentTaskId`. */
  readonly children: ReadonlyMap<TaskId, readonly TaskId[]>
  readonly tasks: ReadonlyMap<TaskId, TaskSpec>
  readonly latestRuns: ReadonlyMap<TaskId, RunRecord>
  readonly auditedSkips: ReadonlyMap<TaskId, HumanSkip>
  readonly unauditedSkips: ReadonlySet<TaskId>
  readonly diagnostics: PlannerDiagnostic[]
}

/**
 * Classify one task against the snapshot indexes.
 * @param task - The task to classify.
 * @param queue - Its queue, or `undefined` when the queue is not stored.
 * @param latest - Its latest run attempt, or `undefined` before a first attempt.
 * @param indexes - Snapshot indexes.
 * @returns Ready (`undefined`), skipped, active, or blocked.
 */
function classify(
  task: TaskSpec,
  queue: QueueRecord | undefined,
  latest: RunRecord | undefined,
  indexes: PlanIndexes,
): Classification | undefined {
  if (indexes.paused) return blocked({ kind: 'global-paused' })
  if (queue === undefined) {
    return blocked({ kind: 'unknown-queue', queueId: task.queueId })
  }
  if (queue.paused) {
    return blocked({ kind: 'queue-paused', queueId: task.queueId })
  }
  if (!task.enabled) return blocked({ kind: 'disabled' })
  if (indexes.unauditedSkips.has(task.id)) return blocked({ kind: 'skip-unaudited' })

  const skip = indexes.auditedSkips.get(task.id)
  if (skip !== undefined) return { kind: 'skip-applied', skip }

  if (indexes.inCycle.has(task.id)) {
    return blocked({ kind: 'dependency-cycle', members: cycleOf(task.id, indexes.cycleMembers) })
  }

  if (latest !== undefined) {
    if (isActiveRunState(latest.state)) {
      return { kind: 'run-active', runId: latest.id, state: latest.state }
    }
    switch (latest.state) {
      case 'ready':
        break
      case 'needs-attention':
        return blocked({ kind: 'needs-attention', runId: latest.id })
      case 'succeeded':
        return blocked({ kind: 'already-succeeded', runId: latest.id })
      case 'deferred':
        // The attempt stopped on purpose and its remainder became child tasks.
        // The task itself is finished as an attempt even though it never
        // succeeded; a new attempt would duplicate the handed-off work.
        return blocked({ kind: 'attempt-settled', runId: latest.id, state: latest.state })
      case 'failed':
      case 'cancelled':
      case 'paused':
        return blocked({ kind: 'attempt-settled', runId: latest.id, state: latest.state })
      default:
        assertNever(latest.state, 'run state')
    }
  }

  return dependencyBlocker(task, indexes)
}

/**
 * Decide whether every dependency of a task is satisfied.
 * @param task - The task whose dependencies to check.
 * @param indexes - Snapshot indexes.
 * @returns `undefined` when all dependencies are satisfied, else the blocker.
 */
function dependencyBlocker(task: TaskSpec, indexes: PlanIndexes): Classification | undefined {
  for (const dependencyId of dependencyIds(task, indexes)) {
    const dependency = indexes.tasks.get(dependencyId)
    if (dependency === undefined) {
      indexes.diagnostics.push({ kind: 'missing-dependency', taskId: task.id, dependencyId })
      return blocked({ kind: 'dependency-missing', dependencyId })
    }
    if (indexes.unauditedSkips.has(dependencyId)) {
      return blocked({ kind: 'dependency-skip-unaudited', dependencyId })
    }
    if (indexes.auditedSkips.has(dependencyId)) continue

    const dependencyRun = indexes.latestRuns.get(dependencyId)
    if (dependencyRun?.state === 'succeeded') continue
    if (indexes.queues.get(dependency.queueId)?.state === 'aborted') {
      return blocked({ kind: 'dependency-aborted', dependencyId })
    }
    if (dependencyRun === undefined) {
      return blocked({ kind: 'dependency-pending', dependencyId, state: 'never-started' })
    }
    if (dependencyRun.state === 'needs-attention') {
      return blocked({ kind: 'dependency-needs-attention', dependencyId })
    }
    if (dependencyRun.state === 'deferred') {
      // A task derived by this parent runs because of the hand-over; the
      // parent's original successors wait until every derived child succeeded.
      if (task.parentTaskId === dependencyId) continue
      const pending = pendingChildren(dependencyId, indexes)
      if (pending === undefined) continue
      return blocked({ kind: 'dependency-deferred-incomplete', dependencyId, pending })
    }
    return blocked({ kind: 'dependency-pending', dependencyId, state: dependencyRun.state })
  }
  return undefined
}

/**
 * Collect the dependencies one task must wait for.
 *
 * Explicit `dependsOn` entries stay authoritative for records written by older
 * authoring flows, while list order adds the whole preceding group. A queue
 * therefore runs serially by default even when a task carries no explicit
 * dependency.
 * @param task - The task whose dependencies to collect.
 * @param indexes - Snapshot indexes.
 * @returns Dependency ids in declaration order, then list order.
 */
function dependencyIds(task: TaskSpec, indexes: PlanIndexes): readonly TaskId[] {
  const ids = [...task.dependsOn]
  const ordered = indexes.queueDependencies.get(task.queueId)?.get(task.id) ?? []
  for (const dependencyId of ordered) {
    if (!ids.includes(dependencyId)) ids.push(dependencyId)
  }
  return ids
}

/**
 * List the direct children of one deferred task that have not completed.
 * @param taskId - The deferred parent.
 * @param indexes - Snapshot indexes.
 * @returns `undefined` when every child completed, else the incomplete ones;
 * an empty list means the parent derived no child at all.
 */
function pendingChildren(taskId: TaskId, indexes: PlanIndexes): readonly TaskId[] | undefined {
  const children = indexes.children.get(taskId) ?? []
  if (children.length === 0) return []
  const pending = children.filter(child => !taskComplete(child, indexes, new Set([taskId])))
  return pending.length === 0 ? undefined : pending
}

/**
 * Decide whether one task's work is complete.
 *
 * `succeeded` and an audited skip count. A `deferred` task counts only when it
 * derived at least one child and every child is complete in turn, so a
 * hand-over never releases work that nobody finished.
 * @param taskId - The task to test.
 * @param indexes - Snapshot indexes.
 * @param visited - Parents already visited, to stop a malformed lineage.
 * @returns Whether the task's remaining work is finished.
 */
function taskComplete(taskId: TaskId, indexes: PlanIndexes, visited: ReadonlySet<TaskId>): boolean {
  if (visited.has(taskId)) return false
  if (indexes.unauditedSkips.has(taskId)) return false
  if (indexes.auditedSkips.has(taskId)) return true
  const run = indexes.latestRuns.get(taskId)
  if (run === undefined) return false
  if (run.state === 'succeeded') return true
  if (run.state !== 'deferred') return false
  const children = indexes.children.get(taskId) ?? []
  if (children.length === 0) return false
  const next = new Set(visited)
  next.add(taskId)
  return children.every(child => taskComplete(child, indexes, next))
}

/**
 * Report what made a task's dependencies satisfied.
 * @param dependencies - Explicit and list-order dependencies that were checked.
 * @param latestRuns - Latest run per task.
 * @param auditedSkips - Audited skips by task.
 * @returns The unlock cause; a human skip outranks a model success when both appear.
 */
function unlockedBy(
  dependencies: readonly TaskId[],
  latestRuns: ReadonlyMap<TaskId, RunRecord>,
  auditedSkips: ReadonlyMap<TaskId, HumanSkip>,
): PlannerReady['unlockedBy'] {
  if (dependencies.length === 0) return 'no-dependencies'
  if (dependencies.some(id => auditedSkips.has(id))) return 'human-skip'
  if (dependencies.every(id => {
    const state = latestRuns.get(id)?.state
    return state === 'succeeded' || state === 'deferred'
  })) return 'succeeded'
  return 'human-skip'
}

/**
 * Wrap a blocker as a classification.
 * @param blocker - The blocker to wrap.
 * @returns The blocked classification.
 */
function blocked(blocker: PlannerBlocker): Classification {
  return { kind: 'blocked', blocker }
}

/**
 * Find the cycle containing one task.
 * @param taskId - A task known to be in a cycle.
 * @param cycles - Every detected cycle.
 * @returns The members of the cycle that contains the task.
 */
function cycleOf(taskId: TaskId, cycles: readonly (readonly TaskId[])[]): readonly TaskId[] {
  return cycles.find(members => members.includes(taskId)) ?? [taskId]
}

/**
 * Index the latest run attempt per task.
 * @param runs - Every stored run.
 * @param tasks - Known tasks.
 * @param diagnostics - Sink for runs whose task is absent.
 * @returns Latest attempt per task id.
 */
function latestRunPerTask(
  runs: readonly RunRecord[],
  tasks: ReadonlyMap<TaskId, TaskSpec>,
  diagnostics: PlannerDiagnostic[],
): Map<TaskId, RunRecord> {
  const latest = new Map<TaskId, RunRecord>()
  for (const run of runs) {
    if (!tasks.has(run.taskId)) {
      diagnostics.push({ kind: 'orphan-run', runId: run.id, taskId: run.taskId })
      continue
    }
    const current = latest.get(run.taskId)
    if (current === undefined || supersedes(run, current)) latest.set(run.taskId, run)
  }
  return latest
}

/**
 * Decide whether one attempt supersedes another.
 * @param candidate - The later run in iteration order.
 * @param current - The attempt currently held as latest.
 * @returns Whether `candidate` is the newer attempt.
 */
function supersedes(candidate: RunRecord, current: RunRecord): boolean {
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  return candidate.id > current.id
}

/**
 * Find dependency cycles among the known tasks.
 *
 * Iterative depth-first search over declared dependency order, so the result is
 * deterministic and linear in tasks plus dependency edges; a 1000-task graph
 * stays cheap.
 * @param tasks - Known tasks by id.
 * @returns One member list per detected cycle.
 */
function findCycleMembers(tasks: ReadonlyMap<TaskId, TaskSpec>): readonly (readonly TaskId[])[] {
  const cycles: TaskId[][] = []
  const finished = new Set<TaskId>()
  const onStack = new Set<TaskId>()

  for (const root of tasks.keys()) {
    if (finished.has(root)) continue
    const stack: { taskId: TaskId; nextDependency: number }[] = [{ taskId: root, nextDependency: 0 }]
    onStack.add(root)
    const path: TaskId[] = [root]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) break
      const task = tasks.get(frame.taskId)
      if (task === undefined) {
        stack.pop()
        continue
      }
      if (frame.nextDependency >= task.dependsOn.length) {
        stack.pop()
        onStack.delete(frame.taskId)
        finished.add(frame.taskId)
        path.pop()
        continue
      }
      const dependencyId = task.dependsOn[frame.nextDependency]
      frame.nextDependency += 1
      if (dependencyId === undefined || !tasks.has(dependencyId)) continue
      if (onStack.has(dependencyId)) {
        const start = path.indexOf(dependencyId)
        if (start >= 0 && !cycles.some(members => sameMembers(members, path.slice(start)))) {
          cycles.push(path.slice(start))
        }
        continue
      }
      if (finished.has(dependencyId)) continue
      onStack.add(dependencyId)
      path.push(dependencyId)
      stack.push({ taskId: dependencyId, nextDependency: 0 })
    }
  }
  return cycles
}

/**
 * Compare two cycles by membership.
 * @param left - First member list.
 * @param right - Second member list.
 * @returns Whether both list the same task ids.
 */
function sameMembers(left: readonly TaskId[], right: readonly TaskId[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(member => set.has(member))
}

/**
 * Order ready tasks: priority descending, then queue position, then ids.
 *
 * The final id tie-break makes the order independent of the input array order,
 * so an unchanged snapshot always yields the same start order.
 * @param left - First ready entry.
 * @param right - Second ready entry.
 * @returns Negative when `left` starts first.
 */
function compareReady(left: PlannerReady, right: PlannerReady): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  if (left.queueOrder !== right.queueOrder) return left.queueOrder - right.queueOrder
  if (left.queueId !== right.queueId) return left.queueId < right.queueId ? -1 : 1
  if (left.taskId === right.taskId) return 0
  return left.taskId < right.taskId ? -1 : 1
}
