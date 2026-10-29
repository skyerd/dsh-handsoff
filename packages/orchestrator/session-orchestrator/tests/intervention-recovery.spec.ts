/**
 * Fault injection for intervention restarts.
 *
 * Every case seeds the durable picture a crash leaves behind at one phase and
 * reopens it with a fresh recovery coordinator (a new process). The assertions
 * are the ones the pipeline promises:
 *
 * - a delivered instruction is never sent or recorded twice;
 * - inserted children are never duplicated in the task table or queue order;
 * - an answer already in the log is captured instead of lost;
 * - `failed` appears only for a missing/unreadable session or an exhausted
 *   explicit restart budget, and its `note` names the reason.
 *
 * The cases never call a model and never append a Session event: they only
 * read durable evidence and advance records, exactly like a restarted host.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import type { InterventionRecord, QueueRecord, RunRecord, TaskSpec } from '../src/schema.ts'
import { InterventionRecovery, scanInterventionLog } from '../src/intervention-recovery.ts'
import { initialPromptOperationId } from '../src/operation.ts'
import { FIXED_DECOMPOSE_PROMPT, interventionId } from '../src/warden.ts'
import type {} from '../src/message-source.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { FakeDurableSessions, namedError, runFixture, taskFixture } from './recovery-fakes.ts'
import { event } from './fake-agent.ts'

const NOW = 10_000
const RUN = RunId('run-iv-1')
const PARENT = TaskId('task-iv')
const QUEUE = QueueId('queue-iv')
const SESSION = SessionId('session-run-iv-1-0')
const ANSWER = '1. 检查剩余模块：请检查并修复剩余的两个模块。\n2. 汇总结果：请汇总修复结果并列出验证证据。'

/** One seeded process picture. */
interface Seeded {
  readonly h: Harness
  readonly durable: FakeDurableSessions
  readonly record: InterventionRecord
  readonly run: RunRecord
  readonly parent: TaskSpec
  readonly queue: QueueRecord
}

interface SeedOptions {
  readonly phase?: InterventionRecord['phase']
  readonly kind?: InterventionRecord['kind']
  readonly sessionId?: boolean
  readonly turn?: number
  readonly producedPrompt?: string
  readonly childTaskIds?: readonly string[]
  readonly recoveryAttempts?: number
  readonly events?: readonly SessionEvent[]
  readonly omitSession?: boolean
  readonly failOpen?: Error
  readonly runState?: RunRecord['state']
}

/** Build one valid intervention record for the seeded run. */
function recordFixture(overrides: Partial<InterventionRecord> = {}): InterventionRecord {
  return {
    id: interventionId(RUN, 0, 'pause-context'),
    runId: RUN,
    taskId: PARENT,
    generation: 0,
    kind: 'pause-context',
    trigger: { contextRatio: 0.61 },
    reason: 'context occupancy reached the switch point 60%',
    childTaskIds: [],
    phase: 'planned',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Build the instruction message a previous host sent into the conversation. */
function instruction(record: InterventionRecord, run: RunRecord, text = FIXED_DECOMPOSE_PROMPT): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
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

/** An assistant message carrying one text block. */
function assistant(text: string): ReturnType<typeof createAssistantMessage> {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'fixture', model: 'fixture-model' },
  })
}

/**
 * Build a log whose original task turn closed before the instruction and whose
 * instruction turn carries the given answer.
 */
function answeredLog(
  record: InterventionRecord,
  run: RunRecord,
  answer: string = ANSWER,
): SessionEvent[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('user/message', 1, createUserMessage({
      content: [{ type: 'text', text: 'original task prompt' }],
      source: { kind: 'user' },
    })),
    event('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: assistant('原始任务的回答：目录已空。'),
      stream: [],
    }),
    event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', 4, { turn: 2 }),
    event('user/message', 5, instruction(record, run)),
    event('assistant/message', 6, {
      turn: 2,
      step: 1,
      message: assistant(answer),
      stream: [],
    }),
    event('turn/end', 7, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

/** A log where the instruction turn is still open with no answer yet. */
function openTurnLog(record: InterventionRecord, run: RunRecord): SessionEvent[] {
  return [
    event('turn/start', 4, { turn: 2 }),
    event('user/message', 5, instruction(record, run)),
  ]
}

/** A log where the instruction turn closed without assistant text. */
function closedEmptyLog(record: InterventionRecord, run: RunRecord): SessionEvent[] {
  return [
    event('turn/start', 4, { turn: 2 }),
    event('user/message', 5, instruction(record, run)),
    event('turn/end', 6, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

/** Seed one durable restart picture over the real store. */
async function seed(options: SeedOptions = {}): Promise<Seeded> {
  const h = await harness()
  const queue: QueueRecord = {
    id: QUEUE,
    title: 'Intervention queue',
    taskOrder: [PARENT],
    paused: false,
    state: 'running',
    revision: 0,
  }
  await h.store.createQueue(queue)
  const parent = taskFixture({
    id: PARENT,
    queueId: QUEUE,
    workspaceId: 'workspace-1',
    cwd: 'C:\\workspace',
    stage: 'implement',
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

  const record = recordFixture({
    kind: options.kind ?? 'pause-context',
    phase: options.phase ?? 'planned',
    ...(options.sessionId === false ? {} : { sessionId: SESSION }),
    ...(options.turn === undefined ? {} : { turn: options.turn }),
    ...(options.producedPrompt === undefined ? {} : { producedPrompt: options.producedPrompt }),
    ...(options.childTaskIds === undefined
      ? {}
      : { childTaskIds: options.childTaskIds.map(id => TaskId(id)) }),
    ...(options.recoveryAttempts === undefined ? {} : { recoveryAttempts: options.recoveryAttempts }),
  })
  await h.store.recordIntervention(record)

  const durable = new FakeDurableSessions()
  if (options.omitSession !== true) {
    durable.put(
      SESSION,
      options.events ?? answeredLog(record, run, options.producedPrompt ?? ANSWER),
    )
  }
  if (options.failOpen !== undefined) durable.failOpen(SESSION, options.failOpen)
  return { h, durable, record, run, parent, queue }
}

/** Compose a fresh coordinator, modelling a process restart. */
function coordinator(seeded: Seeded, maxAttempts = 3): InterventionRecovery {
  return new InterventionRecovery({
    store: seeded.h.store,
    durableSessions: seeded.durable,
    now: () => NOW,
    maxAttempts,
  })
}

/** Count instruction messages in one durable log. */
function instructionCount(seeded: Seeded): number {
  const events = seeded.durable.logs.get(SESSION) ?? []
  return events.filter(entry => entry.type === 'user/message'
    && entry.data.source.kind === 'session-orchestrator'
    && entry.data.source.intervention === seeded.record.id).length
}

/** Child tasks currently stored for the seeded parent. */
function children(seeded: Seeded): TaskSpec[] {
  return seeded.h.store.listTasks().filter(task => task.parentTaskId === PARENT)
}

/** Assert the child ids and queue order never contain duplicates. */
function expectPlacedOnce(seeded: Seeded): void {
  const stored = children(seeded)
  const ids = stored.map(task => task.id)
  expect(new Set(ids).size).toBe(ids.length)
  const order = seeded.h.store.getQueue(QUEUE)?.taskOrder ?? []
  expect(new Set(order).size).toBe(order.length)
  expect(order.filter(id => id !== PARENT)).toEqual(ids)
}

const open: Harness[] = []

afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

/** Register a seeded harness for cleanup. */
async function seeded(options: SeedOptions = {}): Promise<Seeded> {
  const value = await seed(options)
  open.push(value.h)
  return value
}

describe('scanning the instruction turn', () => {
  it('captures only the answer of the instruction turn, not the task answer before it', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    const events = s.durable.logs.get(SESSION) ?? []
    const evidence = scanInterventionLog(SESSION, events, {
      interventionId: s.record.id,
      runId: RUN,
    })
    expect(evidence).toBeDefined()
    expect(evidence?.turn).toBe(2)
    expect(evidence?.turnEnded).toBe(true)
    expect(evidence?.answer).toBe(ANSWER)
    expect(evidence?.answer).not.toContain('目录已空')
  })

  it('ignores an instruction that belongs to another run identity', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    const foreign = createUserMessage({
      content: [{ type: 'text', text: FIXED_DECOMPOSE_PROMPT }],
      source: {
        kind: 'session-orchestrator',
        operationId: initialPromptOperationId(s.run),
        runId: RunId('run-other'),
        generation: 0,
        attempt: 1,
        intervention: s.record.id,
      },
    })
    const onlyForeign = scanInterventionLog(
      SESSION,
      [event('user/message', 0, foreign)],
      { interventionId: s.record.id, runId: RUN },
    )
    expect(onlyForeign).toBeUndefined()
  })
})

describe('restart at planned', () => {
  it('reports safe re-entry when no instruction is durable', async () => {
    const s = await seeded({ phase: 'planned', events: [] })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('not-started')
    expect(instructionCount(s)).toBe(0)
    expect(children(s)).toHaveLength(0)
    expect(s.h.store.getIntervention(s.record.id)?.phase).toBe('planned')
  })

  it('adopts an instruction that landed before the phase write was lost', async () => {
    const s = await seeded({ phase: 'planned', kind: 'refine' })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('settled')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.phase).toBe('settled')
    expect(stored?.sessionId).toBe(SESSION)
    expect(stored?.turn).toBe(2)
    expect(stored?.producedPrompt).toBe(ANSWER)
    expect(instructionCount(s)).toBe(1)
    expect(children(s)).toHaveLength(2)
    expectPlacedOnce(s)
  })
})

describe('restart at prompt-sent', () => {
  it('captures the durable answer and inserts children once', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('settled')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.phase).toBe('settled')
    expect(stored?.promptSent).toBe(FIXED_DECOMPOSE_PROMPT)
    expect(stored?.producedPrompt).toBe(ANSWER)
    expect(stored?.turn).toBe(2)
    expect(instructionCount(s)).toBe(1)
    expect(children(s).map(task => task.id)).toEqual([
      'task-task-iv-c1',
      'task-task-iv-c2',
    ])
    expectPlacedOnce(s)
    expect(s.h.store.getRun(RUN)?.state).toBe('deferred')
  })

  it('keeps waiting without resending when the instruction turn is still open', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    s.durable.put(SESSION, openTurnLog(s.record, s.run))
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('awaiting-answer')
    if (step.kind !== 'awaiting-answer') throw new Error('expected awaiting-answer')
    expect(step.turn).toBe(2)
    expect(step.record.phase).toBe('prompt-sent')
    expect(instructionCount(s)).toBe(1)
    expect(children(s)).toHaveLength(0)
  })

  it('fails only after the explicit restart budget when the turn closed without an answer', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    s.durable.put(SESSION, closedEmptyLog(s.record, s.run))
    const first = await coordinator(s, 3).resume(s.record, { countAttempt: true })
    expect(first.kind).toBe('unchanged')
    expect(s.h.store.getIntervention(s.record.id)?.recoveryAttempts).toBe(1)
    expect(s.h.store.getIntervention(s.record.id)?.phase).toBe('prompt-sent')

    const second = await coordinator(s, 3).resume(s.record, { countAttempt: true })
    expect(second.kind).toBe('unchanged')
    const third = await coordinator(s, 3).resume(s.record, { countAttempt: true })
    expect(third.kind).toBe('failed')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.phase).toBe('failed')
    expect(stored?.note).toContain('retry-exhausted')
    expect(stored?.note).toContain('answer-missing')
    expect(children(s)).toHaveLength(0)
  })

  it('does not consume the budget on a same-process poll', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    s.durable.put(SESSION, closedEmptyLog(s.record, s.run))
    for (let poll = 0; poll < 5; poll += 1) {
      const step = await coordinator(s, 2).resume(s.record, { countAttempt: false })
      expect(step.kind).toBe('unchanged')
    }
    expect(s.h.store.getIntervention(s.record.id)?.phase).toBe('prompt-sent')
    expect(s.h.store.getIntervention(s.record.id)?.recoveryAttempts).toBeUndefined()
  })

  it('fails with session-missing when the conversation is gone', async () => {
    const s = await seeded({ phase: 'prompt-sent', omitSession: true })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('failed')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.phase).toBe('failed')
    expect(stored?.note).toContain('session-missing')
    expect(children(s)).toHaveLength(0)
  })

  it('fails with session-unreadable when the log cannot be read', async () => {
    const s = await seeded({
      phase: 'prompt-sent',
      failOpen: namedError('SessionPersistenceCorruptionError', 'corrupt tail'),
    })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('failed')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.phase).toBe('failed')
    expect(stored?.note).toContain('session-unreadable')
    expect(stored?.note).toContain('corrupt tail')
  })

  it('retries a prompt recorded as sent whose message never became durable', async () => {
    const s = await seeded({ phase: 'prompt-sent', events: [] })
    const first = await coordinator(s, 2).resume(s.record, { countAttempt: true })
    expect(first.kind).toBe('unchanged')
    const second = await coordinator(s, 2).resume(s.record, { countAttempt: true })
    expect(second.kind).toBe('failed')
    const stored = s.h.store.getIntervention(s.record.id)
    expect(stored?.note).toContain('retry-exhausted')
    expect(stored?.note).toContain('instruction-missing')
    expect(instructionCount(s)).toBe(0)
  })
})

describe('restart at prompt-captured', () => {
  it('inserts the persisted answer exactly once across two restarts', async () => {
    const s = await seeded({ phase: 'prompt-captured', producedPrompt: ANSWER })
    const first = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(first.kind).toBe('settled')
    expect(children(s)).toHaveLength(2)
    expectPlacedOnce(s)

    const second = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(second.kind).toBe('settled')
    expect(children(s)).toHaveLength(2)
    expectPlacedOnce(s)
    expect(s.h.store.getIntervention(s.record.id)?.childTaskIds).toEqual([
      'task-task-iv-c1',
      'task-task-iv-c2',
    ])
  })

  it('fails an answer that contains no executable task', async () => {
    const s = await seeded({ phase: 'prompt-captured', producedPrompt: '   ' })
    const step = await coordinator(s).resume(s.record, { countAttempt: true })
    expect(step.kind).toBe('failed')
    expect(s.h.store.getIntervention(s.record.id)?.note).toContain('answer-missing')
    expect(children(s)).toHaveLength(0)
  })
})

describe('restart at children-inserted', () => {
  it('reconciles the queue and deferral without creating a second child', async () => {
    const s = await seeded({ phase: 'prompt-sent' })
    await coordinator(s).resume(s.record, { countAttempt: true })
    const inserted = s.h.store.getIntervention(s.record.id)
    if (inserted === undefined) throw new Error('expected an intervention record')
    // Simulate a crash after children were inserted but before the deferral.
    await s.h.store.advanceIntervention(inserted.id, 'settled', {
      ...inserted,
      phase: 'children-inserted',
      updatedAt: NOW,
    })
    const crashedRun = s.h.store.getRun(RUN)
    if (crashedRun === undefined) throw new Error('expected a seeded run')
    await s.h.store.updateRun(RUN, crashedRun.revision, {
      ...crashedRun,
      state: 'running',
      revision: crashedRun.revision + 1,
      updatedAt: NOW,
    })
    const queueBefore = s.h.store.getQueue(QUEUE)
    const step = await coordinator(s).resume(
      s.h.store.getIntervention(s.record.id) as InterventionRecord,
      { countAttempt: true },
    )
    expect(step.kind).toBe('settled')
    expect(children(s)).toHaveLength(2)
    expectPlacedOnce(s)
    expect(s.h.store.getQueue(QUEUE)?.revision).toBe(queueBefore?.revision)
    expect(s.h.store.getRun(RUN)?.state).toBe('deferred')

    const again = await coordinator(s).resume(
      s.h.store.getIntervention(s.record.id) as InterventionRecord,
      { countAttempt: true },
    )
    expect(again.kind).toBe('settled')
    expect(children(s)).toHaveLength(2)
    expectPlacedOnce(s)
  })
})

describe('child insertion idempotence', () => {
  it('returns the same ids and never duplicates tasks or queue entries', async () => {
    const s = await seeded({ phase: 'planned', events: [] })
    const recovery = coordinator(s)
    const items = [
      { title: 'first', prompt: 'do first' },
      { title: 'second', prompt: 'do second' },
    ]
    const first = await recovery.insertChildren(s.parent, s.queue, items)
    const second = await recovery.insertChildren(
      s.parent,
      s.h.store.getQueue(QUEUE) as QueueRecord,
      items,
    )
    expect(first).toEqual(second)
    expect(children(s)).toHaveLength(2)
    expect(s.h.store.getQueue(QUEUE)?.taskOrder).toEqual([
      PARENT,
      'task-task-iv-c1',
      'task-task-iv-c2',
    ])
    for (const child of children(s)) {
      expect(child.model).toEqual(s.parent.model)
      expect(child.stage).toBe(s.parent.stage)
      expect(child.parentTaskId).toBe(s.parent.id)
    }
  })
})
