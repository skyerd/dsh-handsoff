/**
 * Recovery reconciliation: identity, scheduler gating, uncertainty, leases,
 * durable-session failures, unload order and handle re-acquisition.
 *
 * Every case drives the real recovery manager over the real domain store; only
 * the durable Session medium, the live directory, the supervisor and the
 * scheduler are doubles, so no model work and no Session write happen here.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { OperationId, RunId } from '../src/brand.ts'
import { RecoveryManager } from '../src/recovery.ts'
import { RunSupervisor } from '../src/supervisor.ts'
import { harness } from './harness.ts'
import { event, FakeAgents, FakeDurability } from './fake-agent.ts'
import {
  completedTurnEvents,
  FakeDurableSessions,
  FakeLiveSessions,
  FakeRecoveryScheduler,
  humanPrompt,
  mismatchedMessage,
  namedError,
  NOW,
  operationFixture,
  promptMessage,
  recoveryCase,
  runningRun,
  sourceFor,
  startingRun,
  taskFixture,
} from './recovery-fakes.ts'
import type { RecoveryReport } from '../src/recovery.ts'

function soleDecision(report: RecoveryReport) {
  expect(report.decisions).toHaveLength(1)
  const [decision] = report.decisions
  if (decision === undefined) throw new Error('expected exactly one recovery decision')
  return decision
}

describe('C-002 operation source, not MessageId, is the reconciliation key', () => {
  it('deduplicates the same durable message identity instead of counting two turns', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'submitted' })
    const message = promptMessage(run, operation)
    const c = await recoveryCase({
      run,
      operation,
      events: [
        event('turn/start', 0, { turn: 1 }),
        event('user/message', 1, message),
        event('user/message', 2, message),
        event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'settled-succeeded',
        reason: 'completed',
        turn: 1,
      })
    } finally {
      await c.close()
    }
  })

  it('does not accept a reused message identity that names another operation', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'submitted' })
    const own = promptMessage(run, operation)
    const reused = freezeMessage({
      ...own,
      source: {
        kind: 'session-orchestrator',
        operationId: OperationId('operation-other'),
        runId: run.id,
        generation: 0,
        attempt: 1,
      },
    })
    const c = await recoveryCase({
      run,
      operation: { ...operation, messageId: own.id },
      events: [
        event('turn/start', 0, { turn: 1 }),
        event('user/message', 1, reused),
        event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'submission-unverified',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('C-003 durable message source must match every identity field', () => {
  it('marks a human-only log with a recorded prompt identity as unverified', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'submitted', messageId: 'message-1' })
    const c = await recoveryCase({
      run,
      operation,
      events: [
        event('turn/start', 0, { turn: 1 }),
        event('user/message', 1, humanPrompt()),
        event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'submission-unverified',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('marks a source with the right operation id but another run id as a mismatch', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'submitted' })
    const c = await recoveryCase({
      run,
      operation,
      events: completedTurnEvents(0, 1, mismatchedMessage(operation.id)),
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'message-source-mismatch',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('marks a source with the right run but another generation as a mismatch', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'session-created' })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'later generation prompt' }],
      source: { ...sourceFor(run, operation), generation: 1 },
    })
    const c = await recoveryCase({
      run,
      operation,
      events: completedTurnEvents(0, 1, message),
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'message-source-mismatch',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('C-004 durable operation identity must match the canonical request', () => {
  it('accepts the canonical operation identity', async () => {
    const run = startingRun()
    const c = await recoveryCase({ run, omitSession: true })
    try {
      const report = await c.recovery.reconcile()
      expect(report.fatal).toBeUndefined()
      expect(soleDecision(report)).toMatchObject({ action: 'rolled-back', reason: 'nothing-created' })
    } finally {
      await c.close()
    }
  })

  it('refuses a different request hash', async () => {
    const run = startingRun()
    const operation = operationFixture(run, { requestHash: 'tampered-hash' })
    const c = await recoveryCase({ run, operation })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'request-hash-mismatch',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses a non-canonical operation id', async () => {
    const run = startingRun()
    const operation = operationFixture(run, { id: OperationId('operation-other') })
    const c = await recoveryCase({ run, operation })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'operation-id-mismatch',
      })
    } finally {
      await c.close()
    }
  })

  it('refuses an operation whose run link points elsewhere', async () => {
    const run = startingRun()
    const operation = operationFixture(run, { runId: RunId('run-other') })
    const linked = { ...run, operationId: operation.id }
    const c = await recoveryCase({ run: linked, operation })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'operation-run-mismatch',
      })
    } finally {
      await c.close()
    }
  })
})

describe('C-005 the scheduler stays closed until reconciliation finishes', () => {
  it('gates ticks on a parked durable read, then opens exactly once', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    try {
      const release = c.durable.holdNextOpen()
      const pending = c.recovery.reconcile()
      await c.durable.waitForOpenStart()

      expect(c.recovery.schedulerOpen).toBe(false)
      expect(await c.recovery.tick()).toEqual({ ran: false })
      expect(c.scheduler.tickCalls).toBe(0)

      release()
      const report = await pending
      expect(report.schedulerOpen).toBe(true)
      expect(c.recovery.schedulerOpen).toBe(true)
      expect(await c.recovery.tick()).toMatchObject({ ran: true })
      expect(c.scheduler.tickCalls).toBe(1)
    } finally {
      await c.close()
    }
  })
})

describe('C-006 uncertain state is never replayed automatically', () => {
  it('keeps an uncertain operation with an open run-owned turn for a human', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'uncertain' })
    const message = promptMessage(run, operation)
    const c = await recoveryCase({
      run,
      operation,
      events: [
        event('turn/start', 0, { turn: 1 }),
        event('user/message', 1, message),
      ],
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'restart-uncertain',
      })
      expect(c.supervisor.requests).toHaveLength(0)
      expect(c.durable.logs.get(c.sessionId)).toHaveLength(2)
    } finally {
      await c.close()
    }
  })

  it('settles an uncertain operation only when the log proves a completed run-owned turn', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'uncertain' })
    const c = await recoveryCase({
      run,
      operation,
      events: completedTurnEvents(0, 1, promptMessage(run, operation)),
    })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'settled-succeeded',
        reason: 'completed',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses to create a second session when a recorded session disappeared', async () => {
    const run = startingRun({ activeSessionId: SessionId('session-run-1-0') })
    const operation = operationFixture(run)
    const c = await recoveryCase({ run, operation, omitSession: true })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'session-missing',
      })
      expect(c.supervisor.requests).toHaveLength(0)
      expect(c.durable.logs.size).toBe(0)
    } finally {
      await c.close()
    }
  })
})

describe('C-007 leases and host ownership keep a single writer', () => {
  it('blocks a run leased by another host without writing it', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId, {
      lease: { ownerId: 'host-b', expiresAt: NOW + 500 },
    })
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'blocked',
        reason: 'foreign-held',
      })
      expect(c.store.getRun(run.id)?.revision).toBe(run.revision)
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('blocks a lease that expires beyond the current clock plus TTL', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId, {
      lease: { ownerId: 'host-b', expiresAt: NOW + 5_000 },
    })
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [], leaseTtlMs: 1_000 })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'blocked',
        reason: 'clock-anomaly',
      })
    } finally {
      await c.close()
    }
  })

  it('takes over an expired foreign lease and then decides from evidence', async () => {
    const run = startingRun({
      lease: { ownerId: 'host-b', expiresAt: NOW - 500 },
    })
    const c = await recoveryCase({ run, omitSession: true })
    try {
      const decision = soleDecision(await c.recovery.reconcile())
      expect(decision).toMatchObject({ action: 'rolled-back', reason: 'nothing-created' })
      const stored = c.store.getRun(run.id)
      expect(stored?.state).toBe('ready')
      expect(stored?.lease).toBeUndefined()
    } finally {
      await c.close()
    }
  })

  it('reuses its own unexpired lease without a second run write', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId, {
      lease: { ownerId: 'host-a', expiresAt: NOW + 500 },
    })
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({ action: 'resumed' })
      expect(c.store.getRun(run.id)?.revision).toBe(run.revision)
    } finally {
      await c.close()
    }
  })

  it('refuses to become a second writer when another host owns the domain', async () => {
    const run = startingRun()
    const c = await recoveryCase({ run, settingsHost: 'host-b' })
    try {
      const report = await c.recovery.reconcile()
      expect(report).toMatchObject({
        claimedHost: false,
        schedulerOpen: false,
        fatal: { code: 'second-writer' },
      })
      expect(report.decisions).toHaveLength(0)
      expect(c.recovery.schedulerOpen).toBe(false)
      expect(await c.recovery.tick()).toEqual({ ran: false })
      expect(c.store.getRun(run.id)?.state).toBe('starting')
    } finally {
      await c.close()
    }
  })
})

describe('C-008 durable failures surface an actionable state', () => {
  it('reports an unsupported session format instead of treating it as absent', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId)
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    c.durable.failOpen(sessionId, namedError('SessionFormatUnsupportedError', 'format v99 is newer'))
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'session-format-unsupported',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('reports session corruption instead of replaying', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId)
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    c.durable.failOpen(sessionId, namedError('SessionPersistenceCorruptionError', 'checksum failed'))
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'session-corrupt',
      })
    } finally {
      await c.close()
    }
  })

  it('reports a missing active session for a running run', async () => {
    const run = runningRun(SessionId('session-run-1-0'))
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, omitSession: true })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'session-missing',
        sessionId: run.activeSessionId,
      })
    } finally {
      await c.close()
    }
  })

  it('reports a writer-held session when resume is refused', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId)
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [], writerHeld: true })
    try {
      expect(soleDecision(await c.recovery.reconcile())).toMatchObject({
        action: 'needs-attention',
        reason: 'session-writer-held',
      })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('refuses to open a domain with an invalid persisted run record', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const run = startingRun()
    await first.store.createTask(taskFixture())
    await first.store.createRun(run)
    const medium = pool.media.get('session_orchestrator')
    expect(medium).toBeDefined()
    medium?.tables.get('runs')?.set('run-1', { ...run, state: 'zombie' })
    await first.close()

    await expect(harness(pool)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'invalid-record',
    })
  })
})

describe('unload stops intake before tearing down dependencies', () => {
  it('pauses, closes the scheduler, waits for supervision, then closes the domain', async () => {
    const order: string[] = []
    const c = await recoveryCase({
      run: startingRun(),
      operation: false,
      closeDomain: async () => {
        order.push('domain')
      },
    })
    try {
      await c.recovery.reconcile()

      const schedulerClose = c.scheduler.close.bind(c.scheduler)
      c.scheduler.close = async () => {
        order.push('scheduler')
        await schedulerClose()
        throw new Error('scheduler close failed')
      }
      const supervisorClose = c.supervisor.close.bind(c.supervisor)
      c.supervisor.close = async () => {
        order.push('supervisor')
        await supervisorClose()
      }

      const report = await c.recovery.close()
      expect(report.steps).toEqual([
        'gate-closed',
        'paused',
        'scheduler-closed',
        'supervisor-closed',
        'domain-closed',
      ])
      expect(report.failures).toHaveLength(1)
      expect(report.failures[0]).toContain('scheduler')
      expect(order).toEqual(['scheduler', 'supervisor', 'domain'])
      expect(c.supervisor.closeCalls).toBe(1)
      expect(c.store.getSettings().paused).toBe(true)
      expect(await c.recovery.tick()).toEqual({ ran: false })
      await expect(c.recovery.reconcile()).rejects.toMatchObject({ code: 'closed' })
    } finally {
      await c.close()
    }
  })
})

describe('recovery re-holds the run handle through the real supervisor', () => {
  it('resumes without resubmitting, then settles from the durable turn end', async () => {
    const h = await harness()
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId)
    await h.store.createTask(taskFixture())
    const operation = operationFixture(run, { phase: 'submitted' })
    await h.store.planOperation(operation)
    await h.store.createRun(run)

    const message = promptMessage(run, operation)
    const durable = new FakeDurableSessions()
    durable.put(sessionId, [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, message),
    ])
    const agents = new FakeAgents(h.ctx)
    const flush = new FakeDurability()
    const supervisor = new RunSupervisor({
      ctx: h.ctx,
      store: h.store,
      sessions: flush,
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => NOW,
    })
    const recovery = new RecoveryManager({
      store: h.store,
      durableSessions: durable,
      sessions: new FakeLiveSessions(),
      supervisor,
      scheduler: new FakeRecoveryScheduler(),
      hostInstanceId: 'host-a',
      now: () => NOW,
    })

    try {
      const report = await recovery.reconcile()
      const decision = soleDecision(report)
      expect(decision).toMatchObject({ action: 'resumed', submitPrompt: false })
      const settlement = decision.settlement
      if (settlement === undefined) throw new Error('expected a resumable settlement')

      const agent = await agents.waitForResume()
      expect(agents.resumeOptions[0]).toMatchObject({ resumeSessionId: sessionId })
      expect(supervisor.ownershipOf(run.id)).toBe('owned')
      expect(agent.followups).toHaveLength(0)

      await agent.waitForIdleWait()
      agent.emit(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
      agent.releaseIdle()

      expect(await settlement).toMatchObject({
        state: 'succeeded',
        reason: 'completed',
        committed: true,
        sessionId,
      })
      expect(supervisor.ownershipOf(run.id)).toBe('observed')
      // lease claim, supervisor claim, then the terminal success commit.
      expect(h.store.getRun(run.id)).toMatchObject({ state: 'succeeded', revision: 3 })
    } finally {
      for (const agent of [...agents.created, ...agents.resumed]) agent.releaseIdle()
      await supervisor.close()
      await h.close()
    }
  })
})

describe('recovery read diagnostics', () => {
  it('keeps the scheduler closed when an unexpected durable failure escapes', async () => {
    const sessionId = SessionId('session-run-1-0')
    const run = runningRun(sessionId)
    const operation = operationFixture(run, { phase: 'session-created' })
    const c = await recoveryCase({ run, operation, events: [] })
    c.durable.failOpen(sessionId, new Error('disk vanished'))
    try {
      await expect(c.recovery.reconcile()).rejects.toThrow('disk vanished')
      expect(c.recovery.schedulerOpen).toBe(false)
      expect(c.store.getRun(run.id)?.state).toBe('running')
    } finally {
      await c.close()
    }
  })
})
