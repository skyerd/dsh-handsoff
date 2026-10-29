/**
 * Shapes of the generated recovery evidence. Keeping them in a plain module
 * lets the specs write JSON without dragging runtime code into the artifact.
 */

/** One persisted run field set, without revision-scoped timestamps. */
export interface RunSnapshot {
  readonly id: string
  readonly state: string
  readonly revision: number
  readonly activeSessionId: string | undefined
  readonly generation: number
  readonly sessionLineage: readonly string[]
  readonly operationId: string | undefined
  readonly claimedTurn: number | undefined
  readonly acceptedTurnEndSeq: number | undefined
  readonly lease: { readonly ownerId: string; readonly expiresAt: number } | undefined
}

/** One persisted operation field set. */
export interface OperationSnapshot {
  readonly id: string
  readonly kind: string
  readonly phase: string
  readonly generation: number
  readonly attempt: number
  readonly targetSessionId: string | undefined
  readonly sourceSessionId: string | undefined
  readonly messageId: string | undefined
  readonly requestHash: string
}

/** One durable Session and its event count. */
export interface SessionSnapshot {
  readonly id: string
  readonly events: number
}

/** Everything recovery can read from the durable domain and Session medium. */
export interface MatrixSnapshot {
  readonly runs: readonly RunSnapshot[]
  readonly operations: readonly OperationSnapshot[]
  readonly sessions: readonly SessionSnapshot[]
}

/** The decision fields that survive serialization (no live settlement). */
export interface RecordedDecision {
  readonly runId: string
  readonly stateBefore: string
  readonly stateAfter: string
  readonly action: string
  readonly reason: string
  readonly detail: string | undefined
  readonly operationId: string | undefined
  readonly operationPhaseBefore: string | undefined
  readonly sessionId: string | undefined
  readonly messageId: string | undefined
  readonly turn: number | undefined
  readonly submitPrompt: boolean | undefined
}

/** One recovered resume request. */
export interface RecordedResume {
  readonly sessionId: string
  readonly operationId: string
  readonly submitPrompt: boolean
  readonly messageId: string | undefined
  readonly claimedTurn: number | undefined
}

/** One injected crash point and the state on both sides of it. */
export interface RecordedFaultCase {
  readonly id: string
  readonly title: string
  readonly variant: 'crash-before' | 'crash-after' | 'delivery-lost'
  readonly fault: { readonly method: string; readonly timing: string; readonly reason: string } | undefined
  readonly before: MatrixSnapshot
  readonly crash: MatrixSnapshot
  readonly restarted: MatrixSnapshot
  readonly firstPass: 'rejected' | 'completed'
  readonly restartedDecisions: readonly RecordedDecision[]
  readonly restartedResumes: readonly RecordedResume[]
  readonly schedulerOpenAfterRestart: boolean
  readonly fatal: { readonly code: string; readonly detail: string } | undefined
}

/** One matrix case with its before/after durable picture. */
export interface RecordedCase {
  readonly id: string
  readonly title: string
  readonly variant: string
  readonly runId: string
  readonly before: MatrixSnapshot
  readonly after: MatrixSnapshot
  readonly decision: RecordedDecision | undefined
  readonly fatal: { readonly code: string; readonly detail: string } | undefined
  readonly schedulerOpen: boolean
  readonly resumes: readonly RecordedResume[]
  readonly sessionCount: number
}
