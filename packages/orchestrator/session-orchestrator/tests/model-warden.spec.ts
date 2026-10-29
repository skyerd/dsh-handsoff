/**
 * Opt-in model warden: the review contract and its runtime fallbacks.
 *
 * The suite proves four separate promises:
 *
 * - the default rule mode spends no tokens and records no review rows;
 * - a model review is one bounded, strict-JSON call that names its paying route;
 * - a review that times out or answers off-contract falls back to the local
 *   rules and records `warden-error` in the ledger;
 * - a review never blocks the tick, the cooldown and the budget bound its cost,
 *   and the local safety gates are never downgraded by a model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import type { LocalSessionOrchestrator } from '../src/local.ts'
import type { ModelReviewer, WardenReview } from '../src/model-warden.ts'
import {
  MAX_WARDEN_REASON_CHARS,
  ModelWarden,
  WARDEN_REVIEW_SYSTEM_PROMPT,
  WardenReviewError,
  createModelWarden,
} from '../src/model-warden.ts'
import { SessionOrchestratorRuntime } from '../src/runtime.ts'
import type { RuntimeOptions } from '../src/runtime.ts'
import type { RunHandle, RunSupervisor as Supervisor } from '../src/supervisor.ts'
import type { RunRecord, TaskSpec, WardenAuditRecord } from '../src/types.ts'
import type { WardenPacket } from '../src/warden.ts'
import {
  interventionId,
  isHardGateVerdict,
  protectHardGate,
} from '../src/warden.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { runFixture, taskFixture } from './recovery-fakes.ts'
import { event } from './fake-agent.ts'

const SESSION = SessionId('session-warden')
const RUN = RunId('run-warden-1')
const TASK = TaskId('task-warden')
const QUEUE = QueueId('queue-warden')

/** One packet with every field the review contract reads. */
function packet(overrides: Partial<WardenPacket['health']> = {}): WardenPacket {
  return {
    queue: { brief: '把需求拆成可执行的块', state: 'running' },
    task: { title: '实现登录', prompt: '实现登录表单', generation: 0 },
    health: {
      idleMs: 1_000,
      elapsedMs: 60_000,
      turnOpen: true,
      ceiling: 0.6,
      idleLimitMs: 1_200_000,
      hitRateWarn: 0.9,
      hitRateAbort: 0.5,
      ...overrides,
    },
    recent: [],
    children: [],
  }
}

/** Chunks that assemble one complete text answer. */
function answer(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...usage === undefined ? [] : [{ type: 'usage', usage } as StreamChunk],
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A scripted LLM port that yields one answer and journals its requests. */
function scriptedPort(chunks: readonly StreamChunk[]): {
  stream: (options: unknown) => AsyncIterable<StreamChunk>
  requests: unknown[]
} {
  const requests: unknown[] = []
  return {
    requests,
    stream: (options: unknown): AsyncIterable<StreamChunk> => {
      requests.push(options)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** A port that never answers until its request is aborted. */
function hangingPort(): { stream: (options: unknown) => AsyncIterable<StreamChunk>; requests: unknown[] } {
  const requests: unknown[] = []
  return {
    requests,
    stream: (raw: unknown): AsyncIterable<StreamChunk> => {
      const options = raw as { signal?: AbortSignal }
      requests.push(options)
      return (async function* () {
        await new Promise<void>((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new Error('aborted by the warden deadline'))
          }, { once: true })
        })
      })()
    },
  }
}

/** One configured model warden over a scripted port. */
function warden(port: { stream: (options: unknown) => AsyncIterable<StreamChunk> }): ModelWarden {
  return new ModelWarden(
    port as unknown as ConstructorParameters<typeof ModelWarden>[0],
    { provider: 'reviewer', model: 'reviewer-small' },
    { timeoutMs: 100, maxOutputTokens: 256, maxPacketBytes: 8_000 },
    () => 5_000,
  )
}

describe('model review contract', () => {
  it('answers one strict verdict and reports the route and the tokens it spent', async () => {
    const port = scriptedPort(answer('{"verdict":"decompose","reason":"the remaining work is broad"}', {
      inputTokens: 900,
      outputTokens: 12,
      cacheReadTokens: 100,
    }))
    const review = await warden(port).review(packet())
    expect(review.decision).toEqual({ verdict: 'decompose', reason: 'the remaining work is broad' })
    expect(review.provider).toBe('reviewer')
    expect(review.model).toBe('reviewer-small')
    expect(review.inputTokens).toBe(1_000)
    expect(review.outputTokens).toBe(12)
    expect(review.latencyMs).toBe(0)
    const request = port.requests[0] as {
      system: string
      maxTokens: number
      messages: { content: { text: string }[] }[]
    }
    expect(request.system).toBe(WARDEN_REVIEW_SYSTEM_PROMPT)
    expect(request.maxTokens).toBe(256)
    expect(request.messages[0]?.content[0]?.text).toContain('"ceiling":0.6')
  })

  it('accepts one JSON code fence', async () => {
    const review = await warden(scriptedPort(answer('```json\n{"verdict":"continue","reason":"healthy"}\n```')))
      .review(packet())
    expect(review.decision.verdict).toBe('continue')
  })

  it('rejects an answer that adds a field the contract does not allow', async () => {
    const failing = warden(scriptedPort(answer('{"verdict":"continue","reason":"healthy","tasks":[]}')))
    await expect(failing.review(packet())).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('rejects prose instead of JSON, empty text and a tool request', async () => {
    await expect(warden(scriptedPort(answer('continue, all good'))).review(packet()))
      .rejects.toMatchObject({ code: 'invalid-output' })
    await expect(warden(scriptedPort(answer('   '))).review(packet()))
      .rejects.toMatchObject({ code: 'invalid-output' })
    const toolCall: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as never, name: 'bash', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    await expect(warden(scriptedPort(toolCall)).review(packet()))
      .rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('maps a provider failure to unavailable and an output cap to invalid-output', async () => {
    const failed: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'RATE_LIMIT' } } },
    ]
    await expect(warden(scriptedPort(failed)).review(packet()))
      .rejects.toMatchObject({ code: 'unavailable' })
    const capped: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '{"verdict":' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]
    await expect(warden(scriptedPort(capped)).review(packet()))
      .rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('aborts a review that outlives its deadline', async () => {
    const port = hangingPort()
    const started = Date.now()
    await expect(warden(port).review(packet())).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses an oversized packet without calling the route', async () => {
    const port = scriptedPort(answer('{"verdict":"continue","reason":"healthy"}'))
    const large = packet()
    const oversized: WardenPacket = { ...large, task: { ...large.task, prompt: 'x'.repeat(9_000) } }
    await expect(warden(port).review(oversized)).rejects.toMatchObject({ code: 'packet-too-large' })
    expect(port.requests).toEqual([])
  })

  it('refuses a review setup whose host mounted no LLM service', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(() => createModelWarden(ctx, { provider: 'p', model: 'm' }, {
      timeoutMs: 1_000,
      maxOutputTokens: 100,
      maxPacketBytes: 1_000,
    })).toThrow(/llm service/u)
  })

  it('caps the reason sentence in the contract', () => {
    expect(MAX_WARDEN_REASON_CHARS).toBeGreaterThan(0)
    expect(WARDEN_REVIEW_SYSTEM_PROMPT).toContain(`maxLength`)
  })
})

describe('safety floor', () => {
  it('never lets a model downgrade the context ceiling or the abort line', () => {
    expect(isHardGateVerdict('decompose')).toBe(true)
    expect(isHardGateVerdict('abort-all')).toBe(true)
    expect(isHardGateVerdict('refine')).toBe(false)
    expect(protectHardGate(
      { verdict: 'decompose', reason: 'context' },
      { verdict: 'continue', reason: 'looks fine' },
    ).verdict).toBe('decompose')
    expect(protectHardGate(
      { verdict: 'continue', reason: 'quiet' },
      { verdict: 'refine', reason: 'split it' },
    ).verdict).toBe('refine')
  })
})

/** Runtime config used by the ledger cases. */
function config(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    tickIntervalMs: 5_000,
    contextCeiling: 0.6,
    idleMs: 20 * 60 * 1000,
    hitRateWarn: 0.9,
    hitRateAbort: 0.5,
    minRateSamples: 3,
    pingGraceMs: 5 * 60 * 1000,
    interventionTimeoutMs: 15 * 60 * 1000,
    maxTasks: 8,
    maxDepth: 3,
    maxPromptChars: 2_000,
    healthWriteMs: 15_000,
    interventionRecoveryAttempts: 3,
    autoStart: false,
    wardenMode: 'rule',
    wardenCooldownMs: 60_000,
    wardenMaxReviewsPerRun: 20,
    wardenTimeoutMs: 45_000,
    wardenMaxOutputTokens: 400,
    wardenMaxPacketBytes: 8_000,
    wardenAuditLimit: 20,
    hostWorkBuddyCli: '',
    hostTraeCli: '',
    ...overrides,
  }
}

/** One mounted runtime over a real store and a scripted reviewer. */
interface Mounted {
  readonly h: Harness
  readonly runtime: SessionOrchestratorRuntime
  readonly reviews: WardenPacket[]
  readonly clock: { value: number }
  readonly reviewer: {
    review: (packet: WardenPacket) => Promise<WardenReview>
  }
}

/** Seed one running attempt and mount the runtime on it. */
async function mount(options: {
  readonly config?: Partial<RuntimeOptions>
  readonly reply?: (packet: WardenPacket) => Promise<WardenReview>
} = {}): Promise<Mounted> {
  const h = await harness()
  await unpause(h)
  const queue = {
    id: QUEUE,
    title: 'Warden queue',
    taskOrder: [TASK],
    paused: false,
    state: 'running' as const,
    brief: '把所有剩余工作拆成可执行的块',
    revision: 0,
  }
  await h.store.createQueue(queue)
  const task: TaskSpec = taskFixture({
    id: TASK,
    queueId: QUEUE,
    model: { kind: 'fixed', provider: 'worker', model: 'worker-large' },
  })
  await h.store.createTask(task)
  const run: RunRecord = runFixture({
    id: RUN,
    taskId: TASK,
    state: 'running',
    activeSessionId: SESSION,
    sessionLineage: [SESSION],
  })
  await h.store.createRun(run)

  const clock = { value: 1_000 }
  const reviews: WardenPacket[] = []
  const reviewer = {
    review: async (input: WardenPacket): Promise<WardenReview> => {
      reviews.push(input)
      return options.reply === undefined
        ? {
          decision: { verdict: 'continue', reason: 'healthy' },
          provider: 'reviewer',
          model: 'reviewer-small',
          latencyMs: 12,
          inputTokens: 900,
          outputTokens: 8,
        }
        : await options.reply(input)
    },
  }
  h.ctx.provide('sessions', {
    get: () => undefined,
    flush: undefined,
  })
  const runtime = new SessionOrchestratorRuntime({
    ctx: h.ctx,
    store: h.store,
    supervisor: {
      ownedHandles: { get: (): RunHandle | undefined => undefined },
      cancel: (): boolean => false,
      close: async (): Promise<void> => {},
    } as unknown as Supervisor,
    orchestrator: {
      reconcile: async (): Promise<void> => {},
      tick: async () => ({ paused: false, started: [], skipped: [] }),
      close: async (): Promise<void> => {},
    } as unknown as LocalSessionOrchestrator,
    config: config(options.config),
    modelWarden: reviewer as ModelReviewer,
    now: () => clock.value,
  })
  await runtime.start()
  return { h, runtime, reviews, clock, reviewer }
}

const mounted: Mounted[] = []

afterEach(async () => {
  for (const value of mounted.splice(0)) {
    await value.runtime.close()
    await value.h.close()
  }
})

/** Let the detached review callbacks run to completion. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Unpause the host scheduler so the health pass is not skipped. */
async function unpause(h: Harness): Promise<void> {
  const settings = h.store.getSettings()
  await h.store.updateSettings(settings.revision, {
    ...settings,
    paused: false,
    revision: settings.revision + 1,
    updatedAt: 1_000,
  })
}

describe('runtime warden ledger', () => {
  it('records one model review naming the route that paid for it', async () => {
    const m = await mount({
      config: { wardenMode: 'model' },
      reply: async () => ({
        decision: { verdict: 'continue', reason: 'healthy' },
        provider: 'reviewer',
        model: 'reviewer-small',
        latencyMs: 12,
        inputTokens: 900,
        outputTokens: 8,
      }),
    })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    const rows = m.h.store.listWardenAudits()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mode: 'model',
      verdict: 'continue',
      provider: 'reviewer',
      model: 'reviewer-small',
      inputTokens: 900,
      outputTokens: 8,
    })
    expect(m.h.store.listInterventions()).toEqual([])
  })

  it('stays on the local rules in the default mode and records nothing', async () => {
    const m = await mount({
      reply: async () => {
        throw new WardenReviewError('timeout', 'must not be called')
      },
    })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    expect(m.reviews).toEqual([])
    expect(m.h.store.listWardenAudits()).toEqual([])
  })

  it('falls back to the local verdict and records the failure code', async () => {
    const m = await mount({
      config: { wardenMode: 'model' },
      reply: async () => {
        throw new WardenReviewError('invalid-output', 'the review did not answer with one JSON object')
      },
    })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    const rows = m.h.store.listWardenAudits()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ mode: 'rule-fallback', verdict: 'continue', error: 'invalid-output' })
  })

  it('acts on the model verdict, not the rule verdict, below a safety gate', async () => {
    const m = await mount({
      config: { wardenMode: 'model' },
      reply: async () => ({
        decision: { verdict: 'decompose', reason: 'the remaining work is too broad for one task' },
        provider: 'reviewer',
        model: 'reviewer-small',
        latencyMs: 30,
        inputTokens: 700,
        outputTokens: 20,
      }),
    })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    const record = m.h.store.getIntervention(interventionId(RUN, 0, 'pause-context'))
    expect(record?.warden).toMatchObject({ mode: 'model', verdict: 'decompose', provider: 'reviewer' })
    expect(record?.reason).toContain('too broad')
    expect(m.h.store.listWardenAudits()).toHaveLength(1)
  })

  it('holds the cooldown between two reviews of one run', async () => {
    const m = await mount({ config: { wardenMode: 'model', wardenCooldownMs: 60_000 } })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    m.clock.value += 1_000
    await m.runtime.tick()
    await settle()
    expect(m.reviews).toHaveLength(1)
  })

  it('stops reviewing when the run budget is spent and records it once', async () => {
    const m = await mount({ config: { wardenMode: 'model', wardenCooldownMs: 0, wardenMaxReviewsPerRun: 1 } })
    mounted.push(m)
    await m.runtime.tick()
    await settle()
    m.clock.value += 5_000
    await m.runtime.tick()
    await settle()
    expect(m.reviews).toHaveLength(1)
    const rows: readonly WardenAuditRecord[] = m.h.store.listWardenAudits()
    const exhausted = rows.filter(row => row.error === 'budget-exhausted')
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0]?.mode).toBe('rule-fallback')
  })

  it('never blocks the tick while a review is still running', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const m = await mount({
      config: { wardenMode: 'model' },
      reply: async () => {
        await pending
        return {
          decision: { verdict: 'continue', reason: 'healthy' },
          provider: 'reviewer',
          model: 'reviewer-small',
          latencyMs: 1,
        }
      },
    })
    mounted.push(m)
    const started = Date.now()
    await m.runtime.tick()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(m.h.store.listWardenAudits()).toEqual([])
    release()
    await settle()
    expect(m.h.store.listWardenAudits()).toHaveLength(1)
  })

  it('keeps the local context ceiling ahead of any model review', async () => {
    const h = await harness()
    await unpause(h)
    try {
      await h.store.createQueue({
        id: QUEUE,
        title: 'Ceiling queue',
        taskOrder: [TASK],
        paused: false,
        state: 'running',
        revision: 0,
      })
      await h.store.createTask(taskFixture({ id: TASK, queueId: QUEUE }))
      await h.store.createRun(runFixture({
        id: RUN,
        taskId: TASK,
        state: 'running',
        activeSessionId: SESSION,
        sessionLineage: [SESSION],
      }))
      const live = Session.create(SESSION)
      live.append('request/context', { provider: 'worker', model: 'worker-large', contextWindow: 200 })
      h.ctx.provide('sessions', { get: (id: SessionId) => (id === SESSION ? live : undefined) })
      const review = vi.fn()
      const runtime = new SessionOrchestratorRuntime({
        ctx: h.ctx,
        store: h.store,
        supervisor: {
          ownedHandles: { get: (): RunHandle | undefined => undefined },
          cancel: (): boolean => false,
          close: async (): Promise<void> => {},
        } as unknown as Supervisor,
        orchestrator: {
          reconcile: async (): Promise<void> => {},
          tick: async () => ({ paused: false, started: [], skipped: [] }),
          close: async (): Promise<void> => {},
        } as unknown as LocalSessionOrchestrator,
        config: config({ wardenMode: 'model' }),
        modelWarden: { review },
        meter: { measure: () => ({ totalTokens: 120, baseline: { kind: 'usage' } }) },
        now: () => 1_000,
      })
      await runtime.start()
      await runtime.tick()
      await settle()
      expect(review).not.toHaveBeenCalled()
      const record = h.store.getIntervention(interventionId(RUN, 0, 'pause-context'))
      expect(record?.warden).toMatchObject({ mode: 'rule', verdict: 'decompose' })
      expect(record?.paidBy).toEqual({ provider: 'worker', model: 'worker-large' })
      await runtime.close()
    } finally {
      await h.close()
    }
  })
})

/** One assistant message event with usage. */
function assistant(seq: number, usage: TokenUsage): ReturnType<typeof event> {
  return event('assistant/message', seq, {
    turn: 1,
    step: seq,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'working' }],
      source: { provider: 'worker', model: 'worker-large' },
    }),
    stream: [],
    usage,
  })
}

describe('runtime fallback action', () => {
  it('ignores cold-start samples, then aborts every queue on the first usable low hit rate with no model call', async () => {
    const h = await harness()
    await unpause(h)
    try {
      await h.store.createQueue({
        id: QUEUE,
        title: 'Primary queue',
        taskOrder: [TASK],
        paused: false,
        state: 'running',
        revision: 0,
      })
      await h.store.createQueue({
        id: QueueId('queue-second'),
        title: 'Second queue',
        taskOrder: [],
        paused: false,
        state: 'running',
        revision: 0,
      })
      await h.store.createTask(taskFixture({ id: TASK, queueId: QUEUE, workspaceId: 'w', cwd: '/w' }))
      await h.store.createRun(runFixture({
        id: RUN,
        taskId: TASK,
        state: 'running',
        activeSessionId: SESSION,
        sessionLineage: [SESSION],
      }))
      const live = Session.create(SESSION)
      h.ctx.provide('sessions', { get: (id: SessionId) => (id === SESSION ? live : undefined) })
      const review = vi.fn()
      const cancel = vi.fn(() => true)
      const runtime = new SessionOrchestratorRuntime({
        ctx: h.ctx,
        store: h.store,
        supervisor: {
          ownedHandles: { get: (): RunHandle | undefined => undefined },
          cancel,
          close: async (): Promise<void> => {},
        } as unknown as Supervisor,
        orchestrator: {
          reconcile: async (): Promise<void> => {},
          tick: async () => ({ paused: false, started: [], skipped: [] }),
          close: async (): Promise<void> => {},
        } as unknown as LocalSessionOrchestrator,
        config: config({ wardenMode: 'rule', wardenCooldownMs: 0, minRateSamples: 3 }),
        modelWarden: { review },
        now: () => 1_000,
      })
      await runtime.start()
      // Two calls are a cold start: fewer than three usable samples, so the
      // low read is not a rate and must not stop anything.
      h.ctx.emit('session/event', live, assistant(1, { inputTokens: 100, outputTokens: 1 }))
      h.ctx.emit('session/event', live, assistant(2, { inputTokens: 100, outputTokens: 1 }))
      await runtime.tick()
      await settle()
      expect(h.store.listInterventions()).toEqual([])
      expect(h.store.listQueues().every(queue => queue.state === 'running')).toBe(true)

      // The third call is the first usable sample. A zero hit rate is below
      // 50%, so every queue aborts at once; the local hard gate needs neither
      // a confirmation nor a model review.
      h.ctx.emit('session/event', live, assistant(3, { inputTokens: 100, outputTokens: 1 }))
      await runtime.tick()
      await settle()
      const queues = h.store.listQueues()
      expect(queues).toHaveLength(2)
      expect(queues.every(queue => queue.state === 'aborted')).toBe(true)
      expect(cancel).toHaveBeenCalled()
      expect(review).not.toHaveBeenCalled()
      expect(h.store.listWardenAudits()).toEqual([])
      await runtime.close()
    } finally {
      await h.close()
    }
  })

  it('acts on the local refine verdict when the review is unusable', async () => {
    const h = await harness()
    await unpause(h)
    try {
      await h.store.createQueue({
        id: QUEUE,
        title: 'Refine queue',
        taskOrder: [TASK],
        paused: false,
        state: 'running',
        revision: 0,
      })
      await h.store.createTask(taskFixture({ id: TASK, queueId: QUEUE, workspaceId: 'w', cwd: '/w' }))
      await h.store.createRun(runFixture({
        id: RUN,
        taskId: TASK,
        state: 'running',
        activeSessionId: SESSION,
        sessionLineage: [SESSION],
      }))
      const live = Session.create(SESSION)
      h.ctx.provide('sessions', { get: (id: SessionId) => (id === SESSION ? live : undefined) })
      const runtime = new SessionOrchestratorRuntime({
        ctx: h.ctx,
        store: h.store,
        supervisor: {
          ownedHandles: { get: (): RunHandle | undefined => undefined },
          cancel: (): boolean => false,
          close: async (): Promise<void> => {},
        } as unknown as Supervisor,
        orchestrator: {
          reconcile: async (): Promise<void> => {},
          tick: async () => ({ paused: false, started: [], skipped: [] }),
          close: async (): Promise<void> => {},
        } as unknown as LocalSessionOrchestrator,
        config: config({ wardenMode: 'model' }),
        modelWarden: {
          review: async () => {
            throw new WardenReviewError('unavailable', 'provider refused the review')
          },
        },
        now: () => 1_000,
      })
      await runtime.start()
      // Three calls with half the prompt served from cache: rule verdict `refine`.
      h.ctx.emit('session/event', live, assistant(1, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 }))
      h.ctx.emit('session/event', live, assistant(2, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 }))
      h.ctx.emit('session/event', live, assistant(3, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 }))
      await runtime.tick()
      await settle()
      const record = h.store.getIntervention(interventionId(RUN, 0, 'refine'))
      expect(record?.warden).toMatchObject({ mode: 'rule', verdict: 'refine' })
      const rows = h.store.listWardenAudits()
      expect(rows[0]).toMatchObject({ mode: 'rule-fallback', verdict: 'refine', error: 'unavailable' })
      await runtime.close()
    } finally {
      await h.close()
    }
  })
})
