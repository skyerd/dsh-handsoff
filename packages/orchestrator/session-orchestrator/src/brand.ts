/**
 * Branded identities owned by the session orchestrator.
 *
 * Queues, tasks, runs and operations each cross a durable storage boundary, so
 * each id is branded to keep one kind from being passed where another is
 * expected. The brand is compile-time only: comparison, logging and the stored
 * value keep the underlying string.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/brand
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one orchestration queue. */
export type QueueId = Branded<'QueueId'>

/**
 * Brand a queue identifier.
 * @param id - the opaque queue identifier.
 * @returns the same string with the queue-id brand.
 */
export function QueueId(id: string): QueueId {
  return brandString<QueueId>(id)
}

/** Stable identity of one task specification. */
export type TaskId = Branded<'TaskId'>

/**
 * Brand a task identifier.
 * @param id - the opaque task identifier.
 * @returns the same string with the task-id brand.
 */
export function TaskId(id: string): TaskId {
  return brandString<TaskId>(id)
}

/** Stable identity of one attempt to execute a task. */
export type RunId = Branded<'RunId'>

/**
 * Brand a run identifier.
 * @param id - the opaque run identifier.
 * @returns the same string with the run-id brand.
 */
export function RunId(id: string): RunId {
  return brandString<RunId>(id)
}

/** Stable identity of one create-or-submit operation, reused across retries. */
export type OperationId = Branded<'OperationId'>

/**
 * Brand an operation identifier.
 * @param id - the opaque operation identifier.
 * @returns the same string with the operation-id brand.
 */
export function OperationId(id: string): OperationId {
  return brandString<OperationId>(id)
}
