/**
 * F1–F10 recovery matrix: every durable write point is exercised both before
 * and after the side effect, including the "side effect landed, response lost"
 * variant. Each case records a before/after durable snapshot so the evidence
 * artifacts show exactly what recovery changed.
 *
 * These cases never call a model and never append Session events: they reopen
 * a durable picture and check the reconciliation decision.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { OperationId } from '../src/brand.ts'
import type { RecoveryDecision, RecoveryReport } from '../src/recovery.ts'
import type { OperationRecord, RunRecord } from '../src/schema.ts'
import type { RecordedCase } from './evidence-types.ts'
import { serializedDecision, snapshot } from './evidence-utils.ts'
import {
  completedTurnEvents,
  operationFixture,
  promptMessage,
  recoveryCase,
  runFixture,
  startingRun,
} from './recovery-fakes.ts'
import type { RecoveryCase, RecoveryCaseOptions } from './recovery-fakes.ts'
import { event } from './fake-agent.ts'

const BASELINE_COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84'
const PARENT = SessionId('session-run-1-0')
const CHILD = SessionId('session-run-1-1')

const recorded: RecordedCase[] = []

interface CaseMeta {
  readonly id: string
  readonly title: string
  readonly variant: 'before-write' | 'after-write' | 'response-lost' | 'control'
  readonly expect?: Partial<RecoveryDecision>
  readonly noDecision?: boolean
  readonly check?: (c: RecoveryCase, report: RecoveryReport) => void
}

async function recordCase(options: RecoveryCaseOptions, meta: CaseMeta): Promise<void> {
  const c = await recoveryCase(options)
  try {
    const before = snapshot(c)
    const report = await c.recovery.reconcile()
    const after = snapshot(c)
    const decisions = report.decisions
    if (meta.noDecision === true) {
      expect(decisions).toHaveLength(0)
    } else {
      expect(decisions).toHaveLength(1)
      const [decision] = decisions
      if (decision === undefined) throw new Error(`case ${meta.id} produced no decision`)
      expect(decision).toMatchObject(meta.expect ?? {})
    }
    meta.check?.(c, report)

    recorded.push({
      id: meta.id,
      title: meta.title,
      variant: meta.variant,
      runId: c.run.id,
      before,
      after,
      decision: serializedDecision(decisions[0]),
      fatal: report.fatal,
      schedulerOpen: report.schedulerOpen,
      resumes: c.supervisor.requests.map(request => ({
        sessionId: request.sessionId,
        operationId: request.operationId,
        submitPrompt: request.submitPrompt,
        messageId: request.progress.messageId,
        claimedTurn: request.progress.claimedTurn,
      })),
      sessionCount: c.durable.logs.size,
    })
  } finally {
    await c.close()
  }
}

function handoffFixture(messageDelivered: boolean): {
  run: RunRecord
  handoff: OperationRecord
  childMessage: ReturnType<typeof promptMessage>
} {
  const base = runFixture({
    state: 'handing-off',
    activeSessionId: PARENT,
    sessionLineage: [PARENT],
    generation: 0,
  })
  const handoff: OperationRecord = {
    ...operationFixture(base),
    id: OperationId('operation-handoff-run-1-1'),
    generation: 1,
    kind: 'handoff',
    phase: messageDelivered ? 'submitted' : 'session-created',
    targetSessionId: CHILD,
    sourceSessionId: PARENT,
    requestHash: `handoff|${base.id}|${base.attempt}`,
  }
  const childMessage = promptMessage(base, handoff)
  if (messageDelivered) handoff.messageId = childMessage.id
  return {
    run: { ...base, operationId: handoff.id },
    handoff,
    childMessage,
  }
}

describe('F1 starting CAS', () => {
  it('leaves a ready run untouched (before the starting CAS)', async () => {
    const run = runFixture({ state: 'ready' })
    await recordCase(
      { run, operation: operationFixture(run), omitSession: true },
      {
        id: 'F1-before-write',
        title: 'ready run: the starting CAS never landed',
        variant: 'before-write',
        noDecision: true,
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({ state: 'ready', revision: 0 })
          expect(c.durable.logs.size).toBe(0)
        },
      },
    )
  })

  it('rolls a starting run with no Session back to ready', async () => {
    const run = startingRun()
    await recordCase(
      { run, operation: operationFixture(run), omitSession: true },
      {
        id: 'F1-after-write',
        title: 'starting run: no Session exists, so rollback is safe',
        variant: 'after-write',
        expect: { action: 'rolled-back', reason: 'nothing-created' },
        check: c => {
          // lease claim, then the rollback.
          expect(c.store.getRun(run.id)).toMatchObject({ state: 'ready', revision: 2 })
          expect(c.durable.logs.size).toBe(0)
        },
      },
    )
  })

  it('reaches the same rollback when the starting CAS response was lost', async () => {
    const run = startingRun()
    await recordCase(
      { run, operation: operationFixture(run), omitSession: true },
      {
        id: 'F1-response-lost',
        title: 'starting run: the CAS landed but the caller crashed before observing it',
        variant: 'response-lost',
        expect: { action: 'rolled-back', reason: 'nothing-created' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })
})

describe('F2 Session creation', () => {
  it('rolls back when creation never became durable', async () => {
    const run = startingRun()
    await recordCase(
      { run, operation: operationFixture(run), omitSession: true },
      {
        id: 'F2-before-write',
        title: 'Session creation never became durable',
        variant: 'before-write',
        expect: { action: 'rolled-back' },
      },
    )
  })

  it('adopts the created Session and resumes for the one submission', async () => {
    const run = startingRun()
    const c = { run }
    await recordCase(
      { run, operation: operationFixture(run), events: [] },
      {
        id: 'F2-after-write',
        title: 'Session exists at the deterministic identity',
        variant: 'after-write',
        expect: { action: 'resumed', submitPrompt: true },
        check: (caseRef, report) => {
          expect(report.decisions[0]).toMatchObject({ sessionId: PARENT })
          expect(caseRef.store.getRun(c.run.id)).toMatchObject({
            state: 'running',
            activeSessionId: PARENT,
          })
          expect(caseRef.store.getOperation(operationFixture(c.run).id)).toMatchObject({
            phase: 'session-created',
            targetSessionId: PARENT,
          })
          expect(caseRef.durable.logs.size).toBe(1)
        },
      },
    )
  })

  it('adopts without creating a second Session when the creation response was lost', async () => {
    const run = startingRun()
    await recordCase(
      { run, operation: operationFixture(run), events: [] },
      {
        id: 'F2-response-lost',
        title: 'Session creation landed; the creator never observed the handle',
        variant: 'response-lost',
        expect: { action: 'resumed', submitPrompt: true },
        check: c => {
          expect(c.durable.logs.size).toBe(1)
          expect(c.supervisor.requests).toHaveLength(1)
        },
      },
    )
  })
})

describe('F3 operation target write', () => {
  it('adopts the Session into the run when the target is already recorded', async () => {
    const run = startingRun()
    const operation = operationFixture(run, {
      phase: 'session-created',
      targetSessionId: PARENT,
    })
    await recordCase(
      { run, operation, events: [] },
      {
        id: 'F3-before-write',
        title: 'operation target is durable; the run adoption CAS is not',
        variant: 'before-write',
        expect: { action: 'resumed', submitPrompt: true },
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({
            state: 'running',
            activeSessionId: PARENT,
          })
          expect(c.store.getOperation(operation.id)?.targetSessionId).toBe(PARENT)
        },
      },
    )
  })

  it('keeps the recorded target when the run already adopted it', async () => {
    const run = runFixture({
      state: 'running',
      activeSessionId: PARENT,
      sessionLineage: [PARENT],
    })
    const operation = operationFixture(run, {
      phase: 'session-created',
      targetSessionId: PARENT,
    })
    await recordCase(
      { run, operation, events: [] },
      {
        id: 'F3-after-write',
        title: 'run adoption landed',
        variant: 'after-write',
        expect: { action: 'resumed', submitPrompt: true },
        check: c => {
          expect(c.store.getRun(run.id)?.activeSessionId).toBe(PARENT)
          expect(c.store.getOperation(operation.id)?.targetSessionId).toBe(PARENT)
        },
      },
    )
  })

  it('does not create a second Session when the recorded target is missing', async () => {
    const run = startingRun({ activeSessionId: PARENT })
    const operation = operationFixture(run, {
      phase: 'session-created',
      targetSessionId: PARENT,
    })
    await recordCase(
      { run, operation, omitSession: true },
      {
        id: 'F3-conflict',
        title: 'recorded target is absent from durable storage',
        variant: 'after-write',
        expect: { action: 'needs-attention', reason: 'session-missing' },
        check: c => {
          expect(c.durable.logs.size).toBe(0)
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })
})

describe('F4 prompt delivery', () => {
  it('resumes for submission when no prompt reached the log', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'session-created' })
    await recordCase(
      { run, operation, events: [] },
      {
        id: 'F4-before-write',
        title: 'followup was never made durable',
        variant: 'before-write',
        expect: { action: 'resumed', submitPrompt: true },
      },
    )
  })

  it('settles the prompt from a completed run-owned turn without replay', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'session-created' })
    const message = promptMessage(run, operation)
    await recordCase(
      { run, operation, events: completedTurnEvents(0, 1, message) },
      {
        id: 'F4-after-write',
        title: 'prompt and turn/end are durable',
        variant: 'after-write',
        expect: { action: 'settled-succeeded', reason: 'completed', messageId: message.id },
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({
            state: 'succeeded',
            claimedTurn: 1,
            acceptedTurnEndSeq: 2,
          })
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('settles instead of replaying when delivery landed but its record was lost', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'session-created' })
    const message = promptMessage(run, operation)
    await recordCase(
      { run, operation, events: completedTurnEvents(0, 1, message) },
      {
        id: 'F4-response-lost',
        title: 'followup landed; the submitted-phase write did not',
        variant: 'response-lost',
        expect: { action: 'settled-succeeded' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })
})

describe('F5 submitted record', () => {
  it('refuses to replay an operation recorded as submitted with no prompt', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted' })
    await recordCase(
      { run, operation, events: [] },
      {
        id: 'F5-before-write',
        title: 'submitted phase is durable but followup never happened',
        variant: 'before-write',
        expect: { action: 'needs-attention', reason: 'restart-uncertain' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('refuses a recorded prompt identity with no durable message', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted', messageId: 'message-missing' })
    await recordCase(
      { run, operation, events: [] },
      {
        id: 'F5-after-write',
        title: 'submitted record names a message the log does not contain',
        variant: 'after-write',
        expect: { action: 'needs-attention', reason: 'submission-unverified' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('settles when the message is durable but the submitted record was lost', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'session-created' })
    const message = promptMessage(run, operation)
    await recordCase(
      { run, operation, events: completedTurnEvents(0, 1, message) },
      {
        id: 'F5-record-lost',
        title: 'delivery succeeded but the operation record write failed',
        variant: 'response-lost',
        expect: { action: 'settled-succeeded' },
      },
    )
  })
})

describe('F6 claimed turn mapping', () => {
  it('writes the claimed turn recovered from the durable message', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'claimed' })
    const message = promptMessage(run, operation)
    await recordCase(
      {
        run,
        operation: { ...operation, messageId: message.id },
        events: completedTurnEvents(0, 1, message),
      },
      {
        id: 'F6-claimed',
        title: 'claimed phase and message identity survive; the run mapping does not',
        variant: 'after-write',
        expect: { action: 'settled-succeeded', turn: 1 },
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({ state: 'succeeded', claimedTurn: 1 })
        },
      },
    )
  })

  it('does not attribute a later turn claimed by another operation', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted' })
    const own = promptMessage(run, operation)
    const foreign = promptMessage(run, { ...operation, id: OperationId('operation-other') })
    await recordCase(
      {
        run,
        operation: { ...operation, messageId: own.id },
        events: [
          ...completedTurnEvents(0, 1, own),
          ...completedTurnEvents(3, 2, foreign),
        ],
      },
      {
        id: 'F6-unrelated',
        title: 'a second turn belongs to another operation',
        variant: 'control',
        expect: { action: 'settled-succeeded', turn: 1 },
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({ claimedTurn: 1, acceptedTurnEndSeq: 2 })
        },
      },
    )
  })

  it('resumes an open claimed turn without resubmitting the prompt', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'claimed' })
    const message = promptMessage(run, operation)
    await recordCase(
      {
        run,
        operation: { ...operation, messageId: message.id },
        events: [
          event('turn/start', 0, { turn: 1 }),
          event('user/message', 1, message),
        ],
      },
      {
        id: 'F6-open-turn',
        title: 'the claimed turn is still open',
        variant: 'after-write',
        expect: { action: 'resumed', submitPrompt: false },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(1)
          expect(c.supervisor.requests[0]?.progress).toMatchObject({
            messageId: message.id,
            claimedTurn: 1,
            openTurn: 1,
          })
        },
      },
    )
  })
})

describe('F7 flush boundary', () => {
  it('refuses to settle from an unflushed turn', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted', messageId: 'message-missing' })
    await recordCase(
      {
        run,
        operation,
        events: [event('turn/start', 0, { turn: 1 })],
      },
      {
        id: 'F7-before-flush',
        title: 'turn/start is durable but the message and turn end are not',
        variant: 'before-write',
        expect: { action: 'needs-attention', reason: 'submission-unverified' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('settles after a flushed turn even though the success CAS never landed', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted' })
    const message = promptMessage(run, operation)
    await recordCase(
      {
        run,
        operation: { ...operation, messageId: message.id },
        events: completedTurnEvents(0, 1, message),
      },
      {
        id: 'F7-flushed-crash',
        title: 'flush completed, then the process crashed before the success CAS',
        variant: 'after-write',
        expect: { action: 'settled-succeeded', reason: 'completed' },
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
          expect(c.durable.logs.get(PARENT)).toHaveLength(3)
        },
      },
    )
  })

  it('commits the same success when the flush response was lost', async () => {
    const run = runFixture({ state: 'running', activeSessionId: PARENT, sessionLineage: [PARENT] })
    const operation = operationFixture(run, { phase: 'submitted' })
    const message = promptMessage(run, operation)
    await recordCase(
      {
        run,
        operation: { ...operation, messageId: message.id },
        events: completedTurnEvents(0, 1, message),
      },
      {
        id: 'F7-response-lost',
        title: 'flush landed; its acknowledgement was lost',
        variant: 'response-lost',
        expect: { action: 'settled-succeeded' },
      },
    )
  })
})

describe('F8 success commit and disposal', () => {
  it('leaves an already-succeeded run and its Session untouched', async () => {
    const run = runFixture({
      state: 'succeeded',
      activeSessionId: PARENT,
      sessionLineage: [PARENT],
      claimedTurn: 1,
      acceptedTurnEndSeq: 2,
    })
    const operation = operationFixture(run, { phase: 'claimed' })
    const message = promptMessage(run, operation)
    await recordCase(
      { run, operation, events: completedTurnEvents(0, 1, message), live: true },
      {
        id: 'F8-settled',
        title: 'success CAS landed; disposal did not',
        variant: 'after-write',
        noDecision: true,
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({ state: 'succeeded', revision: 0 })
          expect(c.supervisor.requests).toHaveLength(0)
          expect(c.live.get(PARENT)).toBeDefined()
        },
      },
    )
  })

  it('does not resume a settled run when the success response was lost', async () => {
    const run = runFixture({
      state: 'succeeded',
      activeSessionId: PARENT,
      sessionLineage: [PARENT],
      claimedTurn: 1,
      acceptedTurnEndSeq: 2,
    })
    const operation = operationFixture(run, { phase: 'claimed' })
    const message = promptMessage(run, operation)
    await recordCase(
      { run, operation, events: completedTurnEvents(0, 1, message), live: true },
      {
        id: 'F8-response-lost',
        title: 'the success write landed but the caller crashed before disposing',
        variant: 'response-lost',
        noDecision: true,
        check: c => {
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })
})

describe('F9 handoff child creation', () => {
  it('leaves a child Session without a handoff message for a human', async () => {
    const { run, handoff } = handoffFixture(false)
    await recordCase(
      {
        run,
        operation: handoff,
        sessions: [
          { id: PARENT, events: [] },
          { id: CHILD, events: [] },
        ],
      },
      {
        id: 'F9-child-created',
        title: 'child Session exists but no handoff message was delivered',
        variant: 'after-write',
        expect: { action: 'needs-attention', reason: 'handoff-unverified' },
        check: c => {
          expect(c.durable.logs.size).toBe(2)
          expect(c.store.getRun(run.id)?.activeSessionId).toBe(PARENT)
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('reports a missing child instead of creating a second one', async () => {
    const { run, handoff } = handoffFixture(false)
    await recordCase(
      {
        run,
        operation: handoff,
        sessions: [{ id: PARENT, events: [] }],
      },
      {
        id: 'F9-child-missing',
        title: 'handoff target is durable but the child Session is absent',
        variant: 'before-write',
        expect: { action: 'needs-attention', reason: 'handoff-session-missing' },
        check: c => {
          expect(c.durable.logs.size).toBe(1)
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('never creates a replacement child when empty creation landed without a response', async () => {
    const { run, handoff } = handoffFixture(false)
    await recordCase(
      {
        run,
        operation: handoff,
        sessions: [
          { id: PARENT, events: [] },
          { id: CHILD, events: [] },
        ],
      },
      {
        id: 'F9-response-lost',
        title: 'child creation landed; the creator never observed the handle',
        variant: 'response-lost',
        expect: { action: 'needs-attention', reason: 'handoff-unverified' },
        check: c => {
          expect(c.durable.logs.size).toBe(2)
        },
      },
    )
  })
})

describe('F10 handoff delivery before the active-session switch', () => {
  it('adopts the child generation from the delivered message and settles once', async () => {
    const { run, handoff, childMessage } = handoffFixture(true)
    await recordCase(
      {
        run,
        operation: handoff,
        sessions: [
          { id: PARENT, events: [] },
          { id: CHILD, events: completedTurnEvents(0, 1, childMessage) },
        ],
      },
      {
        id: 'F10-delivered',
        title: 'child message is durable; the run still names the parent',
        variant: 'after-write',
        expect: { action: 'settled-succeeded', reason: 'completed' },
        check: c => {
          expect(c.store.getRun(run.id)).toMatchObject({
            state: 'succeeded',
            activeSessionId: CHILD,
            generation: 1,
            claimedTurn: 1,
          })
          expect(c.store.getRun(run.id)?.sessionLineage).toEqual([PARENT, CHILD])
          expect(c.store.getOperation(handoff.id)?.phase).toBe('submitted')
          expect(c.durable.logs.size).toBe(2)
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })

  it('reaches the same settlement when the active-session switch response was lost', async () => {
    const { run, handoff, childMessage } = handoffFixture(true)
    await recordCase(
      {
        run,
        operation: handoff,
        sessions: [
          { id: PARENT, events: [] },
          { id: CHILD, events: completedTurnEvents(0, 1, childMessage) },
        ],
      },
      {
        id: 'F10-response-lost',
        title: 'child delivery landed; the run CAS response was lost',
        variant: 'response-lost',
        expect: { action: 'settled-succeeded' },
        check: c => {
          expect(c.durable.logs.size).toBe(2)
          expect(c.supervisor.requests).toHaveLength(0)
        },
      },
    )
  })
})

afterAll(async () => {
  const directory = fileURLToPath(new URL('./evidence/', import.meta.url))
  await mkdir(directory, { recursive: true })
  const payload = {
    baselineCommit: BASELINE_COMMIT,
    generatedBy: 'tests/recovery-matrix.spec.ts',
    cases: recorded,
  }
  await writeFile(
    fileURLToPath(new URL('./evidence/recovery-matrix.json', import.meta.url)),
    `${JSON.stringify(payload, null, 2)}\n`,
  )

  const rows = recorded.map(entry => {
    const beforeRun = entry.before.runs.find(run => run.id === entry.runId)
    const afterRun = entry.after.runs.find(run => run.id === entry.runId)
    const beforeOperation = entry.before.operations[0]
    const afterOperation = entry.after.operations[0]
    return `| ${entry.id} | ${entry.variant} | ${beforeRun?.state ?? '-'}@r${beforeRun?.revision ?? '-'} → ${afterRun?.state ?? '-'}@r${afterRun?.revision ?? '-'} | ${beforeOperation?.phase ?? '-'} → ${afterOperation?.phase ?? '-'} | ${entry.decision?.action ?? 'none'}${entry.decision?.reason !== undefined ? `/${entry.decision.reason}` : ''} | ${entry.resumes.length} | ${entry.sessionCount} |`
  })
  const markdown = [
    '# Recovery matrix snapshot diff',
    '',
    `Baseline commit: \`${BASELINE_COMMIT}\``,
    'Generated by `tests/recovery-matrix.spec.ts`; rerun with',
    '`npx vitest run <session-orchestrator>/tests/recovery-matrix.spec.ts`.',
    '',
    '| Case | Variant | Run before → after | Operation before → after | Decision | Resumes | Sessions |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
  await writeFile(
    fileURLToPath(new URL('./evidence/snapshot-diff.md', import.meta.url)),
    markdown,
  )
})
