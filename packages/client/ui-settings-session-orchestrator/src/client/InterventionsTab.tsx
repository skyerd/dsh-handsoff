/** Task-scoped run records: handoffs, observable audit facts and interventions. */

import type { ReactNode } from 'react'
import type {
  InterventionDto, RunDto, SessionLinkDto, WardenAuditDto,
} from './contract.ts'
import {
  timeLabel, wardenErrorKey,
} from './copy.ts'
import { deriveAuditEvents, type AuditEvent } from './model.ts'
import { RunActions } from './RunActions.tsx'
import { SessionRoute } from './SessionRoute.tsx'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './TaskTab.module.css'

interface RunRecordView {
  readonly id: string
  readonly at: number
  readonly reason: string
  readonly action: string
  readonly children: readonly string[]
  readonly tokens?: string
  readonly session?: SessionLinkDto
  readonly internal: string
}

function interventionAction(record: InterventionDto, t: OrchestrationTabProps['t']): string {
  switch (record.kind) {
    case 'pause-context':
    case 'decompose': return t('runRecordDecomposeAction')
    case 'refine': return t('runRecordRefineAction')
    case 'pause-idle':
    case 'stop-and-notify': return t('runRecordIdleAction')
    case 'abort-all': return t('runRecordAbortAction')
  }
}

function interventionReason(record: InterventionDto, t: OrchestrationTabProps['t']): string {
  if (record.trigger.contextRatio !== undefined) {
    return t('runRecordContextReason', { percent: Math.round(record.trigger.contextRatio * 100) })
  }
  if (record.trigger.hitRate !== undefined) {
    return t('runRecordCacheReason', { percent: Math.round(record.trigger.hitRate * 100) })
  }
  if (record.trigger.idleMs !== undefined) {
    return t('runRecordIdleReason', { minutes: Math.round(record.trigger.idleMs / 60000) })
  }
  return record.reason
}

function interventionView(
  record: InterventionDto,
  props: OrchestrationTabProps,
): RunRecordView {
  const { t, live } = props
  const childTitle = (id: string): string => live.tasks.find(task => task.id === id)?.title ?? id
  return {
    id: record.id,
    at: record.updatedAt,
    reason: interventionReason(record, t),
    action: interventionAction(record, t),
    children: record.childTaskIds.map(childTitle),
    tokens: record.warden?.mode !== 'model' ? t('runRecordNoExtraTokens') : t('runRecordTokensBelow'),
    ...(record.session === undefined ? {} : { session: record.session }),
    internal: [
      record.id,
      record.kind,
      record.phase,
      record.reason,
      record.warden === undefined
        ? ''
        : `${record.warden.mode} ${record.warden.provider ?? ''}/${record.warden.model ?? ''}`,
      record.paidBy === undefined ? '' : `paid by ${record.paidBy.provider}/${record.paidBy.model}`,
      record.note,
    ].filter(Boolean).join(' · '),
  }
}

function reviewRow(review: WardenAuditDto, props: OrchestrationTabProps): ReactNode {
  const { t, now } = props
  const fallback = review.mode === 'rule-fallback'
  return (
    <li key={review.id} className={css.taskRow}>
      <div className={css.taskMain}>
        <span className={css.taskTitle}>{review.reason}</span>
        <span className={css.taskMeta}>
          {fallback
            ? review.error === undefined ? t('wardenModeFallback') : t(wardenErrorKey(review.error))
            : t('wardenRoute', { provider: review.provider ?? '', model: review.model ?? '' })}
        </span>
        <span className={css.taskMeta}>
          {t('wardenTokens', { input: review.inputTokens ?? 0, output: review.outputTokens ?? 0 })}
          {' · '}
          {timeLabel(review.createdAt, now, t)}
        </span>
        <details>
          <summary>{t('runRecordTechnicalDetails')}</summary>
          <span className={css.taskMeta}>{[review.id, review.verdict, review.latencyMs].filter(Boolean).join(' · ')}</span>
        </details>
      </div>
    </li>
  )
}

function auditView(event: AuditEvent, t: OrchestrationTabProps['t']): Pick<RunRecordView, 'reason' | 'action'> {
  switch (event.kind) {
    case 'run-error':
      return { reason: t('runRecordFailureReason'), action: t('runRecordFailureAction') }
    case 'operation-phase':
      return { reason: t('runRecordStageReason'), action: t('runRecordStageAction') }
    case 'pressure':
      return { reason: t('runRecordPressureReason'), action: t('runRecordPressureAction') }
    case 'human-skip':
      return { reason: t('runRecordSkipReason'), action: t('runRecordSkipAction') }
    case 'run-created':
    case 'run-updated':
    case 'handoff':
      return { reason: t('runRecordAuditReason'), action: t('runRecordAuditAction') }
  }
}

/**
 * Render only user-facing causes, actions, new tasks, Tokens and controls.
 * Internal identities, phases and paid model routes stay behind disclosures.
 * @param props - live snapshot and the task whose details are open.
 * @returns the task's merged run records.
 */
export function RunRecords(props: OrchestrationTabProps & {
  readonly taskId: string
  readonly run?: RunDto
}) {
  const { t, live, now, taskId, run, actions } = props
  const runById = new Map(live.runs.map(candidate => [candidate.id, candidate]))
  const interventions = live.interventions
    .filter(record => record.taskId === taskId)
    .map(record => interventionView(record, props))
  const handoffs: RunRecordView[] = live.handoffs.flatMap((record) => {
    const owner = runById.get(record.runId)
    if (owner?.taskId !== taskId) return []
    return [{
      id: `handoff:${record.operationId}:${record.generation}`,
      at: record.createdAt,
      reason: t('runRecordHandoffReason'),
      action: t('runRecordHandoffAction'),
      children: [],
      ...(record.bodyTokens === undefined ? {} : { tokens: t('runRecordTokenCount', { tokens: record.bodyTokens }) }),
      session: record.childSession,
      internal: [record.operationId, record.runId, record.mode, `generation ${record.generation}`].join(' · '),
    }]
  })
  const audits: RunRecordView[] = deriveAuditEvents(live.runs, live.handoffs)
    .filter(event => event.taskId === taskId)
    .filter(event => event.kind === 'run-error'
      || event.kind === 'operation-phase'
      || event.kind === 'pressure'
      || event.kind === 'human-skip')
    .map(event => ({
      id: event.id,
      at: event.at,
      ...auditView(event, t),
      children: [],
      internal: [event.id, event.runId, event.kind, 'code' in event ? event.code : ''].filter(Boolean).join(' · '),
    }))
  const records = [...interventions, ...handoffs, ...audits]
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id))
  const reviews = live.wardenAudits
    .filter(review => review.taskId === taskId)
    .sort((left, right) => right.createdAt - left.createdAt)
  const busy = props.drafts.busy !== undefined

  return (
    <section className={css.queuePanel} aria-label={t('runRecordsTitle')}>
      <header className={css.panelHead}>
        <h3 className={css.panelTitle}>{t('runRecordsTitle')}</h3>
      </header>
      {records.length === 0
        ? <p className={css.empty}>{t('runRecordsEmpty')}</p>
        : (
          <ul className={css.taskList}>
            {records.map(record => (
              <li key={record.id} className={css.taskRow}>
                <div className={css.taskMain}>
                  <span className={css.taskTitle}>{record.reason}</span>
                  <span className={css.taskMeta}>{t('runRecordAction')}: {record.action}</span>
                  {record.children.length > 0 && (
                    <span className={css.taskMeta}>
                      {t('runRecordNewTasks')}: {record.children.join('、')}
                    </span>
                  )}
                  {record.tokens !== undefined && (
                    <span className={css.taskMeta}>Token: {record.tokens}</span>
                  )}
                  <span className={css.taskMeta}>{timeLabel(record.at, now, t)}</span>
                  {record.session !== undefined && (
                    <SessionRoute
                      session={record.session}
                      t={t}
                      disabled={busy}
                      onOpen={(session) => { void actions.openSession(session) }}
                    />
                  )}
                  <details>
                    <summary>{t('runRecordTechnicalDetails')}</summary>
                    <span className={css.taskMeta}>{record.internal}</span>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      {reviews.length > 0 && (
        <details>
          <summary>{t('runRecordReviewDetails')}</summary>
          <p className={css.hint}>{t('wardenNotice')}</p>
          <ul className={css.taskList}>{reviews.map(review => reviewRow(review, props))}</ul>
        </details>
      )}
      {run !== undefined && (
        <RunActions
          t={t}
          run={run}
          taskTitle={live.tasks.find(task => task.id === taskId)?.title ?? taskId}
          disabled={busy}
          onCancel={actions.cancelRun}
          onRetry={actions.retryRun}
          onSkip={actions.skipRun}
        />
      )}
    </section>
  )
}
