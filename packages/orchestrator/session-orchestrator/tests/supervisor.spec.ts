/** RunSupervisor: convergence, attribution, failure boundaries and teardown ordering. */
import { describe, expect, it } from 'vitest'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import { RunHandleTable, RunSupervisor } from '../src/supervisor.ts'
import type { RunSettlement, RunStartRequest, RunSupervisorOptions, SupervisorWorkspaces } from '../src/supervisor.ts'
import type { OperationRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { event, FakeAgents, FakeDurability, humanMessage, otherOperationMessage } from './fake-agent.ts'
import type { FakeAgent } from './fake-agent.ts'
import { FakeLiveSessions } from './recovery-fakes.ts'

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Supervised task',
    prompt: 'Produce the result',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'fixed', provider: 'mock', model: 'mock-model' },
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

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunId('run-1'),
    taskId: TaskId('task-1'),
    attempt: 1,
    state: 'ready',
    sessionLineage: [],
    generation: 0,
    workspaceKey: 'workspace-1:/work/one',
    revision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** In-memory Workspace registry that records the sessions it accepts. */
class FakeWorkspaces implements SupervisorWorkspaces {
  readonly attached: SessionId[] = []
  attachError: Error | undefined

  constructor(private readonly paths: Readonly<Record<string, string>>) {}

  get(id: string) {
    const path = this.paths[id]
    if (path === undefined) return undefined
    return {
      path,
      attachSession: async (sessionId: SessionId): Promise<void> => {
        if (this.attachError !== undefined) throw this.attachError
        this.attached.push(sessionId)
      },
    }
  }
}

function operationRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {  return {
    id: OperationId('operation-1'),
    runId: RunId('run-1'),
    generation: 0,
    attempt: 1,
    kind: 'initial-prompt',
    phase: 'planned',
    requestHash: 'hash-a',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

interface Fixture {
  readonly h: Harness
  readonly task: TaskSpec
  readonly run: RunRecord
  readonly operation: OperationRecord
  readonly agents: FakeAgents
  readonly flush: FakeDurability
  readonly live: FakeLiveSessions
  readonly supervisor: RunSupervisor
  readonly request: RunStartRequest
  readonly close: () => Promise<void>
}

/** Compose a real store with fake agents/session and a controllable flush port. */
async function fixture(options: {
  operationPhase?: OperationRecord['phase']
  supervisor?: Partial<RunSupervisorOptions>
} = {}): Promise<Fixture> {
  const h = await harness()
  const spec = task()
  await h.store.createTask(spec)
  const base = runRecord()
  await h.store.createRun(base)
  const operation = operationRecord()
  await h.store.planOperation(operation)
  const run = await h.store.updateRun(base.id, 0, {
    ...base,
    state: 'starting',
    operationId: operation.id,
    revision: 1,
    updatedAt: 1_001,
  })
  let storedOperation = operation
  if (options.operationPhase !== undefined && options.operationPhase !== 'planned') {
    storedOperation = await h.store.advanceOperation(operation.id, 'planned', {
      ...operation,
      phase: options.operationPhase,
      ...(options.operationPhase === 'session-created'
        ? { targetSessionId: SessionId('session-run-1-0') }
        : {}),
      updatedAt: 1_001,
    })
  }
  const agents = new FakeAgents(h.ctx)
  const flush = new FakeDurability()
  const live = new FakeLiveSessions()
  const supervisor = new RunSupervisor({
    ctx: h.ctx,
    store: h.store,
    sessions: flush,
    liveSessions: live,
    agents,
    now: () => 2_000,
    ...options.supervisor,
  })
  return {
    h,
    task: spec,
    run,
    operation: storedOperation,
    agents,
    flush,
    live,
    supervisor,
    request: { run, task: spec, operationId: operation.id },
    close: async () => {
      // A failed assertion must not leave a fake agent parked on whenIdle():
      // close is not allowed to force-kill runs, so release the fake first.
      for (const agent of agents.created) agent.releaseIdle()
      await supervisor.close()
      await h.close()
    },
  }
}

/** Start one run and park it at the fake agent's first idle wait. */
async function begin(f: Fixture): Promise<{ promise: Promise<RunSettlement>; agent: FakeAgent; prompt: Awaited<ReturnType<FakeAgent['waitForFollowup']>> }> {
  const promise = f.supervisor.start(f.request)
  const agent = await f.agents.waitForCreate()
  const prompt = await agent.waitForFollowup()
  await agent.waitForIdleWait()
  return { promise, agent, prompt }
}

function emit(agent: FakeAgent, ...events: SessionEvent[]): void {
  for (const entry of events) agent.emit(entry)
}

function started(turn: number, seq: number): SessionEvent[] {
  return [event('turn/start', seq, { turn })]
}

function completed(turn: number, seq: number): SessionEvent[] {
  return [event('turn/end', seq, { turn, reason: { kind: 'completed' } })]
}

function userMessage(seq: number, message: Parameters<FakeAgent['followup']>[0]): SessionEvent[] {
  return [event('user/message', seq, message)]
}

describe('RunSupervisor workspace binding', () => {
  it('creates the session in the registered workspace and attaches it', async () => {
    const workspaces = new FakeWorkspaces({ 'workspace-1': '/canonical/workspace' })
    const f = await fixture({ supervisor: { workspaces } })
    try {
      const { agent } = await begin(f)
      expect(f.agents.createOptions[0]?.meta).toMatchObject({ cwd: '/canonical/workspace' })
      expect(workspaces.attached).toEqual([agent.session.id])
    } finally {
      await f.close()
    }
  })

  it('refuses to create a session when the task workspace no longer exists', async () => {
    const workspaces = new FakeWorkspaces({})
    const f = await fixture({ supervisor: { workspaces } })
    try {
      await expect(f.supervisor.start(f.request)).rejects.toMatchObject({ code: 'not-found' })
      expect(f.agents.created).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('disposes the created agent when the workspace refuses the attachment', async () => {
    const workspaces = new FakeWorkspaces({ 'workspace-1': '/canonical/workspace' })
    workspaces.attachError = new Error('cwd mismatch')
    const f = await fixture({ supervisor: { workspaces } })
    try {
      await expect(f.supervisor.start(f.request)).rejects.toMatchObject({ code: 'invalid-transition' })
      expect(f.agents.created).toHaveLength(1)
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })
})

describe('RunSupervisor success boundary', () => {
  it('claims the prompt, accepts only a run-owned completed turn, flushes and settles succeeded', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      expect(prompt.source).toMatchObject({
        kind: 'session-orchestrator',
        operationId: f.operation.id,
        runId: f.run.id,
        generation: 0,
        attempt: 1,
      })
      expect(f.h.store.getOperation(f.operation.id)).toMatchObject({
        phase: 'submitted',
        messageId: prompt.id,
        targetSessionId: agent.session.id,
      })
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()

      const settlement = await promise
      expect(settlement).toMatchObject({
        state: 'succeeded',
        reason: 'completed',
        committed: true,
        sessionId: agent.session.id,
        turns: 1,
        acceptedTurnEndSeq: 2,
        duplicates: 0,
        flushParticipated: true,
        disposeError: undefined,
      })
      expect(f.h.store.getRun(f.run.id)).toMatchObject({
        state: 'succeeded',
        revision: 2,
        acceptedTurnEndSeq: 2,
        claimedTurn: 1,
        operationId: f.operation.id,
      })
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('claimed')
      expect(f.flush.calls).toBe(1)
      expect(f.flush.sessions[0]).toBe(agent.session)
      expect(f.supervisor.ownershipOf(f.run.id)).toBe('observed')
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('accepts an N-step turn and multiple owned turns without attributing unrelated turns', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      emit(
        agent,
        ...started(1, 0),
        ...userMessage(1, prompt),
        event('step/start', 2, { turn: 1, step: 1 }),
        event('step/end', 3, { turn: 1, step: 1 }),
        event('step/start', 4, { turn: 1, step: 2 }),
        event('step/end', 5, { turn: 1, step: 2 }),
        ...completed(1, 6),
      )
      // A turn claimed by another operation is not this run's completion.
      emit(
        agent,
        ...started(2, 7),
        ...userMessage(8, otherOperationMessage('operation-other', 'not mine')),
        ...completed(2, 9),
      )
      agent.releaseIdle()

      const settlement = await promise
      expect(settlement).toMatchObject({
        state: 'succeeded',
        turns: 1,
        acceptedTurnEndSeq: 6,
      })
    } finally {
      await f.close()
    }
  })
})

describe('RunSupervisor non-completion', () => {
  it('does not treat one idle as completion when no owned turn was claimed', async () => {
    const f = await fixture()
    try {
      const { promise, agent } = await begin(f)
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'failed', reason: 'turn-missing', turns: 0 })
      expect(f.h.store.getRun(f.run.id)).toMatchObject({ state: 'failed', revision: 2 })
      expect(f.flush.calls).toBe(0)
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('re-converges while a second owned turn is still queued instead of succeeding on the first idle', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      const queued = { ...prompt, id: prompt.id }
      // A distinct message with the same run-owned source waits in the inbox.
      const second = otherOperationMessage('operation-1', 'second run-owned turn')
      agent.enqueue(second)

      emit(agent, ...started(1, 0), ...userMessage(1, queued), ...completed(1, 2))
      agent.releaseIdle()
      await agent.waitForIdleWait()
      expect(f.h.store.getRun(f.run.id)?.state).toBe('starting')

      agent.inbox.remove(second.id)
      emit(agent, ...started(2, 3), ...userMessage(4, second), ...completed(2, 5))
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'succeeded', turns: 2, acceptedTurnEndSeq: 5 })
    } finally {
      await f.close()
    }
  })

  it('waits for delayed maintenance before deciding completion', async () => {
    const f = await fixture()
    try {
      const { promise, agent } = await begin(f)
      const releaseMaintenance = agent.holdMaintenance()
      agent.releaseIdle()
      await agent.waitForMaintenanceStart()
      expect(f.h.store.getRun(f.run.id)?.state).toBe('starting')

      releaseMaintenance()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'failed', reason: 'turn-missing' })
    } finally {
      await f.close()
    }
  })

  it('treats human input as external input and leaves it pending', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      const human = humanMessage('take over')
      agent.enqueue(human)
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'needs-attention', reason: 'external-input' })
      expect(f.h.store.getRun(f.run.id)?.state).toBe('needs-attention')
      expect(agent.inbox.nextTurn).toContain(human)
      expect(f.agents.disposeCalls).toBe(0)
    } finally {
      await f.close()
    }
  })

  it('stops at an unanswered approval without disposing the live agent', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      emit(
        agent,
        ...started(1, 0),
        ...userMessage(1, prompt),
        event('approval/asked', 2, { id: ApprovalRequestId('approval-1'), toolName: 'write' }),
      )
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'needs-attention', reason: 'awaiting-approval' })
      expect(f.agents.disposeCalls).toBe(0)
      await f.supervisor.close()
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('maps terminal turn reasons to failed settlements', async () => {
    const reasons = [
      { reason: { kind: 'error' as const, error: { message: 'boom', code: 'UNKNOWN' } }, expected: 'turn-error' },
      { reason: { kind: 'aborted' as const, reason: { kind: 'user' as const } }, expected: 'turn-aborted' },
      { reason: { kind: 'blocked' as const }, expected: 'turn-blocked' },
    ]
    for (const entry of reasons) {
      const f = await fixture()
      try {
        const { promise, agent, prompt } = await begin(f)
        emit(
          agent,
          ...started(1, 0),
          ...userMessage(1, prompt),
          event('turn/end', 2, { turn: 1, reason: entry.reason }),
        )
        agent.releaseIdle()
        const settlement = await promise
        expect(settlement).toMatchObject({ state: 'failed', reason: entry.expected, turns: 1 })
        expect(f.agents.disposeCalls).toBe(1)
      } finally {
        await f.close()
      }
    }
  })

  it('cancels without replaying the submitted prompt', async () => {
    const f = await fixture()
    try {
      const { promise, agent } = await begin(f)
      expect(f.supervisor.cancel(f.run.id)).toBe(true)
      expect(agent.cancels).toHaveLength(1)
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'cancelled', reason: 'cancelled' })
      expect(f.h.store.getRun(f.run.id)?.state).toBe('cancelled')
      expect(agent.followups).toHaveLength(1)
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })
})

describe('RunSupervisor durability, dedupe and teardown', () => {
  it('deduplicates repeated turn/end events and writes one terminal revision', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      emit(
        agent,
        ...started(1, 0),
        ...userMessage(1, prompt),
        ...completed(1, 2),
        ...completed(1, 3),
        ...completed(1, 3),
      )
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'succeeded', turns: 1, duplicates: 2 })
      expect(f.h.store.getRun(f.run.id)).toMatchObject({ state: 'succeeded', revision: 2 })
    } finally {
      await f.close()
    }
  })

  it('waits for a delayed flush before settling and reports participation', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      const releaseFlush = f.flush.hold()
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      await f.flush.waitForFlush()
      expect(f.h.store.getRun(f.run.id)?.state).toBe('starting')

      releaseFlush()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'succeeded', flushParticipated: true })
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('keeps the live handle and the run un-unlocked when flush fails', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      f.flush.failure = new Error('disk full')
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({
        state: 'needs-attention',
        reason: 'flush-failed',
        detail: 'disk full',
        acceptedTurnEndSeq: 2,
      })
      expect(f.h.store.getRun(f.run.id)).toMatchObject({
        state: 'needs-attention',
        acceptedTurnEndSeq: 2,
      })
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('claimed')
      expect(f.agents.disposeCalls).toBe(0)
      expect(f.supervisor.ownershipOf(f.run.id)).toBe('owned')

      await f.supervisor.close()
      expect(f.agents.disposeCalls).toBe(1)
      expect(f.supervisor.ownershipOf(f.run.id)).toBe('observed')
    } finally {
      await f.close()
    }
  })

  it('settles succeeded only after a delayed dispose completes', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      const releaseDispose = f.agents.holdDispose()
      let settled = false
      promise.then(() => {
        settled = true
      })
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      await f.agents.waitForDisposeStart()
      await Promise.resolve()
      // The terminal state is committed, but the start promise is still waiting
      // on the in-flight dispose and this process owns no table entry meanwhile.
      expect(f.h.store.getRun(f.run.id)?.state).toBe('succeeded')
      expect(settled).toBe(false)
      expect(f.supervisor.ownershipOf(f.run.id)).toBe('observed')

      releaseDispose()
      await promise
      expect(settled).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('reports a dispose failure without reopening the committed run', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      f.agents.disposeMode = 'fail'
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      const settlement = await promise
      expect(settlement).toMatchObject({ state: 'succeeded', disposeError: 'dispose failed' })
      expect(f.h.store.getRun(f.run.id)).toMatchObject({ state: 'succeeded', revision: 2 })
      expect(f.supervisor.ownershipOf(f.run.id)).toBe('observed')
    } finally {
      await f.close()
    }
  })

  it('refuses new runs after close and waits for the in-flight settlement', async () => {
    const f = await fixture()
    try {
      const { promise, agent, prompt } = await begin(f)
      const closing = f.supervisor.close()
      await expect(f.supervisor.start(f.request)).rejects.toMatchObject({ code: 'closed' })

      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      await closing
      expect(await promise).toMatchObject({ state: 'succeeded' })
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })
})

describe('RunSupervisor restart boundaries', () => {
  for (const phase of ['submitted', 'claimed', 'uncertain'] as const) {
    it(`marks a persisted '${phase}' operation uncertain without creating or replaying`, async () => {
      const f = await fixture({ operationPhase: phase })
      try {
        const settlement = await f.supervisor.start(f.request)
        expect(settlement).toMatchObject({ state: 'needs-attention', reason: 'restart-uncertain' })
        expect(f.agents.createOptions).toHaveLength(0)
        expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('uncertain')
        expect(f.h.store.getRun(f.run.id)?.state).toBe('needs-attention')
      } finally {
        await f.close()
      }
    })
  }

  it('resumes a persisted session-created operation once when no live session exists', async () => {
    const f = await fixture({ operationPhase: 'session-created' })
    try {
      await f.h.ctx.plugin(SessionStore)
      const { promise, agent, prompt } = await begin(f)
      expect(agent.session.id).toBe(SessionId('session-run-1-0'))
      expect(f.agents.createOptions[0]?.sessionId).toBe(SessionId('session-run-1-0'))
      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()
      expect(await promise).toMatchObject({ state: 'succeeded', turns: 1 })
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('claimed')
      expect(agent.followups).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('does not replay a session-created operation while its target session is live', async () => {
    const f = await fixture({ operationPhase: 'session-created' })
    try {
      await f.h.ctx.plugin(SessionStore)
      f.live.put(f.h.ctx.sessions.create(SessionId('session-run-1-0')))
      const settlement = await f.supervisor.start(f.request)
      expect(settlement).toMatchObject({ state: 'needs-attention', reason: 'restart-uncertain' })
      expect(f.agents.createOptions).toHaveLength(0)
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('uncertain')
    } finally {
      await f.close()
    }
  })

  it('returns the stored settlement for a terminal run without creating an agent', async () => {
    const f = await fixture()
    try {
      const terminal = await f.h.store.updateRun(f.run.id, 1, {
        ...f.run,
        state: 'succeeded',
        revision: 2,
        acceptedTurnEndSeq: 9,
      })
      const settlement = await f.supervisor.start({ ...f.request, run: terminal })
      expect(settlement).toMatchObject({
        state: 'succeeded',
        reason: 'completed',
        committed: false,
        acceptedTurnEndSeq: 9,
        turns: 0,
      })
      expect(f.agents.createOptions).toHaveLength(0)
    } finally {
      await f.close()
    }
  })
})

describe('RunSupervisor scheduler launch', () => {
  it('returns once the Session exists and settles the run in the background', async () => {
    const f = await fixture()
    try {
      const launched = await f.supervisor.launch(f.request)
      expect(launched).toMatchObject({
        runId: f.run.id,
        sessionId: SessionId('session-run-1-0'),
      })
      expect(f.agents.created).toHaveLength(1)
      const agent = f.agents.created[0]!
      const prompt = await agent.waitForFollowup()
      await agent.waitForIdleWait()
      expect(f.h.store.getOperation(f.operation.id)).toMatchObject({
        phase: 'submitted',
        messageId: prompt.id,
        targetSessionId: agent.session.id,
      })

      emit(agent, ...started(1, 0), ...userMessage(1, prompt), ...completed(1, 2))
      agent.releaseIdle()

      expect(await launched.settlement).toMatchObject({
        state: 'succeeded',
        reason: 'completed',
        committed: true,
        sessionId: agent.session.id,
      })
      expect(f.h.store.getRun(f.run.id)?.state).toBe('succeeded')
      expect(f.agents.created).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('refuses a submitted operation without creating a Session or replaying it', async () => {
    const f = await fixture({ operationPhase: 'submitted' })
    try {
      await expect(f.supervisor.launch(f.request)).rejects.toThrow(/never replays/)
      expect(f.agents.created).toHaveLength(0)
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('submitted')
    } finally {
      await f.close()
    }
  })

  it('commits needs-attention when a Session exists but its durable claim was lost', async () => {
    const f = await fixture()
    try {
      const advance = f.h.store.advanceOperation.bind(f.h.store)
      f.h.store.advanceOperation = async (id, expected, next) => {
        if (next.phase === 'session-created') throw new Error('session-created write lost')
        return await advance(id, expected, next)
      }

      const launched = await f.supervisor.launch(f.request)
      const settlement = await launched.settlement
      expect(settlement).toMatchObject({
        state: 'needs-attention',
        reason: 'restart-uncertain',
        sessionId: launched.sessionId,
        detail: 'session-created write lost',
      })
      expect(f.h.store.getRun(f.run.id)?.state).toBe('needs-attention')
      expect(f.h.store.getOperation(f.operation.id)?.phase).toBe('planned')
      expect(f.agents.created).toHaveLength(1)
      expect(f.agents.created[0]!.followups).toHaveLength(0)
      expect(f.agents.disposeCalls).toBe(1)
    } finally {
      await f.close()
    }
  })
})

describe('RunHandleTable ownership', () => {
  it('owns only held handles and derives observed after take', async () => {
    const f = await fixture()
    try {
      const created = await f.agents.create({
        sessionId: SessionId('session-table'),
        meta: { cwd: '/work/one' },
        agentOptions: {},
      })
      const table = new RunHandleTable()
      expect(table.ownership(f.run.id)).toBe('observed')
      table.hold({ runId: f.run.id, sessionId: created.agent.session.id, operationId: f.operation.id, handle: created })
      expect(table.ownership(f.run.id)).toBe('owned')
      const taken = table.take(f.run.id)
      expect(taken?.handle).toBe(created)
      expect(table.ownership(f.run.id)).toBe('observed')
      expect(f.agents.disposeCalls).toBe(0)
    } finally {
      await f.close()
    }
  })
})
