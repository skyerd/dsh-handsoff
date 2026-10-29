/** Plain-language automation rules and the global scheduler control. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { timeLabel } from './copy.ts'
import { DangerConfirm } from './DangerConfirm.tsx'
import { Summary } from './Summary.tsx'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './PressureTab.module.css'

/**
 * Render the automatic behavior without exposing deployment-only thresholds or
 * duplicating the queue concurrency controls.
 * @param props - live settings, localized copy, and section callbacks.
 * @returns the automation settings tab.
 */
export function PressureTab({ t, live, drafts, now, actions }: OrchestrationTabProps) {
  const busy = drafts.busy !== undefined
  const settings = live.settings
  const [pendingHost, setPendingHost] = useState<'pause' | 'resume' | undefined>()
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
          { label: t('metricSupervisor'), value: t('supervisorLocal') },
        ]}
      />
      <section className={css.block} aria-label={t('tabPressure')}>
        <header className={css.head}>
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('tabPressure')}</span>
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

      <section className={css.block} aria-label={t('automationRulesTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('metricRules')}</span>
            <h3 className={css.title}>{t('automationRulesTitle')}</h3>
          </div>
          <Tag tone="outline">{String(rules.length)}</Tag>
        </header>
        <div className={css.ruleGrid}>
          {rules.map((rule, index) => (
            <article key={rule.title} className={css.rule}>
              <span className={css.ruleIndex} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <h4 className={css.subtitle}>{rule.title}</h4>
              <p className={css.ruleBody}>{rule.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={css.block} aria-label={t('automationCostTitle')}>
        <header className={css.head}>
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('metricSupervisor')}</span>
            <h3 className={css.title}>{t('automationCostTitle')}</h3>
          </div>
          <Tag tone="success">{t('supervisorLocal')}</Tag>
        </header>
        <p className={css.costBody}>{t('automationCostBody')}</p>
        <details className={css.details}>
          <summary className={css.disclosure}>{t('automationModelDetails')}</summary>
          <p className={css.note}>{t('wardenNotice')}</p>
        </details>
      </section>

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
