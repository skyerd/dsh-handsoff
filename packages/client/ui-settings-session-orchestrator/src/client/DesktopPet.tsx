/**
 * Frame-wide desktop mode for the butler fish.
 *
 * This is a draggable, always-on-top *layer inside the Harness desktop window*,
 * not an OS-level window: the browser half cannot create one. The placement,
 * the sprite size and the optional aura are remembered locally, the fish reads
 * the same live snapshot as the settings page, and the right-click rail can
 * return it to the "Fish memory" tab.
 *
 * Left-clicking the fish is deliberately reserved for a future character
 * interaction. The rail opens on right-click only.
 *
 * For true OS-level always-on-top windows, pair this plugin with a native
 * companion such as `dsh-plugin-pet-rs` (MIT). We do not bundle or launch that
 * project; see `THIRD_PARTY_NOTICES.md`.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/DesktopPet
 */

import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OrchestratorLiveState } from './service.ts'
import { petChatLine, petDetail, petSnapshotOf, petSpeech } from './petModel.ts'
import {
  PET_SCALE_DEFAULT, PET_SCALE_MAX, PET_SCALE_MIN,
  setPetMode, setPetPosition, setPetScale, togglePetGlow, usePetPrefs,
} from './petPrefs.ts'
import { usePetArt } from './petArtStore.ts'
import { useStudio } from './studioStore.ts'
import type { PetLook, PetMotion } from './petFrames.ts'
import { PetBubble } from './PetBubble.tsx'
import { PetRail, type PetRailAction } from './PetRail.tsx'
import { EllipsisIcon, ExpandIcon, EyeIcon, EyeOffIcon, HomeIcon, MinimizeIcon } from './PetIcons.tsx'
import { PetSprite } from './PetSprite.tsx'
import css from './DesktopPet.module.css'

/** Locale namespace owned by this plugin. */
const NS = 'settings.sessionOrchestrator'

/** Props the frame binds for the desktop-pet overlay entry. */
export type DesktopPetProps = PropsLocale<typeof NS> & {
  /** Selector hook over the live orchestration snapshot. */
  readonly useLive: <R>(selector: (state: OrchestratorLiveState) => R) => R
}

/** Width/height ratio of one sprite cell (156 / 144). */
const PET_ASPECT = 13 / 12

/** Minimum distance from the viewport edges. */
const EDGE = 8

/** Space the rail (30px) plus its size panel (154px), gaps and the edge need. */
const RAIL_ROOM = 210

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

/** Clamp a position so the sprite and its rail stay reachable. */
function clampPosition(position: PetPosition, width: number, height: number): PetPosition {
  if (typeof window === 'undefined') return position
  const maxX = Math.max(EDGE, window.innerWidth - width - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - height - EDGE)
  const minY = Math.min(120, maxY)
  return {
    x: Math.min(maxX, Math.max(EDGE, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y)),
  }
}

/** Default resting place: lower right, above typical composer controls. */
function defaultPosition(width: number, height: number): PetPosition {
  if (typeof window === 'undefined') return { x: 24, y: 200 }
  return clampPosition({
    x: window.innerWidth - width - 28,
    y: window.innerHeight - height - 84,
  }, width, height)
}

/** Normalise a width coming from persisted storage. */
function petWidthOf(scale: number): number {
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(scale)))
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
  const speech = petChatLine(studio, t) ?? petSpeech(pet, t)
  const detail = petDetail(pet, t, studio.notices.length)
  const petWidth = petWidthOf(prefs.scale)
  const petHeight = Math.round(petWidth * PET_ASPECT)
  const [position, setPosition] = useState<PetPosition>(() => (
    prefs.x !== null && prefs.y !== null
      ? clampPosition({ x: prefs.x, y: prefs.y }, petWidth, petHeight)
      : defaultPosition(petWidth, petHeight)
  ))
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [scaleOpen, setScaleOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragDirection, setDragDirection] = useState<-1 | 0 | 1>(0)
  const [hovered, setHovered] = useState(false)
  const [look, setLook] = useState<PetLook | undefined>()
  const drag = useRef<DragState | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  draggingRef.current = dragging
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showBubble = useCallback((): void => {
    setBubbleOpen(true)
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => { setBubbleOpen(false) }, BUBBLE_VISIBLE_MS)
  }, [])

  // Keep the overlay aligned with a position saved by this or another tab.
  useEffect(() => {
    if (prefs.x === null || prefs.y === null) return
    setPosition(clampPosition({ x: prefs.x, y: prefs.y }, petWidth, petHeight))
  }, [prefs.x, prefs.y, petWidth, petHeight])

  // A resized window must not leave the fish or its rail off-screen.
  useEffect(() => {
    const handleResize = (): void => {
      setPosition(current => clampPosition(current, petWidth, petHeight))
    }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize) }
  }, [petWidth, petHeight])

  // Growing the sprite near an edge must keep the whole body and rail visible.
  useEffect(() => {
    setPosition(current => clampPosition(current, petWidth, petHeight))
  }, [petWidth, petHeight])

  // Never let a pending bubble timer write state after the plugin unloads.
  useEffect(() => () => {
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
  }, [])

  // The rail is a right-click menu: close it on Escape or a click outside the
  // layer. A left click on the fish itself stays reserved and does not close it.
  useEffect(() => {
    if (!railOpen) return undefined
    const handlePointerDown = (event: PointerEvent): void => {
      const box = layer.current
      if (box === null || box.contains(event.target as Node)) return
      setRailOpen(false)
      setScaleOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setRailOpen(false)
      setScaleOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [railOpen])

  // The bundled character has sixteen gaze cells. Follow the cursor while idle
  // so the desktop fish feels alive, but never during a drag or on touch.
  useEffect(() => {
    if (prefs.mode !== 'floating') return undefined
    if (typeof requestAnimationFrame !== 'function') return undefined
    let scheduled = 0
    const handleMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || draggingRef.current || scheduled !== 0) return
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        const box = layer.current?.getBoundingClientRect()
        if (box === undefined || box.width === 0) return
        setLook({
          dx: event.clientX - (box.left + box.width / 2),
          dy: event.clientY - (box.top + box.height * 0.34),
        })
      })
    }
    const clearLook = (): void => { setLook(undefined) }
    window.addEventListener('pointermove', handleMove, { passive: true })
    window.addEventListener('blur', clearLook)
    return () => {
      if (scheduled !== 0) cancelAnimationFrame(scheduled)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('blur', clearLook)
    }
  }, [prefs.mode])

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
  }, [pet.mood, speech, prefs.mode, showBubble])

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
    setDragDirection(0)
    setLook(undefined)
  }

  /** Move the sprite, clamped to the viewport. */
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    const next = clampPosition({
      x: current.originX + event.clientX - current.startX,
      y: current.originY + event.clientY - current.startY,
    }, petWidth, petHeight)
    const deltaX = event.clientX - current.startX
    if (Math.abs(deltaX) > 4 || Math.abs(event.clientY - current.startY) > 4) {
      current.moved = true
    }
    if (Math.abs(deltaX) > 4) setDragDirection(deltaX < 0 ? -1 : 1)
    current.x = next.x
    current.y = next.y
    setPosition(next)
  }

  /**
   * Finish a drag and save the new position. A plain left click deliberately
   * does nothing: that gesture is reserved for the future character interaction.
   */
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    setDragDirection(0)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (current.moved) setPetPosition(current.x, current.y)
  }

  /** Cancel a drag without saving it. */
  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    setDragDirection(0)
  }

  /** Open or close the right-click rail from the keyboard. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setScaleOpen(false)
    setRailOpen(open => !open)
  }

  /** Right-click is the only gesture that opens the icon rail. */
  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setScaleOpen(false)
    setRailOpen(open => !open)
  }

  if (prefs.mode !== 'floating') return null

  let motion: PetMotion | undefined
  if (dragging && dragDirection !== 0) {
    motion = dragDirection < 0 ? 'run-left' : 'run-right'
  } else if (hovered) {
    motion = 'jump'
  }
  const bubbleOnLeft = position.x < 280
  const railSide = position.x >= RAIL_ROOM ? 'left' : 'right'
  const actions: readonly PetRailAction[] = [
    {
      id: 'scale',
      label: t('petRailScale'),
      icon: scaleOpen ? <MinimizeIcon /> : <ExpandIcon />,
      active: scaleOpen,
      onPress: () => { setScaleOpen(open => !open) },
    },
    {
      id: 'glow',
      label: t(prefs.glow ? 'petRailHideGlow' : 'petRailShowGlow'),
      icon: prefs.glow ? <EyeOffIcon /> : <EyeIcon />,
      active: !prefs.glow,
      onPress: togglePetGlow,
    },
    {
      id: 'bubble',
      label: t(bubbleOpen ? 'petHideBubble' : 'petShowBubble'),
      icon: <EllipsisIcon />,
      active: bubbleOpen,
      onPress: () => {
        if (bubbleOpen) setBubbleOpen(false)
        else showBubble()
      },
    },
    {
      id: 'dock',
      label: t('petDockBack'),
      icon: <HomeIcon />,
      onPress: () => { setPetMode('docked') },
    },
  ]

  return (
    <div
      ref={layer}
      className={css.layer}
      style={{
        left: `${String(position.x)}px`,
        top: `${String(position.y)}px`,
        width: `${String(petWidth)}px`,
        height: `${String(petHeight)}px`,
      }}
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
      {railOpen && (
        <PetRail
          side={railSide}
          label={t('petRailLabel')}
          actions={actions}
          scaleOpen={scaleOpen}
          scale={petWidth}
          minScale={PET_SCALE_MIN}
          maxScale={PET_SCALE_MAX}
          scaleLabel={t('petScaleLabel')}
          scaleValueLabel={t('petScaleValue', { size: petWidth })}
          scaleResetLabel={t('petScaleReset')}
          onScaleChange={setPetScale}
          onScaleReset={() => { setPetScale(PET_SCALE_DEFAULT) }}
        />
      )}
      <div
        className={dragging ? `${css.petAnchor} ${css.dragging}` : css.petAnchor}
        role="button"
        tabIndex={0}
        aria-label={t('petRailLabel')}
        aria-expanded={railOpen}
        title={t('petRailHint')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') setHovered(true)
        }}
        onPointerLeave={() => { setHovered(false) }}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <PetSprite
          mood={pet.mood}
          size="desktop"
          art={petArt.art[pet.mood]}
          pixels={petWidth}
          glow={prefs.glow}
          {...(motion === undefined ? {} : { motion })}
          {...(look === undefined ? {} : { look })}
        />
      </div>
    </div>
  )
}
