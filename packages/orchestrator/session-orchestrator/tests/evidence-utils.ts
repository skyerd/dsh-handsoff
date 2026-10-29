/** Shared snapshot helpers for the generated recovery evidence. */
import type { RecoveryDecision } from '../src/recovery.ts'
import type { OperationRecord, RunRecord } from '../src/schema.ts'
import type { MatrixSnapshot, RecordedDecision } from './evidence-types.ts'
import type { RecoveryCase } from './recovery-fakes.ts'

/**
 * Read the full durable picture recovery can see.
 * @param c - seeded recovery fixture.
 * @returns run, operation and Session snapshots.
 */
export function snapshot(c: RecoveryCase): MatrixSnapshot {
  return {
    runs: c.store.listRuns().map((run: RunRecord) => ({
      id: run.id,
      state: run.state,
      revision: run.revision,
      activeSessionId: run.activeSessionId,
      generation: run.generation,
      sessionLineage: [...run.sessionLineage],
      operationId: run.operationId,
      claimedTurn: run.claimedTurn,
      acceptedTurnEndSeq: run.acceptedTurnEndSeq,
      lease: run.lease,
    })),
    operations: c.store.listOperations().map((operation: OperationRecord) => ({
      id: operation.id,
      kind: operation.kind,
      phase: operation.phase,
      generation: operation.generation,
      attempt: operation.attempt,
      targetSessionId: operation.targetSessionId,
      sourceSessionId: operation.sourceSessionId,
      messageId: operation.messageId,
      requestHash: operation.requestHash,
    })),
    sessions: [...c.durable.logs.entries()].map(([id, events]) => ({
      id,
      events: events.length,
    })),
  }
}

/**
 * Drop the live settlement promise so the decision is JSON-safe.
 * @param decision - recovered decision.
 * @returns serializable fields.
 */
export function serializedDecision(decision: RecoveryDecision | undefined): RecordedDecision | undefined {
  if (decision === undefined) return undefined
  return {
    runId: decision.runId,
    stateBefore: decision.stateBefore,
    stateAfter: decision.stateAfter,
    action: decision.action,
    reason: decision.reason,
    detail: decision.detail,
    operationId: decision.operationId,
    operationPhaseBefore: decision.operationPhaseBefore,
    sessionId: decision.sessionId,
    messageId: decision.messageId,
    turn: decision.turn,
    submitPrompt: decision.submitPrompt,
  }
}
