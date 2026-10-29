/**
 * Zod schemas for the authoritative `session_orchestrator` domain.
 *
 * The stored record types are inferred from these schemas so the durable
 * boundary and the compile-time surface cannot drift. Records are validated
 * when the domain opens, so a malformed record refuses the whole open.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/schema
 */

import { z } from 'zod'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session/types'
import { OperationId, QueueId, RunId, TaskId } from './brand.ts'

/** A non-empty string that carries no leading or trailing whitespace. */
const identifier = z.string().min(1).refine(value => value.trim() === value, {
  message: 'Identifiers must not carry leading or trailing whitespace',
})

/** A finite non-negative integer count or epoch-millisecond instant. */
const count = z.number().int().nonnegative()

/** A non-empty human-readable string. */
const text = z.string().min(1)

const sessionIdSchema = identifier.transform(SessionId)
const logOffsetSchema = count.transform(SessionLogOffset)
const taskIdSchema = identifier.transform(TaskId)
const queueIdSchema = identifier.transform(QueueId)
const runIdSchema = identifier.transform(RunId)
const operationIdSchema = identifier.transform(OperationId)

/** How a task selects its model route. */
export const modelPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({
    kind: z.literal('fixed'),
    provider: text,
    model: text,
    reasoningEffort: text.optional(),
  }).strict(),
])

/** How a task selects the agent preset that composes its skills. */
export const skillsPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-preset') }).strict(),
  z.object({ kind: z.literal('preset'), presetId: text }).strict(),
])

/** How a task selects the agent preset identity for a new session. */
export const presetPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({ kind: z.literal('fixed'), id: text }).strict(),
])

/**
 * Per-task context-pressure and handoff thresholds.
 *
 * `ratio` is the pipeline's context switch point (occupancy of the model
 * window), not a warning line: reaching it pauses the task and hands the
 * remainder to child tasks. A pipeline may lower it to 0.4 to reproduce the
 * gate deliberately; the legacy 0.88 handoff is no longer the default.
 */
export const handoffPolicySchema = z.object({
  enabled: z.boolean(),
  ratio: z.number().min(0.4).max(0.95),
  mode: z.enum(['structured-brief', 'last-complete-turn']),
  boundary: z.literal('completed-turn'),
  maxGenerations: z.number().int().min(1),
  maxHandoffTokens: z.number().int().min(1),
}).strict()

/** Preset identity plus the revision current at capture time. */
export const presetRefSchema = z.object({
  id: text,
  revision: count.optional(),
}).strict()

/** Route and preset values resolved at a successful boundary. */
export const effectiveConfigSnapshotSchema = z.object({
  routeSource: z.enum(['completed-turn-header', 'prior-snapshot', 'runtime-fallback', 'fixed-policy']),
  provider: text,
  model: text,
  reasoningEffort: text.optional(),
  preset: presetRefSchema,
  capturedAt: count,
}).strict()

/** One context-pressure reading with the decision it produced. */
export const pressureSnapshotSchema = z.object({
  sessionId: sessionIdSchema,
  logRevision: logOffsetSchema,
  provider: text,
  model: text,
  totalTokens: count,
  contextWindow: z.number().int().positive().optional(),
  ratio: z.number().min(0).optional(),
  baselineKind: z.enum(['none', 'estimated', 'usage']),
  threshold: z.number().min(0.4).max(0.95),
  routeFingerprint: text,
  measuredAt: count,
  decision: z.enum(['handoff-pending', 'no-handoff']),
  blockedBy: z.enum([
    'handoff-disabled',
    'generation-exhausted',
    'context-window-unknown',
    'below-threshold',
    'handoff-in-flight',
    'external-input',
    'paused',
    'cancelled',
    'turn-not-closed',
    'budget-unavailable',
    'empty-generation',
  ]).optional(),
}).strict().refine(
  reading => reading.contextWindow === undefined
    ? reading.ratio === undefined
    : reading.ratio !== undefined,
  { message: 'A ratio is present exactly when a context window is known' },
)

/** One stored task definition. */
export const taskSpecSchema = z.object({
  id: taskIdSchema,
  queueId: queueIdSchema,
  title: text,
  prompt: text,
  workspaceId: text,
  cwd: text,
  preset: presetPolicySchema,
  model: modelPolicySchema,
  skills: skillsPolicySchema,
  dependsOn: z.array(taskIdSchema),
  /** Join the previous list group; derived dependencies follow this marker. */
  parallelWithPrevious: z.boolean().optional(),
  concurrencyGroup: text.optional(),
  priority: z.number().int(),
  handoff: handoffPolicySchema,
  enabled: z.boolean(),
  /**
   * Pipeline stage this task belongs to (`architecture` / `breakdown` /
   * `implement` / `test` / `review`, or any host-defined stage). Absent on
   * records written before the pipeline existed.
   */
  stage: text.optional(),
  /**
   * Task whose decomposition produced this one.
   *
   * Child tasks are inserted immediately after their parent in the queue's
   * `taskOrder`; the parent does not count as complete until every child
   * reached `succeeded`. Derived rather than stored as a child list, so the
   * queue order and the lineage can never disagree.
   */
  parentTaskId: taskIdSchema.optional(),
  revision: count,
}).strict().refine(
  task => new Set(task.dependsOn).size === task.dependsOn.length,
  { message: 'A task may not repeat a dependency' },
).refine(
  task => !task.dependsOn.includes(task.id),
  { message: 'A task may not depend on itself' },
).refine(
  task => task.parentTaskId !== task.id,
  { message: 'A task may not be its own parent' },
)

/**
 * Queue lifecycle of one pipeline.
 *
 * `running` is the only state the scheduler dispatches in; `paused` keeps every
 * record and stops dispatch; `aborted` is the terminal state a health gate
 * writes when the whole pipeline must not resume on its own.
 */
export const queueStateSchema = z.enum(['idle', 'running', 'paused', 'aborted'])

/** One stored queue. */
export const queueRecordSchema = z.object({
  id: queueIdSchema,
  title: text,
  taskOrder: z.array(taskIdSchema),
  paused: z.boolean(),
  maxConcurrentRuns: z.number().int().min(1).optional(),
  /** Pipeline lifecycle; absent on records written before the pipeline existed. */
  state: queueStateSchema.default('idle'),
  /** The original requirement this pipeline decomposes; drives warden prompts. */
  brief: text.optional(),
  /**
   * Workspace every new task in this queue inherits. The task keeps its own
   * copy so one pipeline may intentionally span workspaces; this pair is only
   * the authoring default and is never the dispatch authority.
   */
  workspaceId: text.optional(),
  /** Canonical directory captured with `workspaceId`. */
  cwd: text.optional(),
  /**
   * Route a task inherits when its own model policy is `inherit`.
   *
   * Absent keeps the host default, exactly like `{ kind: 'inherit' }`. A fixed
   * pipeline route is resolved once at dispatch and fixed for the session this
   * attempt creates; changing it never switches a live conversation.
   */
  model: modelPolicySchema.optional(),
  revision: count,
}).strict().refine(
  queue => new Set(queue.taskOrder).size === queue.taskOrder.length,
  { message: 'A queue may not list the same task twice' },
).refine(
  queue => (queue.workspaceId === undefined) === (queue.cwd === undefined),
  { message: 'A queue workspace id and directory must be present together' },
)

/**
 * One health reading for a live run.
 *
 * Sampled at the host tick from durable Session events (cache buckets), the
 * token meter (context occupancy) and the last visible activity (idle). The
 * three signals drive the pipeline gates; the record exists so a human can see
 * why an intervention happened after the fact.
 */
export const runHealthSchema = z.object({
  /** Occupied share of the model context window, when the route advertises one. */
  contextRatio: z.number().min(0).optional(),
  /** Advertised capacity of the routed request context. */
  contextWindow: z.number().int().positive().optional(),
  /** Cache-read share of the prompt tokens seen in this run. */
  cacheHitRate: z.number().min(0).max(1).optional(),
  /** Milliseconds since the last visible Session activity. */
  idleMs: count,
  /** Epoch milliseconds of that last activity. */
  lastActivityAt: count,
  /** Whether a turn was still open at sampling time. */
  turnOpen: z.boolean(),
  /** Which anchor the context reading used. */
  baselineKind: z.enum(['none', 'estimated', 'usage']),
  sampledAt: count,
}).strict().refine(
  health => health.contextWindow === undefined
    ? health.contextRatio === undefined
    : health.contextRatio !== undefined,
  { message: 'A context ratio is present exactly when a context window is known' },
)

/** One stored run attempt. */
export const runRecordSchema = z.object({
  id: runIdSchema,
  taskId: taskIdSchema,
  attempt: z.number().int().min(1),
  state: z.enum([
    'ready',
    'starting',
    'running',
    'handoff-pending',
    'handing-off',
    'succeeded',
    'needs-attention',
    'paused',
    /**
     * The attempt ended on purpose because its remaining work was handed to
     * child tasks. Terminal for this attempt, satisfied for dependants: a child
     * that depends on a deferred parent may start, and the parent's own task
     * does not count as succeeded.
     */
    'deferred',
    'cancelled',
    'failed',
  ]),
  activeSessionId: sessionIdSchema.optional(),
  sessionLineage: z.array(sessionIdSchema),
  generation: count,
  operationId: operationIdSchema.optional(),
  submittedMessageId: text.optional(),
  claimedTurn: count.optional(),
  acceptedTurnEndSeq: count.optional(),
  configSnapshot: effectiveConfigSnapshotSchema.optional(),
  pressure: pressureSnapshotSchema.optional(),
  /** Last sampled pipeline health, when the runtime observes this run. */
  health: runHealthSchema.optional(),
  workspaceKey: text,
  providerKey: text.optional(),
  revision: count,
  lease: z.object({ ownerId: text, expiresAt: count }).strict().optional(),
  lastError: z.object({ code: text, message: text, retryable: z.boolean() }).strict().optional(),
  createdAt: count,
  updatedAt: count,
}).strict().refine(
  run => run.activeSessionId === undefined || run.sessionLineage.includes(run.activeSessionId),
  { message: 'The active session must appear in the run lineage' },
).refine(
  run => run.generation === Math.max(0, run.sessionLineage.length - 1),
  { message: 'The generation must index the last lineage entry, or 0 before one exists' },
)

/** One stored create-or-submit operation. */
export const operationRecordSchema = z.object({
  id: operationIdSchema,
  runId: runIdSchema,
  generation: count,
  attempt: z.number().int().min(1),
  kind: z.enum(['initial-prompt', 'handoff']),
  sourceSessionId: sessionIdSchema.optional(),
  targetSessionId: sessionIdSchema.optional(),
  messageId: text.optional(),
  phase: z.enum(['planned', 'session-created', 'submitted', 'claimed', 'settled', 'uncertain']),
  requestHash: text,
  createdAt: count,
  updatedAt: count,
}).strict().refine(
  operation => operation.kind === 'handoff'
    ? operation.sourceSessionId !== undefined
    : operation.sourceSessionId === undefined,
  { message: 'A handoff operation names its source session; an initial prompt does not' },
)

/** Non-empty audit prose that survives trimming. */
const auditText = z.string().min(1).refine(value => value.trim() !== '', {
  message: 'Audit text must not be blank',
})

/** What a pipeline intervention did. */
export const interventionKindSchema = z.enum([
  /** Context occupancy reached the switch point: pause, ask, decompose. */
  'pause-context',
  /** No visible activity for the idle window: ping first, then pause. */
  'pause-idle',
  /** A paused task was asked to render the remaining-work prompt. */
  'decompose',
  /** Cache hit rate fell below the warn line: append refinement without pausing. */
  'refine',
  /** Cache hit rate fell below the abort line: every queue stops for good. */
  'abort-all',
  /** The warden judged the task stuck; only this queue pauses. */
  'stop-and-notify',
])

/** How far one intervention transaction got. */
export const interventionPhaseSchema = z.enum([
  'planned',
  'prompt-sent',
  'prompt-captured',
  'children-inserted',
  'settled',
  'failed',
])

/**
 * Every judgement a pipeline warden may return, in increasing severity.
 *
 * The tuple is the one vocabulary the durable schema, the rule engine, the
 * model review contract and the UI share; adding a verdict here forces every
 * consumer to handle it.
 */
export const WARDEN_VERDICTS = [
  'continue',
  'refine',
  'stop-and-notify',
  'decompose',
  'abort-all',
] as const

/** Every judgement a pipeline warden may return. */
export const wardenVerdictSchema = z.enum(WARDEN_VERDICTS)

/**
 * Which judge produced one pipeline decision, and the route that paid for it.
 *
 * A rule judgement names no route because it costs no tokens; a model judgement
 * always names the provider and model whose account the review is billed to.
 */
export const interventionWardenSchema = z.object({
  mode: z.enum(['rule', 'model']),
  verdict: wardenVerdictSchema,
  provider: text.optional(),
  model: text.optional(),
}).strict().refine(
  warden => warden.mode === 'rule'
    ? warden.provider === undefined && warden.model === undefined
    : warden.provider !== undefined && warden.model !== undefined,
  { message: 'A model judgement names its provider and model; a rule judgement names neither' },
)

/** Stable reasons a model judgement fell back to the local rules. */
export const wardenFailureCodeSchema = z.enum([
  /** The review did not finish inside the configured deadline. */
  'timeout',
  /** The answer was not the strict JSON object the review contract requires. */
  'invalid-output',
  /** The provider route refused or failed the call. */
  'unavailable',
  /** The bounded packet exceeded the configured character budget. */
  'packet-too-large',
  /** This run already spent its configured review budget. */
  'budget-exhausted',
])

/**
 * One audited warden review of one running task.
 *
 * The ledger exists because a model review costs tokens even when its verdict
 * is `continue` and therefore produces no intervention. Its identity is the run,
 * generation and sampling instant, so a restart cannot append the same review
 * twice. Rows are bounded per run by the runtime's retention limit.
 */
export const wardenAuditRecordSchema = z.object({
  id: identifier,
  runId: runIdSchema,
  taskId: taskIdSchema,
  generation: count,
  /** `model` for a review the model answered; `rule-fallback` when it was skipped or unusable. */
  mode: z.enum(['model', 'rule-fallback']),
  /** The verdict that was actually used. */
  verdict: wardenVerdictSchema,
  /** One human-readable sentence: what the judge concluded. */
  reason: text,
  provider: text.optional(),
  model: text.optional(),
  /** Wall-clock cost of the review, when one ran. */
  latencyMs: count.optional(),
  /** Prompt tokens the adapter reported for the review. */
  inputTokens: count.optional(),
  /** Completion tokens the adapter reported for the review. */
  outputTokens: count.optional(),
  /** Why a model review was not used; present exactly on a fallback row. */
  error: wardenFailureCodeSchema.optional(),
  createdAt: count,
}).strict().refine(
  audit => audit.mode === 'model'
    ? audit.provider !== undefined && audit.model !== undefined && audit.error === undefined
    : audit.error !== undefined,
  { message: 'A model review names its route and no error; a fallback names its error' },
)

/**
 * One audited pipeline intervention.
 *
 * The record is the idempotency identity of the transaction: an intervention id
 * is derived from `(runId, generation, kind)`, so a restarted host replays the
 * phase it observes instead of sending the instruction twice or inserting the
 * same children twice.
 */
export const interventionRecordSchema = z.object({
  id: identifier,
  runId: runIdSchema,
  taskId: taskIdSchema,
  /** Attempt generation the intervention observed. */
  generation: count,
  kind: interventionKindSchema,
  /** The signal that produced the verdict. */
  trigger: z.object({
    contextRatio: z.number().min(0).optional(),
    idleMs: count.optional(),
    hitRate: z.number().min(0).max(1).optional(),
  }).strict(),
  /** One human-readable sentence: why the host acted. */
  reason: text,
  /**
   * Which judge produced this action.
   *
   * Absent on records written before the model warden existed; a `rule`
   * judgement spends no tokens, and a `model` judgement names the route the
   * review was billed to so the ledger can attribute the cost.
   */
  warden: interventionWardenSchema.optional(),
  /**
   * Conversation route whose tokens paid for the instruction turn.
   *
   * The fixed instruction and its answer run inside the task's own Session, so
   * the decomposition itself is billed to this route, not to the warden.
   */
  paidBy: z.object({ provider: text, model: text }).strict().optional(),
  /** Instruction the host sent into the running conversation. */
  promptSent: text.optional(),
  /**
   * Session the instruction was delivered into.
   *
   * Persisted once the host knows it, so a restarted process re-reads exactly
   * this log instead of guessing from the run lineage.
   */
  sessionId: sessionIdSchema.optional(),
  /**
   * Turn the instruction opened.
   *
   * The instruction is admitted as the sole message of its own turn; the turn
   * number is the capture scope. A restart without it derives the turn from the
   * durable message instead of re-sending the instruction.
   */
  turn: count.optional(),
  /** The session's own answer, truncated to the capture budget. */
  producedPrompt: text.optional(),
  /** Tasks created from that answer. */
  childTaskIds: z.array(taskIdSchema),
  /** How many restart reconciliations have tried to advance this record. */
  recoveryAttempts: count.optional(),
  phase: interventionPhaseSchema,
  /** Failure or degradation detail, when the phase is `failed`. */
  note: text.optional(),
  createdAt: count,
  updatedAt: count,
}).strict().refine(
  intervention => intervention.kind === 'abort-all' || intervention.kind === 'stop-and-notify'
    ? true
    : intervention.childTaskIds.length === 0 || intervention.phase !== 'planned',
  { message: 'An intervention that inserted children is no longer planned' },
)

/** One audited human skip of a `needs-attention` run.
 *
 * A skip is append-only: it names the exact run revision the human observed,
 * so recording it compares against that revision instead of overwriting a
 * mutable record. Actor, reason and decision time are required audit fields.
 */
export const skipRecordSchema = z.object({
  taskId: taskIdSchema,
  runId: runIdSchema,
  actor: auditText,
  reason: auditText,
  decidedAt: count,
  runRevision: count,
}).strict()

/** One stored handoff from a source session to its successor. */
export const handoffRecordSchema = z.object({
  generation: z.number().int().min(1),
  runId: runIdSchema,
  sourceSessionId: sessionIdSchema,
  targetSessionId: sessionIdSchema,
  operationId: operationIdSchema,
  sourceSeq: logOffsetSchema,
  bodyHash: text,
  mode: z.enum(['structured-brief', 'last-complete-turn']),
  configSnapshot: effectiveConfigSnapshotSchema,
  bodyTokens: count.optional(),
  createdAt: count,
}).strict().refine(
  handoff => handoff.sourceSessionId !== handoff.targetSessionId,
  { message: 'A handoff must move between two distinct sessions' },
)

/** Host-wide orchestration settings; the domain stores exactly one value. */export const globalSettingsSchema = z.object({
  schemaVersion: z.number().int().min(1),
  paused: z.boolean(),
  maxConcurrentRuns: z.number().int().min(1),
  providerQuotas: z.record(text, z.number().int().min(1)),
  hostInstanceId: text,
  revision: count,
  updatedAt: count,
}).strict()

/** Stored record of one task definition. */
export type TaskSpec = z.infer<typeof taskSpecSchema>

/** Stored record of one queue. */
export type QueueRecord = z.infer<typeof queueRecordSchema>

/** Stored record of one run attempt. */
export type RunRecord = z.infer<typeof runRecordSchema>

/** Stored record of one create-or-submit operation. */
export type OperationRecord = z.infer<typeof operationRecordSchema>

/** Stored record of one completed handoff. */
export type HandoffRecord = z.infer<typeof handoffRecordSchema>

/** Stored record of one audited pipeline intervention. */
export type InterventionRecord = z.infer<typeof interventionRecordSchema>

/** One audited warden review of one running task. */
export type WardenAuditRecord = z.infer<typeof wardenAuditRecordSchema>

/** Why a model judgement fell back to the local rules. */
export type WardenFailureCode = z.infer<typeof wardenFailureCodeSchema>

/** Every verdict a pipeline warden may return. */
export type WardenVerdict = z.infer<typeof wardenVerdictSchema>

/** Which judge produced one intervention and the route that paid for it. */
export type InterventionWarden = z.infer<typeof interventionWardenSchema>

/** What a pipeline intervention did. */
export type InterventionKind = z.infer<typeof interventionKindSchema>

/** How far one intervention transaction got. */
export type InterventionPhase = z.infer<typeof interventionPhaseSchema>

/** Pipeline lifecycle of one queue. */
export type QueueState = z.infer<typeof queueStateSchema>

/** One sampled health reading of a live run. */
export type RunHealth = z.infer<typeof runHealthSchema>

/** Stored record of one audited human skip. */
export type SkipRecord = z.infer<typeof skipRecordSchema>

/** The single stored host-wide settings record. */
export type GlobalSettings = z.infer<typeof globalSettingsSchema>

/** Model route selection rule. */
export type ModelPolicy = z.infer<typeof modelPolicySchema>

/** Skill composition selection rule. */
export type SkillsPolicy = z.infer<typeof skillsPolicySchema>

/** Preset identity selection rule. */
export type PresetPolicy = z.infer<typeof presetPolicySchema>

/** Context-pressure and handoff thresholds for one task. */
export type HandoffPolicy = z.infer<typeof handoffPolicySchema>

/** Which body builder a handoff used. */
export type HandoffMode = HandoffPolicy['mode']

/** Where an effective route came from when it was captured. */
export type ConfigRouteSource = z.infer<typeof effectiveConfigSnapshotSchema>['routeSource']

/** One preset identity with its captured revision. */
export type PresetRef = z.infer<typeof presetRefSchema>

/** Route and preset values resolved at a successful boundary. */
export type EffectiveConfigSnapshot = z.infer<typeof effectiveConfigSnapshotSchema>

/** Which anchor produced a pressure reading. */
export type PressureBaselineKind = z.infer<typeof pressureSnapshotSchema>['baselineKind']

/** What a pressure reading decided. */
export type PressureDecision = z.infer<typeof pressureSnapshotSchema>['decision']

/** Why a pressure reading did not schedule a handoff. */
export type PressureBlockReason = NonNullable<z.infer<typeof pressureSnapshotSchema>['blockedBy']>

/** One context-pressure reading with its decision. */
export type PressureSnapshot = z.infer<typeof pressureSnapshotSchema>

/** Lifecycle state of one run attempt. */
export type RunState = RunRecord['state']

/** A stable error code with a retryability verdict. */
export type RunError = NonNullable<RunRecord['lastError']>

/** Ownership lease that keeps one host responsible for an in-flight run. */
export type RunLease = NonNullable<RunRecord['lease']>

/** Which prompt an operation delivers. */
export type OperationKind = OperationRecord['kind']

/** How far an operation has progressed. */
export type OperationPhase = OperationRecord['phase']
