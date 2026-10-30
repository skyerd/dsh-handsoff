/**
 * Stable-enum to locale-key mapping for the settings page.
 *
 * Wire/state values stay verbatim in data; only their display labels come from
 * the owned dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/copy
 */

import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HandoffDto, RunDto, WardenAuditDto } from './contract.ts'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import type { AuditEvent, BoardColumn } from './model.ts'

/** The page's namespace-bound translate function. */
export type OrchestratorTranslate = (
  key: SessionOrchestratorSettingsLocaleKey,
  params?: Record<string, unknown>,
) => string

/** Closed-union exhaustiveness check. */
function assertNever(value: never): never {
  throw new Error(`session-orchestrator UI: unhandled ${String(value)}`)
}

/**
 * Run-state label key.
 * @param state - run state from the live snapshot.
 * @returns the locale key for that state.
 */
export function runStateKey(state: RunDto['state']): SessionOrchestratorSettingsLocaleKey {
  switch (state) {
    case 'ready': return 'stateReady'
    case 'starting': return 'stateStarting'
    case 'running': return 'stateRunning'
    case 'handoff-pending': return 'stateHandoffPending'
    case 'handing-off': return 'stateHandingOff'
    case 'succeeded': return 'stateSucceeded'
    case 'needs-attention': return 'stateNeedsAttention'
    case 'paused': return 'statePaused'
    case 'deferred': return 'stateDeferred'
    case 'cancelled': return 'stateCancelled'
    case 'failed': return 'stateFailed'
  }
}

/**
 * Operation-phase label key.
 * @param phase - operation phase from the live snapshot.
 * @returns the locale key for that phase.
 */
export function operationPhaseKey(
  phase: NonNullable<RunDto['operation']>['phase'],
): SessionOrchestratorSettingsLocaleKey {
  switch (phase) {
    case 'planned': return 'phasePlanned'
    case 'session-created': return 'phaseSessionCreated'
    case 'submitted': return 'phaseSubmitted'
    case 'claimed': return 'phaseClaimed'
    case 'settled': return 'phaseSettled'
    case 'uncertain': return 'phaseUncertain'
    default: return assertNever(phase)
  }
}

/**
 * Pressure baseline label key.
 * @param baseline - baseline kind from the live snapshot.
 * @returns the locale key for that baseline.
 */
export function baselineKey(
  baseline: NonNullable<RunDto['pressure']>['baselineKind'],
): SessionOrchestratorSettingsLocaleKey {
  switch (baseline) {
    case 'none': return 'baselineNone'
    case 'estimated': return 'baselineEstimated'
    case 'usage': return 'baselineUsage'
    default: return assertNever(baseline)
  }
}

/**
 * Pressure decision label key.
 * @param decision - pressure decision from the live snapshot.
 * @returns the locale key for that decision.
 */
export function decisionKey(
  decision: NonNullable<RunDto['pressure']>['decision'],
): SessionOrchestratorSettingsLocaleKey {
  switch (decision) {
    case 'handoff-pending': return 'decisionHandoffPending'
    case 'no-handoff': return 'decisionNoHandoff'
    default: return assertNever(decision)
  }
}

/**
 * Pressure blocker label key.
 * @param blocker - pressure blocker from the live snapshot, when present.
 * @returns the locale key, or `undefined` without a blocker.
 */
export function blockerKey(
  blocker: NonNullable<RunDto['pressure']>['blockedBy'] | undefined,
): SessionOrchestratorSettingsLocaleKey | undefined {
  switch (blocker) {
    case undefined: return undefined
    case 'handoff-disabled': return 'blockerHandoffDisabled'
    case 'generation-exhausted': return 'blockerGenerationExhausted'
    case 'context-window-unknown': return 'blockerContextWindowUnknown'
    case 'below-threshold': return 'blockerBelowThreshold'
    case 'handoff-in-flight': return 'blockerHandoffInFlight'
    case 'external-input': return 'blockerExternalInput'
    case 'paused': return 'blockerPaused'
    case 'cancelled': return 'blockerCancelled'
    case 'turn-not-closed': return 'blockerTurnNotClosed'
    case 'budget-unavailable': return 'blockerBudgetUnavailable'
    case 'empty-generation': return 'blockerEmptyGeneration'
    default: return assertNever(blocker)
  }
}

/**
 * Handoff-mode label key.
 * @param mode - handoff mode from the live snapshot.
 * @returns the locale key for that mode.
 */
export function handoffModeKey(mode: HandoffDto['mode']): SessionOrchestratorSettingsLocaleKey {
  switch (mode) {
    case 'structured-brief': return 'modeStructuredBrief'
    case 'last-complete-turn': return 'modeLastCompleteTurn'
    default: return assertNever(mode)
  }
}

/**
 * Board-column label key.
 * @param column - parallel-board column.
 * @returns the locale key for that column.
 */
export function boardColumnKey(column: BoardColumn): SessionOrchestratorSettingsLocaleKey {
  switch (column) {
    case 'running': return 'boardColumnRunning'
    case 'waiting': return 'boardColumnWaiting'
    case 'attention': return 'boardColumnAttention'
    case 'paused': return 'boardColumnPaused'
    case 'settled': return 'boardColumnSettled'
  }
}

/**
 * Pipeline-stage label key.
 * @param stage - `TaskSpec.stage`, or `undefined` for a task outside a pipeline.
 * @returns the locale key for a known stage, else `undefined`.
 */
export function stageKey(stage: string | undefined): SessionOrchestratorSettingsLocaleKey | undefined {
  switch (stage) {
    case undefined: return undefined
    case 'architecture': return 'stageArchitecture'
    case 'breakdown': return 'stageBreakdown'
    case 'implement': return 'stageImplement'
    case 'test': return 'stageTest'
    default: return undefined
  }
}

/**
 * Audit-fact label key.
 * @param kind - projected audit fact kind.
 * @returns the locale key for that fact.
 */
export function auditKindKey(kind: AuditEvent['kind']): SessionOrchestratorSettingsLocaleKey {
  switch (kind) {
    case 'run-created': return 'auditKindRunCreated'
    case 'run-updated': return 'auditKindRunUpdated'
    case 'run-error': return 'auditKindRunError'
    case 'operation-phase': return 'auditKindOperationPhase'
    case 'pressure': return 'auditKindPressure'
    case 'handoff': return 'auditKindHandoff'
    case 'human-skip': return 'auditKindHumanSkip'
  }
}

/**
 * Localized explanation key for one stable failure code.
 * @param code - stable failure code from the Host or local client.
 * @returns the locale key for its explanation.
 */
export function errorExplanationKey(code: string): SessionOrchestratorSettingsLocaleKey {
  switch (code) {
    case 'sessionOrchestrator/forbidden': return 'explanationForbidden'
    case 'sessionOrchestrator/not-found': return 'explanationNotFound'
    case 'sessionOrchestrator/revision-conflict': return 'explanationRevisionConflict'
    case 'sessionOrchestrator/conflict': return 'explanationConflict'
    case 'sessionOrchestrator/invalid-transition': return 'explanationInvalidTransition'
    case 'sessionOrchestrator/invalid-request': return 'explanationInvalidRequest'
    case 'sessionOrchestrator/queue-not-empty': return 'explanationQueueNotEmpty'
    case 'sessionOrchestrator/task-list-invalid': return 'explanationTaskListInvalid'
    case 'sessionOrchestrator/unavailable': return 'explanationUnavailable'
    case 'sessionOrchestrator/cancelled': return 'explanationCancelled'
    case 'gateway/cancelled': return 'explanationCancelled'
    case 'gateway/internal': return 'explanationTransport'
    case 'ui/unsaved-queue': return 'explanationUiUnsavedQueue'
    case 'ui/unsaved-task': return 'explanationUiUnsavedTask'
    case 'ui/no-queue': return 'explanationUiNoQueue'
    case 'ui/queue-missing': return 'explanationUiQueueMissing'
    case 'ui/queue-running': return 'explanationUiQueueRunning'
    case 'ui/queue-title-required': return 'explanationUiQueueTitleRequired'
    case 'ui/queue-not-empty': return 'explanationUiQueueNotEmpty'
    case 'ui/no-task': return 'explanationUiNoTask'
    case 'ui/task-missing': return 'explanationUiTaskMissing'
    case 'ui/task-hidden': return 'explanationUiTaskHidden'
    case 'ui/task-has-run': return 'explanationUiTaskHasRun'
    case 'ui/task-id-required': return 'explanationUiTaskIdRequired'
    case 'ui/queue-id-required': return 'explanationUiQueueIdRequired'
    case 'ui/workspace-required': return 'explanationUiWorkspaceRequired'
    case 'ui/workspace-path-required': return 'explanationUiWorkspacePathRequired'
    case 'ui/template-brief-required': return 'explanationUiTemplateBriefRequired'
    case 'ui/pipeline-prompt-required': return 'explanationUiPipelinePromptRequired'
    case 'ui/no-settings': return 'explanationUiNoSettings'
    case 'ui/settings-unavailable': return 'explanationUiSettingsUnavailable'
    case 'ui/run-missing': return 'explanationUiRunMissing'
    case 'ui/run-not-retryable': return 'explanationUiRunNotRetryable'
    case 'ui/run-not-skippable': return 'explanationUiRunNotSkippable'
    case 'ui/audit-required': return 'explanationUiAuditRequired'
    case 'ui/busy': return 'explanationUiBusy'
    case 'ui/disposed': return 'explanationUiDisposed'
    case 'ui/session-unsupported': return 'explanationUiSessionUnsupported'
    case 'ui/session-archived': return 'explanationUiSessionArchived'
    case 'ui/session-missing': return 'explanationUiSessionMissing'
    case 'ui/session-open-failed': return 'explanationUiSessionOpenFailed'
    case 'ui/model-route-required': return 'explanationUiModelRouteRequired'
    case 'ui/archive-unavailable': return 'explanationUiArchiveUnavailable'
    case 'ui/archive-failed': return 'explanationUiArchiveFailed'
    default: return 'explanationUnknown'
  }
}

/**
 * Localized explanation key for one model-review fallback code.
 * @param code - stable fallback code from the review ledger.
 * @returns the locale key explaining why the local rules decided.
 */
export function wardenErrorKey(
  code: NonNullable<WardenAuditDto['error']>,
): SessionOrchestratorSettingsLocaleKey {
  switch (code) {
    case 'timeout': return 'wardenErrorTimeout'
    case 'invalid-output': return 'wardenErrorInvalidOutput'
    case 'unavailable': return 'wardenErrorUnavailable'
    case 'packet-too-large': return 'wardenErrorPacketTooLarge'
    case 'budget-exhausted': return 'wardenErrorBudgetExhausted'
    default: return assertNever(code)
  }
}

/**
 * Relative time label for one epoch millisecond instant.
 * @param at - event time in epoch milliseconds.
 * @param now - current time in epoch milliseconds.
 * @param t - locale translate function.
 * @returns the relative time label.
 */
export function timeLabel(at: number, now: number, t: OrchestratorTranslate): string {
  const bucket = relativeTime(at, now)
  switch (bucket.unit) {
    case 'now': return t('timeNow')
    case 'minutes': return t('timeMinutes', { count: bucket.n })
    case 'hours': return t('timeHours', { count: bucket.n })
    case 'days': return t('timeDays', { count: bucket.n })
    case 'months': return t('timeMonths', { count: bucket.n })
    case 'years': return t('timeYears', { count: bucket.n })
    default: return assertNever(bucket.unit)
  }
}
