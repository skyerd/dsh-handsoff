/**
 * Frame-wide desktop mode for the butler fish.
 *
 * This is a draggable, always-on-top *layer inside the Harness desktop window*,
 * not an OS-level window: the browser half cannot create one. The placement is
 * remembered locally, the fish reads the same live snapshot as the settings
 * page, and the dock button returns it to the "Fish memory" tab.
 *
 * For true OS-level always-on-top windows, pair this plugin with a native
 * companion such as `dsh-plugin-pet-rs` (MIT). We do not bundle or launch that
 * project; see `THIRD_PARTY_NOTICES.md`.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/DesktopPet
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OrchestratorLiveState } from './service.ts'
import { petDetail, petSnapshotOf, petSpeech } from './petModel.ts'
import { setPetMode, setPetPosition, usePetPrefs } from './petPrefs.ts'
import { usePetArt } from './petArtStore.ts'
import { useStudio } from './studioStore.ts'
import { PetBubble } from './PetBubble.tsx'
import { PetSprite } from './PetSprite.tsx'
import css from './DesktopPet.module.css'

/** Locale namespace owned by this plugin. */
const NS = 'settings.sessionOrchestrator'

/** Props the frame binds for the desktop-pet overlay entry. */
export type DesktopPetProps = PropsLocale<typeof NS> & {
  /** Selector hook over the live orchestration snapshot. */
  readonly useLive: <R>(selector: (state: OrchestratorLiveState) => R) => R
}

/** Approximate rendered width of the desktop sprite. */
const PET_WIDTH = 144

/** Approximate rendered height of the desktop sprite. */
const PET_HEIGHT = 144

/** Room reserved under the sprite for the dock controls. */
const CONTROL_ROOM = 34

/** Minimum distance from the viewport edges. */
const EDGE = 8

/** One viewport position. */
interface PetPosition {
  readonly x: number
  readonly y: number
}

/** Live drag bookkeeping. */
interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly originX: number
  readonly originY: number
  x: number
  y: number
  moved: boolean
}

/** Clamp a position so the sprite and its dock controls stay reachable. */
function clampPosition(position: PetPosition): PetPosition {
  if (typeof window === 'undefined') return position
  const maxX = Math.max(EDGE, window.innerWidth - PET_WIDTH - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - PET_HEIGHT - CONTROL_ROOM)
  const minY = Math.min(160, maxY)
  return {
    x: Math.min(maxX, Math.max(EDGE, position.x)),
    y: Math.min(maxY, Math.max(minY, Math.min(maxY, position.y))),
  }
}

/** Default resting place: lower right, above typical composer controls. */
function defaultPosition(): PetPosition {
  if (typeof window === 'undefined') return { x: 24, y: 200 }
  return clampPosition({
    x: window.innerWidth - PET_WIDTH - 28,
    y: window.innerHeight - PET_HEIGHT - 84,
  })
}

/** How long one bubble stays open before folding away. */
const BUBBLE_VISIBLE_MS = 9_000

/** How often the desktop mode re-surfaces a progress bubble. */
const BUBBLE_CYCLE_MS = 45_000

/**
 * Render the floating fish when desktop mode is on.
 * @param props - live snapshot hook and localized copy.
 * @returns the overlay, or null while the fish lives in the settings page.
 */
export function DesktopPet({ useLive, t }: DesktopPetProps) {
  const prefs = usePetPrefs()
  const live = useLive(snapshot => snapshot)
  const studio = useStudio()
  const petArt = usePetArt()
  const pet = petSnapshotOf(live)
  const speech = petSpeech(pet, t)
  const detail = petDetail(pet, t, studio.notices.length)
  const [position, setPosition] = useState<PetPosition>(() => (
    prefs.x !== null && prefs.y !== null
      ? clampPosition({ x: prefs.x, y: prefs.y })
      : defaultPosition()
  ))
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<DragState | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showBubble = useCallback((): void => {
    setBubbleOpen(true)
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => { setBubbleOpen(false) }, BUBBLE_VISIBLE_MS)
  }, [])

  // Keep the overlay aligned with a position saved by this or another tab.
  useEffect(() => {
    if (prefs.x === null || prefs.y === null) return
    setPosition(clampPosition({ x: prefs.x, y: prefs.y }))
  }, [prefs.x, prefs.y])

  // A resized window must not leave the fish off-screen.
  useEffect(() => {
    const handleResize = (): void => {
      setPosition(current => clampPosition(current))
    }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize) }
  }, [])

  // Never let a pending hide timer write state after the plugin unloads.
  useEffect(() => () => {
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
  }, [])

  // Surface the progress bubble on arrival, on mood changes, and periodically.
  useEffect(() => {
    if (prefs.mode !== 'floating') return undefined
    showBubble()
    const cycle = setInterval(showBubble, BUBBLE_CYCLE_MS)
    return () => {
      clearInterval(cycle)
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    }
  }, [prefs.mode, showBubble])

  useEffect(() => {
    if (prefs.mode === 'floating') showBubble()
  }, [pet.mood, prefs.mode, showBubble])

  if (prefs.mode !== 'floating') return null

  /** Start a drag that also distinguishes a tap from a real move. */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      x: position.x,
      y: position.y,
      moved: false,
    }
    setDragging(true)
  }

  /** Move the sprite, clamped to the viewport. */
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    const next = clampPosition({
      x: current.originX + event.clientX - current.startX,
      y: current.originY + event.clientY - current.startY,
    })
    if (Math.abs(event.clientX - current.startX) > 4 || Math.abs(event.clientY - current.startY) > 4) {
      current.moved = true
    }
    current.x = next.x
    current.y = next.y
    setPosition(next)
  }

  /** Finish a drag, or treat a tap as a bubble toggle. */
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (current.moved) setPetPosition(current.x, current.y)
    else setBubbleOpen(open => !open)
  }

  /** Cancel a drag without saving it. */
  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  /** Keyboard equivalent of tapping the fish. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setBubbleOpen(open => !open)
  }

  const bubbleOnLeft = position.x < 300
  return (
    <div
      className={css.layer}
      style={{ left: `${String(position.x)}px`, top: `${String(position.y)}px` }}
      data-pet-mode="floating"
    >
      {bubbleOpen && (
        <div className={bubbleOnLeft ? `${css.bubbleSlot} ${css.bubbleLeft}` : `${css.bubbleSlot} ${css.bubbleRight}`}>
          <PetBubble
            text={speech}
            tone={pet.tone}
            {...(detail === undefined ? {} : { detail })}
            {...(pet.progress.total === 0 ? {} : { ratio: pet.progress.ratio })}
            variant="floating"
            tailSide={bubbleOnLeft ? 'left' : 'right'}
            onDismiss={() => { setBubbleOpen(false) }}
            dismissLabel={t('petHideBubble')}
          />
        </div>
      )}
      <div
        className={dragging ? `${css.petAnchor} ${css.dragging}` : css.petAnchor}
        role="button"
        tabIndex={0}
        aria-label={t(petBubbleOpenLabel(bubbleOpen))}
        aria-expanded={bubbleOpen}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <PetSprite mood={pet.mood} size="desktop" art={petArt.art[pet.mood]} />
      </div>
      <div className={css.controls}>
        <button
          type="button"
          className={css.control}
          aria-label={t(bubbleOpen ? 'petHideBubble' : 'petShowBubble')}
          onClick={() => { setBubbleOpen(open => !open) }}
        >
          {bubbleOpen ? '×' : '…'}
        </button>
        <button
          type="button"
          className={css.control}
          aria-label={t('petDockBack')}
          onClick={() => { setPetMode('docked') }}
        >
          ⌂
        </button>
      </div>
    </div>
  )
}

/** Locale key for the fish's own accessible label. */
function petBubbleOpenLabel(bubbleOpen: boolean): 'petHideBubble' | 'petShowBubble' {
  return bubbleOpen ? 'petHideBubble' : 'petShowBubble'
}
