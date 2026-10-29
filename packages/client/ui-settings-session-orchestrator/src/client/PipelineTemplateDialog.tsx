/**
 * The one-click pipeline form: choose a workspace, write the requirement once,
 * and create four ordered stage tasks as a draft.
 *
 * The queue id is generated once per open form. A retried request therefore
 * reuses the same identity and the host adopts the draft instead of creating a
 * second queue; the in-flight guard covers the double-click case.
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceChoice } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import type { PipelineTemplateInput } from './service.ts'
import { SelectField, TextAreaField, TextField } from './Fields.tsx'
import css from './PipelineTemplateDialog.module.css'

/** Props of the template form. */
export interface PipelineTemplateDialogProps {
  readonly t: OrchestratorTranslate
  readonly workspaces: readonly WorkspaceChoice[]
  readonly busy: boolean
  readonly onClose: () => void
  readonly onCreate: (input: PipelineTemplateInput) => Promise<boolean>
}

/** Generate the stable identity of one draft pipeline. */
function newPipelineQueueId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `pipeline-${Date.now().toString(36)}-${random}`
}

/**
 * Render the requirement-driven template form.
 * @param props - workspaces, localized copy and the create callback.
 * @returns the template panel.
 */
export function PipelineTemplateDialog({
  t, workspaces, busy, onClose, onCreate,
}: PipelineTemplateDialogProps) {
  const [queueId] = useState(newPipelineQueueId)
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.workspaceId ?? '')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const selectedWorkspace = workspaces.find(workspace => workspace.workspaceId === workspaceId)
  const canCreate = !busy && !submitting && workspaceId.trim() !== '' && brief.trim() !== ''
  const stages = [
    t('stageArchitecture'),
    t('stageBreakdown'),
    t('stageImplement'),
    t('stageTest'),
  ]

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setSubmitting(true)
    const created = await onCreate({
      queueId,
      brief,
      workspaceId,
      ...(title.trim() === '' ? {} : { title: title.trim() }),
      ...(selectedWorkspace === undefined ? {} : { cwd: selectedWorkspace.path }),
    })
    setSubmitting(false)
    if (created) onClose()
  }

  return (
    <section className={css.panel} aria-label={t('pipelineTemplateTitle')}>
      <header className={css.header}>
        <div className={css.heading}>
          <span className={css.eyebrow}>{t('pipelineTemplateDraft')}</span>
          <h3 className={css.title}>{t('pipelineTemplateTitle')}</h3>
        </div>
        <Button size="sm" variant="ghost" disabled={submitting} onClick={onClose}>
          {t('cancel')}
        </Button>
      </header>
      <div className={css.grid}>
        <SelectField
          label={t('pipelineTemplateWorkspace')}
          value={workspaceId}
          options={[
            { value: '', label: t('workspaceNone') },
            ...workspaces.map(workspace => ({
              value: workspace.workspaceId,
              label: `${workspace.title} · ${workspace.path}`,
            })),
          ]}
          disabled={busy || submitting}
          onChange={setWorkspaceId}
        />
        <TextField
          label={t('pipelineTemplateQueueTitle')}
          value={title}
          placeholder={t('pipelineTemplateQueueTitleHint')}
          disabled={busy || submitting}
          onChange={setTitle}
        />
      </div>
      <TextAreaField
        label={t('pipelineTemplateBrief')}
        value={brief}
        rows={6}
        placeholder={t('pipelineTemplateBriefHint')}
        disabled={busy || submitting}
        onChange={setBrief}
      />
      <div className={css.stageBlock}>
        <span className={css.stageLabel}>{t('pipelineTemplateStages')}</span>
        <ol className={css.stageList}>
          {stages.map((stage, index) => (
            <li key={stage} className={css.stage}>
              <span className={css.stageIndex}>{index + 1}</span>
              <span className={css.stageName}>{stage}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className={css.note}>{t('pipelineTemplateDraftNote')}</p>
      <footer className={css.footer}>
        <Button
          variant="primary"
          size="sm"
          disabled={!canCreate}
          onClick={() => { void submit() }}
        >
          {t('pipelineTemplateCreate')}
        </Button>
      </footer>
    </section>
  )
}
