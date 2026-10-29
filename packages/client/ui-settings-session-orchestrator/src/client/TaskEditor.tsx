/**
 * The task editor: one local draft over prompt, workspace, route/preset policies,
 * and handoff thresholds. Dependencies and list position are owned by the
 * ordered list above; every write sends the revision the draft was loaded from.
 */

import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostCapabilityDto, ModelPolicy, QueueDto, TaskSummaryDto, WorkspaceChoice } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { handoffModeKey } from './copy.ts'
import type { ModelCatalogState, TaskDraftPatch, TaskDraftState } from './service.ts'
import { Field, NumberField, SelectField, TextAreaField, TextField } from './Fields.tsx'
import { ModelPolicyFields } from './ModelFields.tsx'
import { WorkspaceField, type WorkspaceOption } from './WorkspaceField.tsx'
import css from './TaskEditor.module.css'

/** Props for one task draft. */
export interface TaskEditorProps {
  readonly t: OrchestratorTranslate
  readonly draft: TaskDraftState
  readonly queues: readonly QueueDto[]
  readonly workspaces: readonly WorkspaceChoice[]
  readonly liveTask: TaskSummaryDto | undefined
  readonly busy: boolean
  readonly onEdit: (patch: TaskDraftPatch) => void
  readonly onSave: () => void
  readonly onDiscard: () => void
  /** Route the pipeline stores for tasks that inherit. */
  readonly queueModel: ModelPolicy | undefined
  /** Native host model catalog the route selector reads. */
  readonly models: ModelCatalogState
  /** Primary host capability matrix; the skills row decides what may be shown. */
  readonly host: HostCapabilityDto | undefined
}

/**
 * Render the task draft form.
 * @param props - draft values, live summaries, localized copy, and callbacks.
 * @returns the editor.
 */
export function TaskEditor({
  t, draft, queues, workspaces, liveTask, busy, onEdit, onSave, onDiscard,
  queueModel, models, host,
}: TaskEditorProps) {
  const task = draft.draft
  const stale = draft.mode === 'edit' && liveTask?.revision !== draft.baseRevision
  const disabled = busy || draft.saving
  const queueOptions = queues.map(queue => ({ value: queue.id, label: queue.title }))
  if (!queues.some(queue => queue.id === task.queueId)) {
    queueOptions.unshift({ value: task.queueId, label: task.queueId })
  }
  const workspaceOptions: WorkspaceOption[] = workspaces.map(workspace => ({
    value: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
  }))
  if (task.workspaceId !== '' && !workspaces.some(workspace => workspace.workspaceId === task.workspaceId)) {
    workspaceOptions.push({
      value: task.workspaceId,
      title: task.workspaceId,
      path: task.cwd,
    })
  }
  const selectedWorkspace = workspaces.find(workspace => workspace.workspaceId === task.workspaceId)
  const skillsCapability = host?.capabilities.find(capability => capability.capability === 'skills')
  const skillsHint = skillsCapability?.status === 'supported'
    ? t('skillsDecidedByPreset')
    : skillsCapability === undefined
      ? t('skillsHostUnknown')
      : t('skillsUnsupported', { reason: skillsCapability.reason ?? '' })

  return (
    <section className={css.editor} aria-label={draft.mode === 'create' ? t('newTaskTitle') : t('taskEditor')}>
      <header className={css.header}>
        <div className={css.heading}>
          <span className={css.eyebrow}>{t('advancedTaskEditor')}</span>
          <h3 className={css.title}>{draft.mode === 'create' ? t('newTaskTitle') : t('taskEditor')}</h3>
        </div>
        <div className={css.badges}>
          <Tag tone="outline">{`${t('liveRevision', { revision: draft.baseRevision })}`}</Tag>
          {task.enabled ? <Tag tone="success">{t('taskEnabled')}</Tag> : <Tag tone="quiet">{t('taskEnabled')}</Tag>}
        </div>
      </header>
      {stale && (
        <p className={css.stale} role="status">
          {t('staleDraft')}
        </p>
      )}
      <section className={css.group} aria-label={t('editorBasics')}>
        <h4 className={css.groupTitle}>{t('editorBasics')}</h4>
        <div className={css.grid}>
          <SelectField
            label={t('queueSection')}
            value={task.queueId}
            options={queueOptions}
            disabled
            onChange={() => {}}
          />
          <TextField
            label={t('taskTitle')}
            value={task.title}
            disabled={disabled}
            onChange={(value) => { onEdit({ title: value }) }}
          />
          <WorkspaceField
            label={t('taskWorkspace')}
            placeholder={t('workspaceNone')}
            value={task.workspaceId}
            options={workspaceOptions}
            disabled={disabled}
            onChange={(value) => {
              const workspace = workspaces.find(candidate => candidate.workspaceId === value)
              onEdit({ workspaceId: value, cwd: workspace?.path ?? '' })
            }}
          />
          <TextField
            label={t('taskCwd')}
            value={selectedWorkspace?.path ?? task.cwd}
            disabled
            onChange={() => {}}
          />
          <NumberField
            label={t('taskPriority')}
            value={task.priority}
            disabled={disabled}
            onChange={(value) => { onEdit({ priority: Math.trunc(value) }) }}
          />
          <Field label={t('taskEnabled')}>
            <Switch
              checked={task.enabled}
              label={t('taskEnabled')}
              disabled={disabled}
              onChange={(value) => { onEdit({ enabled: value }) }}
            />
          </Field>
        </div>
      </section>
      <section className={css.group} aria-label={t('editorPrompt')}>
        <h4 className={css.groupTitle}>{t('editorPrompt')}</h4>
        <TextAreaField
          label={t('taskPrompt')}
          value={task.prompt}
          disabled={disabled}
          rows={9}
          onChange={(value) => { onEdit({ prompt: value }) }}
        />
      </section>
      <section className={css.group} aria-label={t('editorRouting')}>
        <h4 className={css.groupTitle}>{t('editorRouting')}</h4>
        <div className={css.grid}>
          <SelectField
            label={t('presetPolicy')}
            value={task.preset.kind}
            options={[
              { value: 'inherit', label: t('presetInherit') },
              { value: 'fixed', label: t('presetFixed') },
            ]}
            disabled={disabled}
            onChange={(kind) => {
              onEdit({ preset: kind === 'fixed' ? { kind: 'fixed', id: '' } : { kind: 'inherit' } })
            }}
          />
          {task.preset.kind === 'fixed' && (
            <TextField
              label={t('presetId')}
              value={task.preset.id}
              disabled={disabled}
              onChange={(value) => { onEdit({ preset: { kind: 'fixed', id: value } }) }}
            />
          )}
          <ModelPolicyFields
            t={t}
            inheritLabel={queueModel?.kind === 'fixed' ? t('modelInheritPipeline') : t('modelInheritHost')}
            value={task.model}
            models={models}
            disabled={disabled}
            onChange={(model) => { onEdit({ model }) }}
          />
        </div>
        {skillsCapability?.status !== 'supported' && <p className={css.note}>{skillsHint}</p>}
      </section>
      <section className={css.handoff} aria-label={t('editorHandoff')}>
        <header className={css.handoffHeader}>
          <div className={css.handoffLead}>
            <h4 className={css.groupTitle}>{t('editorHandoff')}</h4>
            <Tag tone="info">{t(handoffModeKey(task.handoff.mode))}</Tag>
          </div>
          <Field label={t('handoffEnabled')}>
            <Switch
              checked={task.handoff.enabled}
              label={t('handoffEnabled')}
              disabled={disabled}
              onChange={(value) => { onEdit({ handoff: { ...task.handoff, enabled: value } }) }}
            />
          </Field>
        </header>
        <div className={css.grid}>
          <NumberField
            label={t('handoffRatio')}
            value={Math.round(task.handoff.ratio * 100)}
            min={50}
            max={95}
            disabled={disabled || !task.handoff.enabled}
            onChange={(value) => { onEdit({ handoff: { ...task.handoff, ratio: value / 100 } }) }}
          />
          <SelectField
            label={t('handoffMode')}
            value={task.handoff.mode}
            options={[
              { value: 'structured-brief', label: t('handoffStructured') },
              { value: 'last-complete-turn', label: t('handoffLastTurn') },
            ]}
            disabled={disabled || !task.handoff.enabled}
            onChange={(value) => { onEdit({ handoff: { ...task.handoff, mode: value } }) }}
          />
          <NumberField
            label={t('handoffMaxGenerations')}
            value={task.handoff.maxGenerations}
            min={1}
            disabled={disabled || !task.handoff.enabled}
            onChange={(value) => {
              onEdit({ handoff: { ...task.handoff, maxGenerations: Math.trunc(value) } })
            }}
          />
          <NumberField
            label={t('handoffMaxTokens')}
            value={task.handoff.maxHandoffTokens}
            min={1}
            disabled={disabled || !task.handoff.enabled}
            onChange={(value) => {
              onEdit({ handoff: { ...task.handoff, maxHandoffTokens: Math.trunc(value) } })
            }}
          />
        </div>
      </section>
      <footer className={css.footer}>
        <Button variant="primary" disabled={disabled} onClick={onSave}>{t('taskSave')}</Button>
        <Button variant="outline" disabled={disabled} onClick={onDiscard}>{t('taskDiscard')}</Button>
      </footer>
    </section>
  )
}
