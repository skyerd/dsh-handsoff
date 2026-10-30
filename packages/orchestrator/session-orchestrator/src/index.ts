/**
 * Durable session orchestration: records, schemas, revisions and close
 * semantics for a host that runs many agent sessions on a schedule, plus the
 * pure planner and the scheduler that consume those records.
 *
 * This package owns the Service Definition and its authoritative store. It
 * registers no model tools and never calls a model; the supervisor only observes
 * Session events and drives one Agent, while durable Session events are appended
 * by the agent loop. Handoff execution creates a fresh successor Session and
 * delivers one already-rendered recall message; it never summarizes with a model.
 *
 * @module @deepseek-ai/dsh-session-orchestrator
 */

export { OperationId, QueueId, RunId, TaskId } from './brand.ts'
export { OrchestratorError } from './errors.ts'
export type { OrchestratorErrorCode } from './errors.ts'
export type { SessionOrchestratorMessageSource } from './message-source.ts'
export {
  DEFAULT_ORCHESTRATOR_ACCESS,
  SessionOrchestratorController,
} from './remote.ts'
export type {
  CancelRunRequest,
  CreatePipelineTemplateRequest,
  CreateQueueRequest,
  DeleteDraftQueueRequest,
  DeleteQueueValue,
  DeleteTaskRequest,
  DeleteTaskValue,
  DuplicateTaskRequest,
  DuplicateTaskValue,
  EffectiveConfigDto,
  GetHandoffRequest,
  GetQueueRequest,
  GetRunRequest,
  HandoffDto,
  HostCapabilityDto,
  HostCapabilityNameDto,
  HostCapabilityStateDto,
  HostSessionKindDto,
  HandoffListValue,
  HandoffValue,
  InterventionDto,
  InterventionListValue,
  OperationRefDto,
  OrchestratorAccess,
  OrchestratorAccessRequest,
  OrchestratorAction,
  OrchestratorResource,
  OrchestratorResourceKind,
  OrchestratorRole,
  OrchestratorRunControl,
  OrchestratorSnapshotFrame,
  PipelineTemplateValue,
  PresetRefDto,
  PressureDto,
  QueueControlRequest,
  QueueDetailValue,
  QueueDto,
  QueueDraft,
  QueueListValue,
  QueueValue,
  ReorderTasksRequest,
  RepairTaskListRequest,
  RetryRunRequest,
  RunDto,
  RunErrorDto,
  RunHealthDto,
  RunListValue,
  RunValue,
  SessionLinkDto,
  SessionOpenState,
  SessionOrchestratorControllerConfig,
  SessionOrchestratorControllerInternals,
  SessionOrchestratorRemoteErrorCode,
  SetTaskEnabledRequest,
  SettingsDto,
  SettingsDraft,
  SettingsRevisionRequest,
  SettingsValue,
  SkipTaskRequest,
  SkipTaskValue,
  TaskDto,
  TaskDraft,
  TaskSummaryDto,
  TaskValue,
  UpdateQueueRequest,
  UpdateSettingsRequest,
  UpsertTaskRequest,
  WardenAuditDto,
} from './remote-types.ts'

export {
  deriveTaskDependencies,
  effectiveParallelIds,
  taskListIssues,
} from './task-order.ts'
export type {
  OrderedTaskLike,
  TaskListIssue,
  TaskListIssueKind,
} from './task-order.ts'

export {
  PIPELINE_ARTIFACT_DIR,
  PIPELINE_DEFAULT_HANDOFF,
  PIPELINE_STAGES,
  pipelineQueueTitle,
  pipelineStageModel,
  pipelineStagePrompt,
  pipelineTaskId,
  pipelineTaskIds,
} from './pipeline.ts'
export type { PipelineStage, PipelineStageName } from './pipeline.ts'

export {
  HOST_SESSION_CAPABILITIES,
  capabilityReport,
  failedCapability,
  sessionOpenRoute,
  succeeded,
  supportedState,
  unsupportedCapability,
} from './host-session.ts'
export type {
  HostCapabilityState,
  HostCreateSessionRequest,
  HostModelSelection,
  HostSessionAdapter,
  HostSessionCapability,
  HostSessionCapabilityReport,
  HostSessionEvent,
  HostSessionFailure,
  HostSessionKind,
  HostSessionListener,
  HostSessionRef,
  HostSessionResult,
  HostSessionUsage,
  HostWorkspace,
} from './host-session.ts'
export { DshHostSessionAdapter, createDshHostSessionAdapter } from './host-dsh.ts'
export type {
  DshHostAgents,
  DshHostDefaultModel,
  DshHostEventSource,
  DshHostFeatureSupport,
  DshHostLiveSessions,
  DshHostSessionOptions,
  DshHostTokenMeter,
  DshHostWorkspace,
  DshHostWorkspaceSource,
  DshHostWorkspaces,
} from './host-dsh.ts'
export { WorkBuddyHostSessionAdapter, createWorkBuddyHostSessionAdapter, discoverWorkBuddyCli } from './host-workbuddy.ts'
export type {
  WorkBuddyCommandResult,
  WorkBuddyHostSessionOptions,
  WorkBuddyRunHandle,
  WorkBuddyRunOptions,
  WorkBuddyStreamRunner,
} from './host-workbuddy.ts'
export { HostSessionUnavailableError, HostSessionRegistry, createDefaultHostSessionRegistry } from './host-registry.ts'
export type {
  DefaultHostSessionRegistryOptions,
  HostSessionRegistryOptions,
} from './host-registry.ts'
export { TraeHostSessionAdapter, createTraeHostSessionAdapter, discoverTraeCli } from './host-trae.ts'
export { INITIAL_GLOBAL_SETTINGS, sessionOrchestratorDomain } from './storage.ts'
export { SessionOrchestrator } from './store.ts'
export {
  describeBlocker,
  isActiveRunState,
  isAuditedSkip,
  planReadyTasks,
} from './planner.ts'
export type {
  ActiveRunState,
  HumanSkip,
  PlannerActive,
  PlannerBlocker,
  PlannerBlocked,
  PlannerDiagnostic,
  PlannerInput,
  PlannerOutput,
  PlannerReady,
  PlannerSkipped,
} from './planner.ts'
export { LaunchFailure, Scheduler, taskProviderKey } from './scheduler.ts'
export { frozenModelOf, resolveTaskModel } from './model-route.ts'
export type {
  RunLauncher,
  RunLauncherRequest,
  RunLaunchOutcome,
  SchedulerFailure,
  SchedulerOptions,
  SchedulerSkip,
  SchedulerSkipReason,
  SchedulerSnapshot,
  SchedulerStart,
  SchedulerStore,
  SchedulerTickResult,
} from './scheduler.ts'
export {
  initialPromptOperationId,
  initialPromptRequestHash,
  operationLinkConflict,
} from './operation.ts'
export { RecoveryManager, assessRunLease, scanEvents } from './recovery.ts'
export type {
  DurableSessionHandle,
  DurableSessionReader,
  RecoveryAction,
  RecoveryDecision,
  RecoveryManagerOptions,
  RecoveryMessage,
  RecoveryReason,
  RecoveryReport,
  RecoveryScheduler,
  RecoverySessionDirectory,
  RecoveryState,
  RecoveryStore,
  RecoverySupervisor,
  RecoveryUnloadReport,
  RunLeaseVerdict,
  SessionEvidence,
} from './recovery.ts'
export { SupervisorLauncher } from './launcher.ts'
export type { LaunchSupervisor, SupervisorLauncherOptions } from './launcher.ts'
export { LocalSessionOrchestrator } from './local.ts'
export {
  Config as sessionOrchestratorRuntimeConfig,
  DEFAULT_CONTEXT_CEILING,
  DEFAULT_HIT_RATE_ABORT,
  DEFAULT_HIT_RATE_WARN,
  DEFAULT_IDLE_MS,
  DEFAULT_WARDEN_AUDIT_LIMIT,
  DEFAULT_WARDEN_COOLDOWN_MS,
  DEFAULT_WARDEN_MAX_OUTPUT_TOKENS,
  DEFAULT_WARDEN_MAX_PACKET_BYTES,
  DEFAULT_WARDEN_MAX_REVIEWS,
  DEFAULT_WARDEN_MODE,
  DEFAULT_WARDEN_TIMEOUT_MS,
  SessionOrchestratorRuntime,
  apply as applyRuntime,
} from './runtime.ts'
export type { RuntimeOptions, RuntimePhase } from './runtime.ts'
export {
  MAX_WARDEN_REASON_CHARS,
  ModelWarden,
  WARDEN_REVIEW_SCHEMA,
  WARDEN_REVIEW_SYSTEM_PROMPT,
  WardenReviewError,
  createModelWarden,
  wardenReviewSchema,
} from './model-warden.ts'
export type {
  ModelReviewer,
  ModelWardenLimits,
  WardenLlmPort,
  WardenModelRoute,
  WardenReview,
} from './model-warden.ts'
export { WARDEN_VERDICTS } from './schema.ts'
export {
  DEFAULT_DECOMPOSE_LIMITS,
  FIXED_DECOMPOSE_PROMPT,
  IDLE_PING_PROMPT,
  RuleWarden,
  interventionId,
  isHardGateVerdict,
  kindOfVerdict,
  parseDecomposition,
  protectHardGate,
  wardenAuditId,
} from './warden.ts'
export type {
  DecomposeLimits,
  DecomposedTask,
  Warden,
  WardenDecision,
  WardenHealth,
  WardenPacket,
  WardenRecentEvent,
  WardenThresholds,
  WardenVerdict,
} from './warden.ts'
export type {
  LocalSessionOrchestratorDomain,
  LocalSessionOrchestratorOptions,
  LocalSessionOrchestratorStore,
} from './local.ts'
export {
  DEFAULT_HANDOFF_RATIO,
  DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS,
  DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS,
  estimatePressureBudget,
  PressureMonitor,
  pressureRouteFingerprint,
} from './pressure.ts'
export type {
  PressureBodyFallback,
  PressureBudget,
  PressureHandoffBodies,
  PressureMeasurement,
  PressureMeasurementBaseline,
  PressureModeBudget,
  PressureMonitorOptions,
  PressureObservation,
  PressureObservationResult,
  PressureRoute,
  PressureStore,
  PressureTokenMeter,
} from './pressure.ts'
export {
  HOST_DEFAULT_PRESET_ID,
  HandoffManager,
  handoffBodyHash,
  handoffOperationId,
  handoffRequestHash,
  handoffTargetSessionId,
  inspectHandoffSession,
  normalizeHandoffBody,
  renderLastCompleteTurn,
  renderStructuredBrief,
  validateHandoffPolicy,
} from './handoff.ts'
export type {
  HandoffAgents,
  HandoffBackgroundJob,
  HandoffBlockReason,
  HandoffCompleteTurn,
  HandoffConfigDegradation,
  HandoffConfigInheritance,
  HandoffDurability,
  HandoffExecutionRequest,
  HandoffFailureReason,
  HandoffManagerOptions,
  HandoffPresetInheritance,
  HandoffResult,
  HandoffRuntimeModel,
  HandoffSessionFacts,
  HandoffStatus,
  HandoffStopReason,
  HandoffStore,
  HandoffToolFact,
  HandoffToolStatus,
  LastCompleteTurnBodyInput,
  StructuredBriefInput,
} from './handoff.ts'
export { RunHandleTable, RunSupervisor } from './supervisor.ts'
export type {
  RunAcceptedTurn,
  RunHandle,
  RunLaunchStart,
  RunOwnership,
  RunProbe,
  RunResumeProgress,
  RunResumeRequest,
  RunResumeStart,
  RunSettlement,
  RunSettlementReason,
  RunSettlementState,
  RunStartRequest,
  RunSupervisorOptions,
  SessionDurability,
  SupervisorAgents,
  SupervisorLiveSessions,
  SupervisorPresets,
  SupervisorStore,
  SupervisorWorkspace,
  SupervisorWorkspaces,
} from './supervisor.ts'
export { createWorkspaceKeyResolver, normalizeWorkspacePath, resolveWorkspaceKey } from './workspace-key.ts'
export type {
  WorkspaceKeyRejection,
  WorkspaceKeyResolution,
  WorkspaceKeyResolver,
} from './workspace-key.ts'
export type * from './types.ts'
export { default } from './store.ts'
