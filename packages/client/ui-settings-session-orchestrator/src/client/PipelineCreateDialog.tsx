/**
 * The inline queue composer.
 *
 * One queue block holds an existing workspace, an optional name and an ordered
 * list of task prompts. Every task may pin its own model and agent preset; the
 * queue starts only when the user presses Start.
 */

import { useEffect, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelPolicy, WorkspaceChoice } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import type {
  ModelCatalogState, PipelineCreateInput, PipelineCreateTaskInput, PresetCatalogState,
} from './service.ts'
import { SelectField, TextAreaField, TextField } from './Fields.tsx'
import { ModelPolicyFields } from './ModelFields.tsx'
import { RenameDialog } from './RenameDialog.tsx'
import { RowMenu } from './RowMenu.tsx'
import { WorkspaceField, type WorkspaceOption } from './WorkspaceField.tsx'
import css from './PipelineCreateDialog.module.css'

/** Browser storage key for the form's automatic draft. */
export const PIPELINE_DRAFT_STORAGE_KEY = 'dsh.hands-off.pipeline-create-draft.v1'

/** Props of the manual queue composer. */
export interface PipelineCreateDialogProps {
  readonly t: OrchestratorTranslate
  readonly workspaces: readonly WorkspaceChoice[]
  readonly models: ModelCatalogState
  readonly presets: PresetCatalogState
  readonly busy: boolean
  readonly onClose: () => void
  readonly onCreate: (input: PipelineCreateInput) => Promise<boolean>
  readonly onUseTemplate: () => void
}

/** One editable task row. */
interface ComposerTask {
  /** Custom label; empty falls back to `Task N` and then the prompt's first line. */
  readonly title: string
  readonly prompt: string
  readonly model: ModelPolicy
  readonly presetId: string
  readonly collapsed: boolean
}

/** Last local form draft. */
interface StoredPipelineDraft {
  readonly workspaceId?: string
  readonly cwd?: string
  readonly prompts?: readonly string[]
  readonly prompt?: string
  /** Per-row labels, index-aligned with the prompts. */
  readonly taskTitles?: readonly string[]
  readonly title?: string
}

/** Manual queues accept a bounded number of ordered prompts. */
const MAX_MANUAL_PROMPTS = 8

/** The composer starts with one visible task row. */
function emptyTask(): ComposerTask {
  return {
    title: '',
    prompt: '',
    model: { kind: 'inherit' },
    presetId: '',
    collapsed: false,
  }
}

/** Read one stored string field without trusting the stored object. */
function storedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Read an ordered prompt list, including the pre-composer draft shape. */
function storedPrompts(record: Record<string, unknown>): string[] | undefined {
  const values = record.prompts
  if (Array.isArray(values)) {
    const prompts = values.filter((value): value is string => typeof value === 'string')
    if (prompts.length > 0) return prompts.slice(0, MAX_MANUAL_PROMPTS)
  }
  const legacy = storedString(record, 'prompt')
  return legacy === undefined || legacy === '' ? undefined : [legacy]
}

/** Read an ordered label list, index-aligned with the stored prompts. */
function storedTitles(record: Record<string, unknown>): string[] | undefined {
  const values = record.taskTitles
  if (!Array.isArray(values)) return undefined
  const titles = values.filter((value): value is string => typeof value === 'string')
  return titles.length === 0 ? undefined : titles.slice(0, MAX_MANUAL_PROMPTS)
}

/** Restore the last local draft, or an empty one when storage is unavailable. */
function readStoredDraft(): StoredPipelineDraft {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(PIPELINE_DRAFT_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    const workspaceId = storedString(record, 'workspaceId')
    const cwd = storedString(record, 'cwd')
    const prompts = storedPrompts(record)
    const taskTitles = storedTitles(record)
    const title = storedString(record, 'title')
    return {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(prompts === undefined ? {} : { prompts }),
      ...(taskTitles === undefined ? {} : { taskTitles }),
      ...(title === undefined ? {} : { title }),
    }
  } catch (error) {
    console.warn('session-orchestrator UI: could not read the pipeline draft', error)
    return {}
  }
}

/** Persist the local draft; blocked storage leaves the form working. */
function saveStoredDraft(draft: StoredPipelineDraft): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PIPELINE_DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch (error) {
    console.warn('session-orchestrator UI: could not save the pipeline draft', error)
  }
}

/** Remove the local draft after the queue starts. */
function clearStoredDraft(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PIPELINE_DRAFT_STORAGE_KEY)
  } catch (error) {
    console.warn('session-orchestrator UI: could not clear the pipeline draft', error)
  }
}

/**
 * Render the workspace selector, queue name and task-message rows.
 * @param props - workspaces, catalogs, localized copy and create callbacks.
 * @returns the inline composer panel.
 */
export function PipelineCreateDialog({
  t, workspaces, models, presets, busy, onClose, onCreate, onUseTemplate,
}: PipelineCreateDialogProps) {
  const [restored] = useState(readStoredDraft)
  const restoredWorkspace = workspaces.find(workspace => workspace.workspaceId === restored.workspaceId)
  const defaultWorkspace = restoredWorkspace ?? workspaces[0]
  const savedCwd = restoredWorkspace === undefined ? '' : restored.cwd ?? ''
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspace?.workspaceId ?? '')
  const [cwd, setCwd] = useState(savedCwd === '' ? defaultWorkspace?.path ?? '' : savedCwd)
  const [tasks, setTasks] = useState<ComposerTask[]>(() => {
    const prompts = restored.prompts === undefined || restored.prompts.length === 0
      ? ['']
      : [...restored.prompts]
    return prompts.map((prompt, index) => ({
      ...emptyTask(),
      prompt,
      title: restored.taskTitles?.[index] ?? '',
    }))
  })
  const [title, setTitle] = useState(restored.title ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null)
  const restoredDraft = tasks.some(task => task.prompt.trim() !== '') || (restored.title ?? '').trim() !== ''
  const complete = tasks.length > 0 && tasks.every(task => task.prompt.trim() !== '')
  const canCreate = !busy && !submitting
    && workspaceId.trim() !== ''
    && cwd.trim() !== ''
    && complete

  useEffect(() => {
    saveStoredDraft({
      workspaceId,
      cwd,
      prompts: tasks.map(task => task.prompt),
      taskTitles: tasks.map(task => task.title),
      title,
    })
  }, [workspaceId, cwd, tasks, title])

  const editTask = (index: number, patch: Partial<ComposerTask>): void => {
    setTasks(current => current.map((task, at) => at === index ? { ...task, ...patch } : task))
  }

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setSubmitting(true)
    const payload: PipelineCreateTaskInput[] = tasks.map(task => ({
      prompt: task.prompt.trim(),
      ...(task.title.trim() === '' ? {} : { title: task.title.trim() }),
      ...(task.model.kind === 'inherit' ? {} : { model: task.model }),
      ...(task.presetId === '' ? {} : { presetId: task.presetId }),
    }))
    const created = await onCreate({
      tasks: payload,
      workspaceId,
      cwd,
      ...(title.trim() === '' ? {} : { title: title.trim() }),
    })
    setSubmitting(false)
    if (created) {
      clearStoredDraft()
      onClose()
    }
  }

  const presetOptions = [
    { value: '', label: t('composerSkillsInherit'), muted: true },
    ...presets.choices.map(preset => ({
      value: preset.id,
      label: preset.isDefault ? `${preset.name} · ${t('presetDefault')}` : preset.name,
    })),
  ]
  const workspaceOptions: readonly WorkspaceOption[] = workspaces.map(workspace => ({
    value: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
  }))
  const toggleTask = (index: number): void => {
    setTasks(current => current.map((task, at) => (
      at === index ? { ...task, collapsed: !task.collapsed } : task
    )))
  }

  return (
    <section className={css.panel} aria-label={t('pipelineCreateTitle')}>
      <header className={css.header}>
        <div className={css.heading}>
          <h3 className={css.title}>{t('pipelineCreateTitle')}</h3>
        </div>
        <div className={css.badges}>
          {restoredDraft && <Tag tone="outline">{t('pipelineCreateRestored')}</Tag>}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setCollapsed(value => !value) }}
          >
            {collapsed ? t('composerExpand') : t('composerCollapse')}
          </Button>
        </div>
      </header>

      <div className={css.metaGrid}>
        <TextField
          label={t('composerQueueName')}
          value={title}
          disabled={submitting}
          placeholder={t('pipelineCreateOptionalTitle')}
          onChange={setTitle}
        />
        <WorkspaceField
          label={t('pipelineCreateFolder')}
          placeholder={t('workspaceNone')}
          value={workspaceId}
          options={workspaceOptions}
          disabled={busy || submitting}
          onChange={(value) => {
            const workspace = workspaces.find(candidate => candidate.workspaceId === value)
            setWorkspaceId(value)
            setCwd(workspace?.path ?? '')
          }}
        />
      </div>

      {!collapsed && (
        <>
          <div className={css.stepsHead}>
            <span className={css.stepsLabel}>{t('composerSteps')}</span>
            <span className={css.stepsMeta}>{t('queueTaskCount', { count: tasks.length })}</span>
          </div>
          <div className={css.promptList}>
            {tasks.map((task, index) => (
              <article
                className={task.collapsed ? `${css.taskRow} ${css.taskRowCollapsed}` : css.taskRow}
                data-collapsed={task.collapsed}
                key={index}
              >
                <header className={css.taskHead}>
                  <span className={css.stepBadge}>{String(index + 1).padStart(2, '0')}</span>
                  <span className={css.taskName}>
                    {task.title.trim() === '' ? t('composerTask', { index: index + 1 }) : task.title}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={css.collapseButton}
                    aria-label={`${task.collapsed ? t('composerExpand') : t('composerCollapse')} ${t('composerTask', { index: index + 1 })}`}
                    disabled={submitting}
                    onClick={() => { toggleTask(index) }}
                  >
                    <IconChevronDownOutlineRegular
                      size={12}
                      className={task.collapsed ? css.chevronCollapsed : css.chevron}
                    />
                  </Button>
                  <RowMenu
                    label={`${t('taskMenu')} ${t('composerTask', { index: index + 1 })}`}
                    disabled={submitting}
                    items={[
                      {
                        id: 'rename',
                        label: t('renameTask'),
                        onSelect: () => { setRenamingIndex(index) },
                      },
                      {
                        id: 'delete',
                        label: t('deleteTaskAction'),
                        tone: 'danger',
                        disabled: tasks.length <= 1,
                        onSelect: () => {
                          setTasks(current => current.filter((_task, at) => at !== index))
                        },
                      },
                    ]}
                  />
                </header>
                {task.collapsed
                  ? (
                    <div className={css.taskPreview}>
                      <span className={css.previewText} title={task.prompt}>
                        {task.prompt.trim() === '' ? t('composerEmptyPrompt') : task.prompt}
                      </span>
                      {task.model.kind === 'fixed' && (
                        <Tag tone="outline">{task.model.model}</Tag>
                      )}
                    </div>
                  )
                  : (
                    <>
                      <TextAreaField
                        label={t('pipelineCreatePrompt')}
                        value={task.prompt}
                        rows={4}
                        placeholder={t('composerPromptPlaceholder')}
                        disabled={busy || submitting}
                        onChange={(value) => { editTask(index, { prompt: value }) }}
                      />
                      <div className={css.taskControls}>
                        <div className={css.routeFields}>
                          <ModelPolicyFields
                            t={t}
                            inheritLabel={t('modelInheritHost')}
                            value={task.model}
                            models={models}
                            disabled={busy || submitting}
                            onChange={(model) => { editTask(index, { model }) }}
                          />
                        </div>
                        <div className={css.skillField}>
                          <SelectField
                            label={t('composerSkills')}
                            value={task.presetId}
                            options={presetOptions}
                            disabled={busy || submitting || presets.choices.length === 0}
                            onChange={(presetId) => { editTask(index, { presetId }) }}
                          />
                        </div>
                        <div className={css.taskFoot}>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || submitting || task.prompt.trim() === '' || tasks.length >= MAX_MANUAL_PROMPTS}
                            onClick={() => {
                              setTasks(current => {
                                const next = [...current]
                                next.splice(index + 1, 0, emptyTask())
                                return next
                              })
                            }}
                          >
                            {t('composerSend')}
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
              </article>
            ))}
          </div>
          <footer className={css.footer}>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || submitting || tasks.length >= MAX_MANUAL_PROMPTS}
              onClick={() => { setTasks(current => [...current, emptyTask()]) }}
            >
              + {t('pipelineCreateAddPrompt')}
            </Button>
            <div className={css.footerActions}>
              {presets.phase === 'error' && <span className={css.warning}>{presets.error}</span>}
              <Button variant="primary" size="sm" disabled={!canCreate} onClick={() => { void submit() }}>
                {submitting ? t('pipelineCreateSubmitting') : t('composerStart')}
              </Button>
            </div>
          </footer>
        </>
      )}
      {workspaces.length === 0 && <p className={css.warning}>{t('composerNoWorkspace')}</p>}
      <details className={css.optional}>
        <summary>{t('pipelineCreateMore')}</summary>
        <Button variant="ghost" size="sm" disabled={busy || submitting} onClick={onUseTemplate}>
          {t('pipelineCreateTemplateOption')}
        </Button>
      </details>
      <RenameDialog
        t={t}
        open={renamingIndex !== null}
        title={t('renameTask')}
        label={t('taskNameField')}
        value={renamingIndex === null ? '' : tasks[renamingIndex]?.title ?? ''}
        placeholder={t('taskNameOptional')}
        disabled={submitting}
        onCancel={() => { setRenamingIndex(null) }}
        onSave={(next) => {
          const index = renamingIndex
          setRenamingIndex(null)
          if (index === null) return
          setTasks(current => current.map((task, at) => (at === index ? { ...task, title: next } : task)))
        }}
      />
    </section>
  )
}
