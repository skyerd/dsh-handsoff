/**
 * Queues and tasks: the queue overview, the inline composer, the ordered task
 * list, and the task editor behind the advanced disclosure.
 */

import { useState, type DragEvent, type ReactNode } from 'react'
import { Button, Checkbox, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QueueDto, QueueState, TaskSummaryDto, WorkspaceChoice } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { stageKey, timeLabel } from './copy.ts'
import type {
  OrchestratorActions, OrchestratorDraftState, OrchestratorLiveState,
} from './service.ts'
import { buildTaskGraph, queueTaskCount } from './model.ts'
import { DangerConfirm } from './DangerConfirm.tsx'
import { QueueDeleteDialog } from './QueueDeleteDialog.tsx'
import { SelectField, TextAreaField, TextField } from './Fields.tsx'
import { ModelPolicyFields } from './ModelFields.tsx'
import { PipelineCreateDialog } from './PipelineCreateDialog.tsx'
import { PipelineTemplateDialog } from './PipelineTemplateDialog.tsx'
import { Summary } from './Summary.tsx'
import { TaskEditor } from './TaskEditor.tsx'
import { SessionRoute } from './SessionRoute.tsx'
import { WorkspaceField, type WorkspaceOption } from './WorkspaceField.tsx'
import { useMenuFlip } from './useMenuFlip.ts'
import css from './TaskTab.module.css'

/** One selectable host Workspace. */
export type { WorkspaceChoice }

/** Props shared by every orchestration tab. */
export interface OrchestrationTabProps {
  readonly t: OrchestratorTranslate
  readonly live: OrchestratorLiveState
  readonly drafts: OrchestratorDraftState
  readonly workspaces: readonly WorkspaceChoice[]
  readonly now: number
  readonly actions: OrchestratorActions
}

/** Locale key naming one queue lifecycle. */
function queueStateKey(state: QueueState): 'queueStateIdle' | 'queueStateRunning' | 'queueStatePaused' | 'queueStateAborted' {
  switch (state) {
    case 'idle':
      return 'queueStateIdle'
    case 'running':
      return 'queueStateRunning'
    case 'paused':
      return 'queueStatePaused'
    case 'aborted':
      return 'queueStateAborted'
  }
}

/** One ordered task row. */
interface OrderedTask {
  readonly task: TaskSummaryDto
  readonly index: number
}

/** Localize a known template stage; an unknown host stage stays verbatim. */
function stageLabelOf(stage: string | undefined, t: OrchestratorTranslate): string | undefined {
  const key = stageKey(stage)
  return key === undefined ? stage : t(key)
}

/**
 * The row's overflow menu: a rounded card that opens above the trigger when
 * the row sits too low in the card for the list to hang below it.
 */
function RowMenu({ label, children }: {
  readonly label: string
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, menuRef, flipped } = useMenuFlip<HTMLElement>(open)
  return (
    <details
      className={css.rowMenu}
      onToggle={(event) => { setOpen(event.currentTarget.open) }}
    >
      <summary ref={anchorRef} aria-label={label}>⋯</summary>
      {open && (
        <div
          ref={menuRef}
          className={flipped ? `${css.rowMenuBody} ${css.rowMenuBodyUp}` : css.rowMenuBody}
        >
          {children}
        </div>
      )}
    </details>
  )
}

/** Resolve a queue's visible tasks in queue order, then extras by id. */
function orderedTasks(queue: QueueDto | undefined, tasks: readonly TaskSummaryDto[]): OrderedTask[] {
  if (queue === undefined) return []
  const queueTasks = tasks.filter(task => task.queueId === queue.id)
  const byId = new Map(queueTasks.map(task => [task.id, task]))
  const ordered: OrderedTask[] = []
  for (const id of queue.taskOrder) {
    const task = byId.get(id)
    if (task === undefined) continue
    ordered.push({ task, index: ordered.length })
    byId.delete(id)
  }
  for (const task of [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    ordered.push({ task, index: ordered.length })
  }
  return ordered
}

/**
 * Render the queue overview, the composer, the queue settings, and the ordered
 * task list.
 * @param props - snapshots, localized copy, and section callbacks.
 * @returns the queues-and-tasks tab.
 */
export function TaskTab(props: OrchestrationTabProps) {
  const { t, live, drafts, workspaces, now, actions } = props
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTask, setDeleteTask] = useState<{ readonly id: string; readonly title: string } | undefined>()
  const [createOpen, setCreateOpen] = useState(true)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | undefined>()
  const [dropIndex, setDropIndex] = useState<number | undefined>()
  const busy = drafts.busy !== undefined
  const selectedQueue = drafts.selectedQueueId === undefined
    ? undefined
    : live.queues.find(queue => queue.id === drafts.selectedQueueId)
  const rows = orderedTasks(selectedQueue, live.tasks)
  const graph = buildTaskGraph(selectedQueue, live.tasks)
  const startBlocked = graph.issues.length > 0
  const draft = drafts.task
  const liveTask = draft === null ? undefined : live.tasks.find(task => task.id === draft.draft.id)
  const runningQueues = live.queues.filter(queue => queue.state === 'running').length
  const selectedTaskIds = new Set(live.tasks
    .filter(task => task.queueId === selectedQueue?.id)
    .map(task => task.id))
  const hasQueueSessions = live.tasks.some(task => (
    task.queueId === selectedQueue?.id && task.session !== undefined
  )) || live.runs.some(run => (
    selectedTaskIds.has(run.taskId)
    && (run.session !== undefined || run.sessionLineage.length > 0)
  ))
  const workspaceOptions: WorkspaceOption[] = workspaces.map(workspace => ({
    value: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
  }))
  const queueWorkspaceId = drafts.queue?.draft.workspaceId
  if (queueWorkspaceId !== undefined && !workspaces.some(workspace => workspace.workspaceId === queueWorkspaceId)) {
    workspaceOptions.push({
      value: queueWorkspaceId,
      title: queueWorkspaceId,
      path: drafts.queue?.draft.cwd ?? '',
    })
  }

  return (
    <div className={css.tab}>
      <Summary
        label={t('queuesTitle')}
        metrics={[
          { label: t('metricQueues'), value: live.queues.length },
          { label: t('metricRunningQueues'), value: runningQueues },
          { label: t('metricTasks'), value: live.tasks.length },
        ]}
      />
      <div className={css.toolbar}>
        <h3 className={css.toolbarTitle}>{t('queuesTitle')}</h3>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            setTemplateOpen(false)
            setCreateOpen(true)
          }}
        >
          {t('newPipeline')}
        </Button>
      </div>
      {live.queues.length > 0 && (
        <div className={css.queuePicker}>
          <SelectField
            label={t('queueSection')}
            value={drafts.selectedQueueId ?? ''}
            options={[
              { value: '', label: t('noQueue'), muted: true },
              ...live.queues.map(queue => ({ value: queue.id, label: queue.title })),
            ]}
            disabled={busy}
            onChange={(value) => {
              if (value === '') return
              setCreateOpen(false)
              void actions.selectQueue(value)
            }}
          />
        </div>
      )}

      {createOpen && (
        <PipelineCreateDialog
          t={t}
          workspaces={workspaces}
          models={live.models}
          presets={live.presets}
          busy={busy}
          onClose={() => { setCreateOpen(false) }}
          onCreate={actions.createPipeline}
          onUseTemplate={() => {
            setCreateOpen(false)
            setTemplateOpen(true)
          }}
        />
      )}
      {templateOpen && (
        <PipelineTemplateDialog
          t={t}
          workspaces={workspaces}
          busy={busy}
          onClose={() => { setTemplateOpen(false) }}
          onCreate={actions.createPipelineTemplate}
        />
      )}

      {selectedQueue === undefined && live.queues.length > 0 && !createOpen && (
        <section className={css.emptyCard} aria-label={t('noQueue')}>
          <div className={css.emptyMark} aria-hidden="true">01</div>
          <p className={css.emptyText}>{t('noQueue')}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setTemplateOpen(false)
              setCreateOpen(true)
            }}
          >
            {t('newPipeline')}
          </Button>
        </section>
      )}

      {selectedQueue !== undefined && (
        <section className={css.queueCard} aria-label={t('queueSection')}>
          <header className={css.cardHead}>
            <div className={css.cardHeading}>
              <span className={css.eyebrow}>{t('currentQueue')}</span>
              <h3 className={css.cardTitle}>{selectedQueue.title}</h3>
              <p className={css.cardMeta}>
                {selectedQueue.cwd ?? selectedQueue.workspaceId ?? '—'}
                {' · '}
                {t('queueTaskCount', { count: queueTaskCount(selectedQueue, live.tasks) })}
              </p>
            </div>
            <div className={css.cardActions}>
              <Tag tone={selectedQueue.state === 'running' ? 'success' : selectedQueue.state === 'aborted' ? 'danger' : 'neutral'}>
                {t(queueStateKey(selectedQueue.state))}
              </Tag>
              {selectedQueue.state === 'running'
                ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => { void actions.pauseQueue(selectedQueue.id) }}
                  >
                    {t('queuePause')}
                  </Button>
                )
                : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || selectedQueue.state === 'aborted' || startBlocked}
                    onClick={() => { void actions.startQueue(selectedQueue.id) }}
                  >
                    {t('queueStart')}
                  </Button>
                )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || selectedQueue.state === 'aborted'}
                onClick={() => { void actions.abortQueue(selectedQueue.id) }}
              >
                {t('queueAbort')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => { void actions.selectQueue(selectedQueue.id) }}
              >
                {t('reload')}
              </Button>
            </div>
          </header>
          {drafts.queue !== null && (
            <>
              <div className={css.queueFields}>
                <TextField
                  label={t('queueTitle')}
                  value={drafts.queue.draft.title}
                  disabled={busy}
                  onChange={(value) => { actions.editQueue({ title: value }) }}
                />
                <WorkspaceField
                  label={t('queueWorkspace')}
                  placeholder={t('workspaceNone')}
                  value={drafts.queue.draft.workspaceId ?? ''}
                  options={workspaceOptions}
                  disabled={busy}
                  onChange={(value) => {
                    const workspace = workspaces.find(candidate => candidate.workspaceId === value)
                    actions.editQueue({
                      workspaceId: value,
                      cwd: workspace?.path ?? '',
                    })
                  }}
                />
                <ModelPolicyFields
                  t={t}
                  inheritLabel={t('modelInheritHost')}
                  value={drafts.queue.draft.model}
                  models={live.models}
                  disabled={busy}
                  onChange={(model) => { actions.editQueue({ model }) }}
                />
              </div>
              <TextAreaField
                label={t('queueBrief')}
                value={drafts.queue.draft.brief ?? ''}
                disabled={busy}
                rows={3}
                placeholder={t('queueBriefHint')}
                onChange={(value) => { actions.editQueue({ brief: value }) }}
              />
              <footer className={css.cardFoot}>
                <div className={css.cardFootActions}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => { void actions.saveQueue() }}>
                    {t('save')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={actions.discardQueue}>
                    {t('discard')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => { setDeleteOpen(true) }}
                  >
                    {t('deleteQueue')}
                  </Button>
                </div>
                <span className={css.cardMeta}>
                  {t('liveRevision', { revision: selectedQueue.revision })}
                  {live.generatedAt > 0 ? ` · ${timeLabel(live.generatedAt, now, t)}` : ''}
                </span>
              </footer>
            </>
          )}
        </section>
      )}

      {selectedQueue !== undefined && (
        <section className={css.taskCard} aria-label={t('queueOrder')}>
          <header className={css.cardHead}>
            <div className={css.cardHeading}>
              <h3 className={css.cardTitle}>{t('queueOrder')}</h3>
              <p className={css.cardMeta}>{t('queueTaskCount', { count: queueTaskCount(selectedQueue, live.tasks) })}</p>
            </div>
            <div className={css.cardActions}>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { actions.newTask() }}>
                {t('newTask')}
              </Button>
            </div>
          </header>
          {rows.length === 0
            ? <p className={css.empty}>{t('emptyTasks')}</p>
            : (
              <ul className={css.taskList}>
                {rows.map(row => (
                  <li
                    key={row.task.id}
                    className={dropIndex === row.index ? `${css.taskRow} ${css.taskRowDrop}` : css.taskRow}
                    draggable={!busy}
                    onDragStart={(event: DragEvent<HTMLLIElement>) => {
                      setDraggingId(row.task.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(event: DragEvent<HTMLLIElement>) => {
                      if (draggingId === undefined) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDropIndex(row.index)
                    }}
                    onDrop={(event: DragEvent<HTMLLIElement>) => {
                      event.preventDefault()
                      const source = draggingId
                      setDraggingId(undefined)
                      setDropIndex(undefined)
                      if (source === undefined || source === row.task.id) return
                      void actions.moveTaskTo(source, row.index)
                    }}
                    onDragEnd={() => {
                      setDraggingId(undefined)
                      setDropIndex(undefined)
                    }}
                  >
                    <div className={css.taskLead}>
                      <span className={css.dragHandle} aria-hidden="true">⋮⋮</span>
                      <span className={css.taskIndex}>{String(row.index + 1).padStart(2, '0')}</span>
                      <StateDot state={row.task.enabled ? 'done' : 'idle'} />
                    </div>
                    <div className={css.taskMain}>
                      <div className={css.taskTitleLine}>
                        <span className={css.taskTitle}>{row.task.title}</span>
                        {row.task.stage !== undefined && (
                          <Tag tone="outline">{stageLabelOf(row.task.stage, t)}</Tag>
                        )}
                      </div>
                      <div className={css.taskMeta}>
                        <span className={css.metaItem}>
                          {workspaces.find(workspace => workspace.workspaceId === row.task.workspaceId)?.title
                            ?? row.task.workspaceId}
                        </span>
                        <span className={css.metaItem}>
                          {row.index === 0
                            ? t('taskRunsFirst')
                            : row.task.parallelWithPrevious === true
                              ? t('taskRunsWithPrevious')
                              : t('taskRunsAfterPrevious')}
                        </span>
                        <span className={css.metaItem}>
                          {t('taskPriorityValue', { priority: row.task.priority })}
                        </span>
                      </div>
                      <div className={css.taskToggles}>
                        <Switch
                          checked={row.task.enabled}
                          label={`${t('taskEnabled')} ${row.task.title}`}
                          disabled={busy}
                          onChange={(value) => { void actions.setTaskEnabled(row.task.id, value) }}
                        />
                        {row.index > 0 && (
                          <Checkbox
                            checked={row.task.parallelWithPrevious === true}
                            label={t('parallelWithPrevious')}
                            disabled={busy}
                            onChange={(value) => {
                              void actions.setTaskParallelWithPrevious(row.task.id, value)
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <div className={css.taskActions}>
                      {row.task.session !== undefined && (
                        <SessionRoute
                          session={row.task.session}
                          t={t}
                          showRoute={false}
                          disabled={busy}
                          onOpen={(session) => { void actions.openSession(session) }}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t('openTask')} ${row.task.title}`}
                        disabled={busy}
                        onClick={() => { void actions.loadTask(row.task.id) }}
                      >
                        {t('edit')}
                      </Button>
                      <RowMenu label={t('moreActions')}>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('deleteTask')} ${row.task.title}`}
                          disabled={busy || row.task.session !== undefined}
                          onClick={() => { setDeleteTask({ id: row.task.id, title: row.task.title }) }}
                        >
                          {t('deleteTask')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('insertAfter')} ${row.task.title}`}
                          disabled={busy}
                          onClick={() => { actions.newTask(row.index + 1) }}
                        >
                          {t('insertAfter')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('duplicateTask')} ${row.task.title}`}
                          disabled={busy}
                          onClick={() => { void actions.duplicateTask(row.task.id) }}
                        >
                          {t('duplicateTask')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('moveUp')} ${row.task.title}`}
                          disabled={busy || row.index === 0}
                          onClick={() => { void actions.moveTask(row.task.id, 'up') }}
                        >
                          {t('moveUp')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('moveDown')} ${row.task.title}`}
                          disabled={busy || row.index === rows.length - 1}
                          onClick={() => { void actions.moveTask(row.task.id, 'down') }}
                        >
                          {t('moveDown')}
                        </Button>
                      </RowMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          {graph.issues.length > 0 && (
            <div className={css.issuePanel} role="alert">
              <p className={css.issueTitle}>{t('taskListBlocked')}</p>
              <ul className={css.issues}>
                {graph.issues.map((issue, index) => (
                  <li key={`${issue.kind}:${issue.taskId}:${String(index)}`}>
                    {issue.kind === 'missing-dependency' && t('graphIssueMissing', {
                      task: issue.taskId, dependency: issue.dependencyId,
                    })}
                    {issue.kind === 'duplicate-dependency' && t('graphIssueDuplicate', {
                      task: issue.taskId, dependency: issue.dependencyId,
                    })}
                    {issue.kind === 'self-dependency' && t('graphIssueSelf', { task: issue.taskId })}
                    {issue.kind === 'cycle' && t('graphIssueCycle', { task: issue.taskId })}
                  </li>
                ))}
              </ul>
              <p className={css.issueHint}>{t('repairTaskListHint')}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => { void actions.repairTaskList() }}
              >
                {t('repairTaskList')}
              </Button>
            </div>
          )}
        </section>
      )}

      <details className={css.advanced}>
        <summary className={css.advancedSummary}>{t('advancedTaskEditor')}</summary>
        <div className={css.advancedBody}>
          {draft === null
            ? <p className={css.empty}>{t('noTask')}</p>
            : (
              <TaskEditor
                t={t}
                draft={draft}
                queues={live.queues}
                workspaces={workspaces}
                liveTask={liveTask}
                busy={busy}
                queueModel={drafts.queue?.draft.model}
                models={live.models}
                host={live.hosts[0]}
                onEdit={actions.editTask}
                onSave={() => { void actions.saveTask() }}
                onDiscard={actions.discardTask}
              />
            )}
        </div>
      </details>

      <QueueDeleteDialog
        t={t}
        open={deleteOpen}
        title={t('deleteQueueTitle')}
        queueTitle={selectedQueue?.title ?? ''}
        disabled={busy}
        hasSessions={hasQueueSessions}
        onCancel={() => { setDeleteOpen(false) }}
        onConfirm={({ archiveSessions }) => {
          setDeleteOpen(false)
          setCreateOpen(true)
          void actions.deleteQueue({ archiveSessions })
        }}
      />
      <DangerConfirm
        t={t}
        open={deleteTask !== undefined}
        title={t('taskDeleteTitle')}
        body={t('taskDeleteBody', { title: deleteTask?.title ?? '' })}
        disabled={busy}
        onCancel={() => { setDeleteTask(undefined) }}
        onConfirm={() => {
          const target = deleteTask
          setDeleteTask(undefined)
          if (target !== undefined) void actions.deleteTask(target.id)
        }}
      />
    </div>
  )
}
