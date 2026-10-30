/**
 * The butler fish's speech card, shared by the settings page and the desktop
 * overlay. It is deliberately plain: one sentence, one compact progress line,
 * one progress bar, and an optional dismiss button.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetBubble
 */

import type { PetTone } from './petModel.ts'
import css from './PetBubble.module.css'

/** Where the bubble is drawn. */
export type PetBubbleVariant = 'inline' | 'floating'

/** Props of the shared speech card. */
export interface PetBubbleProps {
  readonly text: string
  readonly tone?: PetTone
  /** Compact counts under the sentence. */
  readonly detail?: string
  /** Completion ratio in `[0, 1]`; omit when there is no progress to show. */
  readonly ratio?: number
  readonly variant?: PetBubbleVariant
  /** Which side of the card the little tail sits on; only used when floating. */
  readonly tailSide?: 'left' | 'right'
  readonly onDismiss?: () => void
  readonly dismissLabel?: string
}

/** Tone class lookup. */
const TONE_CLASS: Readonly<Record<PetTone, string>> = {
  info: css.toneInfo,
  success: css.toneSuccess,
  warning: css.toneWarning,
  danger: css.toneDanger,
}

/**
 * Render one speech bubble.
 * @param props - copy, tone, progress and optional dismissal.
 * @returns the bubble.
 */
export function PetBubble({
  text, tone = 'info', detail, ratio, variant = 'inline', tailSide = 'right', onDismiss, dismissLabel,
}: PetBubbleProps) {
  const width = ratio === undefined ? 0 : Math.max(0, Math.min(100, Math.round(ratio * 100)))
  return (
    <div
      className={[
        css.bubble,
        TONE_CLASS[tone],
        variant === 'floating' ? css.floating : css.inline,
      ].join(' ')}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className={css.textRow}>
        <p className={css.text}>{text}</p>
        {onDismiss !== undefined && (
          <button
            type="button"
            className={css.dismiss}
            aria-label={dismissLabel}
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      {detail !== undefined && <span className={css.detail}>{detail}</span>}
      {ratio !== undefined && (
        <div
          className={css.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={width}
          aria-label={detail ?? text}
        >
          <span className={css.progressFill} style={{ width: `${String(width)}%` }} />
        </div>
      )}
      {variant === 'floating' && (
        <span
          className={tailSide === 'left' ? `${css.tail} ${css.tailLeft}` : css.tail}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
