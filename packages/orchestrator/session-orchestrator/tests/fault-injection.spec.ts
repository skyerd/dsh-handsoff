/**
 * Crash injection around every durable write recovery performs:
 *
 * - `before`: the write never reached the medium, so restart must decide again.
 * - `after`: the write landed and the response was lost, so restart must adopt
 *   the durable result and must not repeat its side effect.
 *
 * A second manager over the same store models a process restart. The first
 * manager is expected to reject and keep the scheduler closed.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RecoveryManager } from '../src/recovery.ts'
import type { RecoveryReport } from '../src/recovery.ts'
import type { RecordedFaultCase } from './evidence-types.ts'
import { serializedDecision, snapshot } from './evidence-utils.ts'
import { FaultingRecoveryStore } from './faulting-store.ts'
import type { FaultMethod, FaultTiming } from './faulting-store.ts'
import {
  completedTurnEvents,
  NOW,
  operationFixture,
  promptMessage,
  recoveryCase,
  runFixture,
  startingRun,
} from './recovery-fakes.ts'
import type { RecoveryCase, RecoveryCaseOptions } from './recovery-fakes.ts'

const BASELINE_COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84'
const SESSION = SessionId('session-run-1-0')
const recorded: RecordedFaultCase[] = []

function restart(c: RecoveryCase): RecoveryManager {
  return new RecoveryManager({
    store: c.recoveryStore,
    durableSessions: c.durable,
    sessions: c.live,
    supervisor: c.supervisor,
    scheduler: c.scheduler,
    hostInstanceId: 'host-a',
    now: () => NOW,
    leaseTtlMs: 1_000,
  })
}

function withFaults(options: RecoveryCaseOptions, faults: { current?: FaultingRecoveryStore }): RecoveryCaseOptions {
  return {
    ...options,
    wrapStore: store => {
      const wrapper = new FaultingRecoveryStore(store)
      faults.current = wrapper
      return wrapper
    },
  }
}

function resumesOf(c: RecoveryCase) {
  return c.supervisor.requests.map(request => ({
    sessionId: request.sessionId,
    operationId: request.operationId,
    submitPrompt: request.submitPrompt,
    messageId: request.progress.messageId,
    claimedTurn: request.progress.claimedTurn,
  }))
}

interface CrashResult {
  readonly crash: ReturnType<typeof snapshot>
  readonly report: RecoveryReport
}

async function crashAndRestart(
  c: RecoveryCase,
  faults: FaultingRecoveryStore,
  meta: {
    id: string
    title: string
    method: FaultMethod
    timing: FaultTiming
    reason: string
  },
): Promise<CrashResult> {
  faults.arm(meta.method, meta.timing, meta.reason)
  const before = snapshot(c)
  await expect(c.recovery.reconcile()).rejects.toThrow(meta.reason)
  expect(c.recovery.schedulerOpen).toBe(false)
  expect(await c.recovery.tick()).toEqual({ ran: false })
  const crash = snapshot(c)
  expect(faults.armed).toBe(false)

  const report = await restart(c).reconcile()
  const restarted = snapshot(c)
  recorded.push({
    id: meta.id,
    title: meta.title,
    variant: meta.timing === 'before' ? 'crash-before' : 'crash-after',
    fault: { method: meta.method, timing: meta.timing, reason: meta.reason },
    before,
    crash,
    restarted,
    firstPass: 'rejected',
    restartedDecisions: report.decisions.map(decision => serializedDecision(decision)).filter(
      (decision): decision is NonNullable<typeof decision> => decision !== undefined,
    ),
    restartedResumes: resumesOf(c),
    schedulerOpenAfterRestart: report.schedulerOpen,
    fatal: report.fatal,
  })
  return { crash, report }
}

describe('host claim crash', () => {
  it('reuses a claim that landed before the response was lost', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const run = startingRun()
    const c = await recoveryCase(withFaults({ run, omitSession: true }, faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { report } = await crashAndRestart(c, wrapper, {
        id: 'IP-01-host-claim-after',
        title: 'host claim landed; the claimant crashed before observing it',
        method: 'updateSettings',
        timing: 'after',
        reason: 'host-claim-response-lost',
      })

      expect(c.store.getSettings().hostInstanceId).toBe('host-a')
      expect(report.claimedHost).toBe(false)
      expect(report.decisions[0]).toMatchObject({ action: 'rolled-back' })
      expect(c.store.listRuns()).toHaveLength(1)
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('claims once on restart when the first claim never landed', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const run = startingRun()
    const c = await recoveryCase(withFaults({ run, omitSession: true }, faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { report } = await crashAndRestart(c, wrapper, {
        id: 'IP-02-host-claim-before',
        title: 'host claim never reached the medium',
        method: 'updateSettings',
        timing: 'before',
        reason: 'host-claim-lost',
      })

      expect(report.claimedHost).toBe(true)
      expect(report.decisions[0]).toMatchObject({ action: 'rolled-back' })
      expect(c.store.getSettings().hostInstanceId).toBe('host-a')
    } finally {
      await c.close()
    }
  })
})

describe('success commit crash', () => {
  function completedFixture(): RecoveryCaseOptions {
    const run = runFixture({
      state: 'running',
      activeSessionId: SESSION,
      sessionLineage: [SESSION],
      // Keep the lease claim out of the write sequence so the injected crash
      // targets the terminal success CAS.
      lease: { ownerId: 'host-a', expiresAt: NOW + 500 },
    })
    const operation = operationFixture(run, { phase: 'submitted' })
    const message = promptMessage(run, operation)
    return {
      run,
      operation: { ...operation, messageId: message.id },
      events: completedTurnEvents(0, 1, message),
    }
  }

  it('adopts a success that landed and never repeats the commit', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const c = await recoveryCase(withFaults(completedFixture(), faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { crash, report } = await crashAndRestart(c, wrapper, {
        id: 'IP-03-success-after',
        title: 'success CAS landed; the commit response was lost',
        method: 'updateRun',
        timing: 'after',
        reason: 'success-response-lost',
      })

      expect(crash.runs[0]).toMatchObject({ state: 'succeeded' })
      expect(report.decisions).toHaveLength(0)
      expect(report.schedulerOpen).toBe(true)
      expect(c.store.getRun(c.run.id)).toMatchObject({ state: 'succeeded' })
      expect(c.store.listRuns()).toHaveLength(1)
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })

  it('commits on restart when the success CAS never landed', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const c = await recoveryCase(withFaults(completedFixture(), faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { crash, report } = await crashAndRestart(c, wrapper, {
        id: 'IP-04-success-before',
        title: 'success CAS never reached the medium',
        method: 'updateRun',
        timing: 'before',
        reason: 'success-write-lost',
      })

      expect(crash.runs[0]).toMatchObject({ state: 'running' })
      expect(report.decisions[0]).toMatchObject({ action: 'settled-succeeded' })
      expect(c.store.getRun(c.run.id)).toMatchObject({ state: 'succeeded' })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

describe('operation target crash during adoption', () => {
  function creationFixture(): RecoveryCaseOptions {
    const run = startingRun()
    return { run, operation: operationFixture(run), events: [] }
  }

  it('adopts the recorded target without creating a second Session', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const c = await recoveryCase(withFaults(creationFixture(), faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { crash, report } = await crashAndRestart(c, wrapper, {
        id: 'IP-05-target-after',
        title: 'operation target landed; the adopt response was lost',
        method: 'advanceOperation',
        timing: 'after',
        reason: 'target-response-lost',
      })

      expect(crash.operations[0]).toMatchObject({
        phase: 'session-created',
        targetSessionId: SESSION,
      })
      expect(crash.runs[0]).toMatchObject({ state: 'starting' })
      expect(report.decisions[0]).toMatchObject({ action: 'resumed', submitPrompt: true })
      expect(c.store.getRun(c.run.id)).toMatchObject({
        state: 'running',
        activeSessionId: SESSION,
      })
      expect(c.durable.logs.size).toBe(1)
      expect(c.supervisor.requests).toHaveLength(1)
    } finally {
      await c.close()
    }
  })

  it('writes the target on restart when the first write never landed', async () => {
    const faults: { current?: FaultingRecoveryStore } = {}
    const c = await recoveryCase(withFaults(creationFixture(), faults))
    try {
      const wrapper = faults.current
      if (wrapper === undefined) throw new Error('fault wrapper was not installed')
      const { crash, report } = await crashAndRestart(c, wrapper, {
        id: 'IP-06-target-before',
        title: 'operation target never reached the medium',
        method: 'advanceOperation',
        timing: 'before',
        reason: 'target-write-lost',
      })

      expect(crash.operations[0]?.phase).toBe('planned')
      expect(report.decisions[0]).toMatchObject({ action: 'resumed', submitPrompt: true })
      const seeded = c.operation
      if (seeded === undefined) throw new Error('expected a seeded operation')
      expect(c.store.getOperation(seeded.id)).toMatchObject({
        phase: 'session-created',
        targetSessionId: SESSION,
      })
      expect(c.supervisor.requests).toHaveLength(1)
    } finally {
      await c.close()
    }
  })
})

describe('delivery succeeded but its record failed', () => {
  it('settles from the durable prompt and flushed turn without resubmitting', async () => {
    const run = runFixture({ state: 'running', activeSessionId: SESSION, sessionLineage: [SESSION] })
    const operation = operationFixture(run, { phase: 'session-created' })
    const message = promptMessage(run, operation)
    const c = await recoveryCase({
      run,
      operation,
      events: completedTurnEvents(0, 1, message),
    })
    try {
      const before = snapshot(c)
      const report = await c.recovery.reconcile()
      const restarted = snapshot(c)
      recorded.push({
        id: 'IP-07-delivery-record-lost',
        title: 'prompt and turn/end are durable; the submitted-phase record is not',
        variant: 'delivery-lost',
        fault: undefined,
        before,
        crash: before,
        restarted,
        firstPass: 'completed',
        restartedDecisions: report.decisions.map(decision => serializedDecision(decision)).filter(
          (decision): decision is NonNullable<typeof decision> => decision !== undefined,
        ),
        restartedResumes: resumesOf(c),
        schedulerOpenAfterRestart: report.schedulerOpen,
        fatal: report.fatal,
      })

      expect(report.decisions[0]).toMatchObject({
        action: 'settled-succeeded',
        reason: 'completed',
        messageId: message.id,
      })
      expect(c.store.getRun(run.id)).toMatchObject({ state: 'succeeded' })
      expect(c.supervisor.requests).toHaveLength(0)
    } finally {
      await c.close()
    }
  })
})

afterAll(async () => {
  const directory = fileURLToPath(new URL('./evidence/', import.meta.url))
  await mkdir(directory, { recursive: true })
  await writeFile(
    fileURLToPath(new URL('./evidence/fault-injection.json', import.meta.url)),
    `${JSON.stringify(
      {
        baselineCommit: BASELINE_COMMIT,
        generatedBy: 'tests/fault-injection.spec.ts',
        cases: recorded,
      },
      null,
      2,
    )}\n`,
  )
})
