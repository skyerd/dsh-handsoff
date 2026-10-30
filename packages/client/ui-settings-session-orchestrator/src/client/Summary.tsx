/**
 * One equal-width metric strip shared by every orchestration tab.
 *
 * The strip is the page's only summary surface: a label and a number per cell,
 * separated by hairlines, so the four tabs keep the same top edge. A metric may
 * carry one small icon and become a button when the page has a drill-down view.
 */

import type { ReactNode } from 'react'
import css from './Summary.module.css'

/** One metric cell. */
export interface SummaryMetric {
  readonly label: string
  readonly value: string | number
  /** Optional small leading glyph, e.g. the butler's mail icon. */
  readonly icon?: ReactNode
  /** Turn this cell into a drill-down control. */
  readonly onClick?: () => void
}

/** Props of the shared metric strip. */
export interface SummaryProps {
  readonly label: string
  readonly metrics: readonly SummaryMetric[]
}

/**
 * Render the metric strip.
 * @param props - accessible name and the ordered metric cells.
 * @returns the strip.
 */
export function Summary({ label, metrics }: SummaryProps) {
  return (
    <dl className={css.strip} aria-label={label}>
      {metrics.map((metric) => {
        const content = (
          <>
            <dt className={css.labelLine}>
              {metric.icon !== undefined && <span className={css.icon} aria-hidden="true">{metric.icon}</span>}
              <span className={css.label}>{metric.label}</span>
            </dt>
            <dd className={css.value}>{metric.value}</dd>
          </>
        )
        if (metric.onClick === undefined) {
          return <div className={css.metric} key={metric.label}>{content}</div>
        }
        return (
          <div
            className={css.metricAction}
            key={metric.label}
            role="button"
            tabIndex={0}
            aria-label={`${metric.label}: ${String(metric.value)}`}
            onClick={metric.onClick}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              metric.onClick?.()
            }}
          >
            {content}
          </div>
        )
      })}
    </dl>
  )
}
