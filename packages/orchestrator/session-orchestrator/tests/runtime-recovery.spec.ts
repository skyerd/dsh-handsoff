/**
 * Runtime restart behaviour for interventions.
 *
 * These cases mount the real runtime over the real store and a fake durable
 * log. They prove the two promises the module-level phase matrix cannot prove
 * on its own:
 *
 * - a restarted host never calls `followup()` for a `prompt-sent` record;
 * - a `planned` record with no durable instruction is sent exactly once.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import type { InterventionRecord, QueueRecord, RunRecord, TaskSpec } from '../src/schema.ts'
import type { RunHandle } from '../src/supervisor.ts'
import { RunSupervisor as Supervisor } from '../src/supervisor.ts'
import type { LocalSessionOrchestrator } from '../src/local.ts'
import { SessionOrchestratorRuntime } from '../src/runtime.ts'
import type { RuntimeOptions } from '../src/runtime.ts'
import { initialPromptOperationId } from '../src/operation.ts'
import { FIXED_DECOMPOSE_PROMPT, interventionId } from '../src/warden.ts'
import type {} from '../src/message-source.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { FakeDurableSessions, runFixture, taskFixture } from './recovery-fakes.ts'
import { event } from './fake-agent.ts'

const NOW = 10_000
const RUN = RunId('run-rr-1')
const PARENT = TaskId('task-rr')
const QUEUE = QueueId('queue-rr')
const SESSION = SessionId('session-run-rr-1-0')
const ANSWER = '1. 剩余接口：请补齐两个接口。\n2. 回归验证：请运行回归测试并汇总结果。'

/** Runtime config used by every case. */
const CONFIG: RuntimeOptions = {
  tickIntervalMs: 5_000,
  contextCeiling: 0.6,
  idleMs: 20 * 60 * 1000,
  hitRateWarn: 0.9,
  hitRateAbort: 0.5,
  minRateSamples: 3,
  pingGraceMs: 5 * 60 * 1000,
  interventionTimeoutMs: 1,
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
}

/** One mounted runtime and its observable handles. */
interface Mounted {
  readonly h: Harness
  readonly durable: FakeDurableSessions
  readonly runtime: SessionOrchestratorRuntime
  readonly record: InterventionRecord
  readonly run: RunRecord
  readonly followups: unknown[]
}

/** Build the instruction message a previous host delivered. */
function instruction(record: InterventionRecord, run: RunRecord): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: FIXED_DECOMPOSE_PROMPT }],
    source: {
      kind: 'session-orchestrator',
      operationId: initialPromptOperationId(run),
      runId: run.id,
      generation: run.generation,
      attempt: run.attempt,
      intervention: record.id,
    },
  })
}

/** A completed instruction turn carrying the decomposition answer. */
function answeredLog(record: InterventionRecord, run: RunRecord): ReturnType<typeof event>[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('user/message', 1, instruction(record, run)),
    event('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: ANSWER }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
      stream: [],
    }),
    event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** An instruction whose turn is still open. */
function openLog(record: InterventionRecord, run: RunRecord): ReturnType<typeof event>[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('user/message', 1, instruction(record, run)),
  ]
}

/** Build the owned handle a restarted supervisor would hold. */
function handle(followups: unknown[]): RunHandle {
  return {
    runId: RUN,
    sessionId: SESSION,
    operationId: OperationId('operation-run-rr-1-0'),
    handle: {
      agent: {
        followup: (message: unknown): void => {
          followups.push(message)
        },
      },
    },
  } as unknown as RunHandle
}

/** Seed one restart picture and mount the runtime over it. */
async function mount(options: {
  readonly phase: InterventionRecord['phase']
  readonly events?: readonly ReturnType<typeof event>[]
  readonly withHandle?: boolean
  readonly runState?: RunRecord['state']
}): Promise<Mounted> {
  const h = await harness()
  const queue: QueueRecord = {
    id: QUEUE,
    title: 'Runtime restart queue',
    taskOrder: [PARENT],
    paused: false,
    state: 'running',
    revision: 0,
  }
  await h.store.createQueue(queue)
  const parent: TaskSpec = taskFixture({
    id: PARENT,
    queueId: QUEUE,
    workspaceId: 'workspace-1',
    cwd: 'C:\\workspace',
  })
  await h.store.createTask(parent)
  const run = runFixture({
    id: RUN,
    taskId: PARENT,
    state: options.runState ?? 'running',
    activeSessionId: SESSION,
    sessionLineage: [SESSION],
    operationId: initialPromptOperationId({ id: RUN, generation: 0 }),
  })
  await h.store.createRun(run)
  const record: InterventionRecord = {
    id: interventionId(RUN, 0, 'pause-context'),
    runId: RUN,
    taskId: PARENT,
    generation: 0,
    kind: 'pause-context',
    trigger: { contextRatio: 0.62 },
    reason: 'context occupancy reached the switch point 60%',
    sessionId: SESSION,
    promptSent: FIXED_DECOMPOSE_PROMPT,
    childTaskIds: [],
    phase: options.phase,
    createdAt: NOW,
    updatedAt: NOW,
  }
  await h.store.recordIntervention(record)

  const durable = new FakeDurableSessions()
  durable.put(SESSION, options.events ?? answeredLog(record, run))

  const followups: unknown[] = []
  const handles = new Map<RunId, RunHandle>()
  if (options.withHandle === true) handles.set(RUN, handle(followups))
  const supervisor = {
    ownedHandles: {
      get: (id: RunId): RunHandle | undefined => handles.get(id),
    },
    cancel: (): boolean => false,
    close: async (): Promise<void> => {},
  } as unknown as Supervisor
  const orchestrator = {
    reconcile: async (): Promise<void> => {},
    tick: async (): Promise<{ paused: boolean; started: []; skipped: [] }> => ({
      paused: false,
      started: [],
      skipped: [],
    }),
    close: async (): Promise<void> => {},
  } as unknown as LocalSessionOrchestrator
  const runtime = new SessionOrchestratorRuntime({
    ctx: {} as unknown as Context,
    store: h.store,
    supervisor,
    orchestrator,
    config: CONFIG,
    durableSessions: durable,
    now: () => Date.now(),
  })
  return { h, durable, runtime, record, run, followups }
}

const mounted: Mounted[] = []

afterEach(async () => {
  for (const value of mounted.splice(0)) {
    await value.runtime.close()
    await value.h.close()
  }
})

describe('runtime restart at prompt-sent', () => {
  it('captures the answer and never sends the instruction again', async () => {
    const m = await mount({ phase: 'prompt-sent', withHandle: true })
    mounted.push(m)
    await m.runtime.recoverInterventions({ countAttempt: true })
    const stored = m.h.store.getIntervention(m.record.id)
    expect(stored?.phase).toBe('settled')
    expect(stored?.producedPrompt).toBe(ANSWER)
    expect(m.followups).toHaveLength(0)
    const children = m.h.store.listTasks().filter(task => task.parentTaskId === PARENT)
    expect(children).toHaveLength(2)
    expect(m.h.store.getRun(RUN)?.state).toBe('deferred')
  })

  it('does not send while the instruction turn is still open', async () => {
    const m = await mount({ phase: 'prompt-sent', withHandle: true })
    mounted.push(m)
    m.durable.put(SESSION, openLog(m.record, m.run))
    await m.runtime.recoverInterventions({ countAttempt: true })
    expect(m.followups).toHaveLength(0)
    expect(m.h.store.getIntervention(m.record.id)?.phase).toBe('prompt-sent')
    expect(m.h.store.listTasks().filter(task => task.parentTaskId === PARENT)).toHaveLength(0)
  })
})

describe('runtime restart at planned', () => {
  it('sends a planned instruction exactly once when no durable message exists', async () => {
    const m = await mount({ phase: 'planned', events: [], withHandle: true })
    mounted.push(m)
    await m.runtime.recoverInterventions({ countAttempt: true })
    expect(m.followups).toHaveLength(1)
    const stored = m.h.store.getIntervention(m.record.id)
    expect(stored?.phase).toBe('prompt-sent')
    expect(stored?.promptSent).toBe(FIXED_DECOMPOSE_PROMPT)
    expect(stored?.sessionId).toBe(SESSION)

    // Let the detached answer wait time out, then model a second restart: the
    // durable `prompt-sent` phase forbids another send.
    await new Promise<void>(resolve => setTimeout(resolve, 1_100))
    await m.runtime.recoverInterventions({ countAttempt: true })
    expect(m.followups).toHaveLength(1)
    expect(m.h.store.getIntervention(m.record.id)?.phase).toBe('prompt-sent')
  })
})
