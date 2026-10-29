import { describe, expect, it } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { QueueId, RunId, TaskId } from '../src/brand.ts'
import {
  HandoffManager,
  handoffBodyHash,
  handoffOperationId,
  handoffTargetSessionId,
  inspectHandoffSession,
} from '../src/handoff.ts'
import type {
  HandoffBackgroundJob,
  HandoffManagerOptions,
  HandoffRuntimeModel,
  HandoffStore,
} from '../src/handoff.ts'
import type { PressureSnapshot } from '../src/types.ts'
import type { RunRecord, TaskSpec } from '../src/types.ts'
import { FakeAgents, FakeDurability } from './fake-agent.ts'
import { FakeTokenMeter } from './fake-token-meter.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'

function taskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Handoff task',
    prompt: 'Produce the final report',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: 0.88,
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

function parentSession(options: {
  id?: string
  preset?: string
  requestHeader?: boolean
  open?: boolean
  toolResult?: boolean
} = {}): Session {
  const id = SessionId(options.id ?? 'parent-session')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1_000,
    cwd: '/work/one',
    isSeeded: false,
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  }
  const session = Session.create(id, undefined, header)
  if (options.requestHeader !== false) {
    session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'mock',
          model: 'model-a',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 2_048,
        },
      },
    })
  }
  session.append('request/context', {
    provider: 'mock',
    model: 'model-a',
    contextWindow: 128_000,
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Please produce the final report.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'I inspected the draft and found one gap.' },
        {
          type: 'tool-call',
          id: ToolCallId('call-1'),
          name: 'read_file',
          arguments: '{"path":"draft.md"}',
        },
      ],
      source: { provider: 'mock', model: 'model-a' },
    }),
  }, { surfaceOp: 'append' })
  if (options.toolResult !== false) {
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'Draft contents are complete.' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn: 1, step: 1 })
  if (options.open !== true) {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return session
}

function pendingPressure(session: Session): PressureSnapshot {
  return {
    sessionId: session.id,
    logRevision: session.seq,
    provider: 'mock',
    model: 'model-a',
    totalTokens: 90_000,
    contextWindow: 128_000,
    ratio: 0.7,
    baselineKind: 'usage',
    threshold: 0.88,
    routeFingerprint: 'route-mock-model-a',
    measuredAt: 1_000,
    decision: 'handoff-pending',
  }
}

function runRecord(parent: Session, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    attempt: 1,
    state: 'running',
    activeSessionId: parent.id,
    sessionLineage: [parent.id],
    generation: 0,
    pressure: pendingPressure(parent),
    workspaceKey: 'workspace-1:/work/one',
    revision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

interface Fixture {
  readonly h: Harness
  readonly task: TaskSpec
  readonly run: RunRecord
  readonly parent: Session
  readonly agents: FakeAgents
  readonly flush: FakeDurability
  readonly meter: FakeTokenMeter
  readonly manager: HandoffManager
}

async function fixture(options: {
  parent?: Session
  task?: Partial<TaskSpec>
  run?: Partial<RunRecord>
  manager?: Partial<HandoffManagerOptions>
} = {}): Promise<Fixture> {
  const h = await harness()
  const parent = options.parent ?? parentSession({ preset: 'preset-inherit' })
  const task = taskSpec(options.task)
  await h.store.createTask(task)
  const run = runRecord(parent, options.run)
  await h.store.createRun(run)
  const agents = new FakeAgents(h.ctx)
  const flush = new FakeDurability()
  const meter = new FakeTokenMeter()
  const managerOptions: HandoffManagerOptions = {
    store: h.store,
    sessions: flush,
    agents,
    tokenMeter: meter,
    now: () => 2_000,
    ...(options.manager ?? {}),
  }
  const manager = new HandoffManager(managerOptions)
  return { h, task, run, parent, agents, flush, meter, manager }
}

describe('HandoffManager structured brief', () => {
  it('creates one fresh successor, freezes route/preset and persists lineage', async () => {
    const f = await fixture()
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: f.parent })

      expect(result.status).toBe('handed-off')
      expect(result.reason).toBe('completed')
      expect(result.mode).toBe('structured-brief')
      expect(f.agents.resumed).toHaveLength(0)
      expect(f.agents.created).toHaveLength(1)

      const target = handoffTargetSessionId(f.run.id, f.run.attempt, 1)
      const operationId = handoffOperationId(f.run.id, f.run.attempt, 1)
      expect(result.childSessionId).toBe(target)
      expect(f.agents.createOptions[0]).toMatchObject({
        sessionId: target,
        meta: {
          cwd: '/work/one',
          parentSession: f.parent.id,
          agentPreset: 'preset-inherit',
        },
      })
      expect(f.agents.createOptions[0]?.meta).not.toHaveProperty('parentAgent')
      expect(f.agents.createOptions[0]?.agentOptions).toMatchObject({
        provider: 'mock',
        model: 'model-a',
        maxTokens: 2_048,
      })

      expect(f.agents.created[0]?.followups).toHaveLength(1)
      const prompt = f.agents.created[0]!.followups[0]!
      expect(prompt.source).toMatchObject({
        kind: 'session-orchestrator',
        operationId,
        runId: f.run.id,
        generation: 1,
        attempt: 1,
        form: 'recall',
      })
      const text = prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''
      expect(text).toContain('[SESSION HANDOFF]')
      expect(text).toContain('原任务：')
      expect(text).toContain('Produce the final report')
      expect(text).toContain(`- 来源 Session: ${f.parent.id}`)
      expect(text).toContain(`- 来源截止 seq: ${f.parent.seq}`)
      expect(text).toContain('read_file (call-1) -> Draft contents are complete.')
      expect(text).toContain('继续要求：')
      expect(text).toContain('不要假设 unknown 项已完成')
      expect(result.bodyHash).toBe(handoffBodyHash(text))

      expect(result.config).toMatchObject({
        route: {
          routeSource: 'completed-turn-header',
          provider: 'mock',
          model: 'model-a',
        },
        preset: { id: 'preset-inherit', source: 'session-header' },
        permissions: { source: 'host-preset', copied: false },
        skills: { source: 'preset', copied: false },
      })

      const handoff = f.h.store.getHandoff(operationId)
      expect(handoff).toMatchObject({
        generation: 1,
        runId: f.run.id,
        sourceSessionId: f.parent.id,
        targetSessionId: target,
        operationId,
        sourceSeq: f.parent.seq,
        bodyHash: result.bodyHash,
        mode: 'structured-brief',
      })
      expect(handoff?.configSnapshot.provider).toBe('mock')

      const run = f.h.store.getRun(f.run.id)!
      expect(run).toMatchObject({
        state: 'running',
        generation: 1,
        activeSessionId: target,
        operationId,
        submittedMessageId: prompt.id,
        revision: 2,
      })
      expect(run.sessionLineage).toEqual([f.parent.id, target])
      expect(run.pressure).toBeUndefined()
      expect(run.acceptedTurnEndSeq).toBeUndefined()

      const operation = f.h.store.getOperation(operationId)!
      expect(operation).toMatchObject({
        kind: 'handoff',
        phase: 'settled',
        sourceSessionId: f.parent.id,
        targetSessionId: target,
        messageId: prompt.id,
      })
      expect(f.flush.sessions.map(session => session.id)).toEqual([
        f.parent.id,
        target,
      ])

      const repeated = await f.manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(repeated.status).toBe('blocked')
      expect(f.agents.created).toHaveLength(1)
    } finally {
      await f.h.close()
    }
  })

  it('turns repeated threshold requests into exactly one child Session', async () => {
    const f = await fixture()
    try {
      const [first, second] = await Promise.all([
        f.manager.handoff({ runId: f.run.id, sourceSession: f.parent }),
        f.manager.handoff({ runId: f.run.id, sourceSession: f.parent }),
      ])
      const statuses = [first.status, second.status]
      expect(statuses).toContain('handed-off')
      expect(statuses.filter(status => status === 'handed-off')).toHaveLength(1)
      expect(f.agents.created).toHaveLength(1)
      expect(f.agents.created[0]?.followups).toHaveLength(1)
      expect(f.h.store.listHandoffs()).toHaveLength(1)
    } finally {
      await f.h.close()
    }
  })

  it('does not hand off an open Turn', async () => {
    const parent = parentSession({ preset: 'preset-inherit', open: true })
    const f = await fixture({ parent })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('blocked')
      expect(result.reason).toBe('turn-not-closed')
      expect(f.agents.created).toHaveLength(0)
      expect(f.flush.calls).toBe(0)
      expect(f.h.store.getRun(f.run.id)?.revision).toBe(0)
    } finally {
      await f.h.close()
    }
  })

  it('does not hand off an interrupted tail after the latest completed Turn', async () => {
    const parent = parentSession({ preset: 'preset-inherit' })
    parent.append('assistant/attempt', { turn: 2, step: 1, stream: [] })
    const f = await fixture({ parent })
    try {
      expect(inspectHandoffSession(parent).boundary).toBe('not-completed')
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('blocked')
      expect(result.reason).toBe('turn-not-completed')
      expect(f.agents.created).toHaveLength(0)
      expect(f.flush.calls).toBe(0)
      expect(f.h.store.getRun(f.run.id)?.revision).toBe(0)
    } finally {
      await f.h.close()
    }
  })
})

describe('HandoffManager last complete Turn', () => {
  it('preserves user/assistant/tool pairing and order in the first message', async () => {
    const f = await fixture({
      task: {
        handoff: {
          ...taskSpec().handoff,
          mode: 'last-complete-turn',
        },
      },
    })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(result.status).toBe('handed-off')
      expect(result.mode).toBe('last-complete-turn')

      const prompt = f.agents.created[0]!.followups[0]!
      const text = prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''
      expect(text).toContain('[SESSION HANDOFF — LAST COMPLETE TURN]')
      expect(text).toContain('[user]')
      expect(text).toContain('[assistant]')
      expect(text).toContain('[tool-call read_file call-1]')
      expect(text).toContain('{"path":"draft.md"}')
      expect(text).toContain('[tool-result call-1]')
      expect(text).toContain('Draft contents are complete.')
      expect(text.indexOf('[tool-call read_file call-1]'))
        .toBeLessThan(text.indexOf('[tool-result call-1]'))

      const facts = inspectHandoffSession(f.parent)
      expect(facts.lastCompleteTurn).toMatchObject({ turn: 1, pairingComplete: true })
      expect(facts.lastCompleteTurn?.tools).toEqual([
        expect.objectContaining({ callId: 'call-1', status: 'settled' }),
      ])
      expect(f.h.store.listHandoffs()[0]?.mode).toBe('last-complete-turn')
    } finally {
      await f.h.close()
    }
  })

  it('reports only settled, running-known or unknown tool state', () => {
    const paired = parentSession({ preset: 'preset-inherit' })
    expect(inspectHandoffSession(paired).lastCompleteTurn?.tools[0]?.status).toBe('settled')

    const missing = parentSession({ preset: 'preset-inherit', toolResult: false })
    expect(inspectHandoffSession(missing).lastCompleteTurn?.tools[0]?.status).toBe('unknown')
    const job: HandoffBackgroundJob = { name: 'read_file', callId: 'call-1' }
    expect(inspectHandoffSession(missing, [job]).lastCompleteTurn?.tools[0]?.status)
      .toBe('running-known')
  })

  it('downgrades a long Turn to the structured brief and records the fallback', async () => {
    const f = await fixture({
      task: {
        handoff: {
          ...taskSpec().handoff,
          mode: 'last-complete-turn',
          maxHandoffTokens: 100,
        },
      },
    })
    try {
      f.meter.setEstimator(message => {
        const block = message.content[0]
        const text = block?.type === 'text' ? block.text : ''
        return text.includes('LAST COMPLETE TURN') ? 500 : 10
      })
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(result.status).toBe('handed-off')
      expect(result.mode).toBe('structured-brief')
      expect(result.budget?.fallback).toEqual({
        from: 'last-complete-turn',
        to: 'structured-brief',
        reason: 'max-handoff-tokens',
      })
      const prompt = f.agents.created[0]!.followups[0]!
      const text = prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''
      expect(text).toContain('[SESSION HANDOFF]')
      expect(text).not.toContain('LAST COMPLETE TURN')
      expect(f.h.store.listHandoffs()[0]?.mode).toBe('structured-brief')
      expect(f.h.store.listHandoffs()[0]?.bodyTokens).toBe(10)
    } finally {
      await f.h.close()
    }
  })
})

describe('HandoffManager failure boundaries', () => {
  it('enters needs-attention with model-unavailable when no durable route exists', async () => {
    const parent = parentSession({
      preset: 'preset-inherit',
      requestHeader: false,
    })
    const f = await fixture({
      parent,
      task: { model: { kind: 'inherit' } },
    })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('needs-attention')
      expect(result.reason).toBe('model-unavailable')
      expect(f.agents.created).toHaveLength(0)
      expect(f.flush.calls).toBe(0)
      const run = f.h.store.getRun(f.run.id)!
      expect(run.state).toBe('needs-attention')
      expect(run.lastError).toMatchObject({ code: 'model-unavailable', retryable: true })
    } finally {
      await f.h.close()
    }
  })

  it('keeps lineage and creates no child when the parent flush fails', async () => {
    const f = await fixture()
    try {
      f.flush.failure = new Error('durable flush failed')
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(result.status).toBe('needs-attention')
      expect(result.reason).toBe('flush-failed')
      expect(f.agents.created).toHaveLength(0)
      expect(f.h.store.listHandoffs()).toHaveLength(0)

      const target = handoffTargetSessionId(f.run.id, f.run.attempt, 1)
      const run = f.h.store.getRun(f.run.id)!
      expect(run.state).toBe('needs-attention')
      expect(run.generation).toBe(1)
      expect(run.sessionLineage).toEqual([f.parent.id, target])
      expect(run.lastError).toMatchObject({ code: 'flush-failed' })
      expect(f.h.store.getOperation(handoffOperationId(f.run.id, f.run.attempt, 1)))
        .toBeUndefined()
    } finally {
      await f.h.close()
    }
  })

  it('never creates a second child after the child was created and the commit crashed', async () => {
    const f = await fixture()
    try {
      let failedOnce = false
      const crashing: HandoffStore = {
        getRun: id => f.h.store.getRun(id),
        getTask: id => f.h.store.getTask(id),
        getOperation: id => f.h.store.getOperation(id),
        getHandoff: id => f.h.store.getHandoff(id),
        planOperation: record => f.h.store.planOperation(record),
        recordHandoff: record => f.h.store.recordHandoff(record),
        updateRun: (id, revision, next) => f.h.store.updateRun(id, revision, next),
        advanceOperation: async (id, phase, next) => {
          if (!failedOnce && phase === 'planned' && next.phase === 'session-created') {
            failedOnce = true
            throw new Error('simulated crash after child creation')
          }
          return f.h.store.advanceOperation(id, phase, next)
        },
      }
      const manager = new HandoffManager({
        store: crashing,
        sessions: f.flush,
        agents: f.agents,
        tokenMeter: f.meter,
        now: () => 2_000,
      })

      const first = await manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(first.status).toBe('needs-attention')
      expect(first.reason).toBe('handoff-uncertain')
      expect(f.agents.created).toHaveLength(1)
      expect(f.agents.created[0]?.followups).toHaveLength(0)

      const operationId = handoffOperationId(f.run.id, f.run.attempt, 1)
      const target = handoffTargetSessionId(f.run.id, f.run.attempt, 1)
      expect(f.h.store.getOperation(operationId)).toMatchObject({
        phase: 'uncertain',
        targetSessionId: target,
      })

      const again = await manager.handoff({ runId: f.run.id, sourceSession: f.parent })
      expect(again.status).toBe('blocked')
      expect(f.agents.created).toHaveLength(1)
      expect(f.agents.created[0]?.followups).toHaveLength(0)
      expect(f.h.store.listHandoffs()).toHaveLength(0)
    } finally {
      await f.h.close()
    }
  })

  it('refuses a successor beyond the task generation cap', async () => {
    const lineage = Array.from(
      { length: 21 },
      (_, generation) => SessionId(`session-run-cap-1-${generation}`),
    )
    const parent = parentSession({ id: lineage[20]!, preset: 'preset-inherit' })
    const f = await fixture({
      parent,
      run: {
        id: RunId('run-cap'),
        generation: 20,
        sessionLineage: lineage,
      },
    })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('blocked')
      expect(result.reason).toBe('generation-exhausted')
      expect(f.agents.created).toHaveLength(0)
      expect(f.h.store.getRun(f.run.id)?.revision).toBe(0)
    } finally {
      await f.h.close()
    }
  })

  it('degrades preset inheritance explicitly instead of fabricating a preset', async () => {
    const parent = parentSession({ requestHeader: true })
    const f = await fixture({
      parent,
      task: {
        preset: { kind: 'inherit' },
        model: { kind: 'fixed', provider: 'mock', model: 'model-a' },
      },
    })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('handed-off')
      expect(result.config?.preset).toEqual({ id: 'host-default', source: 'host-default' })
      expect(result.config?.degradations).toContain('preset-host-default')
      expect(f.agents.createOptions[0]?.meta).not.toHaveProperty('agentPreset')
      expect(f.h.store.listHandoffs()[0]?.configSnapshot.preset).toEqual({ id: 'host-default' })
    } finally {
      await f.h.close()
    }
  })
})

describe('HandoffManager public validation', () => {
  it('uses an explicitly supplied runtime route only as the last fallback', async () => {
    const parent = parentSession({ preset: 'preset-inherit', requestHeader: false })
    const runtime: HandoffRuntimeModel = {
      provider: 'fallback-provider',
      model: 'fallback-model',
    }
    const f = await fixture({
      parent,
      task: { model: { kind: 'inherit' } },
      manager: { currentModel: () => runtime },
    })
    try {
      const result = await f.manager.handoff({ runId: f.run.id, sourceSession: parent })
      expect(result.status).toBe('handed-off')
      expect(result.config?.route).toMatchObject({
        routeSource: 'runtime-fallback',
        provider: 'fallback-provider',
        model: 'fallback-model',
      })
      expect(f.agents.createOptions[0]?.agentOptions).toMatchObject(runtime)
    } finally {
      await f.h.close()
    }
  })
})
