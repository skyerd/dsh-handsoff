/** Persistent failure list: plain-language causes with technical facts folded. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientError } from './errors.ts'
import { errorExplanationKey, timeLabel, type OrchestratorTranslate } from './copy.ts'
import css from './ErrorPanel.module.css'

/** Props for the retained failure list. */
export interface ErrorPanelProps {
  readonly t: OrchestratorTranslate
  readonly errors: readonly ClientError[]
  readonly now: number
  readonly onDismiss: (id: string) => void
  readonly onClear: () => void
}

/**
 * Render every retained failure in-page. The main row carries only a localized
 * explanation; stable codes, raw messages and details stay behind a disclosure
 * so the ordinary flow never exposes internal English errors.
 * @param props - retained records and dismissal callbacks.
 * @returns the failure panel, or null when none is retained.
 */
export function ErrorPanel({ t, errors, now, onDismiss, onClear }: ErrorPanelProps) {
  if (errors.length === 0) return null
  return (
    <section className={css.panel} aria-label={t('errorsTitle')}>
      <header className={css.header}>
        <h3 className={css.title}>{t('errorsTitle')}</h3>
        <Button size="sm" variant="outline" onClick={onClear}>{t('clearAll')}</Button>
      </header>
      <ul className={css.list}>
        {errors.map((error) => (
          <li key={error.id} className={css.row} data-error-code={error.code}>
            <div className={css.rowHead}>
              <span className={css.time}>{timeLabel(error.at, now, t)}</span>
              <Button size="sm" variant="ghost" onClick={() => { onDismiss(error.id) }}>
                {t('dismiss')}
              </Button>
            </div>
            <p className={css.explanation}>{t(errorExplanationKey(error.code))}</p>
            <details className={css.disclosure}>
              <summary>{t('runRecordTechnicalDetails')}</summary>
              <dl className={css.facts}>
                <dt>{t('errorCode')}</dt>
                <dd><code>{error.code}</code></dd>
                <dt>{t('errorOperation')}</dt>
                <dd><code>{error.operation}</code></dd>
                {error.message !== '' && (
                  <>
                    <dt>{t('errorMessage')}</dt>
                    <dd>{error.message}</dd>
                  </>
                )}
                {error.detail !== undefined && (
                  <>
                    <dt>{t('errorDetail')}</dt>
                    <dd><code>{error.detail}</code></dd>
                  </>
                )}
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}
