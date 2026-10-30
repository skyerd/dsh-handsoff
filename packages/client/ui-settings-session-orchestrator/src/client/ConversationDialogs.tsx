/**
 * Conversation-level dialogs: model switch, follow-up composer and deletion.
 *
 * Every choice a person makes here stays explicit: the model dialog only
 * switches a fixed route, the follow-up dialog creates one child task in the
 * queue, and deletion mirrors the pipeline dialog's acknowledgement plus
 * optional native archive.
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelPolicy, TaskSummaryDto } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { pinnedRouteOf } from './model.ts'
import type { ModelCatalogState, ModelChoice } from './service.ts'
import { SelectField, TextAreaField } from './Fields.tsx'
import css from './ConversationDialogs.module.css'
import queueCss from './QueueDeleteDialog.module.css'

/** Form value of one advertised route. */
function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Resolve one route from the catalog. */
function choiceOf(choices: readonly ModelChoice[], key: string): ModelChoice | undefined {
  return choices.find(choice => routeKey(choice.provider, choice.model) === key)
}

/** What the model dialog applies. */
export interface ConversationModelChoice {
  readonly model: ModelPolicy
  readonly futureTaskIds: readonly string[]
  readonly muteQueuePrompt: boolean
}

/** Props of the conversation model dialog. */
export interface ConversationModelDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly models: ModelCatalogState
  readonly currentModel: ModelPolicy
  readonly futureTasks: readonly TaskSummaryDto[]
  readonly muted: boolean
  readonly disabled?: boolean
  readonly onCancel: () => void
  readonly onApply: (choice: ConversationModelChoice) => void
}

/**
 * Render the model picker and its optional future-task selection.
 * @param props - catalog, current route, unstarted tasks and callbacks.
 * @returns the dialog, or null while closed.
 */
export function ConversationModelDialog({
  t, open, models, currentModel, futureTasks, muted, disabled = false, onCancel, onApply,
}: ConversationModelDialogProps) {
  const [route, setRoute] = useState('')
  const [effort, setEffort] = useState('')
  const [applyFuture, setApplyFuture] = useState(false)
  const [futureIds, setFutureIds] = useState<ReadonlySet<string>>(new Set())
  const [mute, setMute] = useState(false)

  useEffect(() => {
    if (!open) return
    const advertised = models.choices
    const initial = currentModel.kind === 'fixed'
      ? choiceOf(advertised, routeKey(currentModel.provider, currentModel.model))
      : pinnedRouteOf(advertised)
    setRoute(initial === undefined ? '' : routeKey(initial.provider, initial.model))
    setEffort(initial?.defaultReasoningEffort ?? '')
    setApplyFuture(false)
    setFutureIds(new Set(futureTasks.map(task => task.id)))
    setMute(false)
  }, [open])

  const selected = choiceOf(models.choices, route)
  const reasoning = selected?.reasoningEfforts ?? []
  const available = models.phase === 'ready' && models.choices.length > 0
  const allSelected = futureTasks.every(task => futureIds.has(task.id))

  const apply = (): void => {
    if (selected === undefined) return
    onApply({
      model: {
        kind: 'fixed',
        provider: selected.provider,
        model: selected.model,
        ...(effort === '' ? {} : { reasoningEffort: effort }),
      },
      futureTaskIds: applyFuture ? [...futureIds] : [],
      muteQueuePrompt: mute,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('conversationSwitchTitle')}
      closeLabel={t('close')}
      className={queueCss.dialog!}
      contentClassName={queueCss.content!}
      footer={(
        <>
          <Button variant="outline" className={queueCss.action} onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            className={queueCss.confirm}
            disabled={disabled || selected === undefined}
            onClick={apply}
          >
            {t('conversationSwitchApply')}
          </Button>
        </>
      )}
    >
      <p className={css.body}>{t('conversationSwitchBody')}</p>
      {available
        ? (
          <>
            <SelectField
              label={t('boardModel')}
              value={route}
              options={models.choices.map(choice => ({
                value: routeKey(choice.provider, choice.model),
                label: choice.isDefault === true
                  ? `${choice.providerName} · ${choice.modelName} · ${t('modelDefaultTag')}`
                  : `${choice.providerName} · ${choice.modelName}`,
              }))}
              disabled={disabled}
              onChange={(key) => {
                const next = choiceOf(models.choices, key)
                setRoute(key)
                setEffort(next?.defaultReasoningEffort ?? '')
              }}
            />
            {reasoning.length > 0 && (
              <SelectField
                label={t('modelReasoning')}
                value={effort}
                options={[
                  { value: '', label: t('modelReasoningDefault') },
                  ...reasoning.map(item => ({ value: item.id, label: item.name })),
                ]}
                disabled={disabled}
                onChange={setEffort}
              />
            )}
          </>
        )
        : <p className={css.hint}>{t('conversationModelRequired')}</p>}
      {muted
        ? <p className={css.hint}>{t('conversationSwitchMutedHint')}</p>
        : (
          <>
            <Checkbox
              checked={applyFuture}
              disabled={disabled}
              label={t('conversationSwitchFuture')}
              onChange={setApplyFuture}
            />
            {applyFuture && (
              <div className={css.future}>
                <p className={css.hint}>
                  {t('conversationSwitchFutureHint')} · {t('conversationFutureCount', { count: futureTasks.length })}
                </p>
                {futureTasks.length === 0
                  ? <p className={css.hint}>{t('emptyTasks')}</p>
                  : (
                    <>
                      <Checkbox
                        checked={allSelected}
                        disabled={disabled}
                        label={t('conversationSwitchAll')}
                        onChange={(checked) => {
                          setFutureIds(checked ? new Set(futureTasks.map(task => task.id)) : new Set())
                        }}
                      />
                      <div className={css.futureList}>
                        {futureTasks.map(task => (
                          <Checkbox
                            key={task.id}
                            checked={futureIds.has(task.id)}
                            disabled={disabled}
                            label={task.title}
                            onChange={(checked) => {
                              setFutureIds((current) => {
                                const next = new Set(current)
                                if (checked) next.add(task.id)
                                else next.delete(task.id)
                                return next
                              })
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
              </div>
            )}
            <Checkbox
              checked={mute}
              disabled={disabled}
              label={t('conversationSwitchMute')}
              onChange={setMute}
            />
          </>
        )}
    </Modal>
  )
}

/** Props of the follow-up composer. */
export interface ConversationFollowUpDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly disabled?: boolean
  readonly onCancel: () => void
  readonly onApply: (prompt: string) => void
}

/** Render one follow-up text composer. */
export function ConversationFollowUpDialog({
  t, open, disabled = false, onCancel, onApply,
}: ConversationFollowUpDialogProps) {
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    if (!open) setPrompt('')
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('conversationFollowUpTitle')}
      closeLabel={t('close')}
      className={queueCss.dialog!}
      contentClassName={queueCss.content!}
      footer={(
        <>
          <Button variant="outline" className={queueCss.action} onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            className={queueCss.confirm}
            disabled={disabled || prompt.trim() === ''}
            onClick={() => { onApply(prompt.trim()) }}
          >
            {t('conversationFollowUpApply')}
          </Button>
        </>
      )}
    >
      <TextAreaField
        label={t('conversationFollowUpLabel')}
        hint={t('conversationFollowUpHint')}
        value={prompt}
        rows={4}
        disabled={disabled}
        onChange={setPrompt}
      />
    </Modal>
  )
}

/** Props of the conversation deletion dialog. */
export interface ConversationDeleteDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly disabled?: boolean
  readonly hasSession: boolean
  readonly onCancel: () => void
  readonly onConfirm: (archiveSession: boolean) => void
}

/** Render the acknowledgement-gated conversation removal dialog. */
export function ConversationDeleteDialog({
  t, open, disabled = false, hasSession, onCancel, onConfirm,
}: ConversationDeleteDialogProps) {
  const [archive, setArchive] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    if (!open) {
      setArchive(false)
      setAcknowledged(false)
    }
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('conversationDeleteTitle')}
      closeLabel={t('close')}
      className={queueCss.dialog!}
      contentClassName={queueCss.content!}
      footer={(
        <>
          <Button variant="outline" className={queueCss.action} onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            className={queueCss.confirm}
            disabled={disabled || !acknowledged}
            onClick={() => { onConfirm(archive) }}
          >
            {t('conversationDeleteApply')}
          </Button>
        </>
      )}
    >
      <p className={queueCss.notice}>{t('conversationDeleteBody')}</p>
      <div className={queueCss.archiveBlock}>
        <Checkbox
          checked={archive}
          disabled={disabled || !hasSession}
          label={t('conversationDeleteArchive')}
          onChange={setArchive}
        />
        <p className={queueCss.hint}>
          {hasSession ? t('conversationDeleteArchiveHint') : t('conversationDeleteNoSession')}
        </p>
      </div>
      <div className={queueCss.acknowledgeRow}>
        <Checkbox
          checked={acknowledged}
          disabled={disabled}
          label={t('conversationDeleteAcknowledge')}
          onChange={setAcknowledged}
        />
      </div>
    </Modal>
  )
}
