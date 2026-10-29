/** Controllable fake of the generated `sessionOrchestrator` Remote namespace. */

import { vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol/types'
import type {
  CancelRunRequest, CreatePipelineTemplateRequest, CreateQueueRequest, DeleteDraftQueueRequest,
  DeleteQueueValue, DeleteTaskRequest, DeleteTaskValue, DuplicateTaskRequest, DuplicateTaskValue,
  GetHandoffRequest, GetQueueRequest, GetRunRequest, HandoffListValue, HandoffValue,
  OrchestratorRemote, InterventionListValue, OrchestratorSnapshotFrame, PipelineTemplateValue,
  QueueControlRequest, QueueDetailValue, QueueListValue, QueueValue, ReorderTasksRequest,
  RepairTaskListRequest, RetryRunRequest, RunListValue, RunValue, SetTaskEnabledRequest, SettingsRevisionRequest,
  SettingsValue, SkipTaskRequest, SkipTaskValue, TaskValue, UpdateQueueRequest, UpdateSettingsRequest,
  UpsertTaskRequest,
} from '../../src/client/contract.ts'
import { ok } from './fixtures.client.ts'

/** One async channel a test can push frames or failures into. */
export class TestChannel<T> {
  private readonly buffer: T[] = []
  private readonly waiters: Array<() => void> = []
  private ended = false
  private failure: unknown

  push(value: T): void {
    if (this.ended) return
    this.buffer.push(value)
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.ended = true
    this.wake()
  }

  close(): void {
    this.ended = true
    this.wake()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T
        continue
      }
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const wake = (): void => { resolve() }
        this.waiters.push(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
      if (signal.aborted) return
    }
  }

  private wake(): void {
    while (this.waiters.length > 0) this.waiters.shift()?.()
  }
}

/** Fake namespace with recorded calls and replaceable business results. */
export class FakeOrchestratorRemote implements OrchestratorRemote {
  readonly stream = new TestChannel<OrchestratorSnapshotFrame>()
  readonly calls: Record<string, unknown[]> = {}
  listQueuesResult: RemoteResult<QueueListValue> = ok({ items: [] })
  getQueueResult: RemoteResult<QueueDetailValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: false, state: 'idle', revision: 1 }, tasks: [] })
  createQueueResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: false, state: 'idle', revision: 0 } })
  createPipelineTemplateResult: RemoteResult<PipelineTemplateValue> = ok({
    queue: { id: 'p1', title: 'Pipeline one', taskOrder: ['p1-architecture'], paused: true, state: 'idle', revision: 0 },
    tasks: [],
  })
  updateQueueResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: false, state: 'running', revision: 2 } })
  deleteQueueResult: RemoteResult<DeleteQueueValue> = ok({ queueId: 'q1', deleted: true })
  upsertTaskResult: RemoteResult<TaskValue> = ok({ task: { id: 't1', queueId: 'q1', title: 'Task one', prompt: '', workspaceId: 'w1', cwd: '/w', preset: { kind: 'inherit' }, model: { kind: 'inherit' }, skills: { kind: 'inherit-preset' }, dependsOn: [], priority: 0, handoff: { enabled: true, ratio: 0.88, mode: 'structured-brief', boundary: 'completed-turn', maxGenerations: 4, maxHandoffTokens: 8000 }, enabled: true, revision: 2 } })
  reorderTasksResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: ['t2', 't1'], paused: false, state: 'running', revision: 2 } })
  deleteTaskResult: RemoteResult<DeleteTaskValue> = ok({
    queue: { id: 'q1', title: 'Queue one', taskOrder: ['t2'], paused: false, state: 'idle', revision: 2 },
    deletedTaskId: 't1',
  })
  duplicateTaskResult: RemoteResult<DuplicateTaskValue> = ok({
    queue: { id: 'q1', title: 'Queue one', taskOrder: ['t1', 't1-copy'], paused: false, state: 'idle', revision: 2 },
    task: { id: 't1-copy', queueId: 'q1', title: 'Task one (copy)', prompt: '', workspaceId: 'w1', cwd: '/w', preset: { kind: 'inherit' }, model: { kind: 'inherit' }, skills: { kind: 'inherit-preset' }, dependsOn: [], priority: 0, handoff: { enabled: true, ratio: 0.88, mode: 'structured-brief', boundary: 'completed-turn', maxGenerations: 4, maxHandoffTokens: 8000 }, enabled: true, revision: 0 },
  })
  repairTaskListResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: ['t1'], paused: false, state: 'idle', revision: 2 } })
  setTaskEnabledResult: RemoteResult<TaskValue> = ok({ task: { id: 't1', queueId: 'q1', title: 'Task one', prompt: '', workspaceId: 'w1', cwd: '/w', preset: { kind: 'inherit' }, model: { kind: 'inherit' }, skills: { kind: 'inherit-preset' }, dependsOn: [], priority: 0, handoff: { enabled: true, ratio: 0.88, mode: 'structured-brief', boundary: 'completed-turn', maxGenerations: 4, maxHandoffTokens: 8000 }, enabled: false, revision: 2 } })
  skipTaskResult: RemoteResult<SkipTaskValue> = ok({ skipped: true, taskId: 't1', runId: 'run-t1-1', decidedAt: 4_000 })
  listRunsResult: RemoteResult<RunListValue> = ok({ items: [] })
  getRunResult: RemoteResult<RunValue> = ok({ run: { id: 'run-t1-1', taskId: 't1', attempt: 1, state: 'ready', generation: 0, revision: 1, sessionLineage: [], workspaceKey: 'w1', skipped: false, createdAt: 1, updatedAt: 1 } })
  pauseResult: RemoteResult<SettingsValue> = ok({ settings: { revision: 5, paused: true, maxConcurrentRuns: 2, providerQuotas: {}, updatedAt: 2 } })
  resumeResult: RemoteResult<SettingsValue> = ok({ settings: { revision: 5, paused: false, maxConcurrentRuns: 2, providerQuotas: {}, updatedAt: 2 } })
  cancelResult: RemoteResult<RunValue> = ok({ run: { id: 'run-t1-1', taskId: 't1', attempt: 1, state: 'cancelled', generation: 0, revision: 4, sessionLineage: [], workspaceKey: 'w1', skipped: false, createdAt: 1, updatedAt: 2 } })
  retryResult: RemoteResult<RunValue> = ok({ run: { id: 'run-t1-2', taskId: 't1', attempt: 2, state: 'ready', generation: 0, revision: 0, sessionLineage: [], workspaceKey: 'w1', skipped: false, createdAt: 2, updatedAt: 2 } })
  startQueueResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: false, state: 'running', revision: 2 } })
  pauseQueueResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: true, state: 'paused', revision: 2 } })
  abortQueueResult: RemoteResult<QueueValue> = ok({ queue: { id: 'q1', title: 'Queue one', taskOrder: [], paused: true, state: 'aborted', revision: 2 } })
  listInterventionsResult: RemoteResult<InterventionListValue> = ok({ items: [] })
  listHandoffsResult: RemoteResult<HandoffListValue> = ok({ items: [] })
  getHandoffResult: RemoteResult<HandoffValue> = ok({ handoff: { operationId: 'op-1', runId: 'run-t1-1', generation: 1, parentSession: { sessionId: 's1', linkable: true, openState: 'ready' }, childSession: { sessionId: 's2', linkable: false, openState: 'unsupported' }, sourceSeq: 1, bodyHash: 'hash', mode: 'structured-brief', configSnapshot: { routeSource: 'fixed-policy', provider: 'p', model: 'm', preset: { id: 'd' }, capturedAt: 1 }, createdAt: 1 } })
  getSettingsResult: RemoteResult<SettingsValue> = ok({ settings: { revision: 4, paused: false, maxConcurrentRuns: 2, providerQuotas: {}, updatedAt: 1 } })
  updateSettingsResult: RemoteResult<SettingsValue> = ok({ settings: { revision: 5, paused: false, maxConcurrentRuns: 3, providerQuotas: {}, updatedAt: 2 } })
  createQueueHandler: ((request: CreateQueueRequest) => RemoteResult<QueueValue>) | undefined = undefined
  upsertTaskHandler: ((request: UpsertTaskRequest) => RemoteResult<TaskValue>) | undefined = undefined
  getQueueHandler: ((request: GetQueueRequest) => RemoteResult<QueueDetailValue>) | undefined = undefined
  startQueueHandler: ((request: QueueControlRequest) => RemoteResult<QueueValue>) | undefined = undefined
  deleteDraftQueueHandler: ((request: DeleteDraftQueueRequest) => RemoteResult<DeleteQueueValue>) | undefined = undefined

  readonly listQueues = vi.fn(async (): Promise<RemoteResult<QueueListValue>> => this.listQueuesResult)
  readonly getQueue = vi.fn(
    async (request: GetQueueRequest): Promise<RemoteResult<QueueDetailValue>> =>
      this.getQueueHandler?.(request) ?? this.getQueueResult,
  )
  readonly createQueue = vi.fn(
    async (request: CreateQueueRequest): Promise<RemoteResult<QueueValue>> =>
      this.createQueueHandler?.(request) ?? this.createQueueResult,
  )

  readonly createPipelineTemplate = vi.fn(
    async (_request: CreatePipelineTemplateRequest): Promise<RemoteResult<PipelineTemplateValue>> =>
      this.createPipelineTemplateResult,
  )
  readonly updateQueue = vi.fn(async (_request: UpdateQueueRequest): Promise<RemoteResult<QueueValue>> => this.updateQueueResult)
  readonly deleteDraftQueue = vi.fn(
    async (request: DeleteDraftQueueRequest): Promise<RemoteResult<DeleteQueueValue>> =>
      this.deleteDraftQueueHandler?.(request) ?? this.deleteQueueResult,
  )
  readonly upsertTask = vi.fn(
    async (request: UpsertTaskRequest): Promise<RemoteResult<TaskValue>> =>
      this.upsertTaskHandler?.(request) ?? this.upsertTaskResult,
  )
  readonly reorderTasks = vi.fn(async (_request: ReorderTasksRequest): Promise<RemoteResult<QueueValue>> => this.reorderTasksResult)
  readonly deleteTask = vi.fn(async (_request: DeleteTaskRequest): Promise<RemoteResult<DeleteTaskValue>> => this.deleteTaskResult)
  readonly duplicateTask = vi.fn(async (_request: DuplicateTaskRequest): Promise<RemoteResult<DuplicateTaskValue>> => this.duplicateTaskResult)
  readonly repairTaskList = vi.fn(async (_request: RepairTaskListRequest): Promise<RemoteResult<QueueValue>> => this.repairTaskListResult)
  readonly setTaskEnabled = vi.fn(async (_request: SetTaskEnabledRequest): Promise<RemoteResult<TaskValue>> => this.setTaskEnabledResult)
  readonly skipTask = vi.fn(async (_request: SkipTaskRequest): Promise<RemoteResult<SkipTaskValue>> => this.skipTaskResult)
  readonly listRuns = vi.fn(async (): Promise<RemoteResult<RunListValue>> => this.listRunsResult)
  readonly getRun = vi.fn(async (_request: GetRunRequest): Promise<RemoteResult<RunValue>> => this.getRunResult)
  readonly pause = vi.fn(async (_request: SettingsRevisionRequest): Promise<RemoteResult<SettingsValue>> => this.pauseResult)
  readonly resume = vi.fn(async (_request: SettingsRevisionRequest): Promise<RemoteResult<SettingsValue>> => this.resumeResult)
  readonly cancel = vi.fn(async (_request: CancelRunRequest): Promise<RemoteResult<RunValue>> => this.cancelResult)
  readonly retry = vi.fn(async (_request: RetryRunRequest): Promise<RemoteResult<RunValue>> => this.retryResult)
  readonly startQueue = vi.fn(
    async (request: QueueControlRequest): Promise<RemoteResult<QueueValue>> =>
      this.startQueueHandler?.(request) ?? this.startQueueResult,
  )
  readonly pauseQueue = vi.fn(async (_request: QueueControlRequest): Promise<RemoteResult<QueueValue>> => this.pauseQueueResult)
  readonly abortQueue = vi.fn(async (_request: QueueControlRequest): Promise<RemoteResult<QueueValue>> => this.abortQueueResult)
  readonly listInterventions = vi.fn(async (): Promise<RemoteResult<InterventionListValue>> => this.listInterventionsResult)
  readonly listHandoffs = vi.fn(async (): Promise<RemoteResult<HandoffListValue>> => this.listHandoffsResult)
  readonly getHandoff = vi.fn(async (_request: GetHandoffRequest): Promise<RemoteResult<HandoffValue>> => this.getHandoffResult)
  readonly getSettings = vi.fn(async (): Promise<RemoteResult<SettingsValue>> => this.getSettingsResult)
  readonly updateSettings = vi.fn(async (_request: UpdateSettingsRequest): Promise<RemoteResult<SettingsValue>> => this.updateSettingsResult)

  changed(signal?: AbortSignal): AsyncIterable<OrchestratorSnapshotFrame> {
    this.record('changed', signal)
    const controller = signal ?? new AbortController().signal
    return this.stream.iterate(controller)
  }

  /** Record one call for assertions. */
  private record(name: string, value: unknown): void {
    const list = this.calls[name] ?? []
    list.push(value)
    this.calls[name] = list
  }
}
