/**
 * Host Remote owner for the `sessionOrchestrator` namespace.
 *
 * The controller is a projection over the durable orchestration store: it
 * reads records synchronously, applies revision-bound mutations, filters every
 * result through one access policy, and publishes whole snapshots with a
 * monotonically increasing revision. It never exposes a Handle, a Context or
 * any credential, and it never creates an Agent, calls a model or appends a
 * Session event.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HOST_SESSION_CAPABILITIES } from './host-session.ts'
import type { HostSessionCapabilityReport } from './host-session.ts'
import type { ZodError } from 'zod'
import { OperationId, QueueId, RunId, TaskId } from './brand.ts'
import type {} from './store.ts'
import { OrchestratorError } from './errors.ts'
import {
  globalSettingsSchema,
  modelPolicySchema,
  queueRecordSchema,
  skipRecordSchema,
  taskSpecSchema,
} from './schema.ts'
import {
  PIPELINE_DEFAULT_HANDOFF,
  PIPELINE_STAGES,
  pipelineQueueTitle,
  pipelineStagePrompt,
  pipelineTaskId,
  pipelineTaskIds,
} from './pipeline.ts'
import {
  deriveTaskDependencies,
  effectiveParallelIds,
  taskListIssues,
} from './task-order.ts'
import type { TaskListIssue } from './task-order.ts'
import type {
  EffectiveConfigSnapshot,
  GlobalSettings,
  HandoffRecord,
  InterventionRecord,
  PressureSnapshot,
  QueueRecord,
  RunRecord,
  RunState,
  SkipRecord,
  TaskSpec,
  WardenAuditRecord,
} from './types.ts'

/** Storage domain name whose changes refresh the Remote snapshot. */
const DOMAIN_NAME = 'session_orchestrator'

/** Run states a human may cancel without overwriting a settled outcome. */
const CANCELLABLE_RUN_STATES: ReadonlySet<RunState> = new Set([
  'ready',
  'starting',
  'running',
  'handoff-pending',
  'needs-attention',
  'paused',
])

/** Run states a human may replace with a new attempt. */
const RETRYABLE_RUN_STATES: ReadonlySet<RunState> = new Set([
  'needs-attention',
  'failed',
  'cancelled',
  'paused',
])

/** Same-origin path prefix that opens one Session by identity. */
const SESSION_ROUTE_PREFIX = '/session'

/** Query parameter the Web application reads once at boot to select a Session. */
const SESSION_OPEN_PARAM = 'dsh-session'

/**
 * The slice of `ctx.webServer` this controller needs.
 *
 * Structural rather than imported so a host composition without the browser
 * carrier still mounts the controller: the route simply does not exist there,
 * and every DTO reports `unsupported` instead of advertising a dead link.
 */
interface SessionRouteRegistrar {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (
      request: { readonly url?: string; readonly method?: string },
      response: {
        statusCode: number
        setHeader(name: string, value: string): void
        end(body?: string): void
      },
    ) => void
  }): () => void
}

/**
 * The host Workspace registry face this controller validates against.
 *
 * Structural rather than imported so the orchestration package keeps its
 * package boundary: production passes `ctx.workspaceRegistry`, while a
 * scheduler-only composition without the Workspace plugin keeps the legacy
 * plain `workspaceId + cwd` behavior.
 */
interface WorkspaceLookup {
  get(id: string): { readonly path: string } | undefined
  /** Ordered registry projection; absent on a scheduler-only composition. */
  list?(): readonly {
    readonly workspaceId: string
    readonly path: string
    readonly sessionIds: readonly string[]
  }[]
  /** Sessions the user archived; an archived Session must be restored before it runs. */
  readonly archivedSessionIds?: readonly string[]
}

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
  EffectiveConfigDto,
  GetHandoffRequest,
  GetQueueRequest,
  GetRunRequest,
  HandoffDto,
  HandoffListValue,
  HandoffValue,
  HostCapabilityDto,
  InterventionDto,
  InterventionListValue,
  OrchestratorAccess,
  OrchestratorAction,
  OrchestratorResource,
  OrchestratorResourceKind,
  OrchestratorRole,
  OrchestratorRunControl,
  OrchestratorSnapshotFrame,
  PipelineTemplateValue,
  PressureDto,
  QueueControlRequest,
  QueueDetailValue,
  QueueDto,
  QueueListValue,
  QueueValue,
  ReorderTasksRequest,
  RepairTaskListRequest,
  RetryRunRequest,
  RunDto,
  RunListValue,
  RunValue,
  SessionLinkDto,
  SessionOrchestratorControllerConfig,
  SessionOrchestratorControllerInternals,
  SetTaskEnabledRequest,
  SettingsDto,
  SettingsRevisionRequest,
  SettingsValue,
  SkipTaskRequest,
  SkipTaskValue,
  TaskDto,
  TaskSummaryDto,
  TaskValue,
  UpdateQueueRequest,
  UpdateSettingsRequest,
  UpsertTaskRequest,
  WardenAuditDto,
} from './remote-types.ts'

/** Default policy: Connection admission already authenticated every caller. */
export const DEFAULT_ORCHESTRATOR_ACCESS: OrchestratorAccess = Object.freeze({
  role: (): OrchestratorRole => 'owner',
})

/**
 * Host service backing the generated `ctx.remote.sessionOrchestrator` namespace.
 *
 * Every mutation carries `expectedRevision`; every read and mutation result is
 * projected through an explicit DTO. The class registers no model tool, never
 * calls a model and appends no Session event.
 */
export class SessionOrchestratorController extends TypertRemoteService {
  static inject = ['sessionOrchestrator', 'typert']

  private readonly access: OrchestratorAccess
  private readonly runControl: OrchestratorRunControl | undefined
  private readonly now: () => number
  private readonly subscribers = new Set<() => void>()

  /** Host generation advanced by every durable domain change. */
  private changeRevision = 0

  /**
   * @param ctx - Host Context carrying the orchestration store and Typert registry.
   * @param _config - reserved deployment configuration; no option exists today.
   * @param internals - access policy, optional live-run control and clock.
   */
  constructor(
    ctx: Context,
    _config: SessionOrchestratorControllerConfig = {},
    internals: SessionOrchestratorControllerInternals = {},
  ) {
    super(ctx, 'sessionOrchestratorController', { namespace: 'sessionOrchestrator' })
    this.access = internals.access ?? DEFAULT_ORCHESTRATOR_ACCESS
    this.runControl = internals.runControl
    this.now = internals.now ?? (() => Date.now())
    ctx.effect(() => ctx.on('domain/changed', (change) => {
      if (change.domain !== DOMAIN_NAME) return
      this.changeRevision += 1
      for (const notify of this.subscribers) notify()
    }), 'sessionOrchestratorController.domainChanges')
    // The Session route is a pure redirect to the Web application: it carries
    // no record data, so it needs no access policy of its own.
    ctx.effect(() => this.registerSessionRoute(), 'sessionOrchestratorController.sessionRoute')
  }

  /**
   * List every visible queue without any task definition.
   * @returns the queue projections, in store key order.
   */
  @Remote('listQueues')
  listQueues(): QueueListValue {
    this.requireReadCollection('queue')
    const items = this.ctx.sessionOrchestrator.listQueues()
      .filter(queue => this.canRead('queue', queue.id))
      .map(queue => this.queueDto(queue))
    return { items }
  }

  /**
   * Read one queue and the tasks it owns.
   * @param request - queue identity.
   * @returns the queue and its visible tasks in queue order.
   */
  @Remote('getQueue')
  getQueue(request: GetQueueRequest): QueueDetailValue {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    this.requireReadItem('queue', id)
    const store = this.ctx.sessionOrchestrator
    const queue = store.getQueue(QueueId(id))
    if (queue === undefined) throw notFound('queue', id)
    const order = new Map(queue.taskOrder.map((taskId, index) => [taskId, index]))
    const tasks = store.listTasks()
      .filter(task => task.queueId === queue.id && this.canRead('task', task.id))
      .sort((left, right) => {
        const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER
        const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER
        return leftOrder - rightOrder || left.id.localeCompare(right.id)
      })
    return { queue: this.queueDto(queue), tasks: tasks.map(task => this.taskDto(task)) }
  }

  /**
   * Create one queue at revision zero.
   * @param request - revision zero and the editable draft.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the created queue.
   */
  @Remote('createQueue')
  async createQueue(request: CreateQueueRequest, signal: AbortSignal): Promise<QueueValue> {
    const input = requireRequest(request)
    const expectedRevision = requireRevision(input, 'expectedRevision')
    throwIfCancelled(signal)
    if (expectedRevision !== 0) throw invalidRequest('expectedRevision')
    const record = this.bindQueueWorkspace(parseQueueDraft(requireRecord(input, 'draft'), 0))
    this.requireMutate('queue', record.id)
    try {
      return { queue: this.queueDto(await this.ctx.sessionOrchestrator.createQueue(record)) }
    } catch (error) {
      this.reject(error, { kind: 'queue', id: record.id }, expectedRevision)
    }
  }

  /**
   * Create one architecture → breakdown → implement → test pipeline as a draft.
   *
   * The queue is `idle` and paused, so nothing starts until the user presses
   * "Start pipeline": creating the template never consumes a Token. Task ids are
   * derived from `queueId`, and an existing template is adopted instead of being
   * written twice, so a double click or a retried request cannot duplicate a
   * pipeline. Every stage inherits the pipeline route stored on the queue; a
   * stage may later pin its own route, and subtasks inherit the pipeline route
   * too. The route is resolved once when a stage's Session is created.
   * @param request - the queue identity, requirement, workspace and optional model.
   * @param signal - carrier cancellation; checked before every durable write.
   * @returns the draft queue and its four ordered stage tasks.
   */
  @Remote('createPipelineTemplate')
  async createPipelineTemplate(
    request: CreatePipelineTemplateRequest,
    signal: AbortSignal,
  ): Promise<PipelineTemplateValue> {
    const input = requireRequest(request)
    const expectedRevision = requireRevision(input, 'expectedRevision')
    if (expectedRevision !== 0) throw invalidRequest('expectedRevision')
    const queueId = QueueId(requireId(input, 'queueId'))
    const brief = requireText(input, 'brief')
    if (brief.trim() === '') throw invalidRequest('brief')
    const workspaceId = requireText(input, 'workspaceId')
    const title = input.title === undefined
      ? pipelineQueueTitle(brief)
      : requireText(input, 'title')
    const cwd = input.cwd === undefined ? undefined : requireText(input, 'cwd')
    const maxConcurrentRuns = input.maxConcurrentRuns === undefined
      ? undefined
      : requirePositiveInteger(input, 'maxConcurrentRuns')
    let pipelineModel: TaskSpec['model'] | undefined
    if (input.model !== undefined) pipelineModel = parseModelPolicy(input.model)

    this.requireMutate('queue', queueId)
    const taskIds = pipelineTaskIds(queueId)
    for (const taskId of taskIds) this.requireMutate('task', taskId)
    throwIfCancelled(signal)

    const store = this.ctx.sessionOrchestrator
    const existing = store.getQueue(queueId)
    if (existing !== undefined) {
      // Only an untouched draft template may be adopted. Adding stage tasks to a
      // live or aborted pipeline would change a run the user is already watching.
      if (existing.state === 'running' || existing.state === 'aborted') {
        throw invalidTransition('queue', queueId)
      }
      if (existing.brief !== brief || existing.workspaceId !== workspaceId) {
        throw invalidTransition('queue', queueId)
      }
      if (pipelineModel !== undefined && !sameModelPolicy(existing.model, pipelineModel)) {
        throw invalidTransition('queue', queueId)
      }
      const templateIds = new Set<string>(taskIds)
      for (const task of store.listTasks()) {
        if (task.queueId === queueId && !templateIds.has(task.id)) {
          throw invalidTransition('queue', queueId)
        }
      }
    }

    // Validate every derived task identity before the first durable write, so a
    // collision with another queue cannot leave a queue that owns no stages.
    for (const stage of PIPELINE_STAGES) {
      const taskId = pipelineTaskId(queueId, stage.stage)
      const current = store.getTask(taskId)
      if (current === undefined) continue
      if (current.queueId !== queueId
        || current.stage !== stage.stage
        || current.parentTaskId !== undefined) {
        throw invalidTransition('task', taskId)
      }
    }

    const seed: QueueRecord = existing ?? {
      id: queueId,
      title,
      taskOrder: [...taskIds],
      paused: true,
      state: 'idle',
      brief,
      workspaceId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(pipelineModel === undefined ? {} : { model: pipelineModel }),
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
      revision: 0,
    }
    const bound = this.bindQueueWorkspace(seed)
    if (bound.cwd === undefined) throw invalidRequest('cwd')
    const parsedQueue = queueRecordSchema.safeParse(bound)
    if (!parsedQueue.success) throw invalidRequest(firstIssue(parsedQueue.error))

    let queue = existing
    if (queue === undefined) {
      try {
        queue = await store.createQueue(parsedQueue.data)
      } catch (error) {
        this.reject(error, { kind: 'queue', id: queueId }, expectedRevision)
      }
    }

    for (const [index, stage] of PIPELINE_STAGES.entries()) {
      throwIfCancelled(signal)
      const taskId = pipelineTaskId(queueId, stage.stage)
      const current = store.getTask(taskId)
      if (current !== undefined) {
        // A retried request adopts the stage task it already wrote; a task that
        // belongs to another queue or another stage is a real identity conflict.
        if (current.queueId !== queueId
          || current.stage !== stage.stage
          || current.parentTaskId !== undefined) {
          throw invalidTransition('task', taskId)
        }
        continue
      }
      const previous = index === 0 ? undefined : taskIds[index - 1]
      const candidate = this.bindTaskWorkspace({
        id: taskId,
        queueId,
        title: stage.title,
        prompt: pipelineStagePrompt(stage.stage, brief),
        workspaceId,
        cwd: bound.cwd,
        preset: { kind: 'inherit' },
        model: { kind: 'inherit' },
        skills: { kind: 'inherit-preset' },
        dependsOn: previous === undefined ? [] : [previous],
        priority: 0,
        handoff: PIPELINE_DEFAULT_HANDOFF,
        enabled: true,
        stage: stage.stage,
        revision: 0,
      })
      const parsedTask = taskSpecSchema.safeParse(candidate)
      if (!parsedTask.success) throw invalidRequest(firstIssue(parsedTask.error))
      try {
        await store.createTask(parsedTask.data)
      } catch (error) {
        this.reject(error, { kind: 'task', id: taskId }, 0)
      }
    }

    const latest = store.getQueue(queueId) ?? queue
    if (latest === undefined) throw notFound('queue', queueId)
    const expectedOrder = [...taskIds]
    if (!sameTaskOrder(latest.taskOrder, expectedOrder)) {
      try {
        queue = await store.updateQueue(queueId, latest.revision, {
          ...latest,
          taskOrder: expectedOrder,
          revision: latest.revision + 1,
        })
      } catch (error) {
        this.reject(error, { kind: 'queue', id: queueId }, latest.revision)
      }
    } else {
      queue = latest
    }

    const tasks = expectedOrder.map(taskId => store.getTask(taskId))
      .filter((task): task is TaskSpec => task !== undefined)
    return { queue: this.queueDto(queue), tasks: tasks.map(task => this.taskDto(task)) }
  }

  /**
   * Replace one queue under revision CAS.
   * @param request - queue identity, the observed revision and the editable draft.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated queue.
   */
  @Remote('updateQueue')
  async updateQueue(request: UpdateQueueRequest, signal: AbortSignal): Promise<QueueValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('queue', id)
    throwIfCancelled(signal)
    const draft = requireRecord(input, 'draft')
    if (requireId(draft, 'id') !== id) throw invalidRequest('draft.id')
    const store = this.ctx.sessionOrchestrator
    const current = store.getQueue(QueueId(id))
    if (current === undefined) throw notFound('queue', id)
    if (current.revision !== expectedRevision) throw revisionConflict('queue', id, expectedRevision)
    const next = this.bindQueueWorkspace(parseQueueDraft(draft, expectedRevision + 1, current.state))
    try {
      return { queue: this.queueDto(await store.updateQueue(QueueId(id), expectedRevision, next)) }
    } catch (error) {
      this.reject(error, { kind: 'queue', id }, expectedRevision)
    }
  }

  /**
   * Start one pipeline: unpause the host, mark the queue `running`, then tick.
   *
   * Starting is the only action that clears the host-wide pause, so a click
   * cannot leave a `running` queue that the global gate silently suppresses.
   * @param request - queue identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated queue.
   */
  @Remote('startQueue')
  async startQueue(request: QueueControlRequest, signal: AbortSignal): Promise<QueueValue> {
    return await this.controlQueue(request, signal, 'running')
  }

  /**
   * Pause one pipeline. Running attempts keep their sessions and settle on their
   * own; no new task of this queue is dispatched.
   * @param request - queue identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated queue.
   */
  @Remote('pauseQueue')
  async pauseQueue(request: QueueControlRequest, signal: AbortSignal): Promise<QueueValue> {
    return await this.controlQueue(request, signal, 'paused')
  }

  /**
   * Abort one pipeline: pause it, mark it `aborted` and cancel its live runs.
   * An aborted pipeline does not resume on its own.
   * @param request - queue identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated queue.
   */
  @Remote('abortQueue')
  async abortQueue(request: QueueControlRequest, signal: AbortSignal): Promise<QueueValue> {
    const value = await this.controlQueue(request, signal, 'aborted')
    for (const run of this.ctx.sessionOrchestrator.listRuns()) {
      if (run.state !== 'running') continue
      const task = this.ctx.sessionOrchestrator.getTask(run.taskId)
      if (task?.queueId !== value.queue.id) continue
      this.cancelLiveRun(run.id)
    }
    return value
  }

  /**
   * List every visible intervention, newest first.
   * @returns the intervention projections.
   */
  @Remote('listInterventions')
  listInterventions(): InterventionListValue {
    this.requireReadCollection('run')
    const items = this.ctx.sessionOrchestrator.listInterventions()
      .filter(record => this.canRead('run', record.runId))
      .map(record => this.interventionDto(record))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return { items }
  }

  /**
   * Write one queue lifecycle under revision CAS.
   * @param request - queue identity and the observed revision.
   * @param signal - carrier cancellation.
   * @param state - the lifecycle to write.
   * @returns the updated queue.
   */
  private async controlQueue(
    request: QueueControlRequest,
    signal: AbortSignal,
    state: QueueRecord['state'],
  ): Promise<QueueValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('queue', id)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getQueue(QueueId(id))
    if (current === undefined) throw notFound('queue', id)
    if (current.revision !== expectedRevision) throw revisionConflict('queue', id, expectedRevision)
    if (state === 'running') {
      this.requireRunnableTaskList(current.id)
      // Clear the host-wide pause before the queue becomes `running`. If the
      // gate cannot be cleared, the queue no longer claims to run while the
      // scheduler silently refuses every dispatch.
      try {
        await this.resumeHostForPipeline()
      } catch (error) {
        this.reject(error, { kind: 'settings', id: 'global' }, store.getSettings().revision)
      }
    }
    try {
      const updated = await store.updateQueue(QueueId(id), expectedRevision, {
        ...current,
        state,
        paused: state !== 'running',
        revision: expectedRevision + 1,
      })
      if (state === 'running') await this.kickRuntime()
      return { queue: this.queueDto(updated) }
    } catch (error) {
      this.reject(error, { kind: 'queue', id }, expectedRevision)
    }
  }

  /**
   * Refuse to start a queue whose stored task list carries an invalid dependency.
   *
   * The gate runs before the queue state changes, so an old record such as
   * `dependsOn: ['t-1']` can never enter `running` and block silently in the
   * planner. The settings page offers the repair action that rewrites the list.
   * @param queueId - queue about to start.
   */
  private requireRunnableTaskList(queueId: QueueId): void {
    const issues = taskListIssues(this.queueTaskList(queueId))
    if (issues.length > 0) throw taskListInvalid(queueId, issues)
  }

  /**
   * Clear the host-wide pause so a started pipeline can dispatch.
   * @returns resolution after the settings are durable.
   * @throws OrchestratorError when every compare-and-swap attempt lost the race,
   * so the caller refuses to mark the queue `running`.
   */
  private async resumeHostForPipeline(): Promise<void> {
    const store = this.ctx.sessionOrchestrator
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settings = store.getSettings()
      if (!settings.paused) return
      try {
        await store.updateSettings(settings.revision, {
          ...settings,
          paused: false,
          revision: settings.revision + 1,
          updatedAt: this.now(),
        })
        return
      } catch {
        // Retry against the newer revision.
      }
    }
    throw new OrchestratorError(
      'invalid-transition',
      'host-wide pause could not be cleared for a started pipeline',
    )
  }

  /**
   * Bind a queue's optional default workspace to its canonical directory.
   *
   * A queue without a workspace is a valid draft. Once one is named, it must
   * be a real host Workspace whenever the registry is mounted, so a typed id
   * can never masquerade as a runnable destination.
   * @param record - parsed queue record.
   * @returns the record with the canonical workspace directory.
   */
  private bindQueueWorkspace(record: QueueRecord): QueueRecord {
    if (record.workspaceId === undefined) return record
    const registry = this.workspaceRegistry()
    if (registry === undefined) return record
    const workspace = registry.get(record.workspaceId)
    if (workspace === undefined) throw invalidRequest('workspaceId')
    return { ...record, cwd: workspace.path }
  }

  /**
   * Bind a task to a real host Workspace and its canonical directory.
   *
   * Production always has the registry mounted, so a task cannot be saved with
   * only a display id. The stored `cwd` is overwritten from the registry: the
   * Session must start in the directory the user actually selected, not one a
   * stale draft happened to carry.
   * @param record - parsed task record.
   * @returns the record with the canonical workspace directory.
   */
  private bindTaskWorkspace(record: TaskSpec): TaskSpec {
    if (record.prompt.trim() === '') throw invalidRequest('prompt')
    if (record.workspaceId.trim() === '') throw invalidRequest('workspaceId')
    const registry = this.workspaceRegistry()
    if (registry === undefined) {
      if (record.cwd.trim() === '') throw invalidRequest('cwd')
      return record
    }
    const workspace = registry.get(record.workspaceId)
    if (workspace === undefined) throw invalidRequest('workspaceId')
    return { ...record, cwd: workspace.path }
  }

  /** Resolve the optional host Workspace registry without a hard dependency. */
  private workspaceRegistry(): WorkspaceLookup | undefined {
    return (this.ctx as unknown as { get(name: string): unknown })
      .get('workspaceRegistry') as WorkspaceLookup | undefined
  }

  /**
   * Run one immediate tick after a lifecycle change, when a runtime is mounted.
   *
   * The tick is awaited so a successful start returns only after the scheduler
   * had a chance to create the first run. A tick failure is logged and does not
   * fail the durable start; the next interval retries.
   * @returns resolution after the tick finished or failed.
   */
  private async kickRuntime(): Promise<void> {
    const runtime = (this.ctx as unknown as { get(name: string): unknown })
      .get('sessionOrchestratorRuntime') as { tick(): Promise<void> } | undefined
    if (runtime === undefined) return
    try {
      await runtime.tick()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`sessionOrchestratorController: immediate tick failed: ${message}`)
    }
  }

  /**
   * Delete one queue and every orchestration record it owns.
   * @param request - queue identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the deletion receipt.
   */
  @Remote('deleteDraftQueue')
  async deleteDraftQueue(request: DeleteDraftQueueRequest, signal: AbortSignal): Promise<DeleteQueueValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('queue', id)
    throwIfCancelled(signal)
    try {
      await this.ctx.sessionOrchestrator.deleteQueue(QueueId(id), expectedRevision)
      return { queueId: id, deleted: true }
    } catch (error) {
      this.reject(error, { kind: 'queue', id }, expectedRevision)
    }
  }

  /**
   * Create or replace one task under revision CAS.
   * @param request - task identity, the observed revision and the editable draft.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the stored task.
   */
  @Remote('upsertTask')
  async upsertTask(request: UpsertTaskRequest, signal: AbortSignal): Promise<TaskValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'taskId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('task', id)
    throwIfCancelled(signal)
    const draft = requireRecord(input, 'draft')
    if (requireId(draft, 'id') !== id) throw invalidRequest('draft.id')
    const position = input.position === undefined
      ? undefined
      : requireIndex(input, 'position')
    const queueRevision = input.queueRevision === undefined
      ? undefined
      : requireRevision(input, 'queueRevision')
    const store = this.ctx.sessionOrchestrator
    const current = store.getTask(TaskId(id))
    if (current === undefined && expectedRevision !== 0) throw invalidRequest('expectedRevision')
    if (current !== undefined && current.revision !== expectedRevision) {
      throw revisionConflict('task', id, expectedRevision)
    }
    const next = this.bindTaskWorkspace(
      parseTaskDraft(draft, current === undefined ? 0 : expectedRevision + 1),
    )
    if (current !== undefined && current.queueId !== next.queueId) {
      throw invalidRequest('draft.queueId')
    }
    if (store.getQueue(next.queueId) === undefined) throw notFound('queue', next.queueId)
    if (position === undefined) {
      try {
        const stored = current === undefined
          ? await store.createTask(next)
          : await store.updateTask(TaskId(id), expectedRevision, next)
        return { task: this.taskDto(stored) }
      } catch (error) {
        this.reject(error, { kind: 'task', id }, expectedRevision)
      }
    }
    if (queueRevision === undefined) throw invalidRequest('queueRevision')
    const queue = store.getQueue(next.queueId)
    if (queue === undefined) throw notFound('queue', next.queueId)
    if (queue.revision !== queueRevision) throw revisionConflict('queue', queue.id, queueRevision)
    if (position < 0 || position > this.queueTaskList(queue.id).length + (current === undefined ? 0 : -1)) {
      throw invalidRequest('position')
    }
    const tasks = this.queueTaskList(queue.id)
    const final = new Map(tasks.map(task => [task.id, task]))
    const order = this.normalizedTaskOrder(queue, tasks)
      .filter(taskId => taskId !== id)
    final.set(next.id, next)
    order.splice(position, 0, next.id)
    try {
      const written = await this.writeTaskList(
        queue,
        order,
        final,
        current === undefined ? [next] : [],
        [],
        current === undefined ? new Set() : new Set([next.id]),
      )
      const stored = store.getTask(next.id)
      if (stored === undefined) throw notFound('task', id)
      return { task: this.taskDto(stored), queue: this.queueDto(written) }
    } catch (error) {
      this.reject(error, { kind: 'task', id }, expectedRevision)
    }
  }

  /**
   * Replace one queue's task order and parallel markers under revision CAS.
   *
   * The complete order is validated before any write. Dependencies are not part
   * of the request: the host derives every task's `dependsOn` from the groups
   * this order creates, so a move can never leave a stale dependency behind.
   * @param request - queue identity, observed revision, order and parallel ids.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated queue.
   */
  @Remote('reorderTasks')
  async reorderTasks(request: ReorderTasksRequest, signal: AbortSignal): Promise<QueueValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('queue', id)
    throwIfCancelled(signal)
    const taskOrder = requireStringArray(input, 'taskOrder')
    if (new Set(taskOrder).size !== taskOrder.length) throw invalidRequest('taskOrder')
    const store = this.ctx.sessionOrchestrator
    const current = store.getQueue(QueueId(id))
    if (current === undefined) throw notFound('queue', id)
    if (current.revision !== expectedRevision) throw revisionConflict('queue', id, expectedRevision)
    const tasks = this.queueTaskList(current.id)
    if (tasks.length !== taskOrder.length || tasks.some(task => !taskOrder.includes(task.id))) {
      throw invalidRequest('taskOrder')
    }
    for (const taskId of taskOrder) {
      if (taskId.trim() !== taskId) throw invalidRequest('taskOrder')
    }
    const parallel = this.requireParallelIds(input, taskOrder, this.parallelIdsOf(tasks))
    try {
      const written = await this.writeTaskList(
        current,
        taskOrder.map(TaskId),
        new Map(tasks.map(task => [task.id, task])),
        [],
        [],
        new Set(),
        parallel,
      )
      return { queue: this.queueDto(written) }
    } catch (error) {
      this.reject(error, { kind: 'queue', id }, expectedRevision)
    }
  }

  /**
   * Delete one task, its conversation records and every remaining dependency.
   *
   * A conversation deletion is scoped to this task: its attempts, operations,
   * handoffs, skips, interventions and warden audits are removed too, while every
   * other task in the pipeline stays untouched. Workspace files and Sessions
   * remain outside this domain.
   * @param request - queue identity, task identity and observed queue revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the queue and the deleted identity.
   */
  @Remote('deleteTask')
  async deleteTask(request: DeleteTaskRequest, signal: AbortSignal): Promise<DeleteTaskValue> {
    const input = requireRequest(request)
    const queueId = requireId(input, 'queueId')
    const taskId = requireId(input, 'taskId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('task', taskId)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const queue = store.getQueue(QueueId(queueId))
    if (queue === undefined) throw notFound('queue', queueId)
    if (queue.revision !== expectedRevision) throw revisionConflict('queue', queueId, expectedRevision)
    const task = store.getTask(TaskId(taskId))
    if (task === undefined || task.queueId !== queueId) throw notFound('task', taskId)
    const tasks = this.queueTaskList(queue.id)
    const final = new Map(tasks.filter(candidate => candidate.id !== task.id)
      .map(candidate => [candidate.id, candidate]))
    const order = this.normalizedTaskOrder(queue, tasks).filter(candidate => candidate !== task.id)
    try {
      const written = await this.writeTaskList(queue, order, final, [], [task.id], new Set())
      await store.deleteTaskRecords(task.id)
      return { queue: this.queueDto(written), deletedTaskId: taskId }
    } catch (error) {
      this.reject(error, { kind: 'task', id: taskId }, expectedRevision)
    }
  }

  /**
   * Copy one task immediately after itself under a fresh internal identity.
   * @param request - queue identity, source task identity and queue revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the queue and the new task.
   */
  @Remote('duplicateTask')
  async duplicateTask(request: DuplicateTaskRequest, signal: AbortSignal): Promise<DuplicateTaskValue> {
    const input = requireRequest(request)
    const queueId = requireId(input, 'queueId')
    const taskId = requireId(input, 'taskId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('task', taskId)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const queue = store.getQueue(QueueId(queueId))
    if (queue === undefined) throw notFound('queue', queueId)
    if (queue.revision !== expectedRevision) throw revisionConflict('queue', queueId, expectedRevision)
    const source = store.getTask(TaskId(taskId))
    if (source === undefined || source.queueId !== queueId) throw notFound('task', taskId)
    const tasks = this.queueTaskList(queue.id)
    const order = this.normalizedTaskOrder(queue, tasks)
    const insertAt = order.indexOf(source.id) + 1
    const copyId = nextCopyTaskId(source.id, store.listTasks().map(task => task.id))
    const copy = copiedTask(source, copyId)
    const final = new Map(tasks.map(task => [task.id, task]))
    final.set(copy.id, copy)
    order.splice(insertAt, 0, copy.id)
    try {
      const written = await this.writeTaskList(queue, order, final, [copy], [], new Set())
      const stored = store.getTask(copy.id)
      if (stored === undefined) throw notFound('task', copy.id)
      return { queue: this.queueDto(written), task: this.taskDto(stored) }
    } catch (error) {
      this.reject(error, { kind: 'task', id: copy.id }, expectedRevision)
    }
  }

  /**
   * Rewrite every dependency from the stored list order and parallel markers.
   *
   * The repair button uses this path after a start refusal names a dangling
   * dependency written by an older editor; the task list itself is preserved.
   * @param request - queue identity and observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the repaired queue.
   */
  @Remote('repairTaskList')
  async repairTaskList(request: RepairTaskListRequest, signal: AbortSignal): Promise<QueueValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'queueId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('queue', id)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const queue = store.getQueue(QueueId(id))
    if (queue === undefined) throw notFound('queue', id)
    if (queue.revision !== expectedRevision) throw revisionConflict('queue', id, expectedRevision)
    const tasks = this.queueTaskList(queue.id)
    const order = this.normalizedTaskOrder(queue, tasks)
    try {
      const written = await this.writeTaskList(
        queue,
        order,
        new Map(tasks.map(task => [task.id, task])),
        [],
        [],
        new Set(),
        this.parallelIdsOf(tasks),
      )
      return { queue: this.queueDto(written) }
    } catch (error) {
      this.reject(error, { kind: 'queue', id }, expectedRevision)
    }
  }

  /** Every task belonging to one queue. */
  private queueTaskList(queueId: QueueId): readonly TaskSpec[] {
    return this.ctx.sessionOrchestrator.listTasks().filter(task => task.queueId === queueId)
  }

  /** The stored order with any unlisted task appended in stable id order. */
  private normalizedTaskOrder(queue: QueueRecord, tasks: readonly TaskSpec[]): TaskId[] {
    const known = new Set(tasks.map(task => task.id))
    const ordered = queue.taskOrder.filter(taskId => known.has(taskId))
    const listed = new Set<string>(ordered)
    const extras = tasks
      .filter(task => !listed.has(task.id))
      .map(task => task.id)
      .sort((left, right) => left.localeCompare(right))
    return [...ordered, ...extras]
  }

  /** Ids whose stored marker joins the previous list group. */
  private parallelIdsOf(tasks: readonly TaskSpec[]): ReadonlySet<string> {
    return new Set(tasks.filter(task => task.parallelWithPrevious === true).map(task => task.id))
  }

  /** Read the optional parallel-id request field, defaulting to stored markers. */
  private requireParallelIds(
    input: Record<string, unknown>,
    order: readonly string[],
    fallback: ReadonlySet<string>,
  ): ReadonlySet<string> {
    if (input.parallelWithPrevious === undefined) return effectiveParallelIds(order, fallback)
    const ids = requireStringArray(input, 'parallelWithPrevious')
    if (new Set(ids).size !== ids.length) throw invalidRequest('parallelWithPrevious')
    for (const id of ids) {
      if (id.trim() !== id || !order.includes(id)) throw invalidRequest('parallelWithPrevious')
    }
    return effectiveParallelIds(order, new Set(ids))
  }

  /**
   * Rewrite one queue's list, its derived dependencies and the parallel markers
   * through one store commit.
   * @param queue - queue observed before the edit.
   * @param order - complete order after the edit.
   * @param finalTasks - every task that remains, plus any new task.
   * @param creates - ids that do not exist yet.
   * @param deletes - ids that leave the table.
   * @param forcedUpdates - existing ids whose edited fields must be written even
   * when their derived dependencies did not change.
   * @param parallel - optional effective marker set; stored markers are used
   * when absent.
   * @returns the stored queue.
   */
  private async writeTaskList(
    queue: QueueRecord,
    order: readonly TaskId[],
    finalTasks: ReadonlyMap<string, TaskSpec>,
    creates: readonly TaskSpec[],
    deletes: readonly TaskId[],
    forcedUpdates: ReadonlySet<string>,
    parallel?: ReadonlySet<string>,
  ): Promise<QueueRecord> {
    const effective = parallel ?? this.parallelIdsOf([...finalTasks.values()])
    const markers = effectiveParallelIds(order, effective)
    const dependencies = deriveTaskDependencies(order, markers)
    const createIds = new Set(creates.map(task => task.id))
    const createRecords: TaskSpec[] = []
    const updateRecords: TaskSpec[] = []
    const store = this.ctx.sessionOrchestrator
    for (const taskId of order) {
      const task = finalTasks.get(taskId)
      if (task === undefined) throw invalidRequest('taskOrder')
      const nextDependencies = dependencies.get(taskId) ?? []
      const joinsPrevious = markers.has(taskId)
      if (createIds.has(taskId)) {
        createRecords.push(rewrittenTask(task, nextDependencies, joinsPrevious, 0))
        continue
      }
      const stored = store.getTask(taskId)
      if (stored === undefined) throw notFound('task', taskId)
      const rewritten = forcedUpdates.has(taskId)
        || !sameStrings(stored.dependsOn, nextDependencies)
        || (stored.parallelWithPrevious === true) !== joinsPrevious
      if (rewritten) {
        updateRecords.push(rewrittenTask(task, nextDependencies, joinsPrevious, stored.revision + 1))
      }
    }
    const nextQueue: QueueRecord = {
      ...queue,
      taskOrder: [...order],
      revision: queue.revision + 1,
    }
    return await store.commitTaskList(queue.id, queue.revision, nextQueue, {
      creates: createRecords,
      updates: updateRecords,
      deletes,
    })
  }

  /**
   * Toggle one task's enabled flag under revision CAS.
   * @param request - task identity, observed revision and the requested flag.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the stored task.
   */
  @Remote('setTaskEnabled')
  async setTaskEnabled(request: SetTaskEnabledRequest, signal: AbortSignal): Promise<TaskValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'taskId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    const enabled = requireBoolean(input, 'enabled')
    this.requireMutate('task', id)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getTask(TaskId(id))
    if (current === undefined) throw notFound('task', id)
    if (current.revision !== expectedRevision) throw revisionConflict('task', id, expectedRevision)
    const next: TaskSpec = { ...current, enabled, revision: expectedRevision + 1 }
    try {
      return { task: this.taskDto(await store.updateTask(TaskId(id), expectedRevision, next)) }
    } catch (error) {
      this.reject(error, { kind: 'task', id }, expectedRevision)
    }
  }

  /**
   * Record one audited human skip against a `needs-attention` run.
   * @param request - run identity, observed revision and audit fields.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the audit receipt without the recorded prose.
   */
  @Remote('skipTask')
  async skipTask(request: SkipTaskRequest, signal: AbortSignal): Promise<SkipTaskValue> {
    const input = requireRequest(request)
    const runId = requireId(input, 'runId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    const actor = requireAuditText(input, 'actor')
    const reason = requireAuditText(input, 'reason')
    this.requireMutate('run', runId)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const run = store.getRun(RunId(runId))
    if (run === undefined) throw notFound('run', runId)
    if (run.revision !== expectedRevision) throw revisionConflict('run', runId, expectedRevision)
    if (run.state !== 'needs-attention') throw invalidTransition('run', runId)
    const decidedAt = this.now()
    const candidate: SkipRecord = {
      taskId: run.taskId,
      runId: run.id,
      actor,
      reason,
      decidedAt,
      runRevision: expectedRevision,
    }
    const parsed = skipRecordSchema.safeParse(candidate)
    if (!parsed.success) throw invalidRequest(firstIssue(parsed.error))
    try {
      await store.recordSkip(parsed.data)
      return { skipped: true, taskId: run.taskId, runId: run.id, decidedAt }
    } catch (error) {
      this.reject(error, { kind: 'run', id: runId }, expectedRevision)
    }
  }

  /**
   * List every visible run attempt.
   * @returns the run projections, in store key order.
   */
  @Remote('listRuns')
  listRuns(): RunListValue {
    this.requireReadCollection('run')
    const items = this.ctx.sessionOrchestrator.listRuns()
      .filter(run => this.canRead('run', run.id))
      .map(run => this.runDto(run))
    return { items }
  }

  /**
   * Read one run attempt.
   * @param request - run identity.
   * @returns the run projection.
   */
  @Remote('getRun')
  getRun(request: GetRunRequest): RunValue {
    const input = requireRequest(request)
    const id = requireId(input, 'runId')
    this.requireReadItem('run', id)
    const run = this.ctx.sessionOrchestrator.getRun(RunId(id))
    if (run === undefined) throw notFound('run', id)
    return { run: this.runDto(run) }
  }

  /**
   * Pause the host scheduler.
   * @param request - the observed settings revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated settings.
   */
  @Remote('pause')
  pause(request: SettingsRevisionRequest, signal: AbortSignal): Promise<SettingsValue> {
    return this.setPaused(request, true, signal)
  }

  /**
   * Resume the host scheduler.
   * @param request - the observed settings revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the updated settings.
   */
  @Remote('resume')
  resume(request: SettingsRevisionRequest, signal: AbortSignal): Promise<SettingsValue> {
    return this.setPaused(request, false, signal)
  }

  /**
   * Cancel one run's orchestration state under revision CAS.
   *
   * The durable transition succeeds before an optional live cancel runs, so a
   * stale caller can never stop a run another caller already settled.
   * @param request - run identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the cancelled run.
   */
  @Remote('cancel')
  async cancel(request: CancelRunRequest, signal: AbortSignal): Promise<RunValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'runId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('run', id)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getRun(RunId(id))
    if (current === undefined) throw notFound('run', id)
    if (current.revision !== expectedRevision) throw revisionConflict('run', id, expectedRevision)
    if (!CANCELLABLE_RUN_STATES.has(current.state)) throw invalidTransition('run', id)
    const next: RunRecord = {
      ...current,
      state: 'cancelled',
      revision: expectedRevision + 1,
      updatedAt: this.now(),
      lastError: current.lastError ?? {
        code: 'cancelled',
        message: 'cancelled by operator',
        retryable: false,
      },
    }
    try {
      const stored = await store.updateRun(RunId(id), expectedRevision, next)
      this.cancelLiveRun(stored.id)
      return { run: this.runDto(stored) }
    } catch (error) {
      this.reject(error, { kind: 'run', id }, expectedRevision)
    }
  }

  /**
   * Start one fresh attempt for a settled run under revision CAS.
   *
   * The old attempt stays untouched as history; the new attempt uses the
   * scheduler's deterministic `run-<task>-<attempt>` identity, so two
   * concurrent retries create at most one record. A skip recorded on the old
   * attempt remains audit-only: the local composition applies skips only to the
   * latest attempt, so the fresh attempt is not held back.
   * @param request - settled run identity and the observed revision.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the new `ready` attempt.
   */
  @Remote('retry')
  async retry(request: RetryRunRequest, signal: AbortSignal): Promise<RunValue> {
    const input = requireRequest(request)
    const id = requireId(input, 'runId')
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('run', id)
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getRun(RunId(id))
    if (current === undefined) throw notFound('run', id)
    if (current.revision !== expectedRevision) throw revisionConflict('run', id, expectedRevision)
    if (!RETRYABLE_RUN_STATES.has(current.state)) throw invalidTransition('run', id)
    if (store.listRuns().some(run => run.taskId === current.taskId && run.attempt > current.attempt)) {
      throw invalidTransition('run', id)
    }
    const attempt = current.attempt + 1
    const now = this.now()
    const next: RunRecord = {
      id: RunId(`run-${current.taskId}-${attempt}`),
      taskId: current.taskId,
      attempt,
      state: 'ready',
      sessionLineage: [],
      generation: 0,
      workspaceKey: current.workspaceKey,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      ...(current.providerKey === undefined ? {} : { providerKey: current.providerKey }),
    }
    try {
      return { run: this.runDto(await store.createRun(next)) }
    } catch (error) {
      this.reject(error, { kind: 'run', id }, expectedRevision)
    }
  }

  /**
   * List every completed handoff.
   * @returns the handoff projections, in store key order.
   */
  @Remote('listHandoffs')
  listHandoffs(): HandoffListValue {
    this.requireReadCollection('handoff')
    const items = this.ctx.sessionOrchestrator.listHandoffs()
      .filter(handoff => this.canRead('handoff', handoff.operationId))
      .map(handoff => this.handoffDto(handoff))
    return { items }
  }

  /**
   * Read one completed handoff.
   * @param request - producing operation identity.
   * @returns the handoff projection.
   */
  @Remote('getHandoff')
  getHandoff(request: GetHandoffRequest): HandoffValue {
    const input = requireRequest(request)
    const id = requireId(input, 'operationId')
    this.requireReadItem('handoff', id)
    const handoff = this.ctx.sessionOrchestrator.getHandoff(OperationId(id))
    if (handoff === undefined) throw notFound('handoff', id)
    return { handoff: this.handoffDto(handoff) }
  }

  /**
   * Read the host-wide orchestration settings.
   * @returns the settings projection without host identity.
   */
  @Remote('getSettings')
  getSettings(): SettingsValue {
    this.requireReadItem('settings', 'global')
    return { settings: this.settingsDto(this.ctx.sessionOrchestrator.getSettings()) }
  }

  /**
   * Replace host-wide settings under revision CAS.
   * @param request - observed revision and the editable draft.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the stored settings.
   */
  @Remote('updateSettings')
  async updateSettings(request: UpdateSettingsRequest, signal: AbortSignal): Promise<SettingsValue> {
    const input = requireRequest(request)
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('settings', 'global')
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getSettings()
    if (current.revision !== expectedRevision) {
      throw revisionConflict('settings', 'global', expectedRevision)
    }
    const next = parseSettingsDraft(
      requireRecord(input, 'draft'),
      current,
      expectedRevision + 1,
      this.now(),
    )
    try {
      return { settings: this.settingsDto(await store.updateSettings(expectedRevision, next)) }
    } catch (error) {
      this.reject(error, { kind: 'settings', id: 'global' }, expectedRevision)
    }
  }

  /**
   * Stream whole snapshots: one baseline, then one frame per coalesced change.
   *
   * Every frame carries the host generation current at yield time, so a
   * reconnecting Client starts from the newest generation and discards any
   * older baseline it retained.
   * @param signal - carrier cancellation; abort ends the stream.
   * @returns snapshot frames until the signal aborts.
   */
  @Remote({ mode: 'stream' })
  async *changed(signal: AbortSignal): AsyncIterable<OrchestratorSnapshotFrame> {
    this.requireReadCollection('stream')
    throwIfCancelled(signal)
    let dirty = false
    let wake: (() => void) | undefined
    const notify = (): void => {
      dirty = true
      wake?.()
      wake = undefined
    }
    const onAbort = (): void => {
      wake?.()
      wake = undefined
    }
    this.subscribers.add(notify)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      yield this.snapshot(this.changeRevision)
      while (true) {
        if (signal.aborted) return
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve
            if (signal.aborted) {
              wake = undefined
              resolve()
            }
          })
          wake = undefined
        }
        if (signal.aborted) return
        if (!dirty) continue
        dirty = false
        yield this.snapshot(this.changeRevision)
      }
    } finally {
      this.subscribers.delete(notify)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Persist one paused or resumed settings value.
   * @param request - observed settings revision.
   * @param paused - new pause flag.
   * @param signal - carrier cancellation; checked before the durable write.
   * @returns the stored settings.
   */
  private async setPaused(
    request: SettingsRevisionRequest,
    paused: boolean,
    signal: AbortSignal,
  ): Promise<SettingsValue> {
    const input = requireRequest(request)
    const expectedRevision = requireRevision(input, 'expectedRevision')
    this.requireMutate('settings', 'global')
    throwIfCancelled(signal)
    const store = this.ctx.sessionOrchestrator
    const current = store.getSettings()
    if (current.revision !== expectedRevision) {
      throw revisionConflict('settings', 'global', expectedRevision)
    }
    const next = parseSettingsDraft({
      paused,
      maxConcurrentRuns: current.maxConcurrentRuns,
      providerQuotas: current.providerQuotas,
    }, current, expectedRevision + 1, this.now())
    try {
      return { settings: this.settingsDto(await store.updateSettings(expectedRevision, next)) }
    } catch (error) {
      this.reject(error, { kind: 'settings', id: 'global' }, expectedRevision)
    }
  }

  /** One whole snapshot filtered by the access policy and current store state. */
  private snapshot(revision: number): OrchestratorSnapshotFrame {
    const store = this.ctx.sessionOrchestrator
    const queues = store.listQueues()
      .filter(queue => this.canRead('queue', queue.id))
      .map(queue => this.queueDto(queue))
    const tasks = store.listTasks()
      .filter(task => this.canRead('task', task.id))
      .map(task => this.taskSummaryDto(task))
    const runs = store.listRuns()
      .filter(run => this.canRead('run', run.id))
      .map(run => this.runDto(run))
    const handoffs = store.listHandoffs()
      .filter(handoff => this.canRead('handoff', handoff.operationId))
      .map(handoff => this.handoffDto(handoff))
    const interventions = store.listInterventions()
      .filter(record => this.canRead('run', record.runId))
      .map(record => this.interventionDto(record))
    const wardenAudits = store.listWardenAudits()
      .filter(record => this.canRead('run', record.runId))
      .map(record => this.wardenAuditDto(record))
      .sort((left, right) => right.createdAt - left.createdAt)
    return {
      type: 'snapshot',
      revision,
      generatedAt: this.now(),
      ...(this.canRead('settings', 'global')
        ? { settings: this.settingsDto(store.getSettings()) }
        : {}),
      queues,
      tasks,
      runs,
      handoffs,
      interventions,
      wardenAudits,
      hosts: this.hostDtos(),
    }
  }

  /** Project the runtime's host capability matrices, or none without a runtime. */
  private hostDtos(): readonly HostCapabilityDto[] {
    const runtime = (this.ctx as unknown as { get(name: string): unknown })
      .get('sessionOrchestratorRuntime') as { hostReports?: () => readonly HostSessionCapabilityReport[] } | undefined
    if (runtime?.hostReports === undefined) return []
    return runtime.hostReports().map((report, index) => ({
      host: report.host,
      displayName: report.displayName,
      available: report.available,
      runnable: report.runnable,
      // `reports()` guarantees the primary execution host first.
      queueBackend: index === 0,
      capabilities: HOST_SESSION_CAPABILITIES
        .map(capability => {
          const state = report.capabilities[capability]
          return state.status === 'supported'
            ? {
              capability,
              status: 'supported' as const,
              ...(state.detail === undefined ? {} : { detail: state.detail }),
            }
            : {
              capability,
              status: 'unsupported' as const,
              reason: state.reason,
            }
        }),
    }))
  }

  /** Optional live cancellation after the durable state commit. */
  private cancelLiveRun(id: RunId): void {
    if (this.runControl === undefined) return
    try {
      this.runControl.cancel(id)
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error
      this.ctx.logger.warn(`sessionOrchestratorController: live cancel for '${id}' failed: ${name}`)
    }
  }

  /** One access decision for the current Remote invocation. */
  private role(action: OrchestratorAction, resource: OrchestratorResource): OrchestratorRole {
    const invocation = this.ctx.invocation
    const peerId = invocation === undefined ? undefined : String(invocation.peer.id)
    return this.access.role(peerId === undefined ? { action, resource } : { action, resource, peerId })
  }

  /** Reject a whole collection the policy grants no read to. */
  private requireReadCollection(kind: OrchestratorResourceKind): void {
    if (this.role('read', { kind }) === 'none') throw forbidden('read', kind)
  }

  /** Hide one unreadable record as absent instead of revealing its existence. */
  private requireReadItem(kind: OrchestratorResourceKind, id: string): void {
    if (this.role('read', { kind, id }) === 'none') throw notFound(kind, id)
  }

  /** Whether the policy grants this record read access. */
  private canRead(kind: OrchestratorResourceKind, id: string): boolean {
    return this.role('read', { kind, id }) !== 'none'
  }

  /** Require an owner for a mutation of one named resource. */
  private requireMutate(kind: OrchestratorResourceKind, id: string): void {
    if (this.role('mutate', { kind, id }) !== 'owner') throw forbidden('mutate', kind)
  }

  /** Translate one store failure into its stable Remote code. */
  private reject(
    error: unknown,
    resource: OrchestratorResource,
    expectedRevision?: number,
  ): never {
    if (error instanceof RemoteError) throw error
    if (error instanceof OrchestratorError) {
      switch (error.code) {
        case 'not-found':
          throw notFound(resource.kind, resource.id)
        case 'revision-conflict':
          throw revisionConflict(resource.kind, resource.id, expectedRevision)
        case 'already-exists':
        case 'operation-hash-conflict':
          throw conflict(resource.kind, resource.id)
        case 'invalid-transition':
          throw invalidTransition(resource.kind, resource.id)
        case 'queue-not-empty':
          throw queueNotEmpty(resource.id ?? '')
        case 'closed':
        case 'unsupported':
          throw unavailable()
        default:
          throw error
      }
    }
    throw error
  }

  /** Project one queue without any task definition. */
  private queueDto(queue: QueueRecord): QueueDto {
    return {
      id: queue.id,
      title: queue.title,
      taskOrder: [...queue.taskOrder],
      paused: queue.paused,
      state: queue.state,
      ...(queue.brief === undefined ? {} : { brief: queue.brief }),
      ...(queue.workspaceId === undefined ? {} : { workspaceId: queue.workspaceId }),
      ...(queue.cwd === undefined ? {} : { cwd: queue.cwd }),
      ...(queue.model === undefined ? {} : { model: queue.model }),
      ...(queue.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: queue.maxConcurrentRuns }),
      revision: queue.revision,
    }
  }

  /** Project one task's editable fields. */
  private taskDto(task: TaskSpec): TaskDto {
    return {
      id: task.id,
      queueId: task.queueId,
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      cwd: task.cwd,
      preset: task.preset,
      model: task.model,
      skills: task.skills,
      dependsOn: [...task.dependsOn],
      ...(task.parallelWithPrevious === true ? { parallelWithPrevious: true } : {}),
      ...(task.concurrencyGroup === undefined ? {} : { concurrencyGroup: task.concurrencyGroup }),
      priority: task.priority,
      handoff: task.handoff,
      enabled: task.enabled,
      ...(task.stage === undefined ? {} : { stage: task.stage }),
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      ...this.taskSessionField(task.id),
      revision: task.revision,
    }
  }

  /** Project the compact task summary a snapshot carries. */
  private taskSummaryDto(task: TaskSpec): TaskSummaryDto {
    return {
      id: task.id,
      queueId: task.queueId,
      title: task.title,
      workspaceId: task.workspaceId,
      priority: task.priority,
      enabled: task.enabled,
      model: task.model,
      dependsOn: [...task.dependsOn],
      ...(task.parallelWithPrevious === true ? { parallelWithPrevious: true } : {}),
      ...(task.concurrencyGroup === undefined ? {} : { concurrencyGroup: task.concurrencyGroup }),
      ...(task.stage === undefined ? {} : { stage: task.stage }),
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      ...this.taskSessionField(task.id),
      revision: task.revision,
    }
  }

  /** Project one run and its sanitized operation/config/pressure facts. */
  private runDto(run: RunRecord): RunDto {
    const store = this.ctx.sessionOrchestrator
    const operation = run.operationId === undefined ? undefined : store.getOperation(run.operationId)
    return {
      id: run.id,
      taskId: run.taskId,
      attempt: run.attempt,
      state: run.state,
      generation: run.generation,
      revision: run.revision,
      ...(run.activeSessionId === undefined ? {} : { activeSession: this.sessionRef(run.activeSessionId) }),
      sessionLineage: run.sessionLineage.map(sessionId => this.sessionRef(sessionId)),
      ...this.runSessionField(run),
      ...(operation === undefined ? {} : { operation: { id: operation.id, phase: operation.phase } }),
      ...(run.configSnapshot === undefined ? {} : { configSnapshot: this.configDto(run.configSnapshot) }),
      ...(run.pressure === undefined ? {} : { pressure: this.pressureDto(run.pressure) }),
      ...(run.health === undefined ? {} : { health: run.health }),
      workspaceKey: run.workspaceKey,
      ...(run.providerKey === undefined ? {} : { providerKey: run.providerKey }),
      ...(run.lastError === undefined
        ? {}
        : { lastError: { code: run.lastError.code, retryable: run.lastError.retryable } }),
      skipped: store.getSkip(run.id) !== undefined,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }
  }

  /** Project one audited intervention without its full session answer. */
  private interventionDto(record: InterventionRecord): InterventionDto {
    return {
      id: record.id,
      runId: record.runId,
      taskId: record.taskId,
      generation: record.generation,
      kind: record.kind,
      phase: record.phase,
      reason: record.reason,
      trigger: {
        ...(record.trigger.contextRatio === undefined ? {} : { contextRatio: record.trigger.contextRatio }),
        ...(record.trigger.idleMs === undefined ? {} : { idleMs: record.trigger.idleMs }),
        ...(record.trigger.hitRate === undefined ? {} : { hitRate: record.trigger.hitRate }),
      },
      ...(record.warden === undefined
        ? {}
        : {
          warden: {
            mode: record.warden.mode,
            verdict: record.warden.verdict,
            ...(record.warden.provider === undefined ? {} : { provider: record.warden.provider }),
            ...(record.warden.model === undefined ? {} : { model: record.warden.model }),
          },
        }),
      ...(record.paidBy === undefined ? {} : { paidBy: { ...record.paidBy } }),
      ...(record.promptSent === undefined ? {} : { promptSent: record.promptSent }),
      ...(record.producedPrompt === undefined
        ? {}
        : { producedPrompt: record.producedPrompt.slice(0, 2000) }),
      ...this.interventionSessionField(record),
      ...(record.turn === undefined ? {} : { turn: record.turn }),
      ...(record.recoveryAttempts === undefined
        ? {}
        : { recoveryAttempts: record.recoveryAttempts }),
      childTaskIds: [...record.childTaskIds],
      ...(record.note === undefined ? {} : { note: record.note }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * Project one audited warden review without the packet or the prompt.
   * @param record - stored review row.
   * @returns the review projection.
   */
  private wardenAuditDto(record: WardenAuditRecord): WardenAuditDto {
    return {
      id: record.id,
      runId: record.runId,
      taskId: record.taskId,
      generation: record.generation,
      mode: record.mode,
      verdict: record.verdict,
      reason: record.reason,
      ...(record.provider === undefined ? {} : { provider: record.provider }),
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
      ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
      ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
      ...(record.error === undefined ? {} : { error: record.error }),
      createdAt: record.createdAt,
    }
  }

  /**
   * Session field of one run DTO.
   *
   * `activeSession` is present only while the attempt owns a live Session; a
   * settled attempt still has to be openable, so the last lineage member is
   * the fallback. Neither is guessed from a title or a timestamp.
   * @param run - stored attempt.
   * @returns a partial carrying `session` only when one exists.
   */
  private runSessionField(run: RunRecord | undefined): { session?: SessionLinkDto } {
    if (run === undefined) return {}
    const sessionId = run.activeSessionId ?? run.sessionLineage[run.sessionLineage.length - 1]
    return sessionId === undefined ? {} : { session: this.sessionRef(sessionId) }
  }

  /**
   * Session field of one task DTO.
   * @param taskId - task identity.
   * @returns a partial carrying the latest attempt's `session` when one exists.
   */
  private taskSessionField(taskId: string): { session?: SessionLinkDto } {
    return this.runSessionField(this.latestRunOfTask(taskId))
  }

  /**
   * Session field of one intervention DTO: the Session the host acted on.
   * @param record - stored intervention.
   * @returns a partial carrying `session` when the run still names one.
   */
  private interventionSessionField(record: InterventionRecord): { session?: SessionLinkDto } {
    return this.runSessionField(this.ctx.sessionOrchestrator.getRun(RunId(record.runId)))
  }

  /**
   * Latest attempt of one task.
   * @param taskId - task identity.
   * @returns the highest-attempt run, or undefined before the first dispatch.
   */
  private latestRunOfTask(taskId: string): RunRecord | undefined {
    let latest: RunRecord | undefined
    for (const run of this.ctx.sessionOrchestrator.listRuns()) {
      if (run.taskId !== taskId) continue
      if (latest === undefined || run.attempt > latest.attempt) latest = run
    }
    return latest
  }

  /** Project one completed handoff without its rendered body. */
  private handoffDto(record: HandoffRecord): HandoffDto {
    return {
      operationId: record.operationId,
      runId: record.runId,
      generation: record.generation,
      parentSession: this.sessionRef(record.sourceSessionId),
      childSession: this.sessionRef(record.targetSessionId),
      sourceSeq: record.sourceSeq,
      bodyHash: record.bodyHash,
      mode: record.mode,
      ...(record.bodyTokens === undefined ? {} : { bodyTokens: record.bodyTokens }),
      configSnapshot: this.configDto(record.configSnapshot),
      createdAt: record.createdAt,
    }
  }

  /** Project one frozen route and preset snapshot. */  private configDto(snapshot: EffectiveConfigSnapshot): EffectiveConfigDto {
    return {
      routeSource: snapshot.routeSource,
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }),
      preset: {
        id: snapshot.preset.id,
        ...(snapshot.preset.revision === undefined ? {} : { revision: snapshot.preset.revision }),
      },
      capturedAt: snapshot.capturedAt,
    }
  }

  /** Project one pressure reading without its Session identity. */
  private pressureDto(snapshot: PressureSnapshot): PressureDto {
    return {
      provider: snapshot.provider,
      model: snapshot.model,
      totalTokens: snapshot.totalTokens,
      ...(snapshot.contextWindow === undefined ? {} : { contextWindow: snapshot.contextWindow }),
      ...(snapshot.ratio === undefined ? {} : { ratio: snapshot.ratio }),
      baselineKind: snapshot.baselineKind,
      threshold: snapshot.threshold,
      routeFingerprint: snapshot.routeFingerprint,
      measuredAt: snapshot.measuredAt,
      decision: snapshot.decision,
      ...(snapshot.blockedBy === undefined ? {} : { blockedBy: snapshot.blockedBy }),
    }
  }

  /** Project settings without the host claim identity. */
  private settingsDto(settings: GlobalSettings): SettingsDto {
    return {
      revision: settings.revision,
      paused: settings.paused,
      maxConcurrentRuns: settings.maxConcurrentRuns,
      providerQuotas: { ...settings.providerQuotas },
      updatedAt: settings.updatedAt,
    }
  }

  /**
   * Project one Session identity into everything a caller needs to open it.
   *
   * The projection answers three questions the old `linkable` flag could not:
   * where the Session lives (`workspaceId`), how to address it (`route`), and
   * whether it can be opened today (`openState`). Every value is derived from
   * the identity alone — never from a title, a search or a "most recent"
   * guess — so the same Session keeps one stable address for its whole life.
   * @param sessionId - Session identity.
   * @returns the link projection.
   */
  private sessionRef(sessionId: string): SessionLinkDto {
    const workspaceId = this.workspaceOfSession(sessionId)
    const route = this.sessionRouteAvailable() ? sessionRouteOf(sessionId) : undefined
    const linkable = this.sessionLinkable()
    const openState = !linkable
      ? 'unsupported' as const
      : this.archivedSessions().includes(sessionId)
        ? 'archived' as const
        : 'ready' as const
    return {
      sessionId,
      linkable,
      openState,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(route === undefined ? {} : { route }),
    }
  }

  /** Whether an optional Web Session owner is mounted. */
  private sessionLinkable(): boolean {
    const sessionController: unknown = this.ctx.get('sessionController')
    return sessionController !== undefined
  }

  /** Whether this host serves the same-origin Session route. */
  private sessionRouteAvailable(): boolean {
    return this.webServer() !== undefined
  }

  /**
   * Register `GET /session/<sessionId>` as a redirect into the Web application.
   *
   * A redirect rather than a rendered page keeps the route independent of the
   * client bundle version: the application boots normally at `/` and reads the
   * identity from the query string, so a rebuilt or restarted plugin never
   * invalidates a link that was already handed out.
   * @returns disposer releasing the route with the controller fiber.
   */
  private registerSessionRoute(): () => void {
    const server = this.webServer()
    if (server === undefined) return () => {}
    return server.register({
      kind: 'prefix',
      path: SESSION_ROUTE_PREFIX,
      handler: (request, response) => {
        if (request.method !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405
          response.setHeader('allow', 'GET, HEAD')
          response.end()
          return
        }
        const sessionId = sessionIdFromRoute(pathnameOf(request.url))
        if (sessionId === undefined) {
          response.statusCode = 404
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.end('open a Session as /session/<sessionId>')
          return
        }
        // 302, not 301: a cached permanent redirect would outlive this host.
        response.statusCode = 302
        response.setHeader('cache-control', 'no-store')
        response.setHeader('location', `/?${SESSION_OPEN_PARAM}=${encodeURIComponent(sessionId)}`)
        response.end()
      },
    })
  }

  /** Resolve the optional Web carrier without a hard dependency. */
  private webServer(): SessionRouteRegistrar | undefined {
    return (this.ctx as unknown as { get(name: string): unknown })
      .get('webServer') as SessionRouteRegistrar | undefined
  }

  /** Workspace that claims this Session, when the registry is mounted. */
  private workspaceOfSession(sessionId: string): string | undefined {
    const registry = this.workspaceRegistry()
    const workspaces = registry?.list?.()
    if (workspaces === undefined) return undefined
    return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
  }

  /** Sessions the user archived; empty without the registry. */
  private archivedSessions(): readonly string[] {
    return this.workspaceRegistry()?.archivedSessionIds ?? []
  }
}

/** Same-origin path that opens one Session. */
function sessionRouteOf(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}`
}

/** Pathname of one request URL, or empty when it cannot be parsed. */
function pathnameOf(url: string | undefined): string {
  if (url === undefined) return ''
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return ''
  }
}

/** Session identity a route pathname names, or undefined when it names none. */
function sessionIdFromRoute(pathname: string): string | undefined {
  const prefix = `${SESSION_ROUTE_PREFIX}/`
  if (!pathname.startsWith(prefix)) return undefined
  const encoded = pathname.slice(prefix.length)
  if (encoded === '' || encoded.includes('/')) return undefined
  try {
    const sessionId = decodeURIComponent(encoded)
    return sessionId === '' ? undefined : sessionId
  } catch {
    return undefined
  }
}

/** Stable forbidden failure. */
function forbidden(
  action: OrchestratorAction,
  resource: OrchestratorResourceKind,
): RemoteError<'sessionOrchestrator/forbidden'> {
  return new RemoteError(
    'sessionOrchestrator/forbidden',
    'the caller may not perform this orchestration action',
    { action, resource },
  )
}

/** Stable absent-or-hidden failure. */
function notFound(
  resource: OrchestratorResourceKind,
  id?: string,
): RemoteError<'sessionOrchestrator/not-found'> {
  return new RemoteError(
    'sessionOrchestrator/not-found',
    'the requested orchestration record was not found',
    { resource, ...(id === undefined ? {} : { id }) },
  )
}

/** Stable stale-revision failure. */
function revisionConflict(
  resource: OrchestratorResourceKind,
  id?: string,
  expectedRevision?: number,
): RemoteError<'sessionOrchestrator/revision-conflict'> {
  return new RemoteError(
    'sessionOrchestrator/revision-conflict',
    'the request observed a stale orchestration revision',
    {
      resource,
      ...(id === undefined ? {} : { id }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
  )
}

/** Stable identity conflict. */
function conflict(
  resource: OrchestratorResourceKind,
  id?: string,
): RemoteError<'sessionOrchestrator/conflict'> {
  return new RemoteError(
    'sessionOrchestrator/conflict',
    'the orchestration identity already exists',
    { resource, ...(id === undefined ? {} : { id }) },
  )
}

/** Stable state refusal. */
function invalidTransition(
  resource: OrchestratorResourceKind,
  id?: string,
): RemoteError<'sessionOrchestrator/invalid-transition'> {
  return new RemoteError(
    'sessionOrchestrator/invalid-transition',
    'the current orchestration state forbids this request',
    { resource, ...(id === undefined ? {} : { id }) },
  )
}

/** Stable request validation failure. */
function invalidRequest(field?: string): RemoteError<'sessionOrchestrator/invalid-request'> {
  return new RemoteError(
    'sessionOrchestrator/invalid-request',
    'the orchestration request is invalid',
    field === undefined ? {} : { field },
  )
}

/** Stable non-draft queue refusal. */
function queueNotEmpty(queueId: string): RemoteError<'sessionOrchestrator/queue-not-empty'> {
  return new RemoteError(
    'sessionOrchestrator/queue-not-empty',
    'the queue still owns tasks and is not a draft',
    { queueId },
  )
}

/** Stable refusal for a stored task list whose dependencies cannot run. */
function taskListInvalid(
  queueId: QueueId,
  issues: readonly TaskListIssue[],
): RemoteError<'sessionOrchestrator/task-list-invalid'> {
  return new RemoteError(
    'sessionOrchestrator/task-list-invalid',
    'the queue task list carries dependencies that do not point at a listed task; repair the list before starting',
    { queueId, issues: issues.slice(0, 20) },
  )
}

/** Stable closed-store or unsupported-operation failure. */
function unavailable(): RemoteError<'sessionOrchestrator/unavailable'> {
  return new RemoteError(
    'sessionOrchestrator/unavailable',
    'the orchestration store is unavailable',
    {},
  )
}

/** Stable carrier cancellation. */
function cancelled(): RemoteError<'sessionOrchestrator/cancelled'> {
  return new RemoteError(
    'sessionOrchestrator/cancelled',
    'the orchestration call was cancelled',
    {},
  )
}

/** Throw the stable cancellation failure when the carrier already aborted. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

/**
 * Build one validated queue record from its editable draft.
 *
 * A draft that does not name a lifecycle keeps `fallback`, so editing a title
 * cannot silently pause a running pipeline. `paused` is always derived from the
 * resulting state, because the planner reads only that flag.
 */
function parseQueueDraft(
  draft: Record<string, unknown>,
  revision: number,
  fallback?: QueueRecord['state'],
): QueueRecord {
  const candidate = {
    id: QueueId(requireId(draft, 'id')),
    title: requireText(draft, 'title'),
    taskOrder: requireStringArray(draft, 'taskOrder').map(TaskId),
    paused: requireBoolean(draft, 'paused'),
    state: draft.state === undefined
      ? (fallback ?? (requireBoolean(draft, 'paused') ? 'paused' : 'idle'))
      : requireQueueState(draft, 'state'),
    ...(draft.brief === undefined ? {} : { brief: requireText(draft, 'brief') }),
    ...(draft.workspaceId === undefined ? {} : { workspaceId: requireText(draft, 'workspaceId') }),
    ...(draft.cwd === undefined ? {} : { cwd: requireText(draft, 'cwd') }),
    ...(draft.model === undefined ? {} : { model: parseModelPolicy(draft.model) }),
    ...(draft.maxConcurrentRuns === undefined
      ? {}
      : { maxConcurrentRuns: requirePositiveInteger(draft, 'maxConcurrentRuns') }),
    revision,
  }
  const parsed = queueRecordSchema.safeParse({
    ...candidate,
    paused: candidate.state !== 'running',
  })
  if (!parsed.success) throw invalidRequest(firstIssue(parsed.error))
  return parsed.data
}

/**
 * Parse one model policy from an untrusted draft field.
 * @param value - candidate policy.
 * @returns the validated policy.
 * @throws RemoteError when the field is not a complete policy.
 */
function parseModelPolicy(value: unknown): TaskSpec['model'] {
  const parsed = modelPolicySchema.safeParse(value)
  if (!parsed.success) throw invalidRequest(firstIssue(parsed.error))
  return parsed.data
}

/**
 * Compare one stored pipeline route with a requested route.
 * @param left - stored policy; absent means the host default.
 * @param right - requested policy.
 * @returns whether both name the same route.
 */
function sameModelPolicy(left: TaskSpec['model'] | undefined, right: TaskSpec['model']): boolean {
  const stored: TaskSpec['model'] = left ?? { kind: 'inherit' }
  if (stored.kind === 'inherit' || right.kind === 'inherit') return stored.kind === right.kind
  return stored.provider === right.provider
    && stored.model === right.model
    && stored.reasoningEffort === right.reasoningEffort
}

/** Build one validated task record from its editable draft. */
function parseTaskDraft(draft: Record<string, unknown>, revision: number): TaskSpec {
  const candidate = {
    id: TaskId(requireId(draft, 'id')),
    queueId: QueueId(requireId(draft, 'queueId')),
    title: requireText(draft, 'title'),
    prompt: requireText(draft, 'prompt'),
    workspaceId: requireText(draft, 'workspaceId'),
    cwd: requireText(draft, 'cwd'),
    preset: draft.preset,
    model: draft.model,
    skills: draft.skills,
    dependsOn: requireStringArray(draft, 'dependsOn').map(TaskId),
    ...(draft.parallelWithPrevious === undefined
      ? {}
      : { parallelWithPrevious: requireBoolean(draft, 'parallelWithPrevious') }),
    ...(draft.concurrencyGroup === undefined
      ? {}
      : { concurrencyGroup: requireText(draft, 'concurrencyGroup') }),
    priority: requireInteger(draft, 'priority'),
    handoff: draft.handoff,
    enabled: requireBoolean(draft, 'enabled'),
    ...(draft.stage === undefined ? {} : { stage: requireText(draft, 'stage') }),
    ...(draft.parentTaskId === undefined ? {} : { parentTaskId: TaskId(requireId(draft, 'parentTaskId')) }),
    revision,
  }
  const parsed = taskSpecSchema.safeParse(candidate)
  if (!parsed.success) throw invalidRequest(firstIssue(parsed.error))
  return parsed.data
}

/** Build one validated settings value from its editable draft. */
function parseSettingsDraft(
  draft: Record<string, unknown>,
  current: GlobalSettings,
  revision: number,
  updatedAt: number,
): GlobalSettings {
  const candidate = {
    schemaVersion: current.schemaVersion,
    paused: requireBoolean(draft, 'paused'),
    maxConcurrentRuns: requirePositiveInteger(draft, 'maxConcurrentRuns'),
    providerQuotas: requireQuotas(draft, 'providerQuotas'),
    hostInstanceId: current.hostInstanceId,
    revision,
    updatedAt,
  }
  const parsed = globalSettingsSchema.safeParse(candidate)
  if (!parsed.success) throw invalidRequest(firstIssue(parsed.error))
  return parsed.data
}

/** Whether two task orders name exactly the same sequence. */
function sameTaskOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Whether two dependency lists name exactly the same sequence. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Rebuild one task with its derived dependencies and parallel marker. */
function rewrittenTask(
  task: TaskSpec,
  dependsOn: readonly string[],
  parallelWithPrevious: boolean,
  revision: number,
): TaskSpec {
  const next: TaskSpec = {
    ...task,
    dependsOn: dependsOn.map(TaskId),
    revision,
  }
  delete next.parallelWithPrevious
  return parallelWithPrevious ? { ...next, parallelWithPrevious: true } : next
}

/** Clone one task below itself under a fresh identity, with no marker. */
function copiedTask(source: TaskSpec, id: string): TaskSpec {
  const next: TaskSpec = {
    ...source,
    id: TaskId(id),
    title: `${source.title} (copy)`,
    dependsOn: [],
    revision: 0,
  }
  delete next.parallelWithPrevious
  return next
}

/** Pick the first unused `<source>-copy` identity. */
function nextCopyTaskId(sourceId: string, existing: readonly string[]): string {
  const taken = new Set(existing)
  const base = `${sourceId}-copy`
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Read one zero-based list position. */
function requireIndex(input: Record<string, unknown>, field: string): number {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest(field)
  }
  return value
}

/** Read one plain-object request or reject it. */
function requireRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest()
  return value
}

/** Read one plain-object nested field or reject it. */
function requireRecord(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = input[field]
  if (!isRecord(value)) throw invalidRequest(field)
  return value
}

/** Read one opaque non-empty identifier without surrounding whitespace. */
function requireId(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw invalidRequest(field)
  }
  return value
}

/** Read one non-empty human-readable string. */
function requireText(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.length === 0) throw invalidRequest(field)
  return value
}

/** Read one non-blank audit string. */
function requireAuditText(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') throw invalidRequest(field)
  return value
}

/** Read one boolean field. */
function requireBoolean(input: Record<string, unknown>, field: string): boolean {
  const value = input[field]
  if (typeof value !== 'boolean') throw invalidRequest(field)
  return value
}

/** Read one queue lifecycle value. */
function requireQueueState(input: Record<string, unknown>, field: string): QueueRecord['state'] {
  const value = input[field]
  if (value !== 'idle' && value !== 'running' && value !== 'paused' && value !== 'aborted') {
    throw invalidRequest(field)
  }
  return value
}

/** Read one integer field. */
function requireInteger(input: Record<string, unknown>, field: string): number {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalidRequest(field)
  return value
}

/** Read one non-negative integer revision. */
function requireRevision(input: Record<string, unknown>, field: string): number {
  const value = requireInteger(input, field)
  if (value < 0) throw invalidRequest(field)
  return value
}

/** Read one positive integer field. */
function requirePositiveInteger(input: Record<string, unknown>, field: string): number {
  const value = requireInteger(input, field)
  if (value < 1) throw invalidRequest(field)
  return value
}

/** Read one string array field. */
function requireStringArray(input: Record<string, unknown>, field: string): string[] {
  const value = input[field]
  if (!Array.isArray(value)) throw invalidRequest(field)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) throw invalidRequest(field)
    items.push(item)
  }
  return items
}

/** Read one provider-quota record of positive integers. */
function requireQuotas(input: Record<string, unknown>, field: string): Record<string, number> {
  const value = input[field]
  if (!isRecord(value)) throw invalidRequest(field)
  const quotas: Record<string, number> = {}
  for (const [key, quota] of Object.entries(value)) {
    if (key.length === 0 || key.trim() !== key) throw invalidRequest(field)
    if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 1) throw invalidRequest(field)
    quotas[key] = quota
  }
  return quotas
}

/** Narrow one value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Name the first failing schema field. */
function firstIssue(error: ZodError): string | undefined {
  const issue = error.issues[0]
  return issue === undefined ? undefined : issue.path.map(String).join('.')
}

/**
 * Loader plugin export for the Host row.
 *
 * The class declares its own `inject`, so a profile mounts it beside the store
 * and Typert registry without a wrapper plugin.
 */
export default SessionOrchestratorController
