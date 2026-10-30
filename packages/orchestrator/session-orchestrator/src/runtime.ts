/**
 * Host runtime for the queue pipeline: the missing driver.
 *
 * The store, scheduler, supervisor and recovery manager are all passive: they
 * do exactly what a host asks, when a host asks. This module is that host. It
 * composes the four over the real Context, ticks them on a timer, samples three
 * health signals per running task, and executes the intervention transaction a
 * warden verdict asks for:
 *
 * ```text
 * tick ─┬─ normalize queue lifecycle (only `running` is dispatchable)
 *       ├─ LocalSessionOrchestrator.tick()      → start ready tasks
 *       └─ sample every running task
 *              ├ context ≥ ceiling → instruction → capture → children after parent → parent deferred
 *              ├ hit rate < warn    → instruction → capture → children appended, task keeps running
 *              ├ idle ≥ window      → one ping, then pause the queue
 *              └ hit rate < abort   → every queue aborted, live runs cancelled
 * ```
 *
 * Three facts this module owns and the rest of the package does not:
 *
 * - **A queue is inert unless its state is `running`.** `paused` mirrors that,
 *   so the planner never dispatches an idle, paused or aborted pipeline.
 * - **A decomposition is one model call, not two.** The instruction goes into
 *   the running conversation and its answer is parsed locally, so the produced
 *   prompt is visible in the session log and costs the task's own tokens.
 * - **Every intervention is idempotent by `(run, generation, kind)`.** A restart
 *   re-reads the record and continues from its phase instead of sending the
 *   instruction twice or inserting the same children again.
 *
 * The model warden is opt-in and additive. Rule mode — the default — never
 * touches the LLM service, and even in model mode the local rules keep the
 * safety floor and take over whenever a review is not due, times out, answers
 * off-contract or exhausts its budget. Each review writes one ledger row naming
 * the route that paid for it, so no token is spent without an audit trail.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { OperationId, QueueId, TaskId } from './brand.ts'
import type { RunId as RunIdType, TaskId as TaskIdType } from './brand.ts'
import { initialPromptOperationId } from './operation.ts'
import type {
  RunHandle,
  SessionDurability, SupervisorAgents, SupervisorLiveSessions, SupervisorPresets, SupervisorWorkspaces,
} from './supervisor.ts'
import { RunSupervisor as Supervisor } from './supervisor.ts'
import type { LocalSessionOrchestratorOptions } from './local.ts'
import { LocalSessionOrchestrator } from './local.ts'
import type {
  InterventionKind,
  InterventionRecord,
  QueueRecord,
  QueueState,
  RunHealth,
  RunRecord,
  TaskSpec,
  WardenAuditRecord,
  WardenFailureCode,
  WardenVerdict,
} from './types.ts'
import type { SessionOrchestrator } from './store.ts'
import type { DurableSessionReader } from './recovery.ts'
import { InterventionRecovery } from './intervention-recovery.ts'
import type { InterventionStep } from './intervention-recovery.ts'
import type { ModelReviewer } from './model-warden.ts'
import { WardenReviewError, createModelWarden } from './model-warden.ts'
import type { DshHostFeatureSupport, DshHostLiveSessions, DshHostWorkspaces } from './host-dsh.ts'
import type { HostSessionCapabilityReport } from './host-session.ts'
import { sessionOpenRoute } from './host-session.ts'
import { createDefaultHostSessionRegistry } from './host-registry.ts'
import type { HostSessionRegistry } from './host-registry.ts'
import type {
  Warden,
  WardenDecision,
  WardenPacket,
  WardenRecentEvent,
  WardenThresholds,
} from './warden.ts'
import {
  DEFAULT_DECOMPOSE_LIMITS,
  FIXED_DECOMPOSE_PROMPT,
  IDLE_PING_PROMPT,
  RuleWarden,
  interventionId,
  isHardGateVerdict,
  kindOfVerdict,
  protectHardGate,
  wardenAuditId,
} from './warden.ts'

/** Default context switch point: occupancy of the model window. */
export const DEFAULT_CONTEXT_CEILING = 0.6

/** Default silence window before the runtime probes a task. */
export const DEFAULT_IDLE_MS = 20 * 60 * 1000

/** Default cache-hit warn line. */
export const DEFAULT_HIT_RATE_WARN = 0.9

/** Default cache-hit abort line. */
export const DEFAULT_HIT_RATE_ABORT = 0.5

/** Default warden mode: the local rules, which spend no tokens. */
export const DEFAULT_WARDEN_MODE = 'rule'

/** Default interval between two model reviews of one run. */
export const DEFAULT_WARDEN_COOLDOWN_MS = 60_000

/** Default number of model reviews one run generation may spend. */
export const DEFAULT_WARDEN_MAX_REVIEWS = 20

/** Default deadline of one model review. */
export const DEFAULT_WARDEN_TIMEOUT_MS = 45_000

/** Default output cap of one model review. */
export const DEFAULT_WARDEN_MAX_OUTPUT_TOKENS = 400

/** Default packet cap of one model review, in UTF-8 bytes. */
export const DEFAULT_WARDEN_MAX_PACKET_BYTES = 8_000

/** Default number of review rows retained per run. */
export const DEFAULT_WARDEN_AUDIT_LIMIT = 20

/** Child states one bounded review packet may list. */
const PACKET_CHILD_LIMIT = 8

/** Longest reason kept in one review ledger row, in characters. */
const AUDIT_REASON_LIMIT = 300

/** Plugin configuration; every field has a production default. */
export const Config = z.object({
  /** How often the host drives `reconcile()`/`tick()` and samples health. */
  tickIntervalMs: z.natural().min(1000).default(5000),
  /** Context occupancy that triggers a hand-over. */
  contextCeiling: z.percent().default(DEFAULT_CONTEXT_CEILING),
  /** Silence, in milliseconds, after which a task is probed and then stopped. */
  idleMs: z.natural().min(60_000).default(DEFAULT_IDLE_MS),
  /** Cache hit rate below which a task is refined in place. */
  hitRateWarn: z.percent().default(DEFAULT_HIT_RATE_WARN),
  /** Cache hit rate below which every queue stops for good. */
  hitRateAbort: z.percent().default(DEFAULT_HIT_RATE_ABORT),
  /** Assistant calls required before a hit rate is judged at all. */
  minRateSamples: z.natural().min(1).default(3),
  /** Grace period after the idle ping before the queue is paused. */
  pingGraceMs: z.natural().min(10_000).default(5 * 60 * 1000),
  /** How long one decomposition instruction may take before it fails. */
  interventionTimeoutMs: z.natural().min(30_000).default(15 * 60 * 1000),
  /** Maximum child tasks one answer may produce. */
  maxTasks: z.natural().min(1).default(8),
  /** How deep a decomposition chain may go before the queue stops for a human. */
  maxDepth: z.natural().min(1).default(3),
  /** Maximum characters kept from one produced task prompt. */
  maxPromptChars: z.natural().min(200).default(2000),
  /** Minimum interval between two persisted health readings of one run. */
  healthWriteMs: z.natural().min(1000).default(15_000),
  /**
   * How many restart passes may try to reconcile one intervention before the
   * record fails with `retry-exhausted`. A live turn never consumes the budget.
   */
  interventionRecoveryAttempts: z.natural().min(1).default(3),
  /** Whether the runtime starts driving ticks as soon as the plugin mounts. */
  autoStart: z.boolean().default(true),
  /**
   * Which judge reviews running tasks.
   *
   * `rule` is the default and spends no tokens. `model` requires
   * {@link wardenProvider} and {@link wardenModel} and bills every review to
   * that route; a review that times out, answers off-contract or runs out of
   * budget falls back to the local rules and records the reason.
   */
  wardenMode: z.union(['rule', 'model'] as const).default(DEFAULT_WARDEN_MODE),
  /** Provider route that pays for model reviews; required in `model` mode. */
  wardenProvider: z.string().description('provider route billed for model warden reviews'),
  /** Exact model that pays for model reviews; required in `model` mode. */
  wardenModel: z.string().description('model billed for model warden reviews'),
  /** Reasoning effort passed with each review, when the route exposes one. */
  wardenReasoningEffort: z.string().description('reasoning effort of model warden reviews'),
  /** Minimum interval between two model reviews of one run. */
  wardenCooldownMs: z.natural().min(5_000).default(DEFAULT_WARDEN_COOLDOWN_MS),
  /** Model reviews one run generation may spend before the rules take over. */
  wardenMaxReviewsPerRun: z.natural().min(1).default(DEFAULT_WARDEN_MAX_REVIEWS),
  /** Deadline of one model review, after which it falls back to the rules. */
  wardenTimeoutMs: z.natural().min(5_000).default(DEFAULT_WARDEN_TIMEOUT_MS),
  /** Output cap of one model review. */
  wardenMaxOutputTokens: z.natural().min(64).default(DEFAULT_WARDEN_MAX_OUTPUT_TOKENS),
  /** Largest state packet, in UTF-8 bytes, one review may send. */
  wardenMaxPacketBytes: z.natural().min(1_000).default(DEFAULT_WARDEN_MAX_PACKET_BYTES),
  /** Review ledger rows retained per run; older rows are pruned. */
  wardenAuditLimit: z.natural().min(1).default(DEFAULT_WARDEN_AUDIT_LIMIT),
  /**
   * Explicit WorkBuddy headless CLI entry. Empty means discover the per-user
   * install; a configured path wins and makes the host report available.
   */
  hostWorkBuddyCli: z.string().default(''),
  /**
   * Explicit Trae launcher path. Empty means discover the per-user install;
   * a configured path still reports every conversation capability as disabled.
   */
  hostTraeCli: z.string().default(''),
})

/** Resolved runtime options; every field is present after config validation. */
export interface RuntimeOptions {
  readonly tickIntervalMs: number
  readonly contextCeiling: number
  readonly idleMs: number
  readonly hitRateWarn: number
  readonly hitRateAbort: number
  readonly minRateSamples: number
  readonly pingGraceMs: number
  readonly interventionTimeoutMs: number
  readonly maxTasks: number
  readonly maxDepth: number
  readonly maxPromptChars: number
  readonly healthWriteMs: number
  readonly interventionRecoveryAttempts: number
  readonly autoStart: boolean
  /** Which judge reviews running tasks; the default spends no tokens. */
  readonly wardenMode: 'rule' | 'model'
  /** Provider route billed for model reviews; validated when the mode is `model`. */
  readonly wardenProvider?: string
  /** Model billed for model reviews; validated when the mode is `model`. */
  readonly wardenModel?: string
  /** Reasoning effort passed with each review. */
  readonly wardenReasoningEffort?: string
  readonly wardenCooldownMs: number
  readonly wardenMaxReviewsPerRun: number
  readonly wardenTimeoutMs: number
  readonly wardenMaxOutputTokens: number
  readonly wardenMaxPacketBytes: number
  readonly wardenAuditLimit: number
  /** Explicit WorkBuddy CLI entry; empty means discover it. */
  readonly hostWorkBuddyCli: string
  /** Explicit Trae launcher path; empty means discover it. */
  readonly hostTraeCli: string
}

/** One assistant message captured for intervention parsing. */
interface AssistantRecord {
  /** Durable sequence number the message was appended at. */
  readonly seq: number
  /** Flattened text of the message. */
  readonly text: string
}

/** Everything the runtime remembers about one live session. */
interface SessionActivity {
  /** Epoch milliseconds of the last visible event of any kind. */
  lastActivityAt: number
  /** Whether a turn is open right now. */
  turnOpen: boolean
  /** Aggregate prompt tokens reported by the adapter. */
  promptTokens: number
  /** Cache-read tokens reported by the adapter. */
  cacheReadTokens: number
  /** Assistant calls observed, used to decide whether a hit rate is meaningful. */
  assistantCalls: number
  /** Last assistant messages, capped, for diagnostics. */
  assistant: AssistantRecord[]
  /**
   * The instruction currently waiting for its answer.
   *
   * Capture is scoped to the turn the instruction opens, not to a sequence
   * watermark: an instruction sent while the task's own turn is still running
   * would otherwise capture that turn's answer and hand the wrong text to the
   * decomposer.
   */
  pending?: {
    readonly id: string
    turn?: number
    readonly texts: string[]
  }
  /** Last visible events, capped, for the warden packet. */
  recent: WardenRecentEvent[]
  /** Tool calls observed, keyed by call id. */
  toolStarted: Map<string, { name: string; at: number }>
}

/** One sampled health reading plus the facts the gates need. */
interface Sample {
  readonly health: RunHealth
  readonly activity: SessionActivity
  /** Model route the run's conversation currently asks, when it names one. */
  readonly route?: { readonly provider: string; readonly model: string }
}

/** Which judge produced one action, and the route that paid for it. */
interface JudgedBy {
  readonly mode: 'rule' | 'model'
  readonly verdict: WardenVerdict
  readonly provider?: string
  readonly model?: string
}

/** One review ledger row to persist. */
interface AuditEntry {
  readonly run: RunRecord
  readonly mode: WardenAuditRecord['mode']
  readonly verdict: WardenVerdict
  readonly reason: string
  readonly provider?: string
  readonly model?: string
  readonly latencyMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly error?: WardenFailureCode
  readonly createdAt: number
}

/** A token meter, structurally. `ctx.tokenMeter` satisfies it. */
interface TokenMeterPort {
  measure(session: Session): {
    readonly totalTokens: number
    readonly baseline: { readonly kind: 'none' | 'estimated' | 'usage' }
  }
}

/** Host default model selection, structurally. `ctx.agentDefaultModel` satisfies it. */
interface ModelSelectionPort {
  currentSelection(): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: ReasoningEffortId
  }
}

/**
 * Fill a `inherit` model policy with the host's default selection.
 *
 * The supervisor only passes an explicit route when a task pins one, and a
 * session created without any selection cannot assemble its system prompt
 * (`{{model}}` has no value), so the first turn dies before it opens. A pipeline
 * task that inherits the model therefore needs the host default resolved by the
 * agent seam, not by mutating the task record.
 * @param agents - the host agent registry.
 * @param fallback - the host default selection, when the plugin is mounted.
 * @returns a port that injects the default only when the caller named no route.
 */
function defaultingAgents(
  agents: SupervisorAgents,
  fallback: ModelSelectionPort | undefined,
): SupervisorAgents {
  if (fallback === undefined) return agents
  const pick = (options: AgentOptions | undefined): AgentOptions => {
    const current = options ?? {}
    if (current.provider !== undefined || current.model !== undefined) return current
    const selection = fallback.currentSelection()
    return {
      ...current,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }
  const resume = agents.resume
  return {
    create: async (options: CreateAgentOptions) => await agents.create({
      ...options,
      agentOptions: pick(options.agentOptions),
    }),
    ...(resume === undefined
      ? {}
      : {
        resume: async (options: ResumeAgentOptions) => await resume({
          ...options,
          agentOptions: pick(options.agentOptions),
        }),
      }),
  }
}

/** Runtime lifecycle phase, for diagnostics. */
export type RuntimePhase = 'idle' | 'reconciling' | 'running' | 'closed'

/** The host runtime. Plain composition object, not a Cordis service. */
export class SessionOrchestratorRuntime {
  private readonly ctx: Context
  private readonly store: SessionOrchestrator
  private readonly supervisor: Supervisor
  private readonly orchestrator: LocalSessionOrchestrator
  private readonly ruleWarden: Warden
  private readonly modelWarden: ModelReviewer | undefined
  private readonly recovery: InterventionRecovery
  private readonly options: RuntimeOptions
  private readonly now: () => number
  private readonly meter: TokenMeterPort | undefined
  private readonly hosts: HostSessionRegistry | undefined
  private readonly activity = new Map<string, SessionActivity>()
  private readonly inFlight = new Set<string>()
  private readonly recovering = new Set<string>()
  private readonly healthWrittenAt = new Map<string, number>()
  private readonly pingedAt = new Map<string, number>()
  /** Runs with a model review in flight; a run never runs two at once. */
  private readonly reviewing = new Set<string>()
  /** Instant the last model review of one run started in this process. */
  private readonly reviewedAt = new Map<string, number>()
  /** Runs whose exhausted review budget was already recorded in the ledger. */
  private readonly budgetNoted = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private closed = false

  private phase: RuntimePhase = 'idle'
  private lastTickAt: number | undefined
  private lastError: string | undefined

  /**
   * @param options - host seams and gate thresholds.
   * @throws Error when the model warden mode names no model reviewer.
   */
  constructor(options: {
    readonly ctx: Context
    readonly store: SessionOrchestrator
    readonly supervisor: Supervisor
    readonly orchestrator: LocalSessionOrchestrator
    readonly config: RuntimeOptions
    readonly meter?: TokenMeterPort
    readonly durableSessions?: DurableSessionReader
    readonly warden?: Warden
    readonly modelWarden?: ModelReviewer
    readonly hosts?: HostSessionRegistry
    readonly now?: () => number
  }) {
    this.ctx = options.ctx
    this.store = options.store
    this.supervisor = options.supervisor
    this.orchestrator = options.orchestrator
    this.options = options.config
    this.now = options.now ?? (() => Date.now())
    this.meter = options.meter
    this.hosts = options.hosts
    const thresholds: WardenThresholds = {
      contextCeiling: options.config.contextCeiling,
      idleMs: options.config.idleMs,
      hitRateWarn: options.config.hitRateWarn,
      hitRateAbort: options.config.hitRateAbort,
      minRateSamples: options.config.minRateSamples,
    }
    this.ruleWarden = options.warden ?? new RuleWarden(thresholds)
    // The configured mode is authoritative: an injected reviewer never runs a
    // model call while the pipeline is in its default rule mode.
    this.modelWarden = options.config.wardenMode === 'model' ? options.modelWarden : undefined
    if (options.config.wardenMode === 'model' && this.modelWarden === undefined) {
      throw new Error('wardenMode "model" needs a model reviewer; configure wardenProvider and wardenModel or keep wardenMode "rule"')
    }
    this.recovery = new InterventionRecovery({
      store: options.store,
      ...(options.durableSessions === undefined ? {} : { durableSessions: options.durableSessions }),
      now: this.now,
      maxAttempts: options.config.interventionRecoveryAttempts,
      limits: {
        maxTasks: options.config.maxTasks,
        maxPromptChars: options.config.maxPromptChars,
      },
    })
  }

  /** Current lifecycle phase. */
  get state(): RuntimePhase {
    return this.phase
  }

  /** Last completed tick, or `undefined` before the first one. */
  get lastTick(): number | undefined {
    return this.lastTickAt
  }

  /** Last tick failure, cleared by the next successful tick. */
  get error(): string | undefined {
    return this.lastError
  }

  /**
   * Capability matrix of every host this process knows.
   *
   * The settings page projects this read-only report; an absent registry (a
   * hand-built test runtime) contributes no rows rather than inventing hosts.
   * @returns primary first, then the remaining hosts.
   */
  hostReports(): readonly HostSessionCapabilityReport[] {
    return this.hosts?.reports() ?? []
  }

  /**
   * Install the session listener and begin driving ticks.
   *
   * Reconciliation runs before the first tick, so a restart observes the durable
   * attempts instead of dispatching them again.
   * @returns a promise that resolves once reconciliation finished.
   */
  async start(): Promise<void> {
    if (this.closed) return
    this.ctx.effect(() => {
      const off = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        this.observe(session, event)
      })
      return () => {
        off()
      }
    }, 'sessionOrchestratorRuntime.sessionEvents')
    // Agent failures are contained by the loop, so nothing else reports them.
    // Keep one line per failure in the host log; the run record carries the
    // stable code, but the cause is only visible here.
    this.ctx.effect(() => {
      const bus = this.ctx as unknown as {
        on(name: string, listener: (payload: unknown) => void): () => void
      }
      const off = bus.on('agent/error', (payload: unknown) => {
        const error = (payload as { error?: unknown } | undefined)?.error
        console.error('[session-orchestrator-runtime] agent error:', messageOf(error))
      })
      return () => {
        off()
      }
    }, 'sessionOrchestratorRuntime.agentErrors')
    this.phase = 'reconciling'
    try {
      await this.orchestrator.reconcile()
    } catch (error) {
      this.lastError = messageOf(error)
    }
    if (this.closed) return
    // Reconcile interventions before the first dispatch: a task whose remainder
    // is already in the log must have its children inserted, and a task that
    // received its instruction must never receive it a second time.
    try {
      await this.recoverInterventions({ countAttempt: true })
    } catch (error) {
      this.lastError = messageOf(error)
    }
    if (this.closed) return
    this.phase = 'running'
    if (this.options.autoStart) this.startTimer()
  }

  /**
   * Reconcile every unfinished intervention from durable evidence.
   *
   * A restart pass consumes one retry per record that still cannot progress;
   * the per-tick pass never does, because a long turn is not a failure. The
   * method is public so a host can run it before opening the scheduler gate.
   * @param options - `countAttempt` only on a genuine restart.
   * @returns resolution after every record was examined.
   */
  async recoverInterventions(options: { readonly countAttempt?: boolean } = {}): Promise<void> {
    if (this.closed) return
    for (const record of [...this.store.listInterventions()]) {
      if (record.phase === 'settled' || record.phase === 'failed') continue
      // Only a decomposition transaction owns a fixed instruction and child
      // insertion. An idle probe or a stop record must never be parsed as an
      // answer; the live gate re-evaluates those on its own.
      if (record.kind !== 'pause-context' && record.kind !== 'decompose' && record.kind !== 'refine') continue
      if (this.recovering.has(record.id) || this.inFlight.has(`${record.runId}:${record.kind}`)) continue
      const run = this.store.getRun(record.runId)
      const task = this.store.getTask(record.taskId)
      if (run === undefined) {
        await this.recovery.fail(record, 'run-missing', `run '${record.runId}' is not stored`)
        continue
      }
      if (task === undefined) {
        await this.recovery.fail(record, 'task-missing', `task '${record.taskId}' is not stored`)
        continue
      }
      const queue = this.store.getQueue(task.queueId)
      if (queue === undefined) {
        await this.recovery.fail(record, 'queue-missing', `queue '${task.queueId}' is not stored`)
        continue
      }
      let step: InterventionStep
      try {
        step = await this.recovery.resume(record, options)
      } catch (error) {
        // A concurrent supervisor write may win the phase CAS; the next pass
        // reads the record again instead of failing the intervention.
        console.error('[session-orchestrator-runtime] intervention recovery failed:', messageOf(error))
        continue
      }
      await this.applyStep(step, run, true, options.countAttempt === true)
    }
  }

  /**
   * Start the tick timer if it is not running.
   * @returns nothing.
   */
  startTimer(): void {
    if (this.timer !== undefined || this.closed) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.options.tickIntervalMs)
    this.timer.unref?.()
  }

  /**
   * Run one tick now, for a Remote-triggered start or a test.
   * @returns resolution after the tick finished.
   */
  async tick(): Promise<void> {
    if (this.closed || this.ticking) return
    this.ticking = true
    try {
      await this.tickOnce()
      this.lastError = undefined
    } catch (error) {
      this.lastError = messageOf(error)
      // A swallowed tick failure looks exactly like a quiet pipeline; keep it
      // visible in the host log because the settings page only shows records.
      console.error('[session-orchestrator-runtime] tick failed:', this.lastError)
    } finally {
      this.lastTickAt = this.now()
      this.ticking = false
    }
  }

  /**
   * Stop ticking and release the orchestration composition.
   * @returns resolution after the supervisor and domain settled.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.phase = 'closed'
    await this.orchestrator.close()
  }

  /**
   * One tick: make queue lifecycle authoritative, dispatch, then police health.
   *
   * Dispatch runs before the health pass so a task that just finished frees its
   * workspace key for the next ready task in the same tick.
   * @returns resolution after the pass.
   */
  private async tickOnce(): Promise<void> {
    const settings = this.store.getSettings()
    if (settings.paused) return
    await this.normalizeQueues()
    await this.orchestrator.tick()
    // A detached answer wait can finish between ticks; the tick pass also
    // resumes a record whose session became readable again. It never consumes
    // a retry: a long turn is not a failure.
    await this.recoverInterventions({ countAttempt: false })
    await this.policeHealth()
  }

  /**
   * Make `paused` agree with `state` for every queue.
   *
   * The planner only reads `paused`; the pipeline only reads `state`. Keeping
   * them equal here means an idle, paused or aborted queue can never dispatch,
   * whatever wrote it.
   * @returns resolution after every mismatch was repaired.
   */
  private async normalizeQueues(): Promise<void> {
    for (const queue of this.store.listQueues()) {
      const shouldPause = queue.state !== 'running'
      if (queue.paused === shouldPause) continue
      await this.writeQueue(queue, { paused: shouldPause })
    }
  }

  /**
   * Sample and judge every running task.
   *
   * The local rules always run first and cost nothing. A rule verdict that hits
   * a safety gate acts immediately; otherwise an opt-in model review may decide,
   * within its cooldown and budget, and the review never blocks this pass.
   * @returns resolution after each verdict was dispatched.
   */
  private async policeHealth(): Promise<void> {
    for (const run of this.store.listRuns()) {
      if (run.state !== 'running') continue
      const sample = this.sample(run)
      if (sample === undefined) continue
      await this.persistHealth(run, sample.health)
      const task = this.store.getTask(run.taskId)
      const queue = task === undefined ? undefined : this.store.getQueue(task.queueId)
      if (task === undefined || queue === undefined) continue
      const packet = this.packet(run, task, queue, sample)
      const rule = this.ruleWarden.review(packet)
      this.judge(run, task, queue, sample, packet, rule)
    }
  }

  /**
   * Decide whether the rules or a model review owns this sample.
   *
   * A hard rule verdict acts at once: the context ceiling and the abort line are
   * durable facts, and waiting for a review would weaken them. Every other
   * sample either starts one detached review or falls back to the rules when the
   * review is not due or its budget is spent.
   * @param run - the running attempt.
   * @param task - its task definition.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param packet - the bounded state packet.
   * @param rule - the verdict the local rules produced.
   * @returns nothing; the chosen action runs detached.
   */
  private judge(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    packet: WardenPacket,
    rule: WardenDecision,
  ): void {
    const ruleJudge: JudgedBy = { mode: 'rule', verdict: rule.verdict }
    const model = this.modelWarden
    if (model === undefined || isHardGateVerdict(rule.verdict)) {
      this.dispatch(run, task, queue, sample, rule.verdict, rule.reason, ruleJudge)
      return
    }
    // A review already owns this run; it dispatches its own verdict or the rule
    // fallback when it settles.
    if (this.reviewing.has(run.id)) return
    if (!this.reviewDue(run, rule)) {
      this.dispatch(run, task, queue, sample, rule.verdict, rule.reason, ruleJudge)
      return
    }
    const startedAt = this.now()
    this.reviewedAt.set(run.id, startedAt)
    this.reviewing.add(run.id)
    void model.review(packet)
      .then(async (review) => {
        await this.audit({
          run,
          mode: 'model',
          verdict: review.decision.verdict,
          reason: review.decision.reason,
          provider: review.provider,
          model: review.model,
          latencyMs: review.latencyMs,
          ...(review.inputTokens === undefined ? {} : { inputTokens: review.inputTokens }),
          ...(review.outputTokens === undefined ? {} : { outputTokens: review.outputTokens }),
          createdAt: startedAt,
        })
        this.applyReview(run, task, queue, sample, rule, review.decision, {
          mode: 'model',
          verdict: review.decision.verdict,
          provider: review.provider,
          model: review.model,
        })
      })
      .catch(async (error: unknown) => {
        const code: WardenFailureCode = error instanceof WardenReviewError ? error.code : 'unavailable'
        await this.audit({
          run,
          mode: 'rule-fallback',
          verdict: rule.verdict,
          reason: rule.reason,
          error: code,
          createdAt: startedAt,
        })
        this.applyReview(run, task, queue, sample, rule, rule, ruleJudge)
      })
      .finally(() => {
        this.reviewing.delete(run.id)
      })
  }

  /**
   * Act on the chosen verdict once a review settled.
   *
   * The review is asynchronous, so the attempt may have moved on. A run that is
   * no longer `running` keeps its ledger row but receives no action.
   * @param run - the attempt the review observed.
   * @param task - its task definition.
   * @param queue - its queue.
   * @param sample - the reading the review saw.
   * @param rule - the verdict the local rules produced.
   * @param judged - the verdict that will be used.
   * @param judge - which judge produced it.
   * @returns nothing; the action runs detached.
   */
  private applyReview(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    rule: WardenDecision,
    judged: WardenDecision,
    judge: JudgedBy,
  ): void {
    if (this.closed) return
    const current = this.store.getRun(run.id)
    if (current === undefined || current.state !== 'running') return
    const verdict = protectHardGate(rule, judged)
    this.dispatch(current, task, queue, sample, verdict.verdict, verdict.reason, judge)
  }

  /**
   * Whether a model review of one run is due now.
   *
   * A review is due once the cooldown elapsed since the last one and the run's
   * review budget is not spent. A spent budget is recorded once per generation,
   * then the rules own every later sample of that run.
   * @param run - the running attempt.
   * @param rule - the local verdict, recorded with an exhausted-budget row.
   * @returns whether to start a review.
   */
  private reviewDue(run: RunRecord, rule: WardenDecision): boolean {
    const last = this.reviewedAt.get(run.id) ?? this.lastAuditAt(run.id)
    if (last !== undefined && this.now() - last < this.options.wardenCooldownMs) return false
    if (this.modelReviewCount(run) >= this.options.wardenMaxReviewsPerRun) {
      this.noteBudgetExhausted(run, rule)
      return false
    }
    return true
  }

  /**
   * Record one exhausted review budget per run generation.
   * @param run - the running attempt.
   * @param rule - the local verdict that takes over.
   * @returns nothing; the row is written detached.
   */
  private noteBudgetExhausted(run: RunRecord, rule: WardenDecision): void {
    const key = `${run.id}:g${run.generation}`
    if (this.budgetNoted.has(key)) return
    this.budgetNoted.add(key)
    void this.audit({
      run,
      mode: 'rule-fallback',
      verdict: rule.verdict,
      reason: rule.reason,
      error: 'budget-exhausted',
      createdAt: this.now(),
    })
  }

  /**
   * Count the model reviews one run generation already spent.
   * @param run - the running attempt.
   * @returns reviews recorded in the ledger for this run and generation.
   */
  private modelReviewCount(run: RunRecord): number {
    let count = 0
    for (const row of this.store.listWardenAudits()) {
      if (row.runId !== run.id || row.generation !== run.generation) continue
      if (row.mode === 'model') count += 1
    }
    return count
  }

  /**
   * Latest review instant of one run, from the durable ledger.
   * @param runId - run identity.
   * @returns epoch milliseconds, or `undefined` before the first row.
   */
  private lastAuditAt(runId: string): number | undefined {
    let latest: number | undefined
    for (const row of this.store.listWardenAudits()) {
      if (row.runId !== runId) continue
      if (latest === undefined || row.createdAt > latest) latest = row.createdAt
    }
    return latest
  }

  /**
   * Persist one review ledger row, then prune the run's older rows.
   *
   * The ledger is an audit trail, never a gate input, so a write failure is
   * logged and dropped instead of interrupting the tick or the review.
   * @param entry - the row to record.
   * @returns resolution after the write and pruning attempt.
   */
  private async audit(entry: AuditEntry): Promise<void> {
    if (this.closed) return
    const record: WardenAuditRecord = {
      id: wardenAuditId(entry.run.id, entry.run.generation, entry.createdAt),
      runId: entry.run.id,
      taskId: entry.run.taskId,
      generation: entry.run.generation,
      mode: entry.mode,
      verdict: entry.verdict,
      reason: entry.reason.slice(0, AUDIT_REASON_LIMIT),
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
      ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
      ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      createdAt: entry.createdAt,
    }
    try {
      await this.store.recordWardenAudit(record)
    } catch (error) {
      console.error('[session-orchestrator-runtime] warden audit failed:', messageOf(error))
      return
    }
    await this.pruneAudits(entry.run.id)
  }

  /**
   * Drop the oldest review rows of one run beyond the retention limit.
   * @param runId - run identity.
   * @returns resolution after every deletion attempt.
   */
  private async pruneAudits(runId: string): Promise<void> {
    const rows = this.store.listWardenAudits().filter(row => row.runId === runId)
    const excess = rows.length - this.options.wardenAuditLimit
    if (excess <= 0) return
    const oldest = [...rows].sort((left, right) => left.createdAt - right.createdAt).slice(0, excess)
    for (const row of oldest) {
      try {
        await this.store.deleteWardenAudit(row.id)
      } catch (error) {
        console.error('[session-orchestrator-runtime] warden audit prune failed:', messageOf(error))
      }
    }
  }

  /**
   * Run one verdict detached, so a slow transaction never stalls the tick.
   * @param run - the running attempt.
   * @param task - its task definition.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param verdict - the warden verdict.
   * @param reason - its human-readable reason.
   * @param judge - which judge produced it.
   * @returns nothing.
   */
  private dispatch(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    verdict: WardenVerdict,
    reason: string,
    judge: JudgedBy,
  ): void {
    // Never await an intervention inside the tick: one instruction can wait
    // minutes for its answer, and a blocked tick would stop dispatch and
    // health sampling for every other queue.
    void this.act(run, task, queue, sample, verdict, reason, judge)
      .catch((error: unknown) => {
        console.error('[session-orchestrator-runtime] intervention failed:', messageOf(error))
      })
  }

  /**
   * Execute one verdict, at most once per `(run, generation, kind)`.
   * @param run - the running attempt.
   * @param task - its task definition.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param verdict - the warden verdict.
   * @param reason - its human-readable reason.
   * @param judge - which judge produced it.
   * @returns resolution after the action settled or was refused.
   */
  private async act(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    verdict: WardenVerdict,
    reason: string,
    judge: JudgedBy,
  ): Promise<void> {
    const kind = kindOfVerdict(verdict)
    if (kind === undefined) return
    const key = `${run.id}:${kind}`
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    try {
      if (verdict === 'abort-all') {
        await this.abortAll(run, task, sample, reason, judge)
        return
      }
      if (verdict === 'stop-and-notify') {
        await this.probeOrStop(run, task, queue, sample, reason, judge)
        return
      }
      if (verdict === 'decompose' && this.depthOf(task) >= this.options.maxDepth) {
        await this.stopAtDepth(run, task, queue, sample, reason, judge)
        return
      }
      await this.intervene(run, task, sample, kind, reason, judge)
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * Pause-and-hand-over (or refine in place) transaction.
   *
   * The run is never written to `paused`: the supervisor owns that record and a
   * competing CAS would make its own settlement fail. The instruction is sent
   * into the live conversation, the answer is captured from the event stream,
   * children are inserted after the parent, and only then is a hand-over run
   * closed as `deferred`.
   * @param run - the running attempt.
   * @param task - its task.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param kind - `pause-context` for a hand-over, `refine` to keep running.
   * @param reason - why the host acted.
   * @param judge - which judge produced the verdict.
   * @returns resolution after the transaction settled.
   */
  private async intervene(
    run: RunRecord,
    task: TaskSpec,
    sample: Sample,
    kind: InterventionKind,
    reason: string,
    judge: JudgedBy,
  ): Promise<void> {
    const id = interventionId(run.id, run.generation, kind)
    const existing = this.store.getIntervention(id)
    if (existing !== undefined && (existing.phase === 'settled' || existing.phase === 'failed')) return

    const handle = this.supervisor.ownedHandles.get(run.id)
    const sessionId = handle?.sessionId
      ?? (run.activeSessionId === undefined ? undefined : SessionId(run.activeSessionId))
    if (sessionId === undefined) {
      await this.failIntervention(id, run, task, sample, kind, reason, 'session-missing: the run names no session', judge)
      return
    }
    await this.enter(run, task, sample, kind, reason, sessionId, false, judge)
  }

  /**
   * Enter or resume one intervention transaction.
   *
   * The persisted phase decides what happens: `planned` may send, `prompt-sent`
   * re-reads the log, `prompt-captured` inserts, `children-inserted` reconciles.
   * Nothing here writes the run to `paused`; the supervisor owns that record.
   * @param run - the attempt the intervention belongs to.
   * @param task - its task definition.
   * @param sample - the reading that produced the verdict, for a new record.
   * @param kind - intervention family.
   * @param reason - why the host acted.
   * @param sessionId - session the instruction goes to.
   * @param detached - launch the answer wait instead of awaiting it in place.
   * @param judge - which judge produced the verdict.
   * @returns resolution after the step this entry produced was applied.
   */
  private async enter(
    run: RunRecord,
    task: TaskSpec,
    sample: Sample,
    kind: InterventionKind,
    reason: string,
    sessionId: SessionId,
    detached: boolean,
    judge: JudgedBy,
  ): Promise<void> {
    const id = interventionId(run.id, run.generation, kind)
    const record = this.store.getIntervention(id)
      ?? await this.record(run, task, sample, kind, reason, 'planned', undefined, sessionId, judge)
    const step = await this.recovery.resume(record, { countAttempt: false })
    await this.applyStep(step, run, detached, false)
  }

  /**
   * Apply one durable recovery step.
   *
   * A `not-started` step is the only one that sends the instruction; every
   * later phase reads evidence and never repeats the send. A live answer wait
   * is detached from ticks and from startup, because one answer may take
   * minutes and must not stall scheduling or health sampling.
   * @param step - phase decision from the recovery coordinator.
   * @param run - attempt the intervention belongs to.
   * @param detached - launch the wait instead of awaiting it.
   * @param countAttempt - whether a stalled record consumes one restart retry.
   * @returns resolution after the step was applied.
   */
  private async applyStep(
    step: InterventionStep,
    run: RunRecord,
    detached: boolean,
    countAttempt: boolean,
  ): Promise<void> {
    switch (step.kind) {
      case 'settled':
      case 'failed':
      case 'unchanged':
        return
      case 'not-started': {
        const handle = this.supervisor.ownedHandles.get(run.id)
        if (handle !== undefined) {
          const sent = await this.sendInstruction(step.record, run, handle)
          if (sent === undefined) return
          await this.captureAnswer(sent, run, handle, sent.sessionId ?? handle.sessionId, detached)
          return
        }
        if (!this.canContinue(run.state)) {
          // No side effect was ever performed, so settling is the honest end.
          await this.recovery.abandon(step.record, 'the run ended before the instruction was sent')
        }
        return
      }
      case 'awaiting-answer': {
        const handle = this.supervisor.ownedHandles.get(run.id)
        if (handle === undefined && !this.canContinue(run.state)) {
          await this.recovery.stall(step.record, countAttempt, 'answer-missing',
            'the instruction turn is open but no live owner can append its answer')
          return
        }
        await this.captureAnswer(step.record, run, handle, step.sessionId, detached, step.turn)
        return
      }
    }
  }

  /**
   * Send the fixed instruction and persist `prompt-sent` in one step.
   * @param record - planned intervention.
   * @param run - the attempt.
   * @param handle - the live handle that owns the conversation.
   * @returns the advanced record, or `undefined` when the send was rejected.
   */
  private async sendInstruction(
    record: InterventionRecord,
    run: RunRecord,
    handle: RunHandle,
  ): Promise<InterventionRecord | undefined> {
    const message = createUserMessage({
      content: [{ type: 'text', text: FIXED_DECOMPOSE_PROMPT }],
      source: {
        kind: 'session-orchestrator',
        operationId: run.operationId ?? initialPromptOperationId(run),
        runId: run.id,
        generation: run.generation,
        attempt: run.attempt,
        intervention: record.id,
      },
    })
    try {
      handle.handle.agent.followup(message)
    } catch (error) {
      await this.recovery.fail(record, 'instruction-rejected', messageOf(error))
      return undefined
    }
    try {
      return await this.recovery.markPromptSent(record, FIXED_DECOMPOSE_PROMPT, handle.sessionId)
    } catch {
      // The instruction is already in the log; adopt whatever phase won the CAS.
      return this.store.getIntervention(record.id)
    }
  }

  /**
   * Wait for the instruction turn and persist its answer.
   * @param record - intervention at `prompt-sent`.
   * @param run - the attempt.
   * @param handle - the live handle, when this process owns one.
   * @param sessionId - session that received the instruction.
   * @param detached - launch the wait instead of awaiting it.
   * @param turn - turn already known, when the log proved it.
   * @returns resolution after the answer was captured, or after the wait began.
   */
  private async captureAnswer(
    record: InterventionRecord,
    run: RunRecord,
    handle: RunHandle | undefined,
    sessionId: SessionId,
    detached: boolean,
    turn?: number,
  ): Promise<void> {
    const id = record.id
    const watch = async (): Promise<void> => {
      if (this.recovering.has(id)) return
      this.recovering.add(id)
      try {
        this.beginCapture(sessionId, id, turn)
        if (turn !== undefined) {
          // A resumed instruction turn opened before this process subscribed;
          // its `turn/start` is historical. Track it as open until the live
          // `turn/end` arrives, so a partial answer is never captured.
          const activity = this.activity.get(sessionId) ?? this.blankActivity(this.now())
          activity.turnOpen = true
          this.activity.set(sessionId, activity)
        }
        const answered = await this.awaitAnswer(handle?.handle, sessionId, run.id, id)
        const observedTurn = this.activity.get(sessionId)?.pending?.turn ?? turn
        const produced = this.collectCapture(sessionId)
        this.endCapture(sessionId)
        // Teardown closed the store while this wait was parked; never write to
        // a closed domain from a detached watcher.
        if (this.closed) return
        if (!answered || produced === '') {
          // The turn may have closed while we waited; durable evidence can
          // still settle it. Without an answer the record stays `prompt-sent`.
          await this.recovery.resume(record, { countAttempt: false })
          return
        }
        const captured = await this.recovery.capture(record, produced, observedTurn)
        await this.recovery.resume(captured, { countAttempt: false })
      } finally {
        this.recovering.delete(id)
      }
    }
    if (!detached) {
      await watch()
      return
    }
    void watch().catch((error: unknown) => {
      console.error('[session-orchestrator-runtime] intervention answer wait failed:', messageOf(error))
    })
  }

  /**
   * Whether a run may still produce visible session events.
   * @param state - stored run state.
   * @returns false for terminal attempts.
   */
  private canContinue(state: RunRecord['state']): boolean {
    return state !== 'succeeded'
      && state !== 'failed'
      && state !== 'cancelled'
      && state !== 'deferred'
  }

  /**
   * Stop a decomposition chain that reached its depth limit.
   *
   * Without this a task can decompose into another task that decomposes again,
   * forever, each generation spending the task's own tokens. The queue pauses
   * and the record says why, so a human decides the next move.
   * @param run - the attempt that hit the limit.
   * @param task - its task.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param reason - why the host acted.
   * @param judge - which judge produced the verdict.
   * @returns resolution after the queue paused and the record settled.
   */
  private async stopAtDepth(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    reason: string,
    judge: JudgedBy,
  ): Promise<void> {
    const id = interventionId(run.id, run.generation, 'stop-and-notify')
    if (this.store.getIntervention(id) !== undefined) return
    await this.pauseQueue(queue, 'paused')
    await this.record(
      run,
      task,
      sample,
      'stop-and-notify',
      reason,
      'settled',
      `decomposition depth limit ${this.options.maxDepth} reached; queue paused for a human`,
      undefined,
      judge,
    )
  }

  /**
   * Count how many decompositions produced one task.
   * @param task - the task to measure.
   * @returns the depth, `0` for an original task.
   */
  private depthOf(task: TaskSpec): number {
    let depth = 0
    let current: TaskSpec | undefined = task
    const seen = new Set<string>([task.id])
    while (current?.parentTaskId !== undefined && depth < 32) {
      const parentId = current.parentTaskId
      if (seen.has(parentId)) break
      seen.add(parentId)
      const parent = this.store.getTask(TaskId(parentId))
      depth += 1
      current = parent
    }
    return depth
  }

  /**
   * Probe a silent task once, then pause its queue when it stays silent.
   * @param run - the running attempt.
   * @param task - its task.
   * @param queue - its queue.
   * @param sample - the reading that produced the verdict.
   * @param reason - why the host acted.
   * @param judge - which judge produced the verdict.
   * @returns resolution after the probe or the pause.
   */
  private async probeOrStop(
    run: RunRecord,
    task: TaskSpec,
    queue: QueueRecord,
    sample: Sample,
    reason: string,
    judge: JudgedBy,
  ): Promise<void> {
    const id = interventionId(run.id, run.generation, 'pause-idle')
    const existing = this.store.getIntervention(id)
    if (existing === undefined) {
      const handle = this.supervisor.ownedHandles.get(run.id)
      if (handle === undefined) {
        await this.failIntervention(id, run, task, sample, 'pause-idle', reason, 'no live handle owns this run', judge)
        return
      }
      const record = await this.record(run, task, sample, 'pause-idle', reason, 'planned', undefined, undefined, judge)
      try {
        handle.handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: IDLE_PING_PROMPT }],
          source: {
            kind: 'session-orchestrator',
            operationId: run.operationId ?? initialPromptOperationId(run),
            runId: run.id,
            generation: run.generation,
            attempt: run.attempt,
            intervention: id,
          },
        }))
        this.pingedAt.set(run.id, this.now())
        await this.advance(record, record.phase, { phase: 'prompt-sent', promptSent: IDLE_PING_PROMPT })
      } catch (error) {
        await this.failIntervention(id, run, task, sample, 'pause-idle', reason, messageOf(error), judge, 'planned', record)
      }
      return
    }
    if (existing.phase === 'failed' || existing.phase === 'settled') return
    const pinged = this.pingedAt.get(run.id)
    const baseline = pinged ?? existing.createdAt
    if (this.now() - baseline < this.options.pingGraceMs) return
    if (sample.activity.lastActivityAt > baseline) {
      // The probe was answered: clear the record so a later silence probes again.
      await this.advance(existing, existing.phase, { phase: 'settled', note: 'probe answered' })
      this.pingedAt.delete(run.id)
      return
    }
    await this.pauseQueue(queue, 'paused')
    await this.advance(existing, existing.phase, { phase: 'settled', note: `queue paused: ${reason}` })
    this.pingedAt.delete(run.id)
  }

  /**
   * Abort every queue and cancel every live run.
   * @param run - the attempt that triggered the abort.
   * @param task - its task.
   * @param sample - the reading that produced the verdict.
   * @param reason - why the host acted.
   * @param judge - which judge produced the verdict.
   * @returns resolution after the settings and queues are durable.
   */
  private async abortAll(
    run: RunRecord,
    task: TaskSpec,
    sample: Sample,
    reason: string,
    judge: JudgedBy,
  ): Promise<void> {
    for (const queue of this.store.listQueues()) {
      if (queue.state === 'aborted' && queue.paused) continue
      await this.writeQueue(queue, { state: 'aborted', paused: true })
    }
    await this.pauseHost()
    for (const live of this.store.listRuns()) {
      if (live.state !== 'running') continue
      this.supervisor.cancel(live.id)
    }
    const id = interventionId(run.id, run.generation, 'abort-all')
    if (this.store.getIntervention(id) !== undefined) return
    await this.record(run, task, sample, 'abort-all', reason, 'settled', undefined, undefined, judge)
  }

  /**
   * Read the health of one running attempt.
   * @param run - the running attempt.
   * @returns the sampled health and the conversation route, or `undefined` when its session is unknown.
   */
  private sample(run: RunRecord): Sample | undefined {
    const sessionId = run.activeSessionId
    if (sessionId === undefined) return undefined
    const activity = this.activity.get(sessionId) ?? this.blankActivity(this.now())
    const session = this.liveSessions.get(SessionId(sessionId))
    let contextRatio: number | undefined
    let contextWindow: number | undefined
    let baselineKind: 'none' | 'estimated' | 'usage' = 'none'
    let route: { readonly provider: string; readonly model: string } | undefined
    if (session !== undefined) {
      try {
        const context = session.requestContext()
        if (context !== undefined) route = { provider: context.provider, model: context.model }
      } catch {
        // A Session without a bound request context names no paying route.
      }
    }
    if (route === undefined && run.configSnapshot !== undefined) {
      route = { provider: run.configSnapshot.provider, model: run.configSnapshot.model }
    }
    if (session !== undefined && this.meter !== undefined) {
      try {
        const measured = this.meter.measure(session)
        baselineKind = measured.baseline.kind
        const capacity = session.requestContext()?.contextWindow
        if (capacity !== undefined && capacity > 0) {
          contextWindow = capacity
          contextRatio = measured.totalTokens / capacity
        }
      } catch {
        baselineKind = 'none'
      }
    }
    const cacheHitRate = activity.assistantCalls >= this.options.minRateSamples
      && activity.promptTokens > 0
      ? Math.min(1, activity.cacheReadTokens / activity.promptTokens)
      : undefined
    const sampledAt = this.now()
    const health: RunHealth = {
      idleMs: Math.max(0, sampledAt - activity.lastActivityAt),
      lastActivityAt: activity.lastActivityAt,
      turnOpen: activity.turnOpen,
      baselineKind,
      sampledAt,
      ...(contextRatio === undefined ? {} : { contextRatio }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
    }
    return { health, activity, ...(route === undefined ? {} : { route }) }
  }

  /**
   * Build the bounded packet one review sees.
   * @param run - the running attempt.
   * @param task - its task.
   * @param queue - its queue.
   * @param sample - the reading.
   * @returns the packet.
   */
  private packet(run: RunRecord, task: TaskSpec, queue: QueueRecord, sample: Sample): WardenPacket {
    const children = this.store.listTasks()
      .filter(candidate => candidate.parentTaskId === task.id)
      .slice(0, PACKET_CHILD_LIMIT)
      .map(candidate => {
        const state = this.latestRunState(candidate.id)
        return { title: candidate.title, state: state ?? 'queued' }
      })
    return {
      queue: { brief: (queue.brief ?? queue.title).slice(0, 400), state: queue.state },
      task: {
        title: task.title,
        prompt: task.prompt.slice(0, 800),
        generation: run.generation,
        ...(task.stage === undefined ? {} : { stage: task.stage }),
      },
      health: {
        ...(sample.health.contextRatio === undefined ? {} : { contextRatio: sample.health.contextRatio }),
        ...(sample.health.contextWindow === undefined ? {} : { contextWindow: sample.health.contextWindow }),
        ...(sample.health.cacheHitRate === undefined ? {} : { cacheHitRate: sample.health.cacheHitRate }),
        idleMs: sample.health.idleMs,
        elapsedMs: Math.max(0, this.now() - run.createdAt),
        turnOpen: sample.health.turnOpen,
        ceiling: this.options.contextCeiling,
        idleLimitMs: this.options.idleMs,
        hitRateWarn: this.options.hitRateWarn,
        hitRateAbort: this.options.hitRateAbort,
      },
      recent: sample.activity.recent.slice(-5),
      children,
    }
  }

  /**
   * Persist a health reading, rate-limited per run.
   *
   * A concurrent supervisor write wins the CAS; the reading is then simply
   * dropped, because the next tick samples again.
   * @param run - the running attempt.
   * @param health - the reading to store.
   * @returns resolution after the attempt to persist.
   */
  private async persistHealth(run: RunRecord, health: RunHealth): Promise<void> {
    const last = this.healthWrittenAt.get(run.id) ?? 0
    if (this.now() - last < this.options.healthWriteMs) return
    this.healthWrittenAt.set(run.id, this.now())
    try {
      const latest = this.store.getRun(run.id)
      if (latest === undefined || latest.state !== 'running') return
      await this.store.updateRun(latest.id, latest.revision, {
        ...latest,
        health,
        revision: latest.revision + 1,
        updatedAt: this.now(),
      })
    } catch {
      // A concurrent supervisor write is authoritative; the next tick re-samples.
    }
  }

  /**
   * Pause one queue.
   * @param queue - the queue to pause.
   * @param state - the lifecycle state to write.
   * @returns resolution after the record is durable.
   */
  private async pauseQueue(queue: QueueRecord, state: QueueState): Promise<void> {
    await this.writeQueue(queue, { state, paused: true })
  }

  /**
   * Engage the host-wide pause without touching individual queues.
   * @returns resolution after the settings are durable.
   */
  private async pauseHost(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settings = this.store.getSettings()
      if (settings.paused) return
      try {
        await this.store.updateSettings(settings.revision, {
          ...settings,
          paused: true,
          revision: settings.revision + 1,
          updatedAt: this.now(),
        })
        return
      } catch {
        // Retry against the newer revision.
      }
    }
  }

  /**
   * Write one queue record under revision CAS.
   * @param queue - the queue as observed.
   * @param patch - the fields to change.
   * @returns the stored record.
   */
  private async writeQueue(
    queue: QueueRecord,
    patch: Partial<Pick<QueueRecord, 'state' | 'paused' | 'taskOrder' | 'title' | 'brief'>>,
  ): Promise<QueueRecord> {
    let current = this.store.getQueue(queue.id) ?? queue
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.store.updateQueue(current.id, current.revision, {
          ...current,
          ...patch,
          revision: current.revision + 1,
        })
      } catch (error) {
        const retry = this.store.getQueue(current.id)
        if (retry === undefined) throw error
        current = retry
      }
    }
    return current
  }

  /**
   * Record one planned intervention.
   * @param run - the attempt.
   * @param task - its task.
   * @param sample - the reading.
   * @param kind - intervention family.
   * @param reason - why the host acted.
   * @param phase - starting phase.
   * @param note - failure or degradation detail.
   * @param sessionId - session the instruction goes to.
   * @param judge - which judge produced the verdict.
   * @returns the stored record.
   */
  private async record(
    run: RunRecord,
    task: TaskSpec,
    sample: Sample,
    kind: InterventionKind,
    reason: string,
    phase: InterventionRecord['phase'],
    note?: string,
    sessionId?: SessionId,
    judge?: JudgedBy,
  ): Promise<InterventionRecord> {
    const id = interventionId(run.id, run.generation, kind)
    const now = this.now()
    return await this.store.recordIntervention({
      id,
      runId: run.id,
      taskId: task.id,
      generation: run.generation,
      kind,
      trigger: {
        ...(sample.health.contextRatio === undefined ? {} : { contextRatio: sample.health.contextRatio }),
        ...(sample.health.cacheHitRate === undefined ? {} : { hitRate: sample.health.cacheHitRate }),
        idleMs: sample.health.idleMs,
      },
      reason,
      ...(judge === undefined
        ? {}
        : {
          warden: {
            mode: judge.mode,
            verdict: judge.verdict,
            ...(judge.provider === undefined ? {} : { provider: judge.provider }),
            ...(judge.model === undefined ? {} : { model: judge.model }),
          },
        }),
      ...(sample.route === undefined ? {} : { paidBy: { provider: sample.route.provider, model: sample.route.model } }),
      ...(sessionId === undefined ? {} : { sessionId }),
      childTaskIds: [],
      phase,
      ...(note === undefined ? {} : { note }),
      createdAt: now,
      updatedAt: now,
    })
  }

  /**
   * Record one intervention directly as failed.
   * @param id - intervention identity.
   * @param run - the attempt.
   * @param task - its task.
   * @param sample - the reading.
   * @param kind - intervention family.
   * @param reason - why the host acted.
   * @param note - failure detail.
   * @param judge - which judge produced the verdict.
   * @param phase - phase observed before the failure.
   * @param record - the record to advance, when one exists.
   * @returns resolution after the failure is durable.
   */
  private async failIntervention(
    id: string,
    run: RunRecord,
    task: TaskSpec,
    sample: Sample,
    kind: InterventionKind,
    reason: string,
    note: string,
    judge: JudgedBy,
    phase: InterventionRecord['phase'] = 'planned',
    record?: InterventionRecord,
  ): Promise<void> {
    const base = record ?? this.store.getIntervention(id)
      ?? await this.record(run, task, sample, kind, reason, phase, undefined, undefined, judge)
    try {
      await this.advance(base, base.phase, { phase: 'failed', note })
    } catch {
      // A concurrent writer already moved the phase; the note is best effort.
    }
  }

  /**
   * Advance one intervention record.
   * @param record - the record as observed.
   * @param expected - phase the caller observed.
   * @param patch - fields to change.
   * @returns the stored record.
   */
  private async advance(
    record: InterventionRecord,
    expected: InterventionRecord['phase'],
    patch: Partial<Pick<InterventionRecord, 'phase' | 'promptSent' | 'producedPrompt' | 'childTaskIds' | 'note'>>,
  ): Promise<InterventionRecord> {
    return await this.store.advanceIntervention(record.id, expected, {
      ...record,
      ...patch,
      updatedAt: this.now(),
    })
  }

  /**
   * Wait until the instruction's own turn produced an answer and closed.
   * @param handle - the live handle.
   * @param sessionId - the session to watch.
   * @returns whether an answer arrived before the timeout.
   */
  private async awaitAnswer(
    handle: AgentHandle | undefined,
    sessionId: SessionId,
    runId: RunIdType,
    interventionId?: string,
  ): Promise<boolean> {
    const deadline = this.now() + this.options.interventionTimeoutMs
    let persistedTurn: number | undefined
    while (this.now() < deadline) {
      await delay(1000)
      if (this.closed) return false
      const state = this.store.getRun(runId)?.state
      if (state !== 'running' && state !== 'needs-attention') return false
      const activity = this.activity.get(sessionId)
      const pending = activity?.pending
      if (pending === undefined) return false
      if (pending.turn !== undefined
        && pending.turn !== persistedTurn
        && interventionId !== undefined) {
        // Persist the capture scope as soon as the turn opens, so a restart
        // re-reads this turn even if the process dies before the answer.
        persistedTurn = pending.turn
        const record = this.store.getIntervention(interventionId)
        if (record !== undefined) {
          void this.recovery.markTurn(record, pending.turn).catch(() => {})
        }
      }
      if (pending.turn !== undefined && pending.texts.length > 0 && activity?.turnOpen === false) {
        if (handle !== undefined) {
          try {
            await withTimeout(handle.agent.whenIdle(), Math.min(120_000, this.options.interventionTimeoutMs))
          } catch {
            // A timeout still leaves the captured text usable.
          }
        }
        return true
      }
    }
    return false
  }

  /**
   * Open capture for one instruction on a session.
   * @param sessionId - the session that will receive it.
   * @param id - intervention identity.
   * @returns nothing.
   */
  private beginCapture(sessionId: SessionId, id: string, turn?: number): void {
    const activity = this.activity.get(sessionId) ?? this.blankActivity(this.now())
    activity.pending = { id, texts: [], ...(turn === undefined ? {} : { turn }) }
    this.activity.set(sessionId, activity)
  }

  /**
   * Close capture for one session.
   * @param sessionId - the session being watched.
   * @returns nothing.
   */
  private endCapture(sessionId: SessionId): void {
    const activity = this.activity.get(sessionId)
    if (activity !== undefined) delete activity.pending
  }

  /**
   * Read the text captured for the pending instruction.
   * @param sessionId - the session being watched.
   * @returns the flattened answer, capped by the parse budget.
   */
  private collectCapture(sessionId: SessionId): string {
    const texts = this.activity.get(sessionId)?.pending?.texts ?? []
    return texts
      .map(text => text.trim())
      .filter(text => text !== '')
      .join('\n\n')
      .slice(0, DEFAULT_DECOMPOSE_LIMITS.maxProducedChars)
  }

  /**
   * Read the latest run state of one task.
   * @param taskId - task identity.
   * @returns the state, or `undefined` before the first attempt.
   */
  private latestRunState(taskId: TaskIdType): string | undefined {
    let latest: RunRecord | undefined
    for (const run of this.store.listRuns()) {
      if (run.taskId !== taskId) continue
      if (latest === undefined || run.attempt > latest.attempt) latest = run
    }
    return latest?.state
  }

  /**
   * Fold one durable Session event into the in-memory activity of its session.
   * @param session - the session the event belongs to.
   * @param event - the event.
   * @returns nothing.
   */
  private observe(session: Session, event: SessionEvent): void {
    const key = session.id
    const activity = this.activity.get(key) ?? this.blankActivity(this.now())
    this.activity.set(key, activity)
    activity.lastActivityAt = this.now()
    switch (event.type) {
      case 'turn/start':
        activity.turnOpen = true
        if (activity.pending !== undefined && activity.pending.turn === undefined) {
          activity.pending.turn = event.data.turn
          // Persist the capture scope the moment it is known: a restart must
          // re-read this turn even if the answer arrives after the crash.
          const pending = activity.pending
          const record = this.store.getIntervention(pending.id)
          if (record !== undefined) {
            void this.recovery.markTurn(record, event.data.turn).catch(() => {})
          }
        }
        return
      case 'turn/end':
        activity.turnOpen = false
        return
      case 'assistant/message': {
        activity.assistantCalls += 1
        const usage = event.data.usage
        if (usage !== undefined) {
          activity.promptTokens += usage.inputTokens
          activity.cacheReadTokens += usage.cacheReadTokens ?? 0
        }
        const text = contentText(event.data.message.content)
        activity.assistant.push({ seq: event.seq, text })
        if (activity.assistant.length > 8) activity.assistant.shift()
        if (activity.pending !== undefined && activity.pending.turn === event.data.turn) {
          activity.pending.texts.push(text)
        }
        this.pushRecent(activity, { kind: 'assistant', ok: true })
        return
      }
      case 'tool/call': {
        activity.toolStarted.set(event.data.callId, { name: event.data.name, at: this.now() })
        return
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const started = activity.toolStarted.get(callId)
        activity.toolStarted.delete(callId)
        this.pushRecent(activity, {
          kind: 'tool',
          ...(started === undefined ? {} : { name: started.name, ms: this.now() - started.at }),
          ok: event.data.message.isError !== true,
        })
        return
      }
      case 'user/message': {
        this.pushRecent(activity, { kind: 'user', ok: true })
        const source = event.data.source
        if (source.kind === 'session-orchestrator' && source.intervention !== undefined) {
          // Make the instruction durable at its own boundary: recovery reads
          // this message as the authority for "already sent".
          this.flushSession(session)
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Append one event to the bounded recent list.
   * @param activity - the session activity.
   * @param event - the flattened event.
   * @returns nothing.
   */
  private pushRecent(activity: SessionActivity, event: WardenRecentEvent): void {
    activity.recent.push(event)
    if (activity.recent.length > 5) activity.recent.shift()
  }

  /**
   * Create an empty activity record.
   * @param now - creation instant.
   * @returns the record.
   */
  private blankActivity(now: number): SessionActivity {
    return {
      lastActivityAt: now,
      turnOpen: false,
      promptTokens: 0,
      cacheReadTokens: 0,
      assistantCalls: 0,
      assistant: [],
      recent: [],
      toolStarted: new Map(),
    }
  }

  /**
   * Flush one session through the host's durability checkpoint.
   *
   * Best effort: a host without the seam still recovers from whatever prefix
   * became durable on its own, and a flush failure must never break the loop
   * that observed the event.
   * @param session - session whose buffered events must reach storage.
   */
  private flushSession(session: Session): void {
    const store = (this.ctx as unknown as {
      sessions?: { flush?: (value: Session) => Promise<boolean> }
    }).sessions
    if (store?.flush === undefined) return
    void store.flush(session).catch(() => {})
  }

  /** Live Session directory, taken from the supervisor's host context. */
  private get liveSessions(): SupervisorLiveSessions {
    return (this.ctx as unknown as { sessions: SupervisorLiveSessions }).sessions
  }
}

/**
 * Flatten message content into text.
 * @param content - the content blocks.
 * @returns the concatenated text of every text block.
 */
function contentText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Read an error's message.
 * @param error - the thrown value.
 * @returns a printable message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait for a fixed delay.
 * @param ms - milliseconds to wait.
 * @returns resolution after the delay.
 */
async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Reject when a promise takes longer than a bound.
 * @param promise - the promise to bound.
 * @param ms - the bound.
 * @returns the promise's value.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Cordis plugin name. */
export const name = 'session-orchestrator-runtime'

/**
 * Services the runtime composes. All four are required: without a live session
 * directory or a durability checkpoint the supervisor cannot commit success.
 */
export const inject = ['sessionOrchestrator', 'sessions', 'sessionPersistence', 'agents']

/**
 * Read one optional Cordis service without requiring it at load.
 *
 * @param ctx - host Context carrying the service store.
 * @param name - service name.
 * @returns the service, or `undefined` when it is not mounted.
 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  return ctx.get(name) as T | undefined
}

/**
 * Build the opt-in model reviewer from validated configuration.
 *
 * Rule mode — the default — returns `undefined` and touches no LLM service.
 * Model mode fails here, at load, when the route is incomplete or the host
 * mounted no LLM service, so a misconfiguration never reaches a running queue.
 * @param ctx - host Context the runtime plugin was mounted on.
 * @param config - validated runtime configuration.
 * @returns the reviewer, or `undefined` in rule mode.
 * @throws Error when model mode is missing its route or the `llm` service.
 */
function modelReviewerOf(ctx: Context, config: RuntimeOptions): ModelReviewer | undefined {
  if (config.wardenMode === 'rule') return undefined
  const provider = config.wardenProvider?.trim() ?? ''
  const model = config.wardenModel?.trim() ?? ''
  if (provider === '' || model === '') {
    throw new Error('wardenMode "model" needs both wardenProvider and wardenModel; set them in the plugin configuration')
  }
  return createModelWarden(
    ctx,
    {
      provider,
      model,
      ...(config.wardenReasoningEffort === undefined
        ? {}
        : { reasoningEffort: config.wardenReasoningEffort as ReasoningEffortId }),
    },
    {
      timeoutMs: config.wardenTimeoutMs,
      maxOutputTokens: config.wardenMaxOutputTokens,
      maxPacketBytes: config.wardenMaxPacketBytes,
    },
  )
}

/**
 * Mount the pipeline runtime beside the store and the Remote controller.
 *
 * The plugin holds no model tool and appends no Session event of its own; the
 * only Session write it causes is the intervention instruction, which the agent
 * loop admits like any other user message. A model warden review never enters a
 * Session log: it is one stateless request whose ledger row names its route.
 * @param ctx - host Context carrying the composed services.
 * @param config - gate thresholds and bounds.
 * @returns resolution after the runtime installed and reconciliation started.
 */
export async function apply(ctx: Context, config: RuntimeOptions): Promise<() => Promise<void>> {
  const store = ctx.sessionOrchestrator
  const durability = (ctx as unknown as { sessionPersistence: SessionDurability }).sessionPersistence
  const live = ctx.sessions
  const hostInstanceId = store.getSettings().hostInstanceId
  const modelWarden = modelReviewerOf(ctx, config)
  const defaults = optionalService<ModelSelectionPort>(ctx, 'agentDefaultModel')
  const presets = optionalService<SupervisorPresets>(ctx, 'agentPresets')
  const supervisor = new Supervisor({
    ctx,
    store,
    sessions: durability,
    liveSessions: live,
    agents: defaultingAgents(ctx.agents, defaults),
    // Read on every launch, not once here: Cordis starts profile entries
    // concurrently and publishes `workspaceRegistry` only after its own storage
    // initialization finished. A value captured at mount time can therefore be
    // undefined even though the user just selected a registered Workspace, and
    // every Session would then be created outside it and surface as ungrouped.
    workspaceSource: () => optionalService<SupervisorWorkspaces>(ctx, 'workspaceRegistry'),
    ...(presets === undefined ? {} : { presets }),
  })
  const durableSessions = durability as unknown as LocalSessionOrchestratorOptions['durableSessions']
  const directory = live as unknown as LocalSessionOrchestratorOptions['sessions']
  const orchestrator = new LocalSessionOrchestrator({
    store,
    supervisor,
    durableSessions,
    sessions: directory,
    hostInstanceId: hostInstanceId === 'unclaimed' ? 'session-orchestrator-runtime' : hostInstanceId,
  })
  const meter = optionalService<TokenMeterPort>(ctx, 'tokenMeter')
  // Capability facts are read once from the composition. The adapter reports a
  // feature only when this Context really mounted the service behind it; a
  // missing service stays disabled with its reason instead of being assumed.
  const featureSupport: DshHostFeatureSupport = {
    modelCatalog: optionalService<unknown>(ctx, 'llm') !== undefined,
    skills: presets !== undefined,
    permissions: optionalService<unknown>(ctx, 'permissionPresets') !== undefined,
    compaction: optionalService<unknown>(ctx, 'compaction') !== undefined,
  }
  const hostRegistry = createDefaultHostSessionRegistry({
    ...(config.hostWorkBuddyCli.trim() === '' ? {} : { workbuddyCli: config.hostWorkBuddyCli }),
    ...(config.hostTraeCli.trim() === '' ? {} : { traeCli: config.hostTraeCli }),
    dsh: {
      agents: ctx.agents,
      events: { onSessionEvent: listener => ctx.on('session/event', listener) },
      liveSessions: live as DshHostLiveSessions,
      // The adapter reads the resolver per call for the same reason the
      // supervisor does: a registry that mounts later is still reachable.
      workspaces: () => optionalService<DshHostWorkspaces>(ctx, 'workspaceRegistry'),
      ...(meter === undefined ? {} : { meter }),
      ...(optionalService<unknown>(ctx, 'webServer') === undefined
        ? {}
        : { openRoute: sessionOpenRoute }),
      ...(defaults === undefined
        ? {}
        : { defaultModel: { currentSelection: () => defaults.currentSelection() } }),
      support: featureSupport,
    },
  })
  // The queue's only execution path is the DSH host; a host without the
  // create/send/subscribe trio must fail at load instead of dispatching empty
  // queues that look successful.
  hostRegistry.requireRunnable('dsh')
  const runtime = new SessionOrchestratorRuntime({
    ctx,
    store,
    supervisor,
    orchestrator,
    config,
    hosts: hostRegistry,
    ...(meter === undefined ? {} : { meter }),
    ...(modelWarden === undefined ? {} : { modelWarden }),
    durableSessions,
  })
  const registry = ctx as unknown as { provide(name: string, value: unknown): () => void }
  registry.provide('sessionOrchestratorRuntime', runtime)
  const start = runtime.start()
  return async () => {
    await start
    await runtime.close()
  }
}

/** Re-export the transaction identity helper for hosts that record their own audits. */
export { interventionId }

/** Brand helpers re-exported so a host never has to import the brand module. */
export { OperationId, QueueId }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pipeline runtime, present only when this plugin is mounted. */
    sessionOrchestratorRuntime: SessionOrchestratorRuntime | undefined
  }
}
