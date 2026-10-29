/**
 * Stable failures of the orchestration store.
 *
 * The `code` is the contract callers switch on; `message` is diagnostic prose
 * that carries no prompt, credential, or session content.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/errors
 */

/** Discriminant codes carried by every {@link OrchestratorError}. */
export type OrchestratorErrorCode =
  | 'closed'
  | 'revision-conflict'
  | 'not-found'
  | 'already-exists'
  | 'invalid-transition'
  | 'operation-hash-conflict'
  | 'queue-not-empty'
  | 'unsupported'

/**
 * Failure of one store read or write.
 *
 * `revision-conflict`, `not-found`, `already-exists`, and
 * `operation-hash-conflict` are recoverable by re-reading and retrying with
 * fresh state; `invalid-transition` and `closed` are not.
 */
export class OrchestratorError extends Error {
  /** Stable discriminant for the failure class. */
  readonly code: OrchestratorErrorCode

  /**
   * Construct a stable store failure.
   * @param code - Stable discriminant for the failure class.
   * @param message - Diagnostic prose with no prompt or credential content.
   * @param options - Standard error options carrying a contained cause.
   */
  constructor(code: OrchestratorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'OrchestratorError'
  }
}
