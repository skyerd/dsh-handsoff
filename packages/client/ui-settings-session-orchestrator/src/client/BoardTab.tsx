/**
 * Running-task view grouped by queue.
 *
 * Each queue stays a full-width block. Tasks are ordered exactly as the queue
 * executes them; a child task is indented under its parent. The page exposes
 * only the metrics a user can act on: elapsed time, measured tokens and the
 * cache hit rate.
 */

import { useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelPolicy, QueueDto, RunDto, TaskSummaryDto } from './contract.ts'
import { runStateKey, type OrchestratorTranslate } from './copy.ts'
import { canCancelRun, latestRunOf, runStateTone } from './model.ts'
import { SelectField, TextAreaField } from './Fields.tsx'
import {
  ConversationDeleteDialog,
  ConversationFollowUpDialog,
  ConversationModelDialog,
} from './ConversationDialogs.tsx'
import { DangerConfirm } from './DangerConfirm.tsx'
import { QueueDeleteDialog } from './QueueDeleteDialog.tsx'
import { RenameDialog } from './RenameDialog.tsx'
import { RowMenu } from './RowMenu.tsx'
import { RunActions } from './RunActions.tsx'
import { SessionRoute } from './SessionRoute.tsx'
import { Summary } from './Summary.tsx'
import type { ModelCatalogState } from './service.ts'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './BoardTab.module.css'

/** Format an elapsed wall-clock duration without depending on locale words. */
function elapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Compact a token count for a row label. */
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

/** Status label for a task whose latest attempt may not exist yet. */
function stateLabel(run: RunDto | undefined, t: OrchestratorTranslate): string {
  return run === undefined ? t('stateReady') : t(runStateKey(run.state))
}

/**
 * Name why a run stopped, in the words a person can act on.
 *
 * The run projection carries only the stable failure code — the host message
 * stays on the Host — so this page names the usual cause of each code instead
 * of leaving every failure as "did not finish".
 * @param error - host failure recorded on the run.
 * @param t - localized copy.
 * @returns one sentence, already localized.
 */
function failureReason(
  error: { readonly code: string },
  t: OrchestratorTranslate,
): string {
  switch (error.code) {
    case 'turn-error': return t('runFailureTurn')
    case 'cancelled': return t('runFailureCancelled')
    default: return t('runFailureGeneric', { code: error.code })
  }
}

/** Tag tone for one task row. */
function stateTone(run: RunDto | undefined): 'success' | 'warning' | 'danger' | 'info' | 'outline' | 'quiet' {
  if (run === undefined) return 'quiet'
  switch (run.state) {
    case 'succeeded': return 'success'
    case 'needs-attention': return 'warning'
    case 'failed': return 'danger'
    case 'starting':
    case 'running':
    case 'handoff-pending':
    case 'handing-off': return 'info'
    default: return 'outline'
  }
}

/** Resolve queue tasks in their declared order. */
function orderedTasks(queue: QueueDto, tasks: readonly TaskSummaryDto[]): TaskSummaryDto[] {
  const byId = new Map(tasks.filter(task => task.queueId === queue.id).map(task => [task.id, task]))
  const ordered: TaskSummaryDto[] = []
  for (const id of queue.taskOrder) {
    const task = byId.get(id)
    if (task !== undefined) {
      ordered.push(task)
      byId.delete(id)
    }
  }
  return [...ordered, ...byId.values()]
}

/** One task row with elapsed time, tokens, cache hit rate and conversation link. */
function TaskRow({ task, run, now, t, actions, busy, child, queue, tasks, runs, models }: {
  readonly task: TaskSummaryDto
  readonly run: RunDto | undefined
  readonly now: number
  readonly t: OrchestratorTranslate
  readonly actions: OrchestrationTabProps['actions']
  readonly busy: boolean
  readonly child: boolean
  readonly queue: QueueDto
  readonly tasks: readonly TaskSummaryDto[]
  readonly runs: readonly RunDto[]
  readonly models: ModelCatalogState
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [followOpen, setFollowOpen] = useState(false)
  const [rerunOpen, setRerunOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const elapsed = run === undefined ? 0 : (run.updatedAt || now) - run.createdAt
  const tokens = run?.pressure?.totalTokens ?? 0
  const hitRate = run?.health?.cacheHitRate
  const session = run?.session ?? task.session
  const hasSession = session !== undefined
  const active = run !== undefined && canCancelRun(run.state)
  const conversationDisabled = !hasSession || active
  const currentModel: ModelPolicy = run?.configSnapshot === undefined
    ? task.model
    : {
      kind: 'fixed',
      provider: run.configSnapshot.provider,
      model: run.configSnapshot.model,
      ...(run.configSnapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: run.configSnapshot.reasoningEffort }),
    }
  const started = new Set(runs.map(candidate => candidate.taskId))
  const futureTasks = tasks.filter(candidate =>
    candidate.queueId === queue.id
    && candidate.id !== task.id
    && !started.has(candidate.id))
  const menuItems = [
    {
      id: 'switch-model',
      label: t('conversationSwitchModel'),
      disabled: conversationDisabled,
      onSelect: () => { setModelOpen(true) },
    },
    {
      id: 'follow-up',
      label: t('conversationFollowUp'),
      disabled: conversationDisabled,
      onSelect: () => { setFollowOpen(true) },
    },
    {
      id: 'rerun',
      label: t('conversationRerun'),
      disabled: conversationDisabled,
      onSelect: () => { setRerunOpen(true) },
    },
    {
      id: 'delete',
      label: t('conversationDelete'),
      tone: 'danger' as const,
      disabled: conversationDisabled,
      onSelect: () => { setDeleteOpen(true) },
    },
    {
      id: 'run-actions',
      label: detailsOpen ? t('conversationHideRunActions') : t('conversationRunActions'),
      onSelect: () => { setDetailsOpen(value => !value) },
    },
  ]
  return (
    <li className={child ? `${css.row} ${css.childRow}` : css.row}>
      <div className={css.rowTop}>
        <StateDot state={run === undefined ? 'idle' : runStateTone(run.state)} />
        <span className={css.title}>
          {child ? t('runningChild', { title: task.title }) : task.title}
        </span>
        <Tag tone={stateTone(run)}>{stateLabel(run, t)}</Tag>
        <div className={css.rowActions}>
          <SessionRoute
            session={session}
            t={t}
            label={task.title}
            showRoute={false}
            disabled={busy}
            onOpen={(link) => { void actions.openSession(link) }}
          />
          <RowMenu
            label={`${t('conversationMenu')} ${task.title}`}
            disabled={busy}
            items={menuItems}
          />
        </div>
      </div>
      <div className={css.metrics}>
        <span className={css.metric}>{t('runningElapsed')} {elapsedLabel(elapsed)}</span>
        <span className={css.metric}>{t('runningCredits')} {tokenLabel(tokens)}</span>
        <span className={css.metric}>
          {t('runningHitRate')}{' '}
          {hitRate === undefined ? '—' : `${Math.round(hitRate * 100)}%`}
        </span>
      </div>
      {run?.lastError !== undefined && (
        <p className={css.error}>
          {t('runFailedNotice')} {failureReason(run.lastError, t)}
        </p>
      )}
      {detailsOpen && (
        <div className={css.details}>
          {run === undefined
            ? <p className={css.empty}>{t('boardNoActivity')}</p>
            : (
              <RunActions
                t={t}
                run={run}
                taskTitle={task.title}
                disabled={busy}
                onCancel={actions.cancelRun}
                onRetry={actions.retryRun}
                onSkip={actions.skipRun}
              />
            )}
        </div>
      )}
      <ConversationModelDialog
        t={t}
        open={modelOpen}
        models={models}
        currentModel={currentModel}
        futureTasks={futureTasks}
        muted={actions.modelSwitchPromptMuted(queue.id)}
        disabled={busy}
        onCancel={() => { setModelOpen(false) }}
        onApply={(choice) => {
          void actions.switchConversationModel({
            taskId: task.id,
            ...(session === undefined ? {} : { sessionId: session.sessionId }),
            model: choice.model,
            ...(choice.futureTaskIds.length === 0 ? {} : { applyFutureTaskIds: choice.futureTaskIds }),
            ...(choice.muteQueuePrompt ? { muteQueuePrompt: true } : {}),
          }).then((ok) => { if (ok) setModelOpen(false) })
        }}
      />
      <ConversationFollowUpDialog
        t={t}
        open={followOpen}
        disabled={busy}
        onCancel={() => { setFollowOpen(false) }}
        onApply={(prompt) => {
          void actions.followUpConversation({ taskId: task.id, prompt })
            .then((ok) => { if (ok) setFollowOpen(false) })
        }}
      />
      <DangerConfirm
        t={t}
        open={rerunOpen}
        title={t('conversationRerunTitle')}
        body={t('conversationRerunBody', { title: task.title })}
        disabled={busy}
        onCancel={() => { setRerunOpen(false) }}
        onConfirm={() => {
          void actions.rerunConversation(task.id, t('conversationRerun')).then((ok) => { if (ok) setRerunOpen(false) })
        }}
      />
      <ConversationDeleteDialog
        t={t}
        open={deleteOpen}
        disabled={busy}
        hasSession={hasSession}
        onCancel={() => { setDeleteOpen(false) }}
        onConfirm={(archiveSession) => {
          void actions.deleteConversation({ taskId: task.id, archiveSession })
            .then((ok) => { if (ok) setDeleteOpen(false) })
        }}
      />
    </li>
  )
}

/** One queue block with its ordered tasks and the temporary-add composer. */
function QueueBlock({ queue, tasks, runs, now, t, live, actions, busy }: {
  readonly queue: QueueDto
  readonly tasks: readonly TaskSummaryDto[]
  readonly runs: readonly RunDto[]
  readonly now: number
  readonly t: OrchestratorTranslate
  readonly live: OrchestrationTabProps['live']
  readonly actions: OrchestrationTabProps['actions']
  readonly busy: boolean
}) {
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [presetId, setPresetId] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const rows = orderedTasks(queue, tasks)
  const rowIds = new Set(rows.map(row => row.id))
  const hasSessions = rows.some(row => row.session !== undefined)
    || runs.some(run => rowIds.has(run.taskId))
  // A live attempt still owns a Session, so its queue cannot be removed yet.
  const liveRun = runs.some(run => rowIds.has(run.taskId) && canCancelRun(run.state))
  return (
    <section className={css.queue} aria-label={queue.title}>
      <header className={css.queueHead}>
        <div className={css.queueIdentity}>
          <h3 className={css.queueTitle}>{queue.title}</h3>
          <div className={css.queueMeta}>
            <Tag tone={queue.state === 'running' ? 'success' : queue.state === 'aborted' ? 'danger' : 'quiet'}>
              {queue.state === 'running' ? t('queueStateRunning') : queue.state === 'paused' ? t('queueStatePaused') : queue.state === 'aborted' ? t('queueStateAborted') : t('queueStateIdle')}
            </Tag>
            <span className={css.metaText}>{queue.cwd ?? queue.workspaceId ?? '—'}</span>
            <span className={css.metaText}>{t('queueTaskCount', { count: rows.length })}</span>
          </div>
        </div>
        <div className={css.queueActions}>
          {queue.state === 'running'
            ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void actions.pauseQueue(queue.id) }}>
                {t('queuePause')}
              </Button>
            )
            : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { void actions.startQueue(queue.id) }}>
                {t('queueStart')}
              </Button>
            )}
          <Button size="sm" variant="ghost" onClick={() => { setOpen(value => !value) }}>
            {open ? t('composerCollapse') : t('composerExpand')}
          </Button>
        </div>
      </header>
      {open && (
        <>
          {rows.length === 0
            ? <p className={css.empty}>{t('emptyTasks')}</p>
            : (
              <ul className={css.rows}>
                {rows.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    run={latestRunOf(runs, task.id)}
                    now={now}
                    t={t}
                    actions={actions}
                    busy={busy}
                    child={task.parentTaskId !== undefined}
                    queue={queue}
                    tasks={rows}
                    runs={runs}
                    models={live.models}
                  />
                ))}
              </ul>
            )}
          {adding
            ? (
              <div className={css.tempAdd}>
                <TextAreaField
                  label={t('runningTempAdd')}
                  value={prompt}
                  rows={3}
                  placeholder={t('composerPromptPlaceholder')}
                  disabled={busy}
                  onChange={setPrompt}
                />
                <div className={css.tempGrid}>
                  <SelectField
                    label={t('composerSkills')}
                    value={presetId}
                    options={[
                      { value: '', label: t('composerSkillsInherit'), muted: true },
                      ...live.presets.choices.map(preset => ({
                        value: preset.id,
                        label: preset.isDefault ? `${preset.name} · ${t('presetDefault')}` : preset.name,
                      })),
                    ]}
                    disabled={busy || live.presets.choices.length === 0}
                    onChange={setPresetId}
                  />
                  <div className={css.tempActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || prompt.trim() === ''}
                      onClick={() => {
                        void actions.appendTask({
                          queueId: queue.id,
                          prompt,
                          ...(presetId === '' ? {} : { presetId }),
                        }).then((ok) => {
                          if (!ok) return
                          setPrompt('')
                          setAdding(false)
                        })
                      }}
                    >
                      {t('composerSend')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAdding(false) }}>{t('cancel')}</Button>
                  </div>
                </div>
              </div>
            )
            : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(true) }}>
                + {t('runningTempAdd')}
              </Button>
            )}
        </>
      )}
      <div className={css.queueFoot}>
        <RowMenu
          label={t('queueMenu')}
          disabled={busy}
          items={[
            { id: 'rename', label: t('renameQueue'), onSelect: () => { setRenaming(true) } },
            {
              id: 'delete',
              label: t('deleteQueue'),
              tone: 'danger',
              disabled: queue.state === 'running' || liveRun,
              onSelect: () => { setDeleting(true) },
            },
          ]}
        />
      </div>
      <RenameDialog
        t={t}
        open={renaming}
        title={t('renameQueue')}
        label={t('queueTitle')}
        value={queue.title}
        disabled={busy}
        onCancel={() => { setRenaming(false) }}
        onSave={(next) => {
          setRenaming(false)
          void actions.renameQueue(queue.id, next)
        }}
      />
      <QueueDeleteDialog
        t={t}
        open={deleting}
        title={t('deleteQueueTitle')}
        queueTitle={queue.title}
        disabled={busy}
        hasSessions={hasSessions}
        onCancel={() => { setDeleting(false) }}
        onConfirm={({ archiveSessions }) => {
          setDeleting(false)
          void actions.deleteQueue({ queueId: queue.id, archiveSessions })
        }}
      />
    </section>
  )
}

/**
 * Render every queue and its ordered tasks.
 * @param props - snapshots, localized copy and section callbacks.
 * @returns the running-task view.
 */
export function BoardTab({ t, live, drafts, now, actions }: OrchestrationTabProps) {
  const busy = drafts.busy !== undefined
  const queues = live.queues
  const queueIds = new Set(queues.map(queue => queue.id))
  const orphans = live.tasks.filter(task => !queueIds.has(task.queueId))
  const currentRuns = live.tasks.map(task => latestRunOf(live.runs, task.id))
  const active = currentRuns.filter(run => run !== undefined && (
    run.state === 'starting'
    || run.state === 'running'
    || run.state === 'handoff-pending'
    || run.state === 'handing-off'
  )).length
  const attention = currentRuns.filter(run => run?.state === 'needs-attention').length
  return (
    <div className={css.tab}>
      <Summary
        label={t('tabBoard')}
        metrics={[
          { label: t('metricQueues'), value: queues.length },
          { label: t('metricRunningTasks'), value: active },
          { label: t('metricAttention'), value: attention },
        ]}
      />
      {queues.length === 0 && orphans.length === 0
        ? (
          <section className={css.emptyCard} aria-label={t('runningEmpty')}>
            <span className={css.emptyMark} aria-hidden="true">—</span>
            <p className={css.empty}>{t('runningEmpty')}</p>
          </section>
        )
        : queues.map(queue => (
          <QueueBlock
            key={queue.id}
            queue={queue}
            tasks={live.tasks}
            runs={live.runs}
            now={now}
            t={t}
            live={live}
            actions={actions}
            busy={busy}
          />
        ))}
      {orphans.length > 0 && (
        <section className={css.queue} aria-label={t('runningOther')}>
          <header className={css.queueHead}>
            <h3 className={css.queueTitle}>{t('runningOther')}</h3>
          </header>
          <ul className={css.rows}>
            {orphans.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                run={latestRunOf(live.runs, task.id)}
                now={now}
                t={t}
                actions={actions}
                busy={busy}
                child={task.parentTaskId !== undefined}
                queue={live.queues.find(candidate => candidate.id === task.queueId) ?? {
                  id: task.queueId,
                  title: task.queueId,
                  taskOrder: [],
                  paused: false,
                  state: 'idle',
                  revision: 0,
                }}
                tasks={live.tasks}
                runs={live.runs}
                models={live.models}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
