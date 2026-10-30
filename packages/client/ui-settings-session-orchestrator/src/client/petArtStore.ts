/**
 * Default and user-supplied artwork for the butler fish.
 *
 * The bundled art is CC-BY 3.0 (see `ASSETS-LICENSE.md`). User-supplied sprite
 * sheets are kept only in this browser's IndexedDB; they are never uploaded,
 * never embedded in the package and never leave the machine. This keeps the
 * code MIT while letting a person use a locally licensed, non-commercial
 * character such as the `dsh-whale-maid` sprites.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/petArtStore
 */

import { useSyncExternalStore } from 'react'
import { PET_ART } from './petArt.ts'
import type { PetMood } from './petModel.ts'

/** One drawable image: a static picture or a horizontal frame strip. */
export interface PetArtSource {
  /** Object URL or bundled data URI. */
  readonly src: string
  /** Number of square frames laid out horizontally. */
  readonly frames: number
  /** Whether this image came from local user storage. */
  readonly custom: boolean
}

/** Art selected for every mood. */
export type PetArtMap = Readonly<Record<PetMood, PetArtSource>>

/** One stored local sprite. */
interface PetArtRecord {
  readonly key: string
  readonly blob: Blob
  readonly frames: number
  readonly width: number
  readonly height: number
  readonly name: string
  readonly updatedAt: number
}

/** State exposed to both the settings page and the desktop overlay. */
export interface PetArtState {
  readonly art: PetArtMap
  readonly customKeys: readonly string[]
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error?: string
}

/** File-name stems the local importer understands. */
export const PET_ART_KEYS = [
  'idle', 'joy', 'work', 'think', 'sleep', 'wake',
  'walk', 'welcome', 'drag', 'sad', 'eat', 'play',
  'celebrate', 'success', 'hurt',
] as const

/** Local keys that map to one mood, in preference order. */
const MOOD_SOURCES: Readonly<Record<PetMood, readonly string[]>> = {
  connecting: ['wake', 'think', 'idle'],
  idle: ['idle', 'welcome', 'walk'],
  working: ['work', 'walk', 'idle'],
  attention: ['think', 'welcome', 'idle'],
  done: ['joy', 'celebrate', 'success', 'idle'],
  error: ['sad', 'hurt', 'idle'],
  sleeping: ['sleep', 'wake', 'idle'],
}

/** Bundled fallback for each mood. */
const DEFAULT_ART: PetArtMap = {
  connecting: { src: PET_ART.idle, frames: 1, custom: false },
  idle: { src: PET_ART.idle, frames: 1, custom: false },
  working: { src: PET_ART.idle, frames: 1, custom: false },
  attention: { src: PET_ART.idle, frames: 1, custom: false },
  done: { src: PET_ART.done, frames: 1, custom: false },
  error: { src: PET_ART.idle, frames: 1, custom: false },
  sleeping: { src: PET_ART.sleep, frames: 1, custom: false },
}

/** IndexedDB identity. */
const DB_NAME = 'dsh-handsoff-pet-art'
const STORE_NAME = 'sprites'
const DB_VERSION = 1

let state: PetArtState = { art: DEFAULT_ART, customKeys: [], status: 'idle' }
let loadPromise: Promise<void> | undefined
const listeners = new Set<() => void>()
const objectUrls = new Map<string, string>()

/** Notify the two mounted React trees. */
function publish(next: PetArtState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Subscribe to artwork changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current snapshot. */
function snapshot(): PetArtState {
  return state
}

/** Stable server snapshot. */
function serverSnapshot(): PetArtState {
  return state
}

/** Open the tiny local artwork database. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('pet art database unavailable')) }
  })
}

/** Read every locally stored sprite. */
function readAllRecords(): Promise<PetArtRecord[]> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).getAll()
      request.onsuccess = () => { resolve(request.result as PetArtRecord[]) }
      request.onerror = () => { reject(request.error ?? new Error('pet art read failed')) }
      transaction.oncomplete = () => { db.close() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('pet art transaction failed')) }
    }).catch(reject)
  })
}

/** Replace one local sprite. */
function putRecord(record: PetArtRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(record)
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('pet art write failed')) }
    }).catch(reject)
  })
}

/** Drop every local sprite. */
function clearRecords(): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).clear()
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('pet art clear failed')) }
    }).catch(reject)
  })
}

/** Revoke old object URLs before rebuilding the map. */
function releaseUrls(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url)
  objectUrls.clear()
}

/** Pick the first locally installed key for one mood. */
function sourceForMood(
  mood: PetMood,
  records: ReadonlyMap<string, PetArtRecord>,
): PetArtSource | undefined {
  for (const key of MOOD_SOURCES[mood]) {
    const record = records.get(key)
    const url = objectUrls.get(key)
    if (record !== undefined && url !== undefined) {
      return { src: url, frames: record.frames, custom: true }
    }
  }
  return undefined
}

/** Build the mood map from the local records plus bundled fallbacks. */
function buildArt(records: ReadonlyMap<string, PetArtRecord>): PetArtMap {
  const moods: PetMood[] = [
    'connecting', 'idle', 'working', 'attention', 'done', 'error', 'sleeping',
  ]
  // If the user supplied one character, keep that character for every mood
  // instead of mixing it with the bundled chibi. CSS effects still distinguish
  // working/attention/error when no dedicated sheet exists.
  const customIdle = sourceForMood('idle', records)
  return moods.reduce<Record<string, PetArtSource>>((art, mood) => {
    art[mood] = sourceForMood(mood, records) ?? customIdle ?? DEFAULT_ART[mood]
    return art
  }, {}) as unknown as PetArtMap
}

/** Read local artwork and publish the resolved map. */
async function loadCustomArt(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    publish({ ...state, status: 'ready' })
    return
  }
  publish({ ...state, status: 'loading' })
  const records = await readAllRecords()
  releaseUrls()
  const byKey = new Map<string, PetArtRecord>()
  for (const record of records) {
    byKey.set(record.key, record)
    objectUrls.set(record.key, URL.createObjectURL(record.blob))
  }
  publish({
    art: buildArt(byKey),
    customKeys: [...byKey.keys()].sort(),
    status: 'ready',
  })
}

/** Start the one shared IndexedDB load. */
export function ensurePetArtLoaded(): void {
  if (loadPromise !== undefined || typeof indexedDB === 'undefined') return
  // Defer the first store update until after the current React render: the
  // hook is called from render, and publishing synchronously there would be a
  // render-phase state update.
  loadPromise = Promise.resolve()
    .then(loadCustomArt)
    .catch((error: unknown) => {
      publish({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    })
}

/**
 * Subscribe one component to artwork changes.
 * @returns the current art map and installed local keys.
 */
export function usePetArt(): PetArtState {
  ensurePetArtLoaded()
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/** Turn a file name into one of the supported stems. */
function fileKey(name: string): string | undefined {
  const stem = name.replace(/\.(png|webp|jpg|jpeg)$/iu, '').toLowerCase()
  return (PET_ART_KEYS as readonly string[]).includes(stem) ? stem : undefined
}

/** Read image dimensions without keeping the file decoded. */
async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    } catch {
      // Some browsers expose the API but reject a particular codec; use an <img>.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
      URL.revokeObjectURL(url)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('pet art image could not be decoded'))
    }
    image.src = url
  })
}

/** Detect a horizontal strip of square frames. */
function detectFrames(width: number, height: number): number {
  if (height <= 0) return 1
  const frames = Math.round(width / height)
  return width % height === 0 && frames >= 1 && frames <= 24 ? frames : 1
}

/**
 * Import locally selected sprite files.
 * @param files - user-selected image files, named after one of {@link PET_ART_KEYS}.
 * @returns which keys were stored and which file names were ignored.
 */
export async function importPetArt(files: readonly File[]): Promise<{
  readonly imported: readonly string[]
  readonly skipped: readonly string[]
}> {
  const imported: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    const key = fileKey(file.name)
    if (key === undefined) {
      skipped.push(file.name)
      continue
    }
    try {
      const size = await imageSize(file)
      await putRecord({
        key,
        blob: file,
        frames: detectFrames(size.width, size.height),
        width: size.width,
        height: size.height,
        name: file.name,
        updatedAt: Date.now(),
      })
      imported.push(key)
    } catch {
      skipped.push(file.name)
    }
  }
  await loadCustomArt()
  return { imported, skipped }
}

/** Remove every locally imported sprite and return to the bundled art. */
export async function clearPetArt(): Promise<void> {
  if (typeof indexedDB !== 'undefined') await clearRecords()
  releaseUrls()
  publish({ art: DEFAULT_ART, customKeys: [], status: 'ready' })
}

/** One default art source for callers that need a fallback. */
export function defaultArtFor(mood: PetMood): PetArtSource {
  return DEFAULT_ART[mood]
}
