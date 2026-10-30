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

/** Persisted pet placement. */
export interface PetPrefs {
  readonly mode: PetMode
  /** Viewport x in CSS pixels, or null to use the default corner. */
  readonly x: number | null
  /** Viewport y in CSS pixels, or null to use the default corner. */
  readonly y: number | null
}

/** Storage key owned by this plugin. */
const STORAGE_KEY = 'dsh-handsoff:pet-prefs'

/** Stable default shared by every subscriber. */
const DEFAULTS: PetPrefs = { mode: 'docked', x: null, y: null }

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
  if (next.mode === state.mode && next.x === state.x && next.y === state.y) return
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
