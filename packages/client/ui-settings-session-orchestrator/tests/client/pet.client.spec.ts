/** The fish's mood and copy are derived from the live snapshot only. */

import { describe, expect, it } from 'vitest'
import { en } from '../../src/client/locales.ts'
import type { OrchestratorTranslate } from '../../src/client/copy.ts'
import type { OrchestratorLiveState } from '../../src/client/service.ts'
import { petDetail, petProgressOf, petSnapshotOf, petSpeech } from '../../src/client/petModel.ts'
import { queue, run, taskSummary } from './fixtures.client.ts'

/** A ready snapshot with nothing recorded. */
function live(overrides: Partial<OrchestratorLiveState> = {}): OrchestratorLiveState {
  return {
    phase: 'ready',
    revision: 1,
    generatedAt: 5_000,
    settings: undefined,
    queues: [],
    tasks: [],
    runs: [],
    handoffs: [],
    interventions: [],
    wardenAudits: [],
    hosts: [],
    models: { phase: 'idle', choices: [] },
    presets: { phase: 'idle', choices: [] },
    ...overrides,
  }
}

/** Interpolate one English dictionary entry for the pure model tests. */
function translate(key: keyof typeof en, params: Record<string, unknown> = {}): string {
  return String(en[key]).replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

const t: OrchestratorTranslate = translate

describe('butler fish model', () => {
  it('counts enabled tasks, queue activity and successful attempts', () => {
    const progress = petProgressOf(live({
      queues: [queue({ state: 'running' }), queue({ id: 'q2', state: 'idle' })],
      tasks: [taskSummary({ id: 't1' }), taskSummary({ id: 't2' }), taskSummary({ id: 't3', enabled: false })],
      runs: [
        run({ taskId: 't1', state: 'succeeded', updatedAt: 4_000 }),
        run({ taskId: 't2', state: 'running', updatedAt: 4_500 }),
      ],
    }))
    expect(progress).toMatchObject({
      total: 2,
      done: 1,
      running: 1,
      queuesRunning: 1,
      queuesTotal: 2,
    })
    expect(progress.ratio).toBe(0.5)
  })

  it('lets a needs-attention task outrank a working one', () => {
    const snapshot = petSnapshotOf(live({
      queues: [queue({ state: 'running' })],
      tasks: [taskSummary({ id: 't1' }), taskSummary({ id: 't2' })],
      runs: [
        run({ taskId: 't1', state: 'running' }),
        run({ taskId: 't2', state: 'needs-attention' }),
      ],
    }), 10_000)
    expect(snapshot.mood).toBe('attention')
    expect(snapshot.tone).toBe('warning')
    expect(petSpeech(snapshot, t)).toBe('1 task(s) need your decision. I paused politely.')
  })

  it('celebrates a fully delivered pipeline inside the recent window', () => {
    const snapshot = petSnapshotOf(live({
      tasks: [taskSummary({ id: 't1' })],
      runs: [run({ taskId: 't1', state: 'succeeded', updatedAt: 9_000 })],
    }), 10_000)
    expect(snapshot.mood).toBe('done')
    expect(petSpeech(snapshot, t)).toBe('All 1 tasks are done. Go enjoy the result.')
  })

  it('reports idle progress and reminder counts in the detail line', () => {
    const snapshot = petSnapshotOf(live({
      tasks: [taskSummary({ id: 't1' }), taskSummary({ id: 't2' })],
      runs: [run({ taskId: 't1', state: 'succeeded', updatedAt: 1_000 })],
    }), 20_000)
    expect(petDetail(snapshot, t, 2)).toBe('1/2 tasks done · 0 running · 2 reminders')
    expect(petDetail(petSnapshotOf(live(), 10), t, 1)).toBe('1 reminder(s) waiting')
  })

  it('shows the connection problem instead of a progress claim', () => {
    const snapshot = petSnapshotOf(live({ phase: 'error' }), 10_000)
    expect(snapshot.mood).toBe('error')
    expect(snapshot.tone).toBe('danger')
    expect(snapshot.failure).toBe('connection')
    expect(petSpeech(snapshot, t)).toBe('The schedule feed dropped. I am retrying; your queues are safe.')
  })

  it('separates a failed task from a lost schedule feed', () => {
    const snapshot = petSnapshotOf(live({
      tasks: [taskSummary({ id: 't1' })],
      runs: [run({ taskId: 't1', state: 'failed', updatedAt: 9_000 })],
    }), 10_000)
    expect(snapshot.mood).toBe('error')
    expect(snapshot.failure).toBe('task')
    expect(petSpeech(snapshot, t)).toBe('1 task(s) failed. The queue is intact; decide whether to retry or skip.')
  })
})
