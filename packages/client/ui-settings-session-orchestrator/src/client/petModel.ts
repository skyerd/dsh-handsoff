/**
 * Read-only projection of the live orchestration snapshot for the butler fish.
 *
 * The pet never owns scheduling state: it turns queues, tasks and their latest
 * run attempts into one mood plus one short progress sentence. Keeping the
 * derivation pure makes the sprite, the in-page bubble and the desktop overlay
 * agree on what the fish is saying.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/petModel
 */

import type { RunDto, TaskSummaryDto } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import type { OrchestratorLiveState } from './service.ts'
import type { StudioState } from './studioStore.ts'
import { studioText } from './studioStore.ts'

/** Visual state of the butler fish. */
export type PetMood =
  | 'connecting'
  | 'idle'
  | 'working'
  | 'attention'
  | 'done'
  | 'error'
  | 'sleeping'

/** Bubble colour family. */
export type PetTone = 'info' | 'success' | 'warning' | 'danger'

/** Counts the bubble and the progress bar read. */
export interface PetProgress {
  /** Enabled tasks in the snapshot. */
  readonly total: number
  /** Tasks whose latest attempt succeeded. */
  readonly done: number
  /** Tasks whose latest attempt is starting, running or handing off. */
  readonly running: number
  /** Tasks whose latest attempt needs a human decision. */
  readonly attention: number
  /** Tasks whose latest attempt failed. */
  readonly failed: number
  /** Queues the scheduler currently dispatches. */
  readonly queuesRunning: number
  /** All queues in the snapshot. */
  readonly queuesTotal: number
  /** `done / total`, or 0 before any task exists. */
  readonly ratio: number
}

/** Which kind of trouble the worried face is reporting. */
export type PetFailure = 'connection' | 'task'

/** Everything the pet surfaces for one snapshot. */
export interface PetSnapshot {
  readonly mood: PetMood
  readonly tone: PetTone
  readonly progress: PetProgress
  readonly failure?: PetFailure
}

/** Run states that still occupy a worker. */
const ACTIVE_RUN_STATES: ReadonlySet<RunDto['state']> = new Set([
  'starting',
  'running',
  'handoff-pending',
  'handing-off',
])

/** Run states that count as delivered work. */
const SUCCESS_RUN_STATES: ReadonlySet<RunDto['state']> = new Set(['succeeded'])

/** How long a finished pipeline keeps celebrating, in milliseconds. */
const DONE_CELEBRATION_MS = 10 * 60 * 1000

/** How long a failed attempt keeps the worried face, in milliseconds. */
const FAILURE_WINDOW_MS = 10 * 60 * 1000

/** Latest attempt per task, preferring the higher attempt then the newer write. */
function latestRunsByTask(runs: readonly RunDto[]): Map<string, RunDto> {
  const latest = new Map<string, RunDto>()
  for (const run of runs) {
    const previous = latest.get(run.taskId)
    if (
      previous === undefined
      || run.attempt > previous.attempt
      || (run.attempt === previous.attempt && run.updatedAt >= previous.updatedAt)
    ) {
      latest.set(run.taskId, run)
    }
  }
  return latest
}

/** Newest `updatedAt` across a run map. */
function lastRunActivity(runs: ReadonlyMap<string, RunDto>): number {
  let newest = 0
  for (const run of runs.values()) {
    if (run.updatedAt > newest) newest = run.updatedAt
  }
  return newest
}

/**
 * Reduce one live snapshot to the pet's counts.
 * @param live - the current orchestration snapshot.
 * @returns enabled-task and queue counts, plus the completion ratio.
 */
export function petProgressOf(live: OrchestratorLiveState): PetProgress {
  const tasks: readonly TaskSummaryDto[] = live.tasks.filter(task => task.enabled)
  const latest = latestRunsByTask(live.runs)
  let done = 0
  let running = 0
  let attention = 0
  let failed = 0
  for (const task of tasks) {
    const run = latest.get(task.id)
    if (run === undefined) continue
    if (SUCCESS_RUN_STATES.has(run.state)) done += 1
    else if (ACTIVE_RUN_STATES.has(run.state)) running += 1
    else if (run.state === 'needs-attention') attention += 1
    else if (run.state === 'failed') failed += 1
  }
  const queuesRunning = live.queues.filter(queue => queue.state === 'running').length
  return {
    total: tasks.length,
    done,
    running,
    attention,
    failed,
    queuesRunning,
    queuesTotal: live.queues.length,
    ratio: tasks.length === 0 ? 0 : done / tasks.length,
  }
}

/**
 * Pick the one face the fish should wear right now.
 * @param live - the current orchestration snapshot.
 * @param now - wall clock used for the short done/error windows.
 * @returns mood and bubble tone.
 */
export function petMoodOf(live: OrchestratorLiveState, now: number): PetSnapshot['mood'] {
  if (live.phase === 'connecting') return 'connecting'
  if (live.phase === 'error') return 'error'

  const progress = petProgressOf(live)
  if (progress.attention > 0) return 'attention'

  const latest = latestRunsByTask(live.runs)
  const activityAt = lastRunActivity(latest)
  if (progress.failed > 0 && now - activityAt <= FAILURE_WINDOW_MS) return 'error'
  if (progress.running > 0 || progress.queuesRunning > 0) return 'working'
  if (progress.total > 0 && progress.done === progress.total) {
    if (activityAt > 0 && now - activityAt <= DONE_CELEBRATION_MS) return 'done'
    return 'idle'
  }

  const hour = new Date(now).getHours()
  if (progress.total === 0 && (hour < 6 || hour >= 23)) return 'sleeping'
  return 'idle'
}

/** Tone that matches each mood. */
export function petToneOf(mood: PetMood): PetTone {
  switch (mood) {
    case 'attention': return 'warning'
    case 'error': return 'danger'
    case 'done': return 'success'
    case 'connecting':
    case 'idle':
    case 'working':
    case 'sleeping':
      return 'info'
  }
}

/**
 * Build the whole derived pet view.
 * @param live - the current orchestration snapshot.
 * @param now - wall clock used for the short done/error windows.
 * @returns mood, tone and progress.
 */
export function petSnapshotOf(live: OrchestratorLiveState, now: number = Date.now()): PetSnapshot {
  const mood = petMoodOf(live, now)
  const snapshot: PetSnapshot = { mood, tone: petToneOf(mood), progress: petProgressOf(live) }
  if (mood !== 'error') return snapshot
  return { ...snapshot, failure: live.phase === 'error' ? 'connection' : 'task' }
}

/**
 * One short sentence the fish says about the project.
 * @param pet - derived snapshots from {@link petSnapshotOf}.
 * @param t - the page's dictionary function.
 * @returns localized bubble copy.
 */
export function petSpeech(pet: PetSnapshot, t: OrchestratorTranslate): string {
  const { progress } = pet
  switch (pet.mood) {
    case 'connecting':
      return t('petBubbleConnecting')
    case 'error':
      return pet.failure === 'connection'
        ? t('petBubbleError')
        : t('petBubbleFailed', { count: progress.failed })
    case 'attention':
      return t('petBubbleAttention', { count: progress.attention })
    case 'working':
      return t('petBubbleWorking', {
        running: progress.running,
        queues: progress.queuesRunning,
        done: progress.done,
        total: progress.total,
      })
    case 'done':
      return t('petBubbleDone', { total: progress.total })
    case 'sleeping':
      return t('petBubbleSleeping')
    case 'idle':
      return progress.total === 0
        ? t('petBubbleEmpty')
        : t('petBubbleIdle', { done: progress.done, total: progress.total })
  }
}

/**
 * The compact second line shown under the bubble.
 * @param pet - derived snapshots from {@link petSnapshotOf}.
 * @param t - the page's dictionary function.
 * @param notices - front-end reminders currently armed.
 * @returns localized detail, or `undefined` when there is nothing useful to add.
 */
export function petDetail(pet: PetSnapshot, t: OrchestratorTranslate, notices = 0): string | undefined {
  const { progress } = pet
  if (progress.total === 0) {
    return notices > 0 ? t('petReminderDetail', { count: notices }) : undefined
  }
  const counts = {
    done: progress.done,
    total: progress.total,
    running: progress.running,
    queues: progress.queuesRunning,
  }
  return notices > 0
    ? t('petProgressDetailNotices', { ...counts, count: notices })
    : t('petProgressDetail', counts)
}

/**
 * The line the AI currently wants to say in the shared chat bubble.
 *
 * The butler conversation and proactive notices are front-end owned, so the
 * bubble can speak them both inside the settings page and out on the desktop.
 * When the butler has not spoken yet, the caller falls back to the progress
 * sentence from {@link petSpeech}; the progress bar and detail line still
 * report the live queue state either way.
 * @param studio - local butler conversation and reminders.
 * @param t - the page's dictionary function.
 * @returns the newest butler line, the newest reminder body, or undefined.
 */
export function petChatLine(
  studio: Pick<StudioState, 'messages' | 'notices'>,
  t: OrchestratorTranslate,
): string | undefined {
  let latest: StudioState['messages'][number] | undefined
  for (let index = studio.messages.length - 1; index >= 0; index -= 1) {
    const message = studio.messages[index]
    if (message !== undefined && message.role === 'butler' && message.at > 0) {
      latest = message
      break
    }
  }
  const notice = studio.notices[0]
  // A newer reminder outranks an older reply, so the bubble always carries the
  // most recent thing the AI wanted the user to know.
  if (notice !== undefined && (latest === undefined || notice.at >= latest.at)) {
    return studioText(notice.body, t)
  }
  if (latest !== undefined) return studioText(latest.text, t)
  if (notice !== undefined) return studioText(notice.body, t)
  return undefined
}
