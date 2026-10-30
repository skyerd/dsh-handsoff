/**
 * The HandsOff butler fish: a chibi DeepSeek-blue whale maid.
 *
 * The bundled default is a CC-BY 3.0 derivative of Aeihu's Q-style mermaid
 * (see `ASSETS-LICENSE.md`), dressed in an original navy/white maid outfit and
 * embedded as a data URI. A person may instead import their own locally
 * licensed sprite sheets; those stay in IndexedDB and never enter the bundle.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetSprite
 */

import { useEffect, useState } from 'react'
import type { PetMood } from './petModel.ts'
import { defaultArtFor, type PetArtSource } from './petArtStore.ts'
import css from './PetSprite.module.css'

/** Supported display sizes. */
export type PetSpriteSize = 'inline' | 'desktop'

/** Props of the butler fish. */
export interface PetSpriteProps {
  readonly mood: PetMood
  readonly size?: PetSpriteSize
  /** Source resolved by the shared artwork store; defaults to bundled art. */
  readonly art?: PetArtSource
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

/** Milliseconds per frame for imported horizontal strips. */
const FRAME_MS = 220

/**
 * Render the whale maid.
 * @param props - mood, display size, resolved artwork and accessible name.
 * @returns one self-contained sprite with CSS effects.
 */
export function PetSprite({ mood, size = 'inline', art, label, className }: PetSpriteProps) {
  const source = art ?? defaultArtFor(mood)
  const frames = Math.max(1, source.frames)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    setFrame(0)
    if (frames <= 1) return undefined
    const timer = setInterval(() => {
      setFrame(current => (current + 1) % frames)
    }, FRAME_MS)
    return () => { clearInterval(timer) }
  }, [frames, source.src])

  const rootClass = [
    css.root,
    size === 'desktop' ? css.sizeDesktop : css.sizeInline,
    MOOD_CLASS[mood],
    className ?? '',
  ].filter(Boolean).join(' ')
  const strip = frames > 1
  const offset = strip ? (frame / (frames - 1)) * 100 : 0

  return (
    <span
      className={rootClass}
      data-mood={mood}
      data-custom={source.custom ? 'true' : 'false'}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <span className={css.glow} aria-hidden="true" />
      <span className={css.character}>
        <span
          className={css.art}
          style={{
            backgroundImage: `url("${source.src}")`,
            // A horizontal sheet is stretched to expose one square frame at a
            // time; a single non-square picture is contained without distortion.
            backgroundSize: strip ? `${String(frames * 100)}% 100%` : 'contain',
            backgroundPosition: strip ? `${String(offset)}% 0` : 'center',
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
