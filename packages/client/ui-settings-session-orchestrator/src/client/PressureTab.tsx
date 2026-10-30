/** Automation thresholds, queue routing, details, savings and engineering guardrails. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InterventionDto, QueueDto } from './contract.ts'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import { timeLabel } from './copy.ts'
import { DangerConfirm } from './DangerConfirm.tsx'
import { Summary } from './Summary.tsx'
import { NumberField, SelectField, TextAreaField } from './Fields.tsx'
import { AutomationDialog, type AutomationDialogStage } from './AutomationDialog.tsx'
import {
  addImprovement, addNotice, markAlertHandled, saveAutomation, saveEngineering,
  saveQueueModels, useStudio, type AutomationParams, type EngineeringConstraints, type QueueModelSelection,
} from './studioStore.ts'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './PressureTab.module.css'

/** One automatic intervention projected for the detail table. */
interface DetailRow {
  readonly id: string
  readonly queueTitle: string
  readonly taskTitle: string
  readonly issue: string
  readonly reason: string
  readonly at: number
}

/** Localize one intervention kind. */
function interventionKey(kind: InterventionDto['kind']): SessionOrchestratorSettingsLocaleKey {
  switch (kind) {
    case 'pause-context': return 'pressureKindPauseContext'
    case 'pause-idle': return 'pressureKindPauseIdle'
    case 'decompose': return 'pressureKindDecompose'
    case 'refine': return 'pressureKindRefine'
    case 'abort-all': return 'pressureKindAbortAll'
    case 'stop-and-notify': return 'pressureKindStopNotify'
  }
}

/** Project interventions into rows queue owners can read. */
function buildDetailRows(
  queues: readonly QueueDto[],
  tasks: OrchestrationTabProps['live']['tasks'],
  interventions: readonly InterventionDto[],
  t: OrchestrationTabProps['t'],
): DetailRow[] {
  return [...interventions]
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .map((intervention) => {
      const task = tasks.find(candidate => candidate.id === intervention.taskId)
      const queue = queues.find(candidate => candidate.id === task?.queueId)
      return {
        id: intervention.id,
        queueTitle: queue?.title ?? '—',
        taskTitle: task?.title ?? intervention.taskId,
        issue: t(interventionKey(intervention.kind)),
        reason: intervention.reason,
        at: intervention.createdAt,
      }
    })
}

/** Compact a token count for a metric cell. */
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

/** One queue's two model route selectors. */
function QueueModelCard({ queue, t, models, value, onSave }: {
  readonly queue: QueueDto
  readonly t: OrchestrationTabProps['t']
  readonly models: OrchestrationTabProps['live']['models']
  readonly value: QueueModelSelection | undefined
  readonly onSave: (selection: QueueModelSelection) => void
}) {
  const [supervisor, setSupervisor] = useState(value?.supervisor ?? '')
  const [splitter, setSplitter] = useState(value?.splitter ?? '')
  const [saved, setSaved] = useState(false)
  const routeOptions = [
    { value: '', label: t('pressureQueueModelInherit') },
    ...models.choices.map(choice => ({
      value: `${choice.provider}/${choice.model}`,
      label: `${choice.providerName} · ${choice.modelName}`,
    })),
  ]
  const ensureRoute = (route: string): void => {
    if (route === '' || routeOptions.some(option => option.value === route)) return
    routeOptions.push({ value: route, label: route })
  }
  ensureRoute(supervisor)
  ensureRoute(splitter)

  return (
    <article className={css.queueModel} data-queue-id={queue.id}>
      <header className={css.queueModelHead}>
        <div className={css.queueModelIdentity}>
          <h4 className={css.subtitle}>{queue.title}</h4>
          <span className={css.metaText}>
            {queue.cwd ?? queue.workspaceId ?? '—'} · {t('queueTaskCount', { count: queue.taskOrder.length })}
          </span>
        </div>
        {saved && <Tag tone="success">{t('pressureQueueModelSaved')}</Tag>}
      </header>
      <div className={css.modelGrid}>
        <SelectField
          label={t('pressureQueueSupervisor')}
          value={supervisor}
          options={routeOptions}
          disabled={models.phase === 'loading'}
          onChange={(route) => { setSupervisor(route); setSaved(false) }}
        />
        <SelectField
          label={t('pressureQueueSplitter')}
          value={splitter}
          options={routeOptions}
          disabled={models.phase === 'loading'}
          onChange={(route) => { setSplitter(route); setSaved(false) }}
        />
      </div>
      <div className={css.queueModelFoot}>
        <span className={css.metaText}>
          {models.phase === 'ready'
            ? t('modelFixedHint')
            : models.phase === 'loading' ? t('modelCatalogLoading') : t('modelCatalogUnavailable')}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={models.phase === 'loading'}
          onClick={() => {
            onSave({ supervisor, splitter })
            setSaved(true)
          }}
        >
          {t('pressureQueueModelSave')}
        </Button>
      </div>
    </article>
  )
}

/** One feedback cell in the waste panel. */
function FeedbackCell({ active, label, detail, count }: {
  readonly active: boolean
  readonly label: string
  readonly detail: string
  readonly count: number
}) {
  return (
    <article className={active ? `${css.feedbackCard} ${css.feedbackWarn}` : css.feedbackCard}>
      <header className={css.feedbackHead}>
        <span className={css.subtitle}>{label}</span>
        <Tag tone={active ? 'warning' : 'quiet'}>{String(count)}</Tag>
      </header>
      <p className={css.feedbackBody}>{detail}</p>
    </article>
  )
}

/**
 * Render automatic behavior, per-queue model routing, thresholds, details and
 * the waste feedback loop without exposing deployment-only implementation.
 * @param props - live settings, localized copy, and section callbacks.
 * @returns the automation settings tab.
 */
export function PressureTab({ t, live, drafts, now, actions }: OrchestrationTabProps) {
  const busy = drafts.busy !== undefined
  const settings = live.settings
  const studio = useStudio()
  const [pendingHost, setPendingHost] = useState<'pause' | 'resume' | undefined>()
  const [params, setParams] = useState<AutomationParams>(studio.automation)
  const [engineering, setEngineering] = useState<EngineeringConstraints>(studio.engineering)
  const [dialogStage, setDialogStage] = useState<AutomationDialogStage>('ask')
  const [alertMessage, setAlertMessage] = useState('')
  const details = buildDetailRows(live.queues, live.tasks, live.interventions, t)
  const idleHits = live.interventions.filter(intervention => (
    intervention.kind === 'pause-idle' || intervention.kind === 'stop-and-notify'
  )).length
  const overBudgetRuns = live.runs.filter(run => (
    (run.pressure?.totalTokens ?? 0) >= studio.automation.tokenLimit
  ))
  const alertSource: 'idle' | 'cost' | undefined = idleHits >= 3
    ? 'idle'
    : overBudgetRuns.length > 0 ? 'cost' : undefined
  const alertReason = alertSource === 'idle'
    ? t('pressureAlertIdleReason')
    : t('pressureAlertCostReason')
  const alertOpen = alertSource !== undefined && !studio.alertHandled
  const measuredTokens = live.runs.reduce((sum, run) => sum + (run.pressure?.totalTokens ?? 0), 0)
  const measuredMs = live.runs.reduce((sum, run) => sum + Math.max(0, run.updatedAt - run.createdAt), 0)
  const compressed = live.interventions.filter(intervention => (
    intervention.kind === 'pause-context' || intervention.kind === 'decompose'
  )).length + live.handoffs.length
  const savedTokens = Math.round(measuredTokens * 0.24)
  const savedMinutes = Math.round((measuredMs / 60_000) * 0.31)
  const hasSavings = measuredTokens > 0 || measuredMs > 0 || compressed > 0
  const fileSignals = live.interventions.filter(intervention => intervention.kind === 'pause-context').length
  const commandSignals = live.runs.filter(run => run.lastError !== undefined).length
  const timeSignals = live.interventions.filter(intervention => intervention.kind === 'pause-idle').length
  const tokenSignals = overBudgetRuns.length
  const hasWaste = fileSignals + commandSignals + timeSignals + tokenSignals > 0
  const latestImprovement = studio.improvements[0]
  const paramsInvalid = params.contextThreshold < 10 || params.contextThreshold > 95
    || params.idleMinutes < 1 || params.idleMinutes > 240
    || params.cacheWarn < 5 || params.cacheWarn > 100
    || params.cacheAbort < 5 || params.cacheAbort > 100
    || params.cacheWarn <= params.cacheAbort
    || params.tokenLimit < 1_000 || params.tokenLimit > 100_000_000
  const paramsDirty = JSON.stringify(params) !== JSON.stringify(studio.automation)
  const engineeringInvalid = engineering.codeParagraphLimit < 100 || engineering.codeParagraphLimit > 2_000
  const engineeringDirty = JSON.stringify(engineering) !== JSON.stringify(studio.engineering)
  const rules = [
    { title: t('automationContextTitle'), body: t('automationContextBody') },
    { title: t('automationIdleTitle'), body: t('automationIdleBody') },
    { title: t('automationCacheTitle'), body: t('automationCacheBody') },
    { title: t('automationAbortTitle'), body: t('automationAbortBody') },
  ]

  return (
    <div className={css.tab}>
      <Summary
        label={t('tabPressure')}
        metrics={[
          {
            label: t('metricAutomation'),
            value: settings === undefined ? '—' : settings.paused ? t('queueStatePaused') : t('queueStateRunning'),
          },
          { label: t('metricRules'), value: rules.length },
          { label: t('pressureDetailsTitle'), value: details.length },
        ]}
      />

      <section className={css.block} aria-label={t('tabPressure')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('tabPressure')}</h3>
          </div>
          {settings !== undefined && (
            <Button
              size="sm"
              variant={settings.paused ? 'primary' : 'outline'}
              disabled={busy}
              onClick={() => { setPendingHost(settings.paused ? 'resume' : 'pause') }}
            >
              {settings.paused ? t('resumeHost') : t('pauseHost')}
            </Button>
          )}
        </header>
        {settings === undefined
          ? <p className={css.empty}>{t('noSettingsRead')}</p>
          : (
            <div className={css.meta}>
              <Tag tone={settings.paused ? 'warning' : 'success'}>
                {settings.paused ? t('settingsPaused') : t('settingsRunning')}
              </Tag>
              <span className={css.metaText}>{timeLabel(settings.updatedAt, now, t)}</span>
            </div>
          )}
      </section>

      <section className={css.block} aria-label={t('pressureQueueModelsTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureQueueModelsTitle')}</h3>
          </div>
        </header>
        {live.queues.length === 0
          ? <p className={css.empty}>{t('pressureQueueNoQueues')}</p>
          : (
            <div className={css.queueModels}>
              {live.queues.map(queue => (
                <QueueModelCard
                  key={queue.id}
                  queue={queue}
                  t={t}
                  models={live.models}
                  value={studio.queueModels[queue.id]}
                  onSave={(selection) => { saveQueueModels(queue.id, selection) }}
                />
              ))}
            </div>
          )}
      </section>

      <section className={css.block} aria-label={t('pressureParamsTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureParamsTitle')}</h3>
          </div>
          <Tag tone={paramsDirty ? 'warning' : 'success'}>
            {paramsDirty ? t('pressureParamsDirty') : t('pressureParamsSaved')}
          </Tag>
        </header>
        <div className={css.formGrid}>
          <NumberField
            label={t('pressureParamContext')}
            hint={params.contextThreshold < 10 || params.contextThreshold > 95
              ? t('pressureParamInvalidContext')
              : t('pressureParamContextHint')}
            value={params.contextThreshold}
            min={10}
            max={95}
            step={1}
            onChange={(value) => { setParams(previous => ({ ...previous, contextThreshold: value })) }}
          />
          <NumberField
            label={t('pressureParamIdle')}
            hint={params.idleMinutes < 1 || params.idleMinutes > 240
              ? t('pressureParamInvalidIdle')
              : t('pressureParamIdleHint')}
            value={params.idleMinutes}
            min={1}
            max={240}
            step={1}
            onChange={(value) => { setParams(previous => ({ ...previous, idleMinutes: value })) }}
          />
          <NumberField
            label={t('pressureParamCacheWarn')}
            hint={params.cacheWarn < 5 || params.cacheWarn > 100 || params.cacheWarn <= params.cacheAbort
              ? t('pressureParamInvalidCache')
              : t('pressureParamCacheWarnHint')}
            value={params.cacheWarn}
            min={5}
            max={100}
            step={1}
            onChange={(value) => { setParams(previous => ({ ...previous, cacheWarn: value })) }}
          />
          <NumberField
            label={t('pressureParamCacheAbort')}
            hint={params.cacheAbort < 5 || params.cacheAbort > 100 || params.cacheWarn <= params.cacheAbort
              ? t('pressureParamInvalidCache')
              : t('pressureParamCacheAbortHint')}
            value={params.cacheAbort}
            min={5}
            max={100}
            step={1}
            onChange={(value) => { setParams(previous => ({ ...previous, cacheAbort: value })) }}
          />
          <NumberField
            label={t('pressureParamTokenLimit')}
            hint={params.tokenLimit < 1_000 || params.tokenLimit > 100_000_000
              ? t('pressureParamInvalidToken')
              : t('pressureParamTokenLimitHint')}
            value={params.tokenLimit}
            min={1_000}
            max={100_000_000}
            step={1_000}
            onChange={(value) => { setParams(previous => ({ ...previous, tokenLimit: value })) }}
          />
        </div>
        <footer className={css.formFoot}>
          <Button
            size="sm"
            variant="primary"
            disabled={paramsInvalid || !paramsDirty}
            onClick={() => { saveAutomation(params) }}
          >
            {t('save')}
          </Button>
        </footer>
      </section>

      <section className={css.block} aria-label={t('pressureDetailsTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureDetailsTitle')}</h3>
          </div>
          {details.length > 0 && (
            <Tag tone="warning">{t('pressureDetailsCount', { count: details.length })}</Tag>
          )}
        </header>
        {details.length === 0
          ? (
            <div className={css.clearBox}>
              <span className={css.clearMark} aria-hidden="true">✓</span>
              <div>
                <p className={css.clearTitle}>{t('pressureDetailsNormal')}</p>
                <p className={css.clearBody}>{t('pressureDetailsNormalHint')}</p>
              </div>
            </div>
          )
          : (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('pressureDetailsQueue')}</th>
                    <th>{t('pressureDetailsIssue')}</th>
                    <th>{t('pressureDetailsReason')}</th>
                    <th>{t('pressureDetailsAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {details.map(row => (
                    <tr key={row.id}>
                      <td>
                        <span className={css.tableStrong}>{row.queueTitle}</span>
                        <span className={css.tableMuted}>{row.taskTitle}</span>
                      </td>
                      <td><Tag tone="warning">{row.issue}</Tag></td>
                      <td>{row.reason}</td>
                      <td className={css.tableMuted}>{timeLabel(row.at, now, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {alertMessage !== '' && <p className={css.noticeText} role="status">{alertMessage}</p>}
      </section>

      <section className={css.block} aria-label={t('pressureSavingsTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureSavingsTitle')}</h3>
          </div>
        </header>
        <div className={css.savingsGrid}>
          <div className={css.savingCell}>
            <span className={css.savingLabel}>{t('pressureSavingsMeasured')}</span>
            <span className={css.savingValue}>{tokenLabel(measuredTokens)}</span>
          </div>
          <div className={css.savingCell}>
            <span className={css.savingLabel}>{t('pressureSavingsTokens')}</span>
            <span className={css.savingValue}>{hasSavings ? `−${tokenLabel(savedTokens)}` : '—'}</span>
          </div>
          <div className={css.savingCell}>
            <span className={css.savingLabel}>{t('pressureSavingsTime')}</span>
            <span className={css.savingValue}>
              {hasSavings ? t('timeMinutes', { count: savedMinutes }) : '—'}
            </span>
          </div>
          <div className={css.savingCell}>
            <span className={css.savingLabel}>{t('pressureSavingsContext')}</span>
            <span className={css.savingValue}>{String(compressed)}</span>
          </div>
          <div className={css.savingCell}>
            <span className={css.savingLabel}>{t('pressureSavingsCompression')}</span>
            <span className={css.savingValue}>
              {t('pressureSavingsCompressionValue', { percent: studio.automation.contextThreshold })}
            </span>
          </div>
        </div>
        <div className={css.strategyRow}>
          <span className={css.strategyLabel}>{t('pressureTokenStrategy')}</span>
          <Tag tone="outline">{t('pressureStrategyStrict')}</Tag>
          <Tag tone="info">{t('pressureSavingsCompressionValue', { percent: studio.automation.contextThreshold })}</Tag>
          <span className={css.strategyText}>
            {engineering.preserveContent === '' ? t('pressurePreserveEmpty') : engineering.preserveContent}
          </span>
        </div>
        <p className={css.note}>
          {hasSavings ? t('pressureSavingsSuggestion') : t('pressureSavingsNone')}
        </p>
      </section>

      <section className={css.block} aria-label={t('pressureEngineeringTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureEngineeringTitle')}</h3>
          </div>
          <Tag tone={engineeringDirty ? 'warning' : 'success'}>
            {engineeringDirty ? t('pressureParamsDirty') : t('pressureEngineeringSaved')}
          </Tag>
        </header>
        <div className={css.formGrid}>
          <NumberField
            label={t('pressureCodeLimit')}
            hint={engineeringInvalid ? t('pressureEngineeringInvalid') : t('pressureCodeLimitHint')}
            value={engineering.codeParagraphLimit}
            min={100}
            max={2_000}
            step={50}
            onChange={(value) => { setEngineering(previous => ({ ...previous, codeParagraphLimit: value })) }}
          />
          <TextAreaField
            label={t('pressureFileSplit')}
            hint={t('pressureFileSplitHint')}
            value={engineering.fileSplit}
            rows={2}
            onChange={(value) => { setEngineering(previous => ({ ...previous, fileSplit: value })) }}
          />
          <TextAreaField
            label={t('pressureReadScope')}
            hint={t('pressureReadScopeHint')}
            value={engineering.readScope}
            rows={2}
            onChange={(value) => { setEngineering(previous => ({ ...previous, readScope: value })) }}
          />
          <TextAreaField
            label={t('pressureExcludeScope')}
            hint={t('pressureExcludeScopeHint')}
            value={engineering.excludeScope}
            rows={2}
            onChange={(value) => { setEngineering(previous => ({ ...previous, excludeScope: value })) }}
          />
          <TextAreaField
            label={t('pressurePreserveContent')}
            hint={t('pressurePreserveContentHint')}
            value={engineering.preserveContent}
            rows={2}
            onChange={(value) => { setEngineering(previous => ({ ...previous, preserveContent: value })) }}
          />
        </div>
        <footer className={css.formFoot}>
          <Button
            size="sm"
            variant="primary"
            disabled={engineeringInvalid || !engineeringDirty}
            onClick={() => { saveEngineering(engineering) }}
          >
            {t('save')}
          </Button>
        </footer>
      </section>

      <section className={css.block} aria-label={t('pressureNegativeTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <h3 className={css.title}>{t('pressureNegativeTitle')}</h3>
          </div>
        </header>
        {!hasWaste
          ? <p className={css.empty}>{t('pressureNegativeNone')}</p>
          : (
            <div className={css.feedbackGrid}>
              <FeedbackCell
                active={fileSignals > 0}
                label={t('pressureNegativeFiles')}
                count={fileSignals}
                detail={t('pressureNegativeFilesDetail')}
              />
              <FeedbackCell
                active={commandSignals > 0}
                label={t('pressureNegativeCommands')}
                count={commandSignals}
                detail={t('pressureNegativeCommandsDetail')}
              />
              <FeedbackCell
                active={timeSignals > 0}
                label={t('pressureNegativeTime')}
                count={timeSignals}
                detail={t('pressureNegativeTimeDetail')}
              />
              <FeedbackCell
                active={tokenSignals > 0}
                label={t('pressureNegativeTokens')}
                count={tokenSignals}
                detail={t('pressureNegativeTokensDetail')}
              />
            </div>
          )}
        <div className={css.positiveBox}>
          <h4 className={css.subtitle}>{t('pressurePositiveTitle')}</h4>
          <ul className={css.positiveList}>
            <li>{t('pressurePositiveFiles')}</li>
            <li>{t('pressurePositiveExclude')}</li>
            <li>{t('pressurePositiveDispatch')}</li>
          </ul>
          <div className={css.beforeAfter}>
            <div className={css.compareCol}>
              <span className={css.compareLabel}>{t('pressureBefore')}</span>
              <p className={css.compareText}>{t('pressureNegativeFilesDetail')}</p>
            </div>
            <span className={css.compareArrow} aria-hidden="true">→</span>
            <div className={css.compareCol}>
              <span className={css.compareLabel}>{t('pressureAfter')}</span>
              <p className={css.compareText}>
                {latestImprovement?.result ?? t('pressurePositiveDispatch')}
              </p>
            </div>
          </div>
        </div>
      </section>

      <AutomationDialog
        t={t}
        open={alertOpen || dialogStage === 'result'}
        stage={dialogStage}
        reason={alertReason}
        models={live.models}
        onConfirm={() => { setDialogStage('model') }}
        onDecline={() => {
          markAlertHandled()
          setDialogStage('ask')
          setAlertMessage(t('pressureAlertDecline'))
        }}
        onLater={() => {
          markAlertHandled()
          setDialogStage('ask')
          addNotice({
            title: { kind: 'key', value: 'pressureOptimizeNoticeTitle' },
            body: { kind: 'key', value: 'pressureOptimizeNoticeBody' },
          })
          setAlertMessage(t('pressureAlertDismissed'))
        }}
        onApply={(route) => {
          const modelLabel = route === '' ? t('pressureQueueModelInherit') : route
          addImprovement({
            title: t('improvementGeneratedTitle', { model: modelLabel }),
            cause: t('improvementGeneratedCause'),
            action: `${t('improvementGeneratedAction')} ${t('pressureOptimizeModelHint')}`,
            result: t('improvementGeneratedResult'),
            projects: [live.queues[0]?.title ?? '—'],
          })
          markAlertHandled()
          setDialogStage('result')
        }}
        onDone={() => {
          setDialogStage('ask')
          setAlertMessage(t('pressureOptimizeResultBody'))
        }}
      />

      <DangerConfirm
        t={t}
        open={pendingHost !== undefined}
        title={pendingHost === 'pause' ? t('pauseTitle') : t('resumeTitle')}
        body={pendingHost === 'pause' ? t('pauseBody') : t('resumeBody')}
        disabled={busy}
        onCancel={() => { setPendingHost(undefined) }}
        onConfirm={() => {
          const action = pendingHost
          setPendingHost(undefined)
          if (action === 'pause') void actions.pause()
          if (action === 'resume') void actions.resume()
        }}
      />
    </div>
  )
}
