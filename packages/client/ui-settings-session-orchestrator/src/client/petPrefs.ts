/**
 * Browser-local placement of the butler fish.
 *
 * The in-page pet and the frame-wide desktop overlay live in two separate React
 * trees, so they share this tiny external store instead of passing props through
 * the shell. Only placement is stored; queues and runs stay in the live snapshot.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/petPrefs
 */

import { useSyncExternalStore } from 'react'

/** Where the fish currently lives. */
export type PetMode = 'docked' | 'floating'

/** Smallest and largest desktop sprite width, in CSS pixels. */
export const PET_SCALE_MIN = 96

/** Default desktop sprite width, in CSS pixels. */
export const PET_SCALE_DEFAULT = 144

/** Largest desktop sprite width, in CSS pixels. */
export const PET_SCALE_MAX = 240

/** Persisted pet placement and appearance. */
export interface PetPrefs {
  readonly mode: PetMode
  /** Viewport x in CSS pixels, or null to use the default corner. */
  readonly x: number | null
  /** Viewport y in CSS pixels, or null to use the default corner. */
  readonly y: number | null
  /** Desktop sprite width in CSS pixels. */
  readonly scale: number
  /** Whether the soft aura and ground shadow are drawn behind the fish. */
  readonly glow: boolean
}

/** Storage key owned by this plugin. */
const STORAGE_KEY = 'dsh-handsoff:pet-prefs'

/** Stable default shared by every subscriber. */
const DEFAULTS: PetPrefs = {
  mode: 'docked',
  x: null,
  y: null,
  scale: PET_SCALE_DEFAULT,
  glow: true,
}

/** Clamp a width to the range the rail exposes. */
function scaleValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(value)))
    : PET_SCALE_DEFAULT
}

/** Read the stored placement, tolerating private mode and malformed JSON. */
function read(): PetPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return DEFAULTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
    const record = parsed as Record<string, unknown>
    return {
      mode: record.mode === 'floating' ? 'floating' : 'docked',
      x: typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : null,
      y: typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : null,
      scale: scaleValue(record.scale),
      glow: record.glow !== false,
    }
  } catch {
    return DEFAULTS
  }
}

/** Write placement without letting storage failures break the UI. */
function write(prefs: PetPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // A browser that refuses storage still gets a working, non-persistent pet.
  }
}

let state: PetPrefs = read()
const listeners = new Set<() => void>()

/** Replace state and notify the two mounted trees. */
function publish(next: PetPrefs): void {
  if (
    next.mode === state.mode
    && next.x === state.x
    && next.y === state.y
    && next.scale === state.scale
    && next.glow === state.glow
  ) return
  state = next
  write(state)
  for (const listener of listeners) listener()
}

/** Subscribe to placement changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Snapshot read for React. */
function snapshot(): PetPrefs {
  return state
}

/** Server-side snapshot: React requires one stable object. */
function serverSnapshot(): PetPrefs {
  return DEFAULTS
}

/**
 * Subscribe one component to the shared placement.
 * @returns current mode and saved coordinates.
 */
export function usePetPrefs(): PetPrefs {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/**
 * Move the fish between the settings page and the desktop overlay.
 * @param mode - target home.
 */
export function setPetMode(mode: PetMode): void {
  publish({ ...state, mode })
}

/** Flip between docked and floating. */
export function togglePetMode(): void {
  setPetMode(state.mode === 'docked' ? 'floating' : 'docked')
}

/**
 * Remember a dragged position.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 */
export function setPetPosition(x: number, y: number): void {
  publish({ ...state, x, y })
}

/**
 * Remember the desktop sprite width.
 * @param scale - width in CSS pixels; clamped to the rail's range.
 */
export function setPetScale(scale: number): void {
  publish({ ...state, scale: scaleValue(scale) })
}

/** Flip the soft aura and ground shadow behind the fish. */
export function togglePetGlow(): void {
  publish({ ...state, glow: !state.glow })
}

/** Show or hide the soft aura and ground shadow. */
export function setPetGlow(glow: boolean): void {
  publish({ ...state, glow })
}

/** Forget the saved position so the next desktop show uses the default corner. */
export function resetPetPosition(): void {
  publish({ ...state, x: null, y: null })
}

/** Test hook: clear the stored placement and return to defaults. */
export function resetPetPrefs(): void {
  state = DEFAULTS
  write(state)
  for (const listener of listeners) listener()
}
