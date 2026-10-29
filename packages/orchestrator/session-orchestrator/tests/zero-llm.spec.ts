/**
 * Zero-extra-LLM evidence: static source scan plus runtime service spies.
 *
 * The orchestrator must never call `ctx.llm.stream` or `ctx.llm.prepareCall`,
 * never register a model tool, and never start title, compaction or summary
 * work. The static half proves the source cannot reach those services; the
 * runtime half drives the store, scheduler, pressure monitor, handoff manager,
 * supervisor, recovery reconciler and Remote controller against installed spy
 * services and observes zero calls.
 *
 * A host capability report names the compaction feature as data, so the scan
 * forbids compaction event work (`compaction/...` and `ctx.compaction`) rather
 * than the bare vocabulary word. The runtime journal still proves no compaction
 * call happens.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ReasoningEffortId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import { HandoffManager } from '../src/handoff.ts'
import { PressureMonitor } from '../src/pressure.ts'
import { SessionOrchestratorController } from '../src/remote.ts'
import { Scheduler } from '../src/scheduler.ts'
import { RunSupervisor } from '../src/supervisor.ts'
import type { LocalSessionOrchestrator } from '../src/local.ts'
import { SessionOrchestratorRuntime } from '../src/runtime.ts'
import type { RuntimeOptions } from '../src/runtime.ts'
import type { OperationRecord, PressureSnapshot, RunRecord, TaskSpec } from '../src/types.ts'
import { event, FakeAgents, FakeDurability } from './fake-agent.ts'
import { fakeLauncher } from './fake-launcher.ts'
import { FakeTokenMeter } from './fake-token-meter.ts'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import {
  FakeLiveSessions,
  FakeRecoveryScheduler,
  FakeRecoverySupervisor,
  runningRun,
} from './recovery-fakes.ts'

const HOST_SRC = fileURLToPath(new URL('../src/', import.meta.url))
const CLIENT_SRC = fileURLToPath(new URL('../../../client/ui-settings-session-orchestrator/src/', import.meta.url))

/** Runtime scenarios whose service journals were observed by this spec. */
const recordedJournals: Array<{ readonly scenario: string; readonly calls: Readonly<Record<string, number>> }> = []

/** Translate one mutable counter journal into its recorded call counts. */
function journalCounts(counters: SpyCounters): Record<string, number> {
  return {
    llmStream: counters.llmStream.length,
    llmPrepare: counters.llmPrepare.length,
    toolRegisters: counters.toolRegisters.length,
    agentCreates: counters.agentCreates.length,
    agentResumes: counters.agentResumes.length,
    compactionCalls: counters.compactionCalls.length,
    titleCalls: counters.titleCalls.length,
  }
}

/** Every `.ts`/`.tsx` file below one directory, in stable order. */
function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path)
  }
  return files.sort()
}

/** Whether one module specifier names a package the orchestrator must not import. */
function forbiddenModule(specifier: string): boolean {
  if (specifier === '@deepseek-ai/dsh-agent-loop') return true
  return /(?:^|\/)(?:[^/]*compaction[^/]*|[^/]*session-title[^/]*|[^/]*summari[^/]*)$/u.test(specifier)
}

/** Whether one property path names a service the orchestrator must not reach. */
function forbiddenAccess(text: string): boolean {
  return /(?:^|\.)ctx\.(?:llm|tools|compaction)(?:\b|\.)/u.test(text)
    || /(?:^|\.)ctx\.get\(\s*['"](?:llm|tools|sessionTitle)['"]\s*\)/u.test(text)
}

/** Whether one string literal names auxiliary LLM, title or compaction event work. */
function forbiddenLiteral(value: string): boolean {
  return value === 'llm/stream' || value === 'session-title' || value.startsWith('compaction/')
}

/**
 * Scan one source tree for static zero-LLM violations.
 * @param directory - source root.
 * @param forbiddenImports - module names or patterns that must not appear.
 * @param allowLlmAccess - files allowed to name the `llm` service, one module.
 * @returns one readable violation per offending source location.
 */
function scan(
  directory: string,
  forbiddenImports: (specifier: string) => boolean,
  allowLlmAccess: (file: string) => boolean = () => false,
): string[] {
  const violations: string[] = []
  for (const file of sourceFiles(directory)) {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const mayNameLlm = allowLlmAccess(file)
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier
        if (specifier !== undefined && ts.isStringLiteral(specifier) && forbiddenImports(specifier.text)) {
          violations.push(`${file}: forbidden module '${specifier.text}'`)
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isIdentifier(callee) && callee.text === 'require') {
          const argument = node.arguments[0]
          if (argument !== undefined && ts.isStringLiteral(argument) && forbiddenImports(argument.text)) {
            violations.push(`${file}: forbidden require '${argument.text}'`)
          }
        }
        if (!mayNameLlm && ts.isPropertyAccessExpression(callee) && forbiddenAccess(callee.getText(source))) {
          violations.push(`${file}: forbidden service access '${callee.getText(source)}'`)
        }
      }
      if (!mayNameLlm && ts.isPropertyAccessExpression(node) && forbiddenAccess(node.getText(source))) {
        violations.push(`${file}: forbidden service access '${node.getText(source)}'`)
      }
      if (!mayNameLlm && ts.isStringLiteral(node) && forbiddenLiteral(node.text)) {
        violations.push(`${file}: forbidden literal '${node.text}'`)
      }
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'SessionEventMap') {
        violations.push(`${file}: orchestrator must not extend SessionEventMap`)
      }
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        if (node.name.text === '@deepseek-ai/dsh-session/types') {
          violations.push(`${file}: orchestrator must not extend the Session event module`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations
}

/** The only module allowed to reach the LLM service, because it is opt-in. */
const MODEL_WARDEN_SOURCE = join(HOST_SRC, 'model-warden.ts')

/** Whether one source file names the `llm` service. */
function namesLlmService(file: string): boolean {
  return /ctx\.get\(\s*['"]llm['"]\s*\)/u.test(readFileSync(file, 'utf8'))
}

/** Aggregate counters for every forbidden runtime service. */
interface SpyCounters {
  readonly llmStream: unknown[]
  readonly llmPrepare: unknown[]
  readonly toolRegisters: unknown[]
  readonly agentCreates: unknown[]
  readonly agentResumes: unknown[]
  readonly compactionCalls: unknown[]
  readonly titleCalls: unknown[]
}

/**
 * Install spy services under the real Context so any orchestrator access is
 * observable, then return their call journals.
 * @param ctx - context shared by the orchestrator components under test.
 * @returns the mutable journals.
 */
function installSpies(ctx: Context): SpyCounters {
  const counters: SpyCounters = {
    llmStream: [],
    llmPrepare: [],
    toolRegisters: [],
    agentCreates: [],
    agentResumes: [],
    compactionCalls: [],
    titleCalls: [],
  }
  ctx.provide('llm', {
    stream(options: unknown) {
      counters.llmStream.push(options)
      throw new Error('orchestrator must not stream a model call')
    },
    prepareCall(options: unknown) {
      counters.llmPrepare.push(options)
      throw new Error('orchestrator must not prepare a model call')
    },
    registerAdapter() {
      throw new Error('orchestrator must not register an LLM adapter')
    },
  })
  ctx.provide('tools', {
    register(definition: unknown) {
      counters.toolRegisters.push(definition)
      return () => {}
    },
  })
  ctx.provide('agents', {
    async create(options: unknown) {
      counters.agentCreates.push(options)
      throw new Error('orchestrator must use its injected agents port')
    },
    async resume(options: unknown) {
      counters.agentResumes.push(options)
      throw new Error('orchestrator must use its injected agents port')
    },
  })
  ctx.provide('compaction', {
    async summarize(input: unknown) {
      counters.compactionCalls.push(input)
      throw new Error('orchestrator must not compact context')
    },
  })
  ctx.provide('sessionTitle', {
    async generate(input: unknown) {
      counters.titleCalls.push(input)
      throw new Error('orchestrator must not generate a session title')
    },
  })
  return counters
}

/** Every journal must stay empty. */
function expectNoForbiddenCalls(counters: SpyCounters): void {
  expect(counters.llmStream).toEqual([])
  expect(counters.llmPrepare).toEqual([])
  expect(counters.toolRegisters).toEqual([])
  expect(counters.agentCreates).toEqual([])
  expect(counters.agentResumes).toEqual([])
  expect(counters.compactionCalls).toEqual([])
  expect(counters.titleCalls).toEqual([])
}

/** Runtime config of the rule-mode journal scenarios. */
const RULE_CONFIG: RuntimeOptions = {
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
}

/** Unpause the host scheduler so pressure and dispatch gates do not mask work. */
async function unpause(h: Harness): Promise<void> {
  const settings = h.store.getSettings()
  await h.store.updateSettings(settings.revision, {
    ...settings,
    paused: false,
    revision: settings.revision + 1,
    updatedAt: 1_000,
  })
}

/** A queue record at revision zero. */
function queueRecord(taskIds: readonly string[] = []) {
  return {
    id: QueueId('queue-1'),
    title: 'Queue one',
    taskOrder: taskIds.map(TaskId),
    paused: false,
    state: 'idle' as const,
    revision: 0,
  }
}

/** A task specification at revision zero. */
function taskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: TaskId('task-1'),
    queueId: QueueId('queue-1'),
    title: 'Task one',
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
      maxHandoffTokens: 4_096,
    },
    enabled: true,
    revision: 0,
    ...overrides,
  }
}

/** A stored run at revision zero. */
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

/** A planned initial-prompt operation. */
function operationRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: OperationId('operation-1'),
    runId: RunId('run-1'),
    generation: 0,
    attempt: 1,
    kind: 'initial-prompt',
    phase: 'planned',
    requestHash: 'hash-one',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** A parent Session with one normally closed Turn containing a tool pair. */
function parentSession(): Session {
  const id = SessionId('session-parent')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1_000,
    cwd: '/work/one',
    isSeeded: false,
    agentPreset: 'preset-inherit',
  }
  const session = Session.create(id, undefined, header)
  session.append('request/header', {
    reason: 'initial',
    header: {
      config: {
        provider: 'mock',
        model: 'mock-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 2_048,
      },
    },
  })
  session.append('request/context', {
    provider: 'mock',
    model: 'mock-model',
    contextWindow: 128_000,
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Please produce the result.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('zero extra LLM: static source boundary', () => {
  it('host sources reach the LLM service only from the opt-in model warden', () => {
    expect(scan(HOST_SRC, forbiddenModule, file => file === MODEL_WARDEN_SOURCE)).toEqual([])
    const naming = sourceFiles(HOST_SRC).filter(namesLlmService)
    expect(naming).toEqual([MODEL_WARDEN_SOURCE])
  })

  it('client settings sources import no LLM, tool or agent package', () => {
    expect(scan(CLIENT_SRC, specifier => (
      forbiddenModule(specifier)
      || specifier === '@deepseek-ai/dsh-llm'
      || specifier === '@deepseek-ai/dsh-tools'
      || specifier.startsWith('@deepseek-ai/dsh-agent')
      || specifier === '@deepseek-ai/dsh-session'
    ))).toEqual([])
  })
})

describe('zero extra LLM: runtime service journals', () => {
  it('store, scheduler, Remote and recovery leave every LLM/tool/agent journal empty', async () => {
    const h = await harness()
    const counters = installSpies(h.ctx)
    try {
      await unpause(h)
      await h.store.createQueue(queueRecord(['task-1']))
      await h.store.createTask(taskSpec())
      await h.store.createRun(runRecord())

      const controller = new SessionOrchestratorController(h.ctx, {}, { now: () => 1_000 })
      expect(controller.listQueues().items).toHaveLength(1)
      expect(controller.listRuns().items).toHaveLength(1)
      expect(controller.listHandoffs().items).toEqual([])
      expect(controller.getSettings().settings.maxConcurrentRuns).toBeGreaterThan(0)

      const streamController = new AbortController()
      const stream = controller.changed(streamController.signal)[Symbol.asyncIterator]()
      const first = await stream.next()
      expect(first.done).toBe(false)
      streamController.abort()
      expect((await stream.next()).done).toBe(true)
      recordedJournals.push({ scenario: 'store + Remote snapshot', calls: journalCounts(counters) })

      const runHarness = await harness()
      const runCounters = installSpies(runHarness.ctx)
      try {
        await unpause(runHarness)
        await runHarness.store.createQueue(queueRecord(['task-1']))
        await runHarness.store.createTask(taskSpec())
        await runHarness.store.createRun(runRecord())
        const launcher = fakeLauncher()
        const scheduler = new Scheduler({
          store: runHarness.store,
          launcher,
          now: () => 1_000,
          workspaceKeys: { resolve: workspaceId => ({ ok: true, workspaceKey: `${workspaceId}:/work/one` }) },
        })
        const tick = await scheduler.tick()
        expect(tick.started).toHaveLength(1)
        await launcher.acceptAll()
        await scheduler.drain()
        await scheduler.close()
        expectNoForbiddenCalls(runCounters)
        recordedJournals.push({ scenario: 'scheduler dispatch', calls: journalCounts(runCounters) })
      } finally {
        await runHarness.close()
      }

      const recoveryHarness = await harness()
      const recoveryCounters = installSpies(recoveryHarness.ctx)
      try {
        const task = taskSpec({ handoff: { ...taskSpec().handoff, enabled: false } })
        await recoveryHarness.store.createTask(task)
        const run = runRecord({ state: 'starting' })
        await recoveryHarness.store.createRun(run)
        const supervisor = new FakeRecoverySupervisor()
        const scheduler = new FakeRecoveryScheduler()
        const { RecoveryManager } = await import('../src/recovery.ts')
        const recovery = new RecoveryManager({
          store: recoveryHarness.store,
          durableSessions: {
            async open() {
              throw Object.assign(new Error('session is not stored'), { name: 'SessionPersistenceNotFoundError' })
            },
          },
          sessions: { get: () => undefined },
          supervisor,
          scheduler,
          hostInstanceId: 'host-a',
          now: () => 1_000,
        })
        const report = await recovery.reconcile()
        expect(report.decisions).toHaveLength(1)
        await recovery.close()
        expectNoForbiddenCalls(recoveryCounters)
        recordedJournals.push({ scenario: 'recovery reconciliation', calls: journalCounts(recoveryCounters) })
      } finally {
        await recoveryHarness.close()
      }

      expectNoForbiddenCalls(counters)
    } finally {
      await h.close()
    }
  })

  it('a running pipeline in the default rule mode reviews with no model call', async () => {
    const h = await harness()
    const counters = installSpies(h.ctx)
    try {
      h.ctx.provide('sessions', { get: () => undefined })
      await unpause(h)
      await h.store.createQueue(queueRecord(['task-1']))
      await h.store.createTask(taskSpec())
      const session = SessionId('session-rule')
      await h.store.createRun(runRecord({
        state: 'running',
        activeSessionId: session,
        sessionLineage: [session],
      }))
      const runtime = new SessionOrchestratorRuntime({
        ctx: h.ctx,
        store: h.store,
        supervisor: {
          ownedHandles: { get: () => undefined },
          cancel: () => false,
          close: async () => {},
        } as unknown as RunSupervisor,
        orchestrator: {
          reconcile: async () => {},
          tick: async () => ({ paused: false, started: [], skipped: [] }),
          close: async () => {},
        } as unknown as LocalSessionOrchestrator,
        config: RULE_CONFIG,
        now: () => 1_000,
      })
      await runtime.tick()
      expect(h.store.listWardenAudits()).toEqual([])
      expectNoForbiddenCalls(counters)
      recordedJournals.push({ scenario: 'rule-mode health pass', calls: journalCounts(counters) })
      await runtime.close()
    } finally {
      await h.close()
    }
  })

  it('pressure, handoff body rendering and supervision leave every journal empty', async () => {
    const pressureHarness = await harness()
    const pressureCounters = installSpies(pressureHarness.ctx)
    try {
      await unpause(pressureHarness)
      await pressureHarness.store.createQueue(queueRecord(['task-1']))
      await pressureHarness.store.createTask(taskSpec())
      await pressureHarness.store.createRun(runningRun(SessionId('session-pressure')))
      const session = Session.create(SessionId('session-pressure'))
      session.append('request/context', {
        provider: 'mock',
        model: 'mock-model',
        contextWindow: 128_000,
      })
      const meter = new FakeTokenMeter()
      meter.setReading(120_000, 'usage')
      const monitor = new PressureMonitor({
        store: pressureHarness.store,
        tokenMeter: meter,
        now: () => 1_000,
      })
      const observed = await monitor.observe({
        runId: RunId('run-1'),
        session,
        turnClosed: true,
        bodies: {
          structuredBrief: [createUserMessage({
            content: [{ type: 'text', text: 'Deterministic brief body.' }],
            source: { kind: 'user' },
          })],
        },
      })
      expect(observed.decision).toBe('handoff-pending')
      expect(observed.budget?.selected.mode).toBe('structured-brief')
      expectNoForbiddenCalls(pressureCounters)
      recordedJournals.push({ scenario: 'pressure measurement and pricing', calls: journalCounts(pressureCounters) })
    } finally {
      await pressureHarness.close()
    }

    const handoffHarness = await harness()
    const handoffCounters = installSpies(handoffHarness.ctx)
    try {
      await handoffHarness.store.createQueue(queueRecord(['task-1']))
      const parent = parentSession()
      const task = taskSpec()
      await handoffHarness.store.createTask(task)
      await handoffHarness.store.createRun(runningRun(parent.id, {
        pressure: pendingPressure(parent),
      }))
      const agents = new FakeAgents(handoffHarness.ctx)
      const flush = new FakeDurability()
      const manager = new HandoffManager({
        store: handoffHarness.store,
        sessions: flush,
        agents,
        tokenMeter: new FakeTokenMeter(),
        now: () => 2_000,
      })
      const result = await manager.handoff({ runId: RunId('run-1'), sourceSession: parent })
      expect(result.status).toBe('handed-off')
      expect(result.mode).toBe('structured-brief')
      expect(agents.created).toHaveLength(1)
      expect(agents.created[0]?.followups).toHaveLength(1)
      expectNoForbiddenCalls(handoffCounters)
      recordedJournals.push({ scenario: 'handoff body rendering and delivery', calls: journalCounts(handoffCounters) })
    } finally {
      await handoffHarness.close()
    }

    const supervisorHarness = await harness()
    const supervisorCounters = installSpies(supervisorHarness.ctx)
    const agents = new FakeAgents(supervisorHarness.ctx)
    const flush = new FakeDurability()
    const supervisor = new RunSupervisor({
      ctx: supervisorHarness.ctx,
      store: supervisorHarness.store,
      sessions: flush,
      liveSessions: new FakeLiveSessions(),
      agents,
      now: () => 2_000,
    })
    try {
      const spec = taskSpec()
      const base = runRecord()
      await supervisorHarness.store.createTask(spec)
      await supervisorHarness.store.createRun(base)
      const operation = operationRecord()
      await supervisorHarness.store.planOperation(operation)
      const run = await supervisorHarness.store.updateRun(base.id, 0, {
        ...base,
        state: 'starting',
        operationId: operation.id,
        revision: 1,
        updatedAt: 1_001,
      })
      const settlement = supervisor.start({ run, task: spec, operationId: operation.id })
      const agent = await agents.waitForCreate()
      const prompt = await agent.waitForFollowup()
      await agent.waitForIdleWait()
      agent.emit(event('turn/start', 0, { turn: 1 }))
      agent.emit(event('user/message', 1, prompt))
      agent.emit(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }))
      agent.releaseIdle()
      expect(await settlement).toMatchObject({ state: 'succeeded', reason: 'completed' })
      expectNoForbiddenCalls(supervisorCounters)
      recordedJournals.push({ scenario: 'run supervision and settlement', calls: journalCounts(supervisorCounters) })
    } finally {
      for (const agent of agents.created) agent.releaseIdle()
      await supervisor.close()
      await supervisorHarness.close()
    }
  })
})

afterAll(async () => {
  const directory = fileURLToPath(new URL('./evidence/', import.meta.url))
  await mkdir(directory, { recursive: true })
  const payload = {
    baselineCommit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    generatedBy: 'tests/zero-llm.spec.ts',
    staticScan: {
      host: {
        files: sourceFiles(HOST_SRC).length,
        violations: scan(HOST_SRC, forbiddenModule, file => file === MODEL_WARDEN_SOURCE),
        llmServiceModules: sourceFiles(HOST_SRC).filter(namesLlmService).length,
      },
      client: {
        files: sourceFiles(CLIENT_SRC).length,
        violations: scan(CLIENT_SRC, specifier => (
          forbiddenModule(specifier)
          || specifier === '@deepseek-ai/dsh-llm'
          || specifier === '@deepseek-ai/dsh-tools'
          || specifier.startsWith('@deepseek-ai/dsh-agent')
          || specifier === '@deepseek-ai/dsh-session'
        )),
      },
    },
    runtimeJournals: recordedJournals,
  }
  await writeFile(
    fileURLToPath(new URL('./evidence/zero-llm.json', import.meta.url)),
    `${JSON.stringify(payload, null, 2)}\n`,
  )
})

/** One pending pressure snapshot for a closed parent Turn. */
function pendingPressure(session: Session): PressureSnapshot {
  return {
    sessionId: session.id,
    logRevision: session.seq,
    provider: 'mock',
    model: 'mock-model',
    totalTokens: 90_000,
    contextWindow: 128_000,
    ratio: 0.7,
    baselineKind: 'usage',
    threshold: 0.88,
    routeFingerprint: 'route-mock-mock-model',
    measuredAt: 1_000,
    decision: 'handoff-pending',
  }
}
