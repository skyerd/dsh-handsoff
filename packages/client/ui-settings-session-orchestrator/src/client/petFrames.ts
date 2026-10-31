/**
 * Frame timing for the bundled 8×11 “ds鲸鲸娘 / 大肥鱼” sprite grid.
 *
 * The sheet comes from `zhouwu97/ds-pet` (MIT). Rows 0–8 are the nine action
 * animations used by the pet; rows 9–10 hold the sixteen gaze directions.
 * Keeping the timing table pure lets the inline preview and the desktop
 * overlay resolve exactly the same frame for the same state.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/petFrames
 */

import type { PetMood } from './petModel.ts'

/** One animation the sprite sheet can play. */
export type PetMotion =
  | 'idle'
  | 'run-left'
  | 'run-right'
  | 'wave'
  | 'jump'
  | 'failed'
  | 'waiting'
  | 'working'
  | 'review'
  | 'sleep'

/** A screen-space vector used by the sixteen-direction gaze rows. */
export interface PetLook {
  /** Horizontal distance from the character's centre, in CSS pixels. */
  readonly dx: number
  /** Vertical distance from the character's centre, in CSS pixels. */
  readonly dy: number
}

/** One cell of the sprite grid. */
export interface PetFrame {
  readonly row: number
  readonly column: number
}

/** One row and its per-frame dwell times in milliseconds. */
interface MotionSpec {
  readonly row: number
  readonly durations: readonly number[]
  /** A single resting cell; used by the sleeping pose. */
  readonly fixed?: number
}

/** Canonical ds-pet v2 timings, kept in one place. */
const MOTIONS: Readonly<Record<PetMotion, MotionSpec>> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'run-right': { row: 1, durations: Array<number>(8).fill(100) },
  'run-left': { row: 2, durations: Array<number>(8).fill(100) },
  wave: { row: 3, durations: Array<number>(4).fill(160) },
  jump: { row: 4, durations: Array<number>(5).fill(140) },
  failed: { row: 5, durations: Array<number>(8).fill(160) },
  waiting: { row: 6, durations: Array<number>(6).fill(180) },
  working: { row: 7, durations: Array<number>(6).fill(160) },
  review: { row: 8, durations: Array<number>(6).fill(160) },
  // Column 3 of the idle row is the closed-eye rest pose.
  sleep: { row: 0, durations: [4_000], fixed: 3 },
}

/** Milliseconds per frame for user-imported horizontal strips. */
export const CUSTOM_FRAME_MS = 220

/** Rows that hold the sixteen gaze directions. */
const GAZE_FIRST_ROW = 9

/**
 * Resolve the mood to the row the bundled character should play.
 * @param mood - the live orchestration mood.
 * @returns one action animation.
 */
export function motionForMood(mood: PetMood): PetMotion {
  switch (mood) {
    case 'connecting': return 'waiting'
    case 'working': return 'working'
    case 'attention': return 'waiting'
    case 'done': return 'jump'
    case 'error': return 'failed'
    case 'sleeping': return 'sleep'
    case 'idle': return 'idle'
  }
}

/**
 * Pick the cell for one motion at a given elapsed time.
 * @param motion - the animation to play.
 * @param elapsed - milliseconds since the motion started.
 * @param reduced - freeze on the first cell instead of cycling.
 * @returns the row and column of the sheet.
 */
export function frameAt(motion: PetMotion, elapsed: number, reduced = false): PetFrame {
  const spec = MOTIONS[motion]
  const cycle = spec.durations.reduce((total, duration) => total + duration, 0)
  if (spec.fixed !== undefined) return { row: spec.row, column: spec.fixed }
  if (cycle <= 0 || reduced) return { row: spec.row, column: 0 }
  let remaining = Math.max(0, elapsed) % cycle
  let column = 0
  while (column < spec.durations.length - 1) {
    const duration = spec.durations[column] ?? 0
    if (remaining < duration) break
    remaining -= duration
    column += 1
  }
  return { row: spec.row, column }
}

/**
 * Map a pointer offset to one of the sixteen gaze cells.
 * @param look - pointer offset from the character's face.
 * @returns a row/column in rows 9–10, or undefined when the pointer is too close.
 */
export function gazeFrame(look: PetLook): PetFrame | undefined {
  const { dx, dy } = look
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 24) return undefined
  const direction = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) / 22.5) % 16
  return {
    row: GAZE_FIRST_ROW + Math.floor(direction / 8),
    column: direction % 8,
  }
}
