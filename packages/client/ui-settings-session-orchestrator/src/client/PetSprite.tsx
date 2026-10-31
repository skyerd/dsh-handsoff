/**
 * The HandsOff butler fish: “ds鲸鲸娘 / 大肥鱼”, the MIT-licensed blue whale
 * maid from `zhouwu97/ds-pet`.
 *
 * The bundled default is one 8×11 sprite grid (see `petArt.ts`): rows 0–8 are
 * nine action animations and rows 9–10 are sixteen gaze directions. A person
 * may instead import locally licensed sprite strips; those stay in IndexedDB
 * and never enter the bundle. All motion is frame timing plus CSS, so the
 * package stays far below the 10 MB target.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetSprite
 */

import { useEffect, useRef } from 'react'
import type { PetMood } from './petModel.ts'
import { defaultArtFor, type PetArtSource } from './petArtStore.ts'
import {
  CUSTOM_FRAME_MS, frameAt, gazeFrame, motionForMood,
  type PetFrame, type PetLook, type PetMotion,
} from './petFrames.ts'
import css from './PetSprite.module.css'

/** Supported display sizes. */
export type PetSpriteSize = 'inline' | 'desktop'

/** Props of the butler fish. */
export interface PetSpriteProps {
  readonly mood: PetMood
  readonly size?: PetSpriteSize
  /** Source resolved by the shared artwork store; defaults to bundled art. */
  readonly art?: PetArtSource
  /** Interaction overrides the mood-derived motion (drag, hover, tap). */
  readonly motion?: PetMotion
  /** Pointer offset for the sixteen-direction gaze rows. */
  readonly look?: PetLook
  /** Draw the soft aura and ground shadow; defaults to true. */
  readonly glow?: boolean
  /** Custom desktop width in CSS pixels; the height follows the sheet aspect. */
  readonly pixels?: number
  /** Accessible name; omit when a surrounding button already carries the label. */
  readonly label?: string
  readonly className?: string
}

/** Mood to module class, kept explicit so every state has a visual branch. */
const MOOD_CLASS: Readonly<Record<PetMood, string>> = {
  connecting: css.moodConnecting,
  idle: css.moodIdle,
  working: css.moodWorking,
  attention: css.moodAttention,
  done: css.moodDone,
  error: css.moodError,
  sleeping: css.moodSleeping,
}

/** CSS background position that exposes one cell of a grid. */
function cellPosition(columns: number, rows: number, cell: PetFrame): string {
  // A plain imported picture keeps its aspect ratio and is centred.
  if (columns <= 1 && rows <= 1) return 'center'
  const x = columns <= 1 ? 0 : (cell.column / (columns - 1)) * 100
  const y = rows <= 1 ? 0 : (cell.row / (rows - 1)) * 100
  return `${String(x)}% ${String(y)}%`
}

/**
 * Render the whale maid.
 * @param props - mood, display size, resolved artwork, interaction motion and gaze.
 * @returns one self-contained sprite with CSS effects.
 */
export function PetSprite({
  mood, size = 'inline', art, motion, look, glow = true, pixels, label, className,
}: PetSpriteProps) {
  const source = art ?? defaultArtFor(mood)
  const resolvedMotion = motion ?? motionForMood(mood)
  const columns = Math.max(1, source.columns)
  const rows = Math.max(1, source.rows)
  const artRef = useRef<HTMLSpanElement>(null)
  const motionRef = useRef<PetMotion>(resolvedMotion)
  const lookRef = useRef<PetLook | undefined>(look)
  motionRef.current = resolvedMotion
  lookRef.current = look

  useEffect(() => {
    const element = artRef.current
    if (element === null) return undefined
    const reduced = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let motionStart = performance.now()
    let previousMotion: PetMotion | '' = ''
    let previousPosition = ''
    let handle = 0

    /** Draw the current cell; React state is never touched per frame. */
    const paint = (now: number): void => {
      const current = motionRef.current
      if (current !== previousMotion) {
        previousMotion = current
        motionStart = now
      }
      let cell: PetFrame
      if (source.custom && rows === 1) {
        // Imported art is a horizontal strip: cycle it independent of mood.
        cell = {
          row: 0,
          column: reduced || columns === 1
            ? 0
            : Math.floor((now - motionStart) / CUSTOM_FRAME_MS) % columns,
        }
      } else {
        cell = frameAt(current, now - motionStart, reduced)
        const lookNow = lookRef.current
        if (current === 'idle' && lookNow !== undefined && rows >= 11) {
          cell = gazeFrame(lookNow) ?? cell
        }
        // A shorter custom grid must not point past its own last cell.
        cell = {
          row: Math.min(cell.row, rows - 1),
          column: Math.min(cell.column, columns - 1),
        }
      }
      const position = cellPosition(columns, rows, cell)
      if (position !== previousPosition) {
        element.style.backgroundPosition = position
        previousPosition = position
      }
      if (!reduced && typeof requestAnimationFrame === 'function') {
        handle = requestAnimationFrame(paint)
      }
    }

    paint(performance.now())
    return () => {
      if (handle !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    }
  }, [source.src, source.columns, source.rows, source.custom])

  const rootClass = [
    css.root,
    size === 'desktop' ? css.sizeDesktop : css.sizeInline,
    MOOD_CLASS[mood],
    className ?? '',
  ].filter(Boolean).join(' ')
  const initial = source.custom && rows === 1 ? { row: 0, column: 0 } : frameAt(resolvedMotion, 0)
  const rootStyle = pixels === undefined
    ? undefined
    : { width: `${String(pixels)}px`, height: `${String(Math.round(pixels * 13 / 12))}px` }

  return (
    <span
      className={rootClass}
      style={rootStyle}
      data-mood={mood}
      data-motion={resolvedMotion}
      data-glow={glow ? 'on' : 'off'}
      data-custom={source.custom ? 'true' : 'false'}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      {glow && (
        <>
          <span className={css.glow} aria-hidden="true" />
          <span className={css.shadow} aria-hidden="true" />
        </>
      )}
      <span className={css.character}>
        <span
          ref={artRef}
          className={css.art}
          style={{
            backgroundImage: `url("${source.src}")`,
            // Percentages expose one cell of a columns×rows grid, and scale
            // exactly for both 96×104 inline and 144×156 desktop sizes.
            backgroundSize: columns <= 1 && rows <= 1
              ? 'contain'
              : `${String(columns * 100)}% ${String(rows * 100)}%`,
            backgroundPosition: cellPosition(columns, rows, initial),
            backgroundRepeat: 'no-repeat',
          }}
        />
        <span className={css.spout} aria-hidden="true"><i /><i /><i /></span>
        <span className={css.bubbles} aria-hidden="true"><i /><i /><i /></span>
        <span className={css.attentionMark} aria-hidden="true">!</span>
        <span className={css.sparkles} aria-hidden="true">✦</span>
        <span className={css.sweat} aria-hidden="true" />
        <span className={css.zzz} aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>
      </span>
    </span>
  )
}
