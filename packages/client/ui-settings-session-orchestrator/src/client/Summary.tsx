/**
 * One equal-width metric strip shared by every orchestration tab.
 *
 * The strip is the page's only summary surface: a label and a number per cell,
 * separated by hairlines, so the four tabs keep the same top edge.
 */

import css from './Summary.module.css'

/** One metric cell. */
export interface SummaryMetric {
  readonly label: string
  readonly value: string | number
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
      {metrics.map(metric => (
        <div className={css.metric} key={metric.label}>
          <dt className={css.label}>{metric.label}</dt>
          <dd className={css.value}>{metric.value}</dd>
        </div>
      ))}
    </dl>
  )
}
