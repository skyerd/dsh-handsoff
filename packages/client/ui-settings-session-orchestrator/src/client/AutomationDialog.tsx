/** The management-AI message and the model choice behind its optimisation. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorTranslate } from './copy.ts'
import type { ModelCatalogState } from './service.ts'
import { SelectField } from './Fields.tsx'
import css from './PressureTab.module.css'

/** Step the management-AI dialog currently shows. */
export type AutomationDialogStage = 'ask' | 'model' | 'result'

/** Props for the management-AI decision dialog. */
export interface AutomationDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly stage: AutomationDialogStage
  readonly reason: string
  readonly models: ModelCatalogState
  readonly onConfirm: () => void
  readonly onDecline: () => void
  readonly onLater: () => void
  readonly onApply: (route: string) => void
  readonly onDone: () => void
}

/**
 * Render the three-step management-AI dialog.
 * @param props - step, reason, catalog and step callbacks.
 * @returns the modal, or null while closed.
 */
export function AutomationDialog({
  t, open, stage, reason, models, onConfirm, onDecline, onLater, onApply, onDone,
}: AutomationDialogProps) {
  const [route, setRoute] = useState('')
  if (!open) return null
  const options = [
    { value: '', label: t('pressureQueueModelInherit') },
    ...models.choices.map(choice => ({
      value: `${choice.provider}/${choice.model}`,
      label: `${choice.providerName} · ${choice.modelName}`,
    })),
  ]
  const title = stage === 'ask'
    ? t('pressureAlertTitle')
    : stage === 'model'
      ? t('pressureOptimizeTitle')
      : t('pressureOptimizeResultTitle')

  return (
    <div className={css.overlay} role="presentation">
      <section className={css.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <header className={css.dialogHead}>
          <span className={css.dialogKicker}>{t('metricSupervisor')}</span>
          <h3 className={css.dialogTitle}>{title}</h3>
        </header>
        {stage === 'ask' && (
          <>
            <p className={css.dialogBody}>{t('pressureAlertBody')}</p>
            <div className={css.reasonBox}>
              <span className={css.reasonLabel}>{t('pressureOptimizeReason')}</span>
              <p className={css.reasonText}>{reason}</p>
            </div>
            <div className={css.dialogActions}>
              <Button size="sm" variant="primary" onClick={onConfirm}>{t('pressureAlertConfirm')}</Button>
              <Button size="sm" variant="outline" onClick={onDecline}>{t('pressureAlertDecline')}</Button>
              <Button size="sm" variant="ghost" onClick={onLater}>{t('pressureAlertLater')}</Button>
            </div>
          </>
        )}
        {stage === 'model' && (
          <>
            <p className={css.dialogBody}>{t('pressureOptimizeBody')}</p>
            <div className={css.reasonBox}>
              <span className={css.reasonLabel}>{t('pressureOptimizeReason')}</span>
              <p className={css.reasonText}>{reason}</p>
            </div>
            <SelectField
              label={t('pressureOptimizeModel')}
              hint={t('pressureOptimizeModelHint')}
              value={route}
              options={options}
              disabled={models.phase === 'loading'}
              onChange={setRoute}
            />
            {models.phase !== 'ready' && (
              <Tag tone="warning">
                {models.phase === 'loading' ? t('modelCatalogLoading') : t('modelCatalogUnavailable')}
              </Tag>
            )}
            <div className={css.dialogActions}>
              <Button size="sm" variant="primary" onClick={() => { onApply(route) }}>
                {t('pressureOptimizeApply')}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDecline}>{t('cancel')}</Button>
            </div>
          </>
        )}
        {stage === 'result' && (
          <>
            <p className={css.dialogBody}>{t('pressureOptimizeResultBody')}</p>
            <div className={css.resultBox}>
              <Tag tone="success">{t('skillsGlobalImprovementsTitle')}</Tag>
              <p className={css.resultText}>{t('improvementGeneratedResult')}</p>
            </div>
            <div className={css.dialogActions}>
              <Button size="sm" variant="primary" onClick={onDone}>{t('pressureOptimizeDone')}</Button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
