/**
 * The one route resolution a dispatch and a resume share.
 *
 * A task pins its own route, inherits the pipeline route, inherits the route the
 * previous task's conversation used, or inherits the host default. The
 * resolution happens once, before the Session is created; the resulting route is
 * fixed for that conversation. A stored effective config snapshot outranks the
 * task policy when resuming, so re-holding a conversation after a completed turn
 * never switches its model.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/model-route
 */

import type { EffectiveConfigSnapshot, ModelPolicy, QueueRecord, RunRecord, TaskSpec } from './types.ts'

/**
 * Resolve the route one task dispatch creates its Session with.
 *
 * A fixed task route always wins. Otherwise a fixed pipeline route is the
 * inheritance target; a pipeline that itself inherits takes the route the
 * previous task's conversation actually used, and only a task with no such
 * predecessor leaves the host default in charge. The result never changes after
 * the Session exists.
 * @param task - task carrying its own model policy.
 * @param queue - pipeline whose stored policy is the inheritance target.
 * @param previous - route the previous task's latest conversation used, when one exists.
 * @returns the route the new Session must use.
 */
export function resolveTaskModel(
  task: Pick<TaskSpec, 'model'>,
  queue: Pick<QueueRecord, 'model'> | undefined,
  previous?: ModelPolicy,
): ModelPolicy {
  if (task.model.kind === 'fixed') return task.model
  const pipeline = queue?.model
  if (pipeline?.kind === 'fixed') return pipeline
  if (previous?.kind === 'fixed') return previous
  return task.model
}

/**
 * Read the route the previous task's latest conversation used.
 *
 * The walk starts at the task immediately before this one in the pipeline's
 * order and skips predecessors that never ran and never pinned a route. A fixed
 * predecessor policy outranks its frozen run snapshot, because switching a
 * conversation's model also writes that task policy and must reach the next
 * conversation; a task that still inherits is resolved from the snapshot that
 * recorded what its Session actually used.
 * @param task - task whose inherited route is required.
 * @param queue - pipeline that supplies the task order.
 * @param tasks - every stored task.
 * @param runs - every stored attempt.
 * @returns a fixed route to inherit, or undefined when no predecessor has one.
 */
export function previousConversationModel(
  task: Pick<TaskSpec, 'id' | 'queueId'>,
  queue: Pick<QueueRecord, 'taskOrder'> | undefined,
  tasks: readonly Pick<TaskSpec, 'id' | 'model'>[],
  runs: readonly Pick<RunRecord, 'taskId' | 'attempt' | 'updatedAt' | 'configSnapshot'>[],
): ModelPolicy | undefined {
  const order = queue?.taskOrder
  if (order === undefined) return undefined
  const index = order.indexOf(task.id)
  if (index <= 0) return undefined
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = tasks.find(candidate => candidate.id === order[cursor])
    if (previous === undefined) continue
    const latest = runs
      .filter(run => run.taskId === previous.id)
      .reduce<Pick<RunRecord, 'taskId' | 'attempt' | 'updatedAt' | 'configSnapshot'> | undefined>(
        (winner, run) => {
          if (winner === undefined) return run
          if (run.attempt !== winner.attempt) return run.attempt > winner.attempt ? run : winner
          return run.updatedAt > winner.updatedAt ? run : winner
        },
        undefined,
      )
    if (previous.model.kind === 'fixed') return previous.model
    if (latest?.configSnapshot !== undefined) return frozenModelOf(latest.configSnapshot)
  }
  return undefined
}

/**
 * Read the route a completed boundary already froze for one conversation.
 *
 * Recovery uses this before the task policy: a live Session must keep the model
 * it was created with even when the pipeline or task draft changed afterwards.
 * @param snapshot - effective config captured at a successful turn boundary.
 * @returns the frozen fixed route.
 */
export function frozenModelOf(snapshot: EffectiveConfigSnapshot): ModelPolicy {
  return {
    kind: 'fixed',
    provider: snapshot.provider,
    model: snapshot.model,
    ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }),
  }
}
