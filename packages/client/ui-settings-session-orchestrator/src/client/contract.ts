/**
 * Client-facing projection of the `sessionOrchestrator` Remote namespace.
 *
 * The DTO and request types come from the Host controller source at commit
 * 639ed015397290b3745d163aafe02ffee4aa3f84; this package adds only the
 * generated-method signatures the browser calls. The namespace service itself
 * is mounted by the Remote assembly, so the UI reaches it through
 * `ctx.get('remote.sessionOrchestrator')` rather than a second transport.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/contract
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol/types'
import type {
  CancelRunRequest,
  CreatePipelineTemplateRequest,
  CreateQueueRequest,
  DeleteDraftQueueRequest,
  DeleteQueueValue,
  DeleteTaskRequest,
  DeleteTaskValue,
  DuplicateTaskRequest,
  DuplicateTaskValue,
  GetHandoffRequest,
  GetQueueRequest,
  GetRunRequest,
  HandoffDto,
  HandoffListValue,
  HandoffValue,
  HostCapabilityDto,
  HostCapabilityNameDto,
  HostCapabilityStateDto,
  HostSessionKindDto,
  InterventionDto,
  InterventionListValue,
  ModelPolicy,
  OrchestratorSnapshotFrame,
  PipelineTemplateValue,
  QueueControlRequest,
  QueueDetailValue,
  QueueDto,
  QueueDraft,
  QueueListValue,
  QueueState,
  QueueValue,
  ReorderTasksRequest,
  RepairTaskListRequest,
  RetryRunRequest,
  RunDto,
  RunListValue,
  RunValue,
  SessionLinkDto,
  SessionOpenState,
  SetTaskEnabledRequest,
  SettingsDto,
  SettingsDraft,
  SettingsRevisionRequest,
  SettingsValue,
  SkipTaskRequest,
  SkipTaskValue,
  TaskDraft,
  TaskDto,
  TaskSummaryDto,
  TaskValue,
  UpdateQueueRequest,
  UpdateSettingsRequest,
  UpsertTaskRequest,
  WardenAuditDto,
} from '@deepseek-ai/dsh-session-orchestrator'

export type {
  CancelRunRequest, CreatePipelineTemplateRequest, CreateQueueRequest, DeleteDraftQueueRequest, DeleteQueueValue,
  DeleteTaskRequest, DeleteTaskValue, DuplicateTaskRequest, DuplicateTaskValue,
  GetHandoffRequest, GetQueueRequest, GetRunRequest, HandoffDto, HandoffListValue, HandoffValue,
  HostCapabilityDto, HostCapabilityNameDto, HostCapabilityStateDto, HostSessionKindDto,
  InterventionDto, InterventionListValue, OrchestratorSnapshotFrame, PipelineTemplateValue, QueueControlRequest,
  QueueDetailValue, QueueDto, QueueDraft, QueueListValue, QueueState, QueueValue,
  ModelPolicy,
  ReorderTasksRequest, RepairTaskListRequest, RetryRunRequest, RunDto, RunListValue, RunValue, SessionLinkDto,
  SessionOpenState, SetTaskEnabledRequest, SettingsDto, SettingsDraft, SettingsRevisionRequest, SettingsValue,
  SkipTaskRequest, SkipTaskValue, TaskDraft, TaskDto, TaskSummaryDto, TaskValue,
  UpdateQueueRequest, UpdateSettingsRequest, UpsertTaskRequest, WardenAuditDto,
}

/** One browser-selectable host Workspace. */
export interface WorkspaceChoice {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

/**
 * The methods the browser drives on `remote.sessionOrchestrator`.
 *
 * The generated namespace owns tracing, cancellation transport and wire
 * validation; this interface only names the controller methods the page uses.
 */
export interface OrchestratorRemote {
  /**
   * Open one snapshot generation.
   * @param signal - carrier cancellation; abort ends the iteration.
   * @returns one baseline frame followed by coalesced whole snapshots.
   */
  changed(signal?: AbortSignal): AsyncIterable<OrchestratorSnapshotFrame>
  /**
   * List visible queues.
   * @returns queue projections.
   */
  listQueues(): Promise<RemoteResult<QueueListValue>>
  /**
   * Read one queue and its tasks.
   * @param request - queue identity.
   * @returns queue detail.
   */
  getQueue(request: GetQueueRequest): Promise<RemoteResult<QueueDetailValue>>
  /**
   * Create one queue at revision zero.
   * @param request - revision zero and the draft.
   * @returns the created queue.
   */
  createQueue(request: CreateQueueRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Create one four-stage pipeline as a draft queue plus its ordered tasks.
   * @param request - queue identity, requirement, workspace and optional model.
   * @returns the draft queue and its stage tasks.
   */
  createPipelineTemplate(
    request: CreatePipelineTemplateRequest,
  ): Promise<RemoteResult<PipelineTemplateValue>>
  /**
   * Replace one queue under revision CAS.
   * @param request - identity, observed revision and draft.
   * @returns the stored queue.
   */
  updateQueue(request: UpdateQueueRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Delete one queue that owns no task.
   * @param request - identity and observed revision.
   * @returns the deletion receipt.
   */
  deleteDraftQueue(request: DeleteDraftQueueRequest): Promise<RemoteResult<DeleteQueueValue>>
  /**
   * Start one pipeline: unpause the host and mark the queue running.
   * @param request - identity and observed revision.
   * @returns the stored queue.
   */
  startQueue(request: QueueControlRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Pause one pipeline without cancelling its running attempts.
   * @param request - identity and observed revision.
   * @returns the stored queue.
   */
  pauseQueue(request: QueueControlRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Abort one pipeline and cancel its live runs.
   * @param request - identity and observed revision.
   * @returns the stored queue.
   */
  abortQueue(request: QueueControlRequest): Promise<RemoteResult<QueueValue>>
  /**
   * List audited pipeline interventions.
   * @returns intervention projections, newest first.
   */
  listInterventions(): Promise<RemoteResult<InterventionListValue>>
  /**
   * Create or replace one task under revision CAS.
   * @param request - identity, observed revision and draft.
   * @returns the stored task.
   */
  upsertTask(request: UpsertTaskRequest): Promise<RemoteResult<TaskValue>>
  /**
   * Replace one queue's task order and parallel markers under revision CAS.
   * @param request - queue identity, observed revision, order and parallel ids.
   * @returns the stored queue.
   */
  reorderTasks(request: ReorderTasksRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Delete one task and rewrite the remaining dependencies in one commit.
   * @param request - queue identity, task identity and observed revision.
   * @returns the queue and the deleted identity.
   */
  deleteTask(request: DeleteTaskRequest): Promise<RemoteResult<DeleteTaskValue>>
  /**
   * Copy one task immediately after itself under a fresh identity.
   * @param request - queue identity, source task identity and observed revision.
   * @returns the queue and the new task.
   */
  duplicateTask(request: DuplicateTaskRequest): Promise<RemoteResult<DuplicateTaskValue>>
  /**
   * Rewrite every dependency from the current list order.
   * @param request - queue identity and observed revision.
   * @returns the repaired queue.
   */
  repairTaskList(request: RepairTaskListRequest): Promise<RemoteResult<QueueValue>>
  /**
   * Toggle one task's enabled flag under revision CAS.
   * @param request - task identity, observed revision and flag.
   * @returns the stored task.
   */
  setTaskEnabled(request: SetTaskEnabledRequest): Promise<RemoteResult<TaskValue>>
  /**
   * Record one audited human skip.
   * @param request - run identity, observed revision, actor and reason.
   * @returns the audit receipt.
   */
  skipTask(request: SkipTaskRequest): Promise<RemoteResult<SkipTaskValue>>
  /**
   * List visible runs.
   * @returns run projections.
   */
  listRuns(): Promise<RemoteResult<RunListValue>>
  /**
   * Read one run.
   * @param request - run identity.
   * @returns the run projection.
   */
  getRun(request: GetRunRequest): Promise<RemoteResult<RunValue>>
  /**
   * Pause the host scheduler.
   * @param request - observed settings revision.
   * @returns the stored settings.
   */
  pause(request: SettingsRevisionRequest): Promise<RemoteResult<SettingsValue>>
  /**
   * Resume the host scheduler.
   * @param request - observed settings revision.
   * @returns the stored settings.
   */
  resume(request: SettingsRevisionRequest): Promise<RemoteResult<SettingsValue>>
  /**
   * Cancel one run's orchestration state.
   * @param request - run identity and observed revision.
   * @returns the cancelled run.
   */
  cancel(request: CancelRunRequest): Promise<RemoteResult<RunValue>>
  /**
   * Start a fresh attempt for one settled run.
   * @param request - run identity and observed revision.
   * @returns the new ready attempt.
   */
  retry(request: RetryRunRequest): Promise<RemoteResult<RunValue>>
  /**
   * List completed handoffs.
   * @returns handoff projections.
   */
  listHandoffs(): Promise<RemoteResult<HandoffListValue>>
  /**
   * Read one completed handoff.
   * @param request - producing operation identity.
   * @returns the handoff projection.
   */
  getHandoff(request: GetHandoffRequest): Promise<RemoteResult<HandoffValue>>
  /**
   * Read host-wide orchestration settings.
   * @returns the settings projection.
   */
  getSettings(): Promise<RemoteResult<SettingsValue>>
  /**
   * Replace host-wide settings under revision CAS.
   * @param request - observed revision and draft.
   * @returns the stored settings.
   */
  updateSettings(request: UpdateSettingsRequest): Promise<RemoteResult<SettingsValue>>
}

/**
 * Default draft of a task the page has not stored yet.
 * @param queueId - queue the new task will belong to.
 * @returns an unsaved task draft.
 */
export function emptyTaskDraft(queueId: string): TaskDraft {
  return {
    id: '',
    queueId,
    title: '',
    prompt: '',
    workspaceId: '',
    cwd: '',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: 0.6,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 4,
      maxHandoffTokens: 8_000,
    },
    enabled: true,
  }
}

/**
 * Default draft of a queue the page has not stored yet.
 * @returns an unsaved queue draft.
 */
export function emptyQueueDraft(): QueueDraft {
  return { id: '', title: '', taskOrder: [], paused: false, state: 'idle', model: { kind: 'inherit' } }
}
