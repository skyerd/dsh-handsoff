/**
 * The one route resolution a dispatch and a resume share.
 *
 * A task pins its own route, inherits the pipeline route, or inherits the host
 * default. The resolution happens once, before the Session is created; the
 * resulting route is fixed for that conversation. A stored effective config
 * snapshot outranks the task policy when resuming, so re-holding a conversation
 * after a completed turn never switches its model.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/model-route
 */

import type { EffectiveConfigSnapshot, ModelPolicy, QueueRecord, TaskSpec } from './types.ts'

/**
 * Resolve the route one task dispatch creates its Session with.
 *
 * A fixed task route always wins. Otherwise a fixed pipeline route is the
 * inheritance target; a pipeline that itself inherits leaves the host default in
 * charge. The result never changes after the Session exists.
 * @param task - task carrying its own model policy.
 * @param queue - pipeline whose stored policy is the inheritance target.
 * @returns the route the new Session must use.
 */
export function resolveTaskModel(
  task: Pick<TaskSpec, 'model'>,
  queue: Pick<QueueRecord, 'model'> | undefined,
): ModelPolicy {
  if (task.model.kind === 'fixed') return task.model
  const pipeline = queue?.model
  return pipeline?.kind === 'fixed' ? pipeline : task.model
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
