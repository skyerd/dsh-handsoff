/**
 * Client-safe Remote vocabulary for the `sessionOrchestrator` namespace.
 *
 * These declarations carry the request, value and DTO types the generated
 * browser artifact imports. This module has no Host imports and no runtime
 * behavior, so a Client program can read it without joining Host Context
 * merges.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/remote-types
 */

import type { RunId } from './brand.ts'
import type { TaskListIssue } from './task-order.ts'
import type {
  ConfigRouteSource,
  HandoffMode,
  HandoffPolicy,
  InterventionKind,
  InterventionPhase,
  ModelPolicy,
  OperationPhase,
  PresetPolicy,
  PressureBaselineKind,
  PressureBlockReason,
  PressureDecision,
  QueueState,
  RunHealth,
  RunState,
  SkillsPolicy,
  WardenFailureCode,
  WardenVerdict,
} from './types.ts'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Read or mutation decision an access policy classifies. */
export type OrchestratorAction = 'read' | 'mutate'

/** Permission one access policy grants for a request. */
export type OrchestratorRole = 'owner' | 'observer' | 'none'

/** Resource family named by an access decision. */
export type OrchestratorResourceKind =
  | 'queue'
  | 'task'
  | 'run'
  | 'handoff'
  | 'settings'
  | 'stream'

/** One resource an access policy may filter. */
export interface OrchestratorResource {
  /** Record family; `stream` and `settings` name non-record resources. */
  readonly kind: OrchestratorResourceKind
  /** Record identity; absent for a collection-level decision. */
  readonly id?: string
}

/** One access decision input. */
export interface OrchestratorAccessRequest {
  /** Whether the caller intends to read or mutate. */
  readonly action: OrchestratorAction
  /** Resource the request names. */
  readonly resource: OrchestratorResource
  /** Connection Peer identity; absent for an in-process operator call. */
  readonly peerId?: string
}

/**
 * Host-declared access policy for the orchestration namespace.
 *
 * The policy runs once per record when a list or snapshot is built, so it can
 * both deny a whole collection and filter individual records. An observer may
 * read; only an owner may mutate.
 */
export interface OrchestratorAccess {
  /**
   * Classify one request.
   * @param request - action, resource and the calling Peer identity.
   * @returns the role granted for that request.
   */
  role(request: OrchestratorAccessRequest): OrchestratorRole
}

/**
 * Optional live-run control a host may compose from its supervisor.
 *
 * Cancelling durable orchestration state never tears down an Agent by itself;
 * a host that owns the live Handle passes its supervisor's `cancel(id)` here.
 */
export interface OrchestratorRunControl {
  /**
   * Ask the live supervisor to cancel one run.
   * @param runId - run whose Agent should be stopped.
   * @returns whether a live Handle was found.
   */
  cancel(runId: RunId): boolean
}

/** Replaceable test seams of the controller. */
export interface SessionOrchestratorControllerInternals {
  /** Access policy; defaults to owner for every admitted call. */
  readonly access?: OrchestratorAccess
  /** Optional live-run cancellation seam; absent means state-only cancel. */
  readonly runControl?: OrchestratorRunControl
  /** Clock used for audit times and snapshot timestamps. */
  readonly now?: () => number
}

/** Deployment configuration of the controller; no deployment-varying options exist. */
export type SessionOrchestratorControllerConfig = Record<string, never>

/**
 * Whether one Session can be opened right now, and when it cannot, why.
 *
 * The host only ever projects `ready`, `archived` or `unsupported`: it cannot
 * prove deletion without a cold read, so `missing` is reserved for the browser,
 * which already holds the Session catalog the sidebar lists.
 */
export type SessionOpenState = 'ready' | 'archived' | 'missing' | 'unsupported'

/**
 * One Session identity plus everything needed to open it by identity alone.
 *
 * The route never encodes a title: `sessionId` is the whole address, so a
 * rename cannot break a link and a duplicate title cannot resolve to the wrong
 * conversation.
 */
export interface SessionLinkDto {
  /** Opaque Session identity; the only routing key. */
  readonly sessionId: string
  /** Whether an optional Web `sessionController` is mounted. */
  readonly linkable: boolean
  /** Workspace the session is registered in, when the registry knows it. */
  readonly workspaceId?: string
  /** Same-origin path that opens this Session, when the surface can open it. */
  readonly route?: string
  /** Openability as the host can prove it. */
  readonly openState: SessionOpenState
}

/** One editable queue projection. */
export interface QueueDto {
  readonly id: string
  readonly title: string
  readonly taskOrder: readonly string[]
  readonly paused: boolean
  /** Pipeline lifecycle; the scheduler only dispatches a `running` queue. */
  readonly state: QueueState
  /** The original requirement this pipeline decomposes. */
  readonly brief?: string
  /** Workspace new tasks in this queue inherit. */
  readonly workspaceId?: string
  /** Canonical directory captured with `workspaceId`. */
  readonly cwd?: string
  /**
   * Route a task inherits when its own policy is `inherit`.
   *
   * Omitted or `{ kind: 'inherit' }` leaves the host default in charge. A fixed
   * route is resolved once at dispatch and fixed for the Session it creates.
   */
  readonly model?: ModelPolicy
  readonly maxConcurrentRuns?: number
  readonly revision: number
}

/** Values a queue create or update may change. */
export interface QueueDraft {
  readonly id: string
  readonly title: string
  readonly taskOrder: readonly string[]
  readonly paused: boolean
  /** Pipeline lifecycle; omitted means `paused ? 'paused' : 'idle'`. */
  readonly state?: QueueState
  /** The original requirement this pipeline decomposes. */
  readonly brief?: string
  /** Workspace new tasks in this queue inherit. */
  readonly workspaceId?: string
  /** Canonical directory captured with `workspaceId`. */
  readonly cwd?: string
  /** Route a task inherits when its own policy is `inherit`. */
  readonly model?: ModelPolicy
  readonly maxConcurrentRuns?: number
}

/** Full task projection returned by `getQueue`. */
export interface TaskDto {
  readonly id: string
  readonly queueId: string
  readonly title: string
  readonly prompt: string
  readonly workspaceId: string
  readonly cwd: string
  readonly preset: PresetPolicy
  readonly model: ModelPolicy
  readonly skills: SkillsPolicy
  readonly dependsOn: readonly string[]
  /** Join the previous list group; the host derives `dependsOn` from this. */
  readonly parallelWithPrevious?: boolean
  readonly concurrencyGroup?: string
  readonly priority: number
  readonly handoff: HandoffPolicy
  readonly enabled: boolean
  /** Pipeline stage, when the task belongs to one. */
  readonly stage?: string
  /** Task whose decomposition created this one. */
  readonly parentTaskId?: string
  /** Session of this task's latest attempt; absent before the first dispatch. */
  readonly session?: SessionLinkDto
  readonly revision: number
}

/** Compact task projection carried by snapshots. */
export interface TaskSummaryDto {
  readonly id: string
  readonly queueId: string
  readonly title: string
  readonly workspaceId: string
  readonly priority: number
  readonly enabled: boolean
  /** Model route this task will use; inherited tasks resolve it at dispatch. */
  readonly model: ModelPolicy
  readonly dependsOn: readonly string[]
  /** Join the previous list group; the host derives `dependsOn` from this. */
  readonly parallelWithPrevious?: boolean
  readonly concurrencyGroup?: string
  readonly stage?: string
  readonly parentTaskId?: string
  /** Session of this task's latest attempt; absent before the first dispatch. */
  readonly session?: SessionLinkDto
  readonly revision: number
}

/** Values a task create or update may change. */
export interface TaskDraft {
  readonly id: string
  readonly queueId: string
  readonly title: string
  readonly prompt: string
  readonly workspaceId: string
  readonly cwd: string
  readonly preset: PresetPolicy
  readonly model: ModelPolicy
  readonly skills: SkillsPolicy
  readonly dependsOn: readonly string[]
  /** Join the previous list group; the host derives `dependsOn` from this. */
  readonly parallelWithPrevious?: boolean
  readonly concurrencyGroup?: string
  readonly priority: number
  readonly handoff: HandoffPolicy
  readonly enabled: boolean
  readonly stage?: string
  readonly parentTaskId?: string
}

/** One operation identity and phase attached to a run. */
export interface OperationRefDto {
  readonly id: string
  readonly phase: OperationPhase
}

/** One preset identity captured with its revision when available. */
export interface PresetRefDto {
  readonly id: string
  readonly revision?: number
}

/** Route and preset values frozen at a successful boundary. */
export interface EffectiveConfigDto {
  readonly routeSource: ConfigRouteSource
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly preset: PresetRefDto
  readonly capturedAt: number
}

/** One context-pressure reading attached to a run. */
export interface PressureDto {
  readonly provider: string
  readonly model: string
  readonly totalTokens: number
  readonly contextWindow?: number
  readonly ratio?: number
  readonly baselineKind: PressureBaselineKind
  readonly threshold: number
  readonly routeFingerprint: string
  readonly measuredAt: number
  readonly decision: PressureDecision
  readonly blockedBy?: PressureBlockReason
}

/** One stable run failure without its diagnostic message. */
export interface RunErrorDto {
  readonly code: string
  readonly retryable: boolean
}

/** One health reading of a live run. */
export type RunHealthDto = RunHealth

/** One run attempt projection. */
export interface RunDto {
  readonly id: string
  readonly taskId: string
  readonly attempt: number
  readonly state: RunState
  readonly generation: number
  readonly revision: number
  readonly activeSession?: SessionLinkDto
  readonly sessionLineage: readonly SessionLinkDto[]
  /**
   * The one Session this attempt actually executes in: the active one, or the
   * last member of its lineage once the attempt settled.
   */
  readonly session?: SessionLinkDto
  readonly operation?: OperationRefDto
  readonly configSnapshot?: EffectiveConfigDto
  readonly pressure?: PressureDto
  readonly health?: RunHealthDto
  readonly workspaceKey: string
  readonly providerKey?: string
  readonly lastError?: RunErrorDto
  readonly skipped: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** One audited pipeline intervention; never the full session answer body. */
export interface InterventionDto {
  readonly id: string
  readonly runId: string
  readonly taskId: string
  readonly generation: number
  readonly kind: InterventionKind
  readonly phase: InterventionPhase
  /** Why the host acted, in one sentence. */
  readonly reason: string
  /**
   * Which judge produced this action.
   *
   * Absent on records written before the model warden existed. A `model` entry
   * names the route whose tokens paid for the review.
   */
  readonly warden?: {
    readonly mode: 'rule' | 'model'
    readonly verdict: WardenVerdict
    readonly provider?: string
    readonly model?: string
  }
  /**
   * Conversation route whose tokens paid for the instruction turn.
   *
   * The fixed instruction and its answer run inside the task's own Session, so
   * the decomposition itself is billed to this route, not to the warden.
   */
  readonly paidBy?: {
    readonly provider: string
    readonly model: string
  }
  /** The signal that produced the verdict. */
  readonly trigger: {
    readonly contextRatio?: number
    readonly idleMs?: number
    readonly hitRate?: number
  }
  /** Instruction the host sent, when one was sent. */
  readonly promptSent?: string
  /** Answer captured from the session, truncated to the capture budget. */
  readonly producedPrompt?: string
  /** Session the host acted on, when the run still names one. */
  readonly session?: SessionLinkDto
  /** Turn the instruction opened, when the durable log proved it. */
  readonly turn?: number
  /** Restart reconciliations that already tried to advance this record. */
  readonly recoveryAttempts?: number
  readonly childTaskIds: readonly string[]
  readonly note?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * One audited warden review; never the state packet or the review prompt.
 *
 * A `model` row names the route and tokens it cost, so the page can attribute
 * every patrol to the account that paid. A `rule-fallback` row records why the
 * model review was not used, including `budget-exhausted` and provider failures.
 */
export interface WardenAuditDto {
  readonly id: string
  readonly runId: string
  readonly taskId: string
  readonly generation: number
  readonly mode: 'model' | 'rule-fallback'
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

/** One completed handoff projection; never its rendered body. */
export interface HandoffDto {
  readonly operationId: string
  readonly runId: string
  readonly generation: number
  readonly parentSession: SessionLinkDto
  readonly childSession: SessionLinkDto
  readonly sourceSeq: number
  readonly bodyHash: string
  readonly mode: HandoffMode
  readonly bodyTokens?: number
  readonly configSnapshot: EffectiveConfigDto
  readonly createdAt: number
}

/** Host-wide orchestration settings without host identity. */
export interface SettingsDto {
  readonly revision: number
  readonly paused: boolean
  readonly maxConcurrentRuns: number
  readonly providerQuotas: Readonly<Record<string, number>>
  readonly updatedAt: number
}

/** Values an explicit settings mutation may change. */
export interface SettingsDraft {
  readonly paused: boolean
  readonly maxConcurrentRuns: number
  readonly providerQuotas: Readonly<Record<string, number>>
}

/** Request for one queue lookup. */
export interface GetQueueRequest {
  readonly queueId: string
}

/** Request for one run lookup. */
export interface GetRunRequest {
  readonly runId: string
}

/** Request for one handoff lookup. */
export interface GetHandoffRequest {
  readonly operationId: string
}

/** Start, pause or abort one pipeline under revision CAS. */
export interface QueueControlRequest {
  readonly queueId: string
  readonly expectedRevision: number
}

/** Intervention list result. */
export interface InterventionListValue {
  readonly items: readonly InterventionDto[]
}

/** Create one queue at revision zero. */
export interface CreateQueueRequest {
  readonly expectedRevision: number
  readonly draft: QueueDraft
}

/**
 * Create one architecture → breakdown → implement → test pipeline as a draft.
 *
 * `queueId` is the idempotency identity: a repeated call with the same id
 * reuses the queue and creates only the stage tasks that are still missing, so
 * a lost response or a double click cannot produce a duplicate pipeline.
 */
export interface CreatePipelineTemplateRequest {
  readonly expectedRevision: number
  readonly queueId: string
  /** Optional label; a requirement-derived title is used when absent. */
  readonly title?: string
  /** Original requirement written once and embedded in every stage prompt. */
  readonly brief: string
  readonly workspaceId: string
  /** Canonical directory; filled from the Workspace registry when available. */
  readonly cwd?: string
  readonly maxConcurrentRuns?: number
  /** Route every stage inherits; absent means each stage inherits the host. */
  readonly model?: ModelPolicy
}

/** The draft queue and its four ordered stage tasks. */
export interface PipelineTemplateValue {
  readonly queue: QueueDto
  readonly tasks: readonly TaskDto[]
}

/** Replace one queue under revision CAS. */
export interface UpdateQueueRequest {
  readonly queueId: string
  readonly expectedRevision: number
  readonly draft: QueueDraft
}

/** Delete one queue and every orchestration record it owns. */
export interface DeleteDraftQueueRequest {
  readonly queueId: string
  readonly expectedRevision: number
}

/** Create or replace one task under revision CAS. */
export interface UpsertTaskRequest {
  readonly taskId: string
  readonly expectedRevision: number
  readonly draft: TaskDraft
  /**
   * Zero-based position in the queue list. When present, the host inserts or
   * moves the task and rewrites every dependency from the new order.
   */
  readonly position?: number
  /** Queue revision the position edit was based on; required with `position`. */
  readonly queueRevision?: number
}

/** Replace one queue's task order and parallel markers under revision CAS. */
export interface ReorderTasksRequest {
  readonly queueId: string
  readonly expectedRevision: number
  readonly taskOrder: readonly string[]
  /**
   * Ids that run together with the task above them. Absent means every task
   * runs after the previous list group.
   */
  readonly parallelWithPrevious?: readonly string[]
}

/** Delete one task and repair every dependency left behind. */
export interface DeleteTaskRequest {
  readonly queueId: string
  readonly taskId: string
  readonly expectedRevision: number
}

/** Queue state after one task leaves the list. */
export interface DeleteTaskValue {
  readonly queue: QueueDto
  readonly deletedTaskId: string
}

/** Copy one task immediately after itself under a fresh internal identity. */
export interface DuplicateTaskRequest {
  readonly queueId: string
  readonly taskId: string
  readonly expectedRevision: number
}

/** The queue and its new copied task. */
export interface DuplicateTaskValue {
  readonly queue: QueueDto
  readonly task: TaskDto
}

/** Rewrite every dependency from the current list order and parallel markers. */
export interface RepairTaskListRequest {
  readonly queueId: string
  readonly expectedRevision: number
}

/** Toggle one task's enabled flag under revision CAS. */
export interface SetTaskEnabledRequest {
  readonly taskId: string
  readonly expectedRevision: number
  readonly enabled: boolean
}

/** Record one audited human skip against a `needs-attention` run. */
export interface SkipTaskRequest {
  readonly runId: string
  readonly expectedRevision: number
  readonly actor: string
  readonly reason: string
}

/** Revision-only request for the host-wide pause and resume. */
export interface SettingsRevisionRequest {
  readonly expectedRevision: number
}

/** Cancel one run under revision CAS. */
export interface CancelRunRequest {
  readonly runId: string
  readonly expectedRevision: number
}

/** Start a fresh attempt for one settled run under revision CAS. */
export interface RetryRunRequest {
  readonly runId: string
  readonly expectedRevision: number
}

/** Replace host-wide settings under revision CAS. */
export interface UpdateSettingsRequest {
  readonly expectedRevision: number
  readonly draft: SettingsDraft
}

/** Queue list result. */
export interface QueueListValue {
  readonly items: readonly QueueDto[]
}

/** Queue detail with its visible tasks. */
export interface QueueDetailValue {
  readonly queue: QueueDto
  readonly tasks: readonly TaskDto[]
}

/** One queue result. */
export interface QueueValue {
  readonly queue: QueueDto
}

/** One task result. */
export interface TaskValue {
  readonly task: TaskDto
  /** Queue projection after an order-changing task write. */
  readonly queue?: QueueDto
}

/** Deletion receipt. */
export interface DeleteQueueValue {
  readonly queueId: string
  readonly deleted: true
}

/** Audited skip receipt. */
export interface SkipTaskValue {
  readonly skipped: true
  readonly taskId: string
  readonly runId: string
  readonly decidedAt: number
}

/** Run list result. */
export interface RunListValue {
  readonly items: readonly RunDto[]
}

/** One run result. */
export interface RunValue {
  readonly run: RunDto
}

/** Handoff list result. */
export interface HandoffListValue {
  readonly items: readonly HandoffDto[]
}

/** One handoff result. */
export interface HandoffValue {
  readonly handoff: HandoffDto
}

/** One settings result. */
export interface SettingsValue {
  readonly settings: SettingsDto
}

/** Host a capability row describes. */
export type HostSessionKindDto = 'dsh' | 'workbuddy' | 'trae'

/** The operations and host features a task may use. */
export type HostCapabilityNameDto =
  | 'listWorkspaces'
  | 'createSession'
  | 'sendPrompt'
  | 'openSession'
  | 'subscribeEvents'
  | 'getUsage'
  | 'selectModel'
  | 'listModels'
  | 'skills'
  | 'permissions'
  | 'compaction'

/** One capability row: supported with an optional boundary, or disabled with a reason. */
export interface HostCapabilityStateDto {
  readonly capability: HostCapabilityNameDto
  readonly status: 'supported' | 'unsupported'
  /** Concrete boundary of a supported operation. */
  readonly detail?: string
  /** Why an unsupported operation is disabled. */
  readonly reason?: string
}

/** One host's real capability matrix. */
export interface HostCapabilityDto {
  readonly host: HostSessionKindDto
  readonly displayName: string
  readonly available: boolean
  /** Whether this host exposes the create/send/subscribe trio a queue needs. */
  readonly runnable: boolean
  /**
   * Whether this host is the queue's execution backend.
   *
   * Only the primary host is true; a host that happens to support the trio
   * (for example WorkBuddy) still runs no queue here.
   */
  readonly queueBackend: boolean
  readonly capabilities: readonly HostCapabilityStateDto[]
}

/** One whole-orchestration snapshot, safe to replace Client state wholesale. */
export interface OrchestratorSnapshotFrame {
  readonly type: 'snapshot'
  /** Monotonic host generation; a lower value is stale. */
  readonly revision: number
  readonly generatedAt: number
  readonly settings?: SettingsDto
  readonly queues: readonly QueueDto[]
  readonly tasks: readonly TaskSummaryDto[]
  readonly runs: readonly RunDto[]
  readonly handoffs: readonly HandoffDto[]
  readonly interventions: readonly InterventionDto[]
  /**
   * Warden review ledger, bounded per run by retention.
   *
   * Empty in the default rule mode, where no review spends a token.
   */
  readonly wardenAudits: readonly WardenAuditDto[]
  /**
   * Host conversation capability matrix, primary host first.
   *
   * Empty only when no runtime is mounted, so an older composition does not
   * invent hosts it cannot verify.
   */
  readonly hosts: readonly HostCapabilityDto[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The caller has no role for the requested action or resource. */
    'sessionOrchestrator/forbidden': {
      readonly action: OrchestratorAction
      readonly resource: OrchestratorResourceKind
    }
    /** The requested record is absent or hidden by the access policy. */
    'sessionOrchestrator/not-found': {
      readonly resource: OrchestratorResourceKind
      readonly id?: string
    }
    /** The caller observed a revision the store has already moved past. */
    'sessionOrchestrator/revision-conflict': {
      readonly resource: OrchestratorResourceKind
      readonly id?: string
      readonly expectedRevision?: number
    }
    /** The identity already exists or two requests share one operation identity. */
    'sessionOrchestrator/conflict': {
      readonly resource: OrchestratorResourceKind
      readonly id?: string
    }
    /** The record exists but its current state forbids the request. */
    'sessionOrchestrator/invalid-transition': {
      readonly resource: OrchestratorResourceKind
      readonly id?: string
    }
    /** The wire request failed validation. */
    'sessionOrchestrator/invalid-request': { readonly field?: string }
    /** A queue still owns tasks and is therefore not a draft. */
    'sessionOrchestrator/queue-not-empty': { readonly queueId: string }
    /** The stored task list carries a dependency the queue cannot run. */
    'sessionOrchestrator/task-list-invalid': {
      readonly queueId: string
      readonly issues: readonly TaskListIssue[]
    }
    /** The authoritative store is closed or the requested operation is unsupported. */
    'sessionOrchestrator/unavailable': {}
    /** A queue control named a lifecycle the request cannot reach. */
    'sessionOrchestrator/queue-state': {
      readonly queueId: string
      readonly state: string
    }
    /** The carrier signal cancelled the call or stream. */
    'sessionOrchestrator/cancelled': {}
  }
}

/** Every stable failure code of the `sessionOrchestrator` namespace. */
export type SessionOrchestratorRemoteErrorCode =
  | 'sessionOrchestrator/forbidden'
  | 'sessionOrchestrator/not-found'
  | 'sessionOrchestrator/revision-conflict'
  | 'sessionOrchestrator/conflict'
  | 'sessionOrchestrator/invalid-transition'
  | 'sessionOrchestrator/invalid-request'
  | 'sessionOrchestrator/queue-not-empty'
  | 'sessionOrchestrator/task-list-invalid'
  | 'sessionOrchestrator/queue-state'
  | 'sessionOrchestrator/unavailable'
  | 'sessionOrchestrator/cancelled'
