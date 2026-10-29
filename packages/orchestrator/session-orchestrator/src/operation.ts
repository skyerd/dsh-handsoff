/**
 * Canonical operation identity for one initial-prompt attempt.
 *
 * The scheduler writes these values before a run leaves `ready`, and recovery
 * recomputes them from the durable run. A stored operation whose identity,
 * request hash or run linkage disagrees with the run is a reconciliation
 * conflict: it must never be treated as this attempt's work.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/operation
 */

import { OperationId } from './brand.ts'
import type { OperationRecord, RunRecord } from './schema.ts'

/**
 * Derive the stable operation identity for one run generation.
 * @param run - the run attempt whose operation is being planned.
 * @returns the operation id shared by every retry of this generation.
 */
export function initialPromptOperationId(run: Pick<RunRecord, 'id' | 'generation'>): OperationId {
  return OperationId(`operation-${run.id}-${run.generation}`)
}

/**
 * Derive the request hash that binds one initial-prompt operation to its run.
 * @param run - the run attempt whose operation is being planned.
 * @returns the canonical request hash stored in the operation.
 */
export function initialPromptRequestHash(
  run: Pick<RunRecord, 'id' | 'generation' | 'attempt' | 'taskId'>,
): string {
  return `${run.id}|${run.generation}|${run.attempt}|initial-prompt|${run.taskId}`
}

/**
 * Check that a stored operation really belongs to one run generation.
 * @param run - the durable run.
 * @param operation - the operation the run points at, or its generation's operation.
 * @returns the stable conflict reason, or `undefined` when the linkage is sound.
 */
export function operationLinkConflict(
  run: RunRecord,
  operation: OperationRecord,
): 'operation-run-mismatch' | 'operation-generation-mismatch' | 'operation-attempt-mismatch' | undefined {
  if (operation.runId !== run.id) return 'operation-run-mismatch'
  if (operation.generation !== run.generation) return 'operation-generation-mismatch'
  if (operation.attempt !== run.attempt) return 'operation-attempt-mismatch'
  return undefined
}
