/** Pressure measurement boundaries, route invalidation and decision deduplication. */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import {
  DEFAULT_HANDOFF_RATIO,
  estimatePressureBudget,
  PressureMonitor,
} from '../src/pressure.ts'
import type { PressureObservation, PressureObservationResult } from '../src/pressure.ts'
import type { RunRecord, TaskSpec } from '../src/types.ts'
import { FakeTokenMeter } from './fake-token-meter.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'

/** A task with the required fields, overridable per case. */
function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Pressure task',
    prompt: 'Work',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: DEFAULT_HANDOFF_RATIO,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 20,
      maxHandoffTokens: 4096,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

/** A stored run with the required fields, overridable per case. */
function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunId(id),
    taskId: TaskId('task-1'),
    attempt: 1,
    state: 'running',
    sessionLineage: [],
    generation: 0,
    workspaceKey: 'workspace-1:/work/one',
    revision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** One frozen user message with the given text. */
function message(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** A detached Session whose latest context names one route. */
function liveSession(
  id: string,
  provider = 'provider-a',
  model = 'model-a',
  contextWindow?: number,
): Session {
  const session = Session.create(SessionId(id))
  session.append('request/context', {
    provider,
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  })
  return session
}

/** Open the host gate so settings.paused does not mask pressure gates. */
async function unpause(h: Harness): Promise<void> {
  const settings = h.store.getSettings()
  await h.store.updateSettings(settings.revision, {
    ...settings,
    paused: false,
    revision: settings.revision + 1,
    updatedAt: 2_000,
  })
}

/** Observe with the gate facts these cases hold fixed. */
function observe(
  monitor: PressureMonitor,
  runId: string,
  session: Session,
  bodies: PressureObservation['bodies'],
): Promise<PressureObservationResult> {
  return monitor.observe({
    runId: RunId(runId),
    session,
    turnClosed: true,
    ...(bodies === undefined ? {} : { bodies }),
  })
}

describe('pressure threshold boundaries', () => {
  it('does not trigger at 87.99%, triggers at 88% and 88.01%', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      const bodies = { structuredBrief: [message('brief')] }

      const cases = [
        { id: 'run-low', total: 8_799, decision: 'no-handoff', blockedBy: 'below-threshold', ratio: 0.8799 },
        { id: 'run-edge', total: 8_800, decision: 'handoff-pending', blockedBy: undefined, ratio: 0.88 },
        { id: 'run-high', total: 8_801, decision: 'handoff-pending', blockedBy: undefined, ratio: 0.8801 },
      ] as const
      for (const entry of cases) {
        await h.store.createRun(run(entry.id))
        const session = liveSession(`${entry.id}-session`, 'provider-a', 'model-a', 10_000)
        meter.setReading(entry.total, 'estimated')
        const result = await observe(monitor, entry.id, session, bodies)
        expect(result.decision).toBe(entry.decision)
        expect(result.blockedBy).toBe(entry.blockedBy)
        expect(result.snapshot?.ratio).toBeCloseTo(entry.ratio, 10)
        expect(result.snapshot?.totalTokens).toBe(entry.total)
        expect(result.snapshot?.threshold).toBe(DEFAULT_HANDOFF_RATIO)
        expect(result.recorded).toBe(true)
      }
    } finally {
      await h.close()
    }
  })
})

describe('baseline and trigger configurability', () => {
  it('records estimated and usage baselines and lets usage trigger', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })

      await h.store.createRun(run('run-estimated'))
      meter.setReading(9_000, 'estimated')
      const estimated = await observe(
        monitor,
        'run-estimated',
        liveSession('session-estimated', 'provider-a', 'model-a', 10_000),
        { structuredBrief: [message('brief')] },
      )
      expect(estimated.decision).toBe('handoff-pending')
      expect(estimated.snapshot?.baselineKind).toBe('estimated')

      await h.store.createRun(run('run-usage'))
      meter.setReading(9_000, 'usage')
      const usage = await observe(
        monitor,
        'run-usage',
        liveSession('session-usage', 'provider-a', 'model-a', 10_000),
        { structuredBrief: [message('brief')] },
      )
      expect(usage.decision).toBe('handoff-pending')
      expect(usage.snapshot?.baselineKind).toBe('usage')
    } finally {
      await h.close()
    }
  })

  it('observe-only records an estimated reading without triggering; usage may trigger', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({
        store: h.store,
        tokenMeter: meter,
        now: () => 1_000,
        estimatedMode: 'observe-only',
      })
      await h.store.createRun(run('run-observe-only'))
      const session = liveSession('session-observe-only', 'provider-a', 'model-a', 10_000)

      meter.setReading(9_000, 'estimated')
      const estimated = await observe(monitor, 'run-observe-only', session, {
        structuredBrief: [message('brief')],
      })
      expect(estimated.decision).toBe('no-handoff')
      expect(estimated.blockedBy).toBe('handoff-disabled')
      expect(estimated.observeOnly).toBe(true)

      meter.setReading(9_000, 'usage')
      session.append('request/context', { provider: 'provider-a', model: 'model-a', contextWindow: 10_000 })
      const usage = await observe(monitor, 'run-observe-only', session, {
        structuredBrief: [message('brief')],
      })
      expect(usage.decision).toBe('handoff-pending')
      expect(usage.observeOnly).toBe(false)
      expect(usage.snapshot?.baselineKind).toBe('usage')
    } finally {
      await h.close()
    }
  })
})

describe('route changes and compaction', () => {
  it('invalidates a pending route when the model changes', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-route'))
      const session = liveSession('session-route', 'provider-a', 'model-a', 10_000)
      const bodies = { structuredBrief: [message('brief')] }

      meter.setReading(9_000, 'estimated')
      const first = await observe(monitor, 'run-route', session, bodies)
      expect(first.decision).toBe('handoff-pending')
      expect(first.snapshot?.ratio).toBeCloseTo(0.9, 10)
      const firstFingerprint = first.snapshot?.routeFingerprint

      session.append('request/context', {
        provider: 'provider-a',
        model: 'model-b',
        contextWindow: 200_000,
      })
      const second = await observe(monitor, 'run-route', session, bodies)
      expect(second.decision).toBe('no-handoff')
      expect(second.blockedBy).toBe('below-threshold')
      expect(second.recorded).toBe(true)
      expect(second.snapshot?.model).toBe('model-b')
      expect(second.snapshot?.contextWindow).toBe(200_000)
      expect(second.snapshot?.ratio).toBeCloseTo(0.045, 10)
      expect(second.snapshot?.routeFingerprint).not.toBe(firstFingerprint)
    } finally {
      await h.close()
    }
  })

  it('replaces a pending decision when compaction lowers pressure', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-compact'))
      const session = liveSession('session-compact', 'provider-a', 'model-a', 10_000)
      const bodies = { structuredBrief: [message('brief')] }

      meter.setReading(9_000, 'estimated')
      const before = await observe(monitor, 'run-compact', session, bodies)
      expect(before.decision).toBe('handoff-pending')

      session.append('request/context', { provider: 'provider-a', model: 'model-a', contextWindow: 10_000 })
      meter.setReading(4_000, 'estimated')
      const after = await observe(monitor, 'run-compact', session, bodies)
      expect(after.decision).toBe('no-handoff')
      expect(after.blockedBy).toBe('below-threshold')
      expect(after.recorded).toBe(true)
      expect(after.snapshot?.totalTokens).toBe(4_000)
      expect(h.store.getRun(RunId('run-compact'))?.pressure?.decision).toBe('no-handoff')
    } finally {
      await h.close()
    }
  })
})

describe('missing capacity and streaming deduplication', () => {
  it('does not trigger when the latest context has no capacity', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-unknown-window'))
      const session = liveSession('session-unknown-window', 'provider-a', 'model-a')
      meter.setReading(9_000, 'estimated')

      const result = await observe(monitor, 'run-unknown-window', session, {
        structuredBrief: [message('brief')],
      })
      expect(result.decision).toBe('no-handoff')
      expect(result.blockedBy).toBe('context-window-unknown')
      expect(result.recorded).toBe(true)
      expect(result.snapshot?.contextWindow).toBeUndefined()
      expect(result.snapshot?.ratio).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('writes one pending decision for repeated and streaming observations', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-stream'))
      const session = liveSession('session-stream', 'provider-a', 'model-a', 10_000)
      const bodies = { structuredBrief: [message('brief')] }
      meter.setReading(9_000, 'estimated')

      const first = await observe(monitor, 'run-stream', session, bodies)
      expect(first.decision).toBe('handoff-pending')
      expect(first.recorded).toBe(true)
      expect(meter.measureCalls).toHaveLength(1)

      const duplicate = await observe(monitor, 'run-stream', session, bodies)
      expect(duplicate.decision).toBe('handoff-pending')
      expect(duplicate.recorded).toBe(false)
      expect(meter.measureCalls).toHaveLength(1)
      expect(h.store.getRun(RunId('run-stream'))?.revision).toBe(1)

      session.append('request/context', { provider: 'provider-a', model: 'model-a', contextWindow: 10_000 })
      const streamed = await observe(monitor, 'run-stream', session, bodies)
      expect(streamed.decision).toBe('handoff-pending')
      expect(streamed.recorded).toBe(false)
      expect(meter.measureCalls).toHaveLength(2)
      expect(h.store.getRun(RunId('run-stream'))?.revision).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('cooldown, generation and pause gates', () => {
  it('waits for a completed turn in an advanced generation', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task())
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-child', {
        generation: 1,
        sessionLineage: [SessionId('parent'), SessionId('child')],
        activeSessionId: SessionId('child'),
      }))
      const session = liveSession('child', 'provider-a', 'model-a', 10_000)
      const bodies = { structuredBrief: [message('brief')] }
      meter.setReading(9_000, 'estimated')

      const cooling = await observe(monitor, 'run-child', session, bodies)
      expect(cooling.decision).toBe('no-handoff')
      expect(cooling.blockedBy).toBe('empty-generation')
      expect(cooling.recorded).toBe(true)

      const current = h.store.getRun(RunId('run-child'))
      expect(current).toBeDefined()
      await h.store.updateRun(RunId('run-child'), current?.revision ?? 0, {
        ...(current as RunRecord),
        acceptedTurnEndSeq: 21,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: 1_100,
      })
      const ready = await observe(monitor, 'run-child', session, bodies)
      expect(ready.decision).toBe('handoff-pending')
      expect(ready.recorded).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('blocks at the generation cap and while paused', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task({
        handoff: {
          enabled: true,
          ratio: DEFAULT_HANDOFF_RATIO,
          mode: 'structured-brief',
          boundary: 'completed-turn',
          maxGenerations: 1,
          maxHandoffTokens: 4096,
        },
      }))
      await unpause(h)
      const meter = new FakeTokenMeter()
      meter.setEstimator(() => 1)
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-cap', {
        generation: 1,
        sessionLineage: [SessionId('parent'), SessionId('child')],
        acceptedTurnEndSeq: 9,
      }))
      meter.setReading(9_000, 'estimated')
      const capped = await observe(
        monitor,
        'run-cap',
        liveSession('session-cap', 'provider-a', 'model-a', 10_000),
        { structuredBrief: [message('brief')] },
      )
      expect(capped.decision).toBe('no-handoff')
      expect(capped.blockedBy).toBe('generation-exhausted')

      const settings = h.store.getSettings()
      await h.store.updateSettings(settings.revision, {
        ...settings,
        paused: true,
        revision: settings.revision + 1,
        updatedAt: 2_000,
      })
      await h.store.createRun(run('run-paused'))
      const paused = await observe(
        monitor,
        'run-paused',
        liveSession('session-paused', 'provider-a', 'model-a', 10_000),
        { structuredBrief: [message('brief')] },
      )
      expect(paused.decision).toBe('no-handoff')
      expect(paused.blockedBy).toBe('paused')
    } finally {
      await h.close()
    }
  })
})

describe('handoff body budgets', () => {
  it('triggers through the structured brief when the verbatim turn exceeds the cap', async () => {
    const h = await harness()
    try {
      await h.store.createTask(task({
        handoff: {
          enabled: true,
          ratio: DEFAULT_HANDOFF_RATIO,
          mode: 'last-complete-turn',
          boundary: 'completed-turn',
          maxGenerations: 20,
          maxHandoffTokens: 450,
        },
      }))
      await unpause(h)
      const meter = new FakeTokenMeter()
      const monitor = new PressureMonitor({ store: h.store, tokenMeter: meter, now: () => 1_000 })
      await h.store.createRun(run('run-fallback'))
      meter.setReading(9_000, 'usage')

      const result = await observe(
        monitor,
        'run-fallback',
        liveSession('session-fallback', 'provider-a', 'model-a', 10_000),
        {
          structuredBrief: [message('brief')],
          lastCompleteTurn: [message('a'.repeat(450)), message('b'.repeat(50))],
        },
      )
      expect(result.decision).toBe('handoff-pending')
      expect(result.budget?.selected.mode).toBe('structured-brief')
      expect(result.budget?.lastCompleteTurn?.withinMax).toBe(false)
      expect(result.budget?.fallback?.reason).toBe('max-handoff-tokens')
      expect(result.snapshot?.decision).toBe('handoff-pending')
    } finally {
      await h.close()
    }
  })

  it('prices structured-brief and last-complete-turn with separate reserves', () => {
    const meter = new FakeTokenMeter()
    const brief = message('brief')
    const lastTurn = [message('a'.repeat(450)), message('b'.repeat(50))]
    const options = {
      structuredBriefReserveTokens: 64,
      lastCompleteTurnReserveTokens: 0,
      maxTokens: 450,
    }

    const fallback = estimatePressureBudget(
      'last-complete-turn',
      { structuredBrief: [brief], lastCompleteTurn: lastTurn },
      meter,
      options,
    )
    expect(fallback).toBeDefined()
    expect(fallback?.structuredBrief?.bodyTokens).toBe(5)
    expect(fallback?.structuredBrief?.reserveTokens).toBe(64)
    expect(fallback?.structuredBrief?.totalTokens).toBe(69)
    expect(fallback?.lastCompleteTurn?.bodyTokens).toBe(500)
    expect(fallback?.lastCompleteTurn?.reserveTokens).toBe(0)
    expect(fallback?.lastCompleteTurn?.withinMax).toBe(false)
    expect(fallback?.selected.mode).toBe('structured-brief')
    expect(fallback?.fallback).toEqual({
      from: 'last-complete-turn',
      to: 'structured-brief',
      reason: 'max-handoff-tokens',
    })

    const verbatim = estimatePressureBudget(
      'last-complete-turn',
      { structuredBrief: [brief], lastCompleteTurn: lastTurn },
      meter,
      { ...options, maxTokens: 600 },
    )
    expect(verbatim?.selected.mode).toBe('last-complete-turn')
    expect(verbatim?.selected.totalTokens).toBe(500)
    expect(verbatim?.fallback).toBeUndefined()
  })

  it('does not price a body mode that was not supplied', () => {
    const meter = new FakeTokenMeter()
    expect(estimatePressureBudget(
      'structured-brief',
      { lastCompleteTurn: [message('turn')] },
      meter,
      { structuredBriefReserveTokens: 64, lastCompleteTurnReserveTokens: 0, maxTokens: 4096 },
    )).toBeUndefined()
    expect(estimatePressureBudget(
      'last-complete-turn',
      { structuredBrief: [message('brief')] },
      meter,
      { structuredBriefReserveTokens: 64, lastCompleteTurnReserveTokens: 0, maxTokens: 4096 },
    )).toBeUndefined()
  })
})
