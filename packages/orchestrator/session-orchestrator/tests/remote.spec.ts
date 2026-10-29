/**
 * Remote namespace, access filtering, revision CAS, cancellation races,
 * redacted DTOs and reconnect snapshots for the orchestration controller.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import type SessionOrchestrator from '../src/store.ts'
import type { HandoffRecord, RunRecord } from '../src/types.ts'
import type {
  OrchestratorAccess,
  OrchestratorRunControl,
  OrchestratorSnapshotFrame,
  QueueDraft,
  TaskDraft,
} from '../src/remote-types.ts'
import { SessionOrchestratorController } from '../src/remote.ts'
import { harness } from './harness.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A fresh, never-aborted carrier signal. */
function signal(): AbortSignal {
  return new AbortController().signal
}

/** Capture a synchronous failure. */
function failure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to fail')
}

interface Fixture {
  readonly ctx: Context
  readonly store: SessionOrchestrator
  readonly controller: SessionOrchestratorController
  /** Routes the controller registered on the fake Web carrier. */
  readonly routes: RegisteredRoute[]
}

/** One route a fake carrier captured. */
interface RegisteredRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (request: { url?: string; method?: string }, response: FakeResponse) => void
}

/** Minimal response the Session-route handler writes to. */
interface FakeResponse {
  statusCode: number
  readonly headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** A carrier that records every registration without listening. */
function fakeCarrier(routes: RegisteredRoute[]): {
  register(route: RegisteredRoute): () => void
} {
  return {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
}

/** Drive one registered route with a request URL. */
function callRoute(
  routes: readonly RegisteredRoute[],
  url: string,
  method = 'GET',
): FakeResponse {
  const route = routes.find(candidate => candidate.path === '/session')
  if (route === undefined) throw new Error('no /session route was registered')
  const headers: Record<string, string> = {}
  const response: FakeResponse = {
    statusCode: 0,
    headers,
    body: '',
    setHeader: (name, value) => { headers[name.toLowerCase()] = value },
    end: (body) => { response.body = body ?? '' },
  }
  route.handler({ url, method }, response)
  return response
}

/** Compose the store and one controller over a fresh memory domain. */
async function setup(
  options: {
    readonly access?: OrchestratorAccess
    readonly runControl?: OrchestratorRunControl
    readonly now?: () => number
    readonly sessionController?: boolean
    readonly webServer?: boolean
    readonly workspaces?: Readonly<Record<string, { readonly path: string }>>
    readonly workspaceClaims?: readonly {
      readonly workspaceId: string
      readonly path: string
      readonly sessionIds: readonly string[]
    }[]
    readonly archivedSessions?: readonly string[]
  } = {},
): Promise<Fixture> {
  const h = await harness()
  roots.push(h.ctx)
  const routes: RegisteredRoute[] = []
  if (options.sessionController === true) h.ctx.provide('sessionController', {})
  if (options.workspaces !== undefined) {
    h.ctx.provide('workspaceRegistry', {
      get: (id: string) => options.workspaces?.[id],
    })
  }
  if (options.workspaceClaims !== undefined) {
    h.ctx.provide('workspaceRegistry', {
      get: (id: string) => options.workspaceClaims?.find(claim => claim.workspaceId === id),
      list: () => options.workspaceClaims ?? [],
      archivedSessionIds: options.archivedSessions ?? [],
    })
  }
  if (options.webServer === true) {
    h.ctx.provide('webServer', fakeCarrier(routes) as never)
  }
  const internals = {
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.runControl === undefined ? {} : { runControl: options.runControl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  const controller = new SessionOrchestratorController(h.ctx, {}, internals)
  return { ctx: h.ctx, store: h.store, controller, routes }
}

/** A queue draft with the required fields. */
function queueDraft(overrides: Partial<QueueDraft> = {}): QueueDraft {
  return {
    id: 'queue-1',
    title: 'Queue one',
    taskOrder: [],
    paused: false,
    ...overrides,
  }
}

/** A task draft with the required fields. */
function taskDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: 'task-1',
    queueId: 'queue-1',
    title: 'First task',
    prompt: 'Do the first thing',
    workspaceId: 'workspace-1',
    cwd: '/work/one',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: true,
      ratio: 0.88,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 20,
      maxHandoffTokens: 4096,
    },
    enabled: true,
    ...overrides,
  }
}

/** A stored run with the required fields. */
function run(overrides: Partial<RunRecord> = {}): RunRecord {
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

/** A stored handoff with the required fields. */
function handoff(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    generation: 1,
    runId: RunId('run-1'),
    sourceSessionId: SessionId('session-parent'),
    targetSessionId: SessionId('session-child'),
    operationId: OperationId('operation-1'),
    sourceSeq: SessionLogOffset(42),
    bodyHash: 'body-hash',
    mode: 'structured-brief',
    configSnapshot: {
      routeSource: 'fixed-policy',
      provider: 'deepseek',
      model: 'deepseek-chat',
      preset: { id: 'preset-1' },
      capturedAt: 900,
    },
    bodyTokens: 120,
    createdAt: 1_000,
    ...overrides,
  }
}

/** Read one frame or fail when the stream ended. */
async function nextFrame(
  iterator: AsyncIterator<OrchestratorSnapshotFrame>,
): Promise<OrchestratorSnapshotFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('snapshot stream ended before the expected frame')
  return next.value
}

/** One baseline frame, then close the stream. */
async function baseline(controller: SessionOrchestratorController): Promise<OrchestratorSnapshotFrame> {
  const abort = new AbortController()
  const iterator = controller.changed(abort.signal)[Symbol.asyncIterator]()
  const frame = await nextFrame(iterator)
  abort.abort()
  await iterator.next()
  return frame
}

describe('sessionOrchestrator Remote namespace', () => {
  it('binds the namespace and advertises every documented method', async () => {
    const { controller } = await setup()
    expect(controller.typertRemote).toMatchObject({
      serviceKey: 'sessionOrchestratorController',
      namespace: 'sessionOrchestrator',
    })
    const markers = remoteMethods(controller)
    expect(markers.map(marker => marker.method)).toEqual([
      'listQueues',
      'getQueue',
      'createQueue',
      'createPipelineTemplate',
      'updateQueue',
      'startQueue',
      'pauseQueue',
      'abortQueue',
      'listInterventions',
      'deleteDraftQueue',
      'upsertTask',
      'reorderTasks',
      'deleteTask',
      'duplicateTask',
      'repairTaskList',
      'setTaskEnabled',
      'skipTask',
      'listRuns',
      'getRun',
      'pause',
      'resume',
      'cancel',
      'retry',
      'listHandoffs',
      'getHandoff',
      'getSettings',
      'updateSettings',
      'changed',
    ])
    expect(markers.find(marker => marker.method === 'changed')).toMatchObject({
      mode: 'stream',
      invocation: { kind: 'direct' },
    })
  })

  it('lets an owner create, read, reorder and toggle orchestration records', async () => {
    const { controller } = await setup()
    const created = await controller.createQueue(
      { expectedRevision: 0, draft: queueDraft() },
      signal(),
    )
    expect(created.queue).toMatchObject({ id: 'queue-1', revision: 0, taskOrder: [] })
    expect(controller.listQueues().items).toHaveLength(1)

    const task = await controller.upsertTask(
      { taskId: 'task-1', expectedRevision: 0, draft: taskDraft() },
      signal(),
    )
    expect(task.task).toMatchObject({ id: 'task-1', queueId: 'queue-1', revision: 0 })

    const reordered = await controller.reorderTasks(
      { queueId: 'queue-1', expectedRevision: 0, taskOrder: ['task-1'] },
      signal(),
    )
    expect(reordered.queue).toMatchObject({ taskOrder: ['task-1'], revision: 1 })

    const disabled = await controller.setTaskEnabled(
      { taskId: 'task-1', expectedRevision: 0, enabled: false },
      signal(),
    )
    expect(disabled.task.enabled).toBe(false)

    const detail = controller.getQueue({ queueId: 'queue-1' })
    expect(detail.tasks.map(item => item.id)).toEqual(['task-1'])
    expect(detail.queue.taskOrder).toEqual(['task-1'])
  })

  it('rewrites dependencies from list order when tasks move', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    for (const id of ['task-1', 'task-2', 'task-3']) {
      await controller.upsertTask({
        taskId: id,
        expectedRevision: 0,
        draft: taskDraft({ id, title: id }),
      }, signal())
    }
    await controller.reorderTasks({
      queueId: 'queue-1',
      expectedRevision: 0,
      taskOrder: ['task-3', 'task-1', 'task-2'],
    }, signal())
    const detail = controller.getQueue({ queueId: 'queue-1' })
    expect(detail.queue.taskOrder).toEqual(['task-3', 'task-1', 'task-2'])
    expect(detail.tasks.map(task => [task.id, task.dependsOn])).toEqual([
      ['task-3', []],
      ['task-1', ['task-3']],
      ['task-2', ['task-1']],
    ])
    expect(store.listTasks().every(task =>
      task.dependsOn.every(id => store.getTask(TaskId(id)) !== undefined))).toBe(true)
  })

  it('deletes one task and repairs the remaining dependency in the same commit', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    for (const id of ['task-1', 'task-2', 'task-3']) {
      await controller.upsertTask({
        taskId: id,
        expectedRevision: 0,
        draft: taskDraft({ id, title: id }),
      }, signal())
    }
    await controller.reorderTasks({
      queueId: 'queue-1',
      expectedRevision: 0,
      taskOrder: ['task-1', 'task-2', 'task-3'],
    }, signal())
    const queueRevision = controller.getQueue({ queueId: 'queue-1' }).queue.revision
    const deleted = await controller.deleteTask({
      queueId: 'queue-1',
      taskId: 'task-2',
      expectedRevision: queueRevision,
    }, signal())
    expect(deleted.deletedTaskId).toBe('task-2')
    expect(deleted.queue.taskOrder).toEqual(['task-1', 'task-3'])
    expect(store.getTask(TaskId('task-2'))).toBeUndefined()
    const remaining = controller.getQueue({ queueId: 'queue-1' }).tasks
    expect(remaining.map(task => [task.id, task.dependsOn])).toEqual([
      ['task-1', []],
      ['task-3', ['task-1']],
    ])
  })

  it('derives parallel groups only from the "with previous item" marker', async () => {
    const { controller } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    for (const id of ['task-1', 'task-2', 'task-3']) {
      await controller.upsertTask({
        taskId: id,
        expectedRevision: 0,
        draft: taskDraft({ id, title: id }),
      }, signal())
    }
    await controller.reorderTasks({
      queueId: 'queue-1',
      expectedRevision: 0,
      taskOrder: ['task-1', 'task-2', 'task-3'],
      parallelWithPrevious: ['task-2'],
    }, signal())
    const parallel = controller.getQueue({ queueId: 'queue-1' }).tasks
    expect(parallel.map(task => [task.id, task.parallelWithPrevious === true, task.dependsOn])).toEqual([
      ['task-1', false, []],
      ['task-2', true, []],
      ['task-3', false, ['task-1', 'task-2']],
    ])
    const revision = controller.getQueue({ queueId: 'queue-1' }).queue.revision
    await controller.reorderTasks({
      queueId: 'queue-1',
      expectedRevision: revision,
      taskOrder: ['task-1', 'task-2', 'task-3'],
      parallelWithPrevious: [],
    }, signal())
    expect(controller.getQueue({ queueId: 'queue-1' }).tasks.map(task => task.dependsOn)).toEqual([
      [],
      ['task-1'],
      ['task-2'],
    ])
  })

  it('inserts a task at a position and copies one below itself', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft(),
    }, signal())
    await controller.upsertTask({
      taskId: 'task-2',
      expectedRevision: 0,
      draft: taskDraft({ id: 'task-2', title: 'Inserted first' }),
      position: 0,
      queueRevision: 0,
    }, signal())
    expect(controller.getQueue({ queueId: 'queue-1' })).toMatchObject({
      queue: { taskOrder: ['task-2', 'task-1'] },
      tasks: [
        { id: 'task-2', dependsOn: [] },
        { id: 'task-1', dependsOn: ['task-2'] },
      ],
    })
    const queueRevision = controller.getQueue({ queueId: 'queue-1' }).queue.revision
    const copy = await controller.duplicateTask({
      queueId: 'queue-1',
      taskId: 'task-2',
      expectedRevision: queueRevision,
    }, signal())
    expect(copy.task.id).toBe('task-2-copy')
    expect(copy.queue.taskOrder).toEqual(['task-2', 'task-2-copy', 'task-1'])
    expect(store.getTask(TaskId('task-1'))?.dependsOn).toEqual(['task-2-copy'])
  })

  it('blocks start on a legacy dangling dependency and repairs it from the list order', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({ dependsOn: ['t-1'] }),
    }, signal())
    const before = controller.getQueue({ queueId: 'queue-1' }).queue.revision
    await expect(controller.startQueue(
      { queueId: 'queue-1', expectedRevision: before },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/task-list-invalid',
      details: {
        queueId: 'queue-1',
        issues: [{ kind: 'missing-dependency', taskId: 'task-1', dependencyId: 't-1' }],
      },
    })
    expect(controller.getQueue({ queueId: 'queue-1' }).queue.state).toBe('idle')
    const repaired = await controller.repairTaskList({
      queueId: 'queue-1',
      expectedRevision: before,
    }, signal())
    expect(store.getTask(TaskId('task-1'))?.dependsOn).toEqual([])
    const started = await controller.startQueue({
      queueId: 'queue-1',
      expectedRevision: repaired.queue.revision,
    }, signal())
    expect(started.queue.state).toBe('running')
  })

  it('creates the four-stage pipeline draft once, even when the click repeats', async () => {
    const { controller, store } = await setup({
      workspaces: { 'workspace-1': { path: '/canonical/workspace' } },
    })
    const request = {
      expectedRevision: 0,
      queueId: 'pipeline-1',
      brief: 'Ship a requirement-driven pipeline',
      workspaceId: 'workspace-1',
    }
    const created = await controller.createPipelineTemplate(request, signal())
    expect(created.queue).toMatchObject({
      id: 'pipeline-1',
      state: 'idle',
      paused: true,
      workspaceId: 'workspace-1',
      cwd: '/canonical/workspace',
      brief: 'Ship a requirement-driven pipeline',
    })
    expect(created.queue.taskOrder).toEqual([
      'pipeline-1-architecture',
      'pipeline-1-breakdown',
      'pipeline-1-implement',
      'pipeline-1-test',
    ])
    expect(created.tasks.map(task => task.stage)).toEqual([
      'architecture', 'breakdown', 'implement', 'test',
    ])
    expect(created.tasks.map(task => task.dependsOn)).toEqual([
      [],
      ['pipeline-1-architecture'],
      ['pipeline-1-breakdown'],
      ['pipeline-1-implement'],
    ])
    expect(created.tasks.every(task => task.prompt.includes(request.brief))).toBe(true)
    expect(created.tasks.every(task => task.model.kind === 'inherit')).toBe(true)
    expect(created.tasks.every(task => task.enabled)).toBe(true)

    const revision = created.queue.revision
    const again = await controller.createPipelineTemplate(request, signal())
    expect(again.queue.revision).toBe(revision)
    expect(again.tasks.map(task => task.id)).toEqual(created.tasks.map(task => task.id))
    expect(store.listQueues()).toHaveLength(1)
    expect(store.listTasks()).toHaveLength(4)

    await expect(controller.createPipelineTemplate({
      ...request,
      brief: 'A different requirement reusing the same identity',
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-transition',
      details: { resource: 'queue', id: 'pipeline-1' },
    })
    expect(store.listTasks()).toHaveLength(4)
  })

  it('refuses a pipeline template whose workspace is not registered', async () => {
    const { controller, store } = await setup({
      workspaces: { 'workspace-1': { path: '/canonical/workspace' } },
    })
    await expect(controller.createPipelineTemplate({
      expectedRevision: 0,
      queueId: 'pipeline-2',
      brief: 'Missing workspace',
      workspaceId: 'missing-workspace',
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'workspaceId' },
    })
    expect(store.listQueues()).toHaveLength(0)
    expect(store.listTasks()).toHaveLength(0)
  })

  it('binds queue and task workspaces to the registered canonical directory', async () => {
    const { controller, store } = await setup({
      workspaces: { 'workspace-1': { path: '/canonical/workspace' } },
    })
    const created = await controller.createQueue({
      expectedRevision: 0,
      draft: queueDraft({
        workspaceId: 'workspace-1',
        cwd: '/stale/draft',
        brief: 'Ship the queue in a real workspace',
      }),
    }, signal())
    expect(created.queue).toMatchObject({
      workspaceId: 'workspace-1',
      cwd: '/canonical/workspace',
      brief: 'Ship the queue in a real workspace',
    })

    const task = await controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({
        prompt: 'Paste this complete task prompt into the new session.',
        cwd: '/stale/task/draft',
      }),
    }, signal())
    expect(task.task).toMatchObject({
      workspaceId: 'workspace-1',
      cwd: '/canonical/workspace',
      prompt: 'Paste this complete task prompt into the new session.',
    })
    expect(store.getTask(TaskId('task-1'))?.cwd).toBe('/canonical/workspace')
  })

  it('refuses a task whose workspace is not registered or whose prompt is blank', async () => {
    const { controller, store } = await setup({
      workspaces: { 'workspace-1': { path: '/canonical/workspace' } },
    })
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await expect(controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({ workspaceId: 'missing-workspace' }),
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'workspaceId' },
    })
    await expect(controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({ prompt: '   ' }),
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'prompt' },
    })
    expect(store.getTask(TaskId('task-1'))).toBeUndefined()
  })

  it('allows an observer to read but never to mutate', async () => {
    const access: OrchestratorAccess = { role: () => 'observer' }
    const { controller } = await setup({ access })
    expect(controller.listQueues()).toEqual({ items: [] })
    await expect(controller.createQueue(
      { expectedRevision: 0, draft: queueDraft() },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/forbidden',
      details: { action: 'mutate', resource: 'queue' },
    })
  })

  it('rejects a caller with no role and hides records the policy filters out', async () => {
    const noRole: OrchestratorAccess = { role: () => 'none' }
    const { controller: denied } = await setup({ access: noRole })
    expect(failure(() => denied.listQueues())).toMatchObject({
      code: 'sessionOrchestrator/forbidden',
      details: { action: 'read', resource: 'queue' },
    })
    expect(failure(() => denied.getQueue({ queueId: 'queue-1' }))).toMatchObject({
      code: 'sessionOrchestrator/not-found',
      details: { resource: 'queue', id: 'queue-1' },
    })
    await expect(denied.pause({ expectedRevision: 0 }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/forbidden',
    })

    const hidden: OrchestratorAccess = {
      role: ({ resource }) => resource.id === 'run-hidden' ? 'none' : 'owner',
    }
    const { controller, store } = await setup({ access: hidden })
    await store.createRun(run({ id: RunId('run-visible') }))
    await store.createRun(run({ id: RunId('run-hidden'), attempt: 2 }))
    expect(controller.listRuns().items.map(item => item.id)).toEqual(['run-visible'])
    expect(failure(() => controller.getRun({ runId: 'run-hidden' }))).toMatchObject({
      code: 'sessionOrchestrator/not-found',
      details: { resource: 'run', id: 'run-hidden' },
    })
    const frame = await baseline(controller)
    expect(frame.runs.map(item => item.id)).toEqual(['run-visible'])
  })

  it('updates an existing task under revision CAS', async () => {
    const { controller } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask(
      { taskId: 'task-1', expectedRevision: 0, draft: taskDraft() },
      signal(),
    )
    const updated = await controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({ title: 'Renamed task' }),
    }, signal())
    expect(updated.task).toMatchObject({ title: 'Renamed task', revision: 1 })
    await expect(controller.upsertTask({
      taskId: 'task-1',
      expectedRevision: 0,
      draft: taskDraft({ title: 'Stale edit' }),
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/revision-conflict',
      details: { resource: 'task', id: 'task-1', expectedRevision: 0 },
    })
    expect(controller.getQueue({ queueId: 'queue-1' }).tasks[0]?.title).toBe('Renamed task')
  })

  it('rejects a stale revision without overwriting the winning edit', async () => {
    const { controller } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    const results = await Promise.allSettled([
      controller.updateQueue({
        queueId: 'queue-1',
        expectedRevision: 0,
        draft: queueDraft({ title: 'First edit' }),
      }, signal()),
      controller.updateQueue({
        queueId: 'queue-1',
        expectedRevision: 0,
        draft: queueDraft({ title: 'Second edit' }),
      }, signal()),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const failureReason: unknown = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined
    expect(failureReason).toMatchObject({
      code: 'sessionOrchestrator/revision-conflict',
      details: { resource: 'queue', id: 'queue-1', expectedRevision: 0 },
    })
    const current = controller.getQueue({ queueId: 'queue-1' }).queue
    const winner: unknown = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined
    expect(current.title).toBe((winner as { readonly queue: { readonly title: string } }).queue.title)
    expect(current.revision).toBe(1)
  })

  it('maps invalid wire input to one stable request code', async () => {
    const { controller } = await setup()
    await expect(controller.createQueue(
      { expectedRevision: 1, draft: queueDraft() },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'expectedRevision' },
    })
    await expect(controller.createQueue(
      {
        expectedRevision: 0,
        draft: { id: 'queue-1', taskOrder: [], paused: false },
      } as never,
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'title' },
    })
    expect(failure(() => controller.getQueue(null as never))).toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
    })
    await expect(controller.reorderTasks(
      { queueId: 'queue-1', expectedRevision: 0, taskOrder: ['task-1', 'task-1'] },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'taskOrder' },
    })
    await expect(controller.skipTask(
      { runId: 'run-1', expectedRevision: 0, actor: '   ', reason: 'handled' },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'actor' },
    })
    await expect(controller.cancel(
      { runId: 'run-1', expectedRevision: -1 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'expectedRevision' },
    })
  })

  it('deletes a queue together with its tasks', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await expect(controller.deleteDraftQueue(
      { queueId: 'queue-1', expectedRevision: 1 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/revision-conflict',
    })
    const deleted = await controller.deleteDraftQueue(
      { queueId: 'queue-1', expectedRevision: 0 },
      signal(),
    )
    expect(deleted).toEqual({ queueId: 'queue-1', deleted: true })
    expect(failure(() => controller.getQueue({ queueId: 'queue-1' }))).toMatchObject({
      code: 'sessionOrchestrator/not-found',
    })

    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask(
      { taskId: 'task-1', expectedRevision: 0, draft: taskDraft() },
      signal(),
    )
    await controller.deleteDraftQueue(
      { queueId: 'queue-1', expectedRevision: 0 },
      signal(),
    )
    expect(store.getQueue(QueueId('queue-1'))).toBeUndefined()
    expect(store.getTask(TaskId('task-1'))).toBeUndefined()
  })

  it('cancels under revision CAS and never stops a run another caller settled', async () => {
    const cancelled: RunId[] = []
    const runControl: OrchestratorRunControl = {
      cancel: (runId) => {
        cancelled.push(runId)
        return true
      },
    }
    const { controller, store } = await setup({ runControl })
    await store.createRun(run({ state: 'running' }))
    const results = await Promise.allSettled([
      controller.cancel({ runId: 'run-1', expectedRevision: 0 }, signal()),
      controller.cancel({ runId: 'run-1', expectedRevision: 0 }, signal()),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(cancelled).toHaveLength(1)
    expect(store.getRun(RunId('run-1'))?.state).toBe('cancelled')

    await store.createRun(run({ id: RunId('run-settled'), attempt: 2, state: 'running' }))
    await store.updateRun(
      RunId('run-settled'),
      0,
      run({ id: RunId('run-settled'), attempt: 2, state: 'succeeded', revision: 1 }),
    )
    await expect(controller.cancel(
      { runId: 'run-settled', expectedRevision: 0 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/revision-conflict',
    })
    expect(store.getRun(RunId('run-settled'))?.state).toBe('succeeded')
    expect(cancelled).toEqual([RunId('run-1')])

    await store.createRun(run({ id: RunId('run-done'), attempt: 3, state: 'succeeded' }))
    await expect(controller.cancel(
      { runId: 'run-done', expectedRevision: 0 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-transition',
    })

    await store.createRun(run({ id: RunId('run-handoff'), attempt: 4, state: 'handing-off' }))
    await expect(controller.cancel(
      { runId: 'run-handoff', expectedRevision: 0 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-transition',
    })
  })

  it('creates at most one deterministic retry attempt', async () => {
    const { controller, store } = await setup()
    await store.createRun(run({ id: RunId('run-task-1-1'), state: 'failed' }))
    const results = await Promise.allSettled([
      controller.retry({ runId: 'run-task-1-1', expectedRevision: 0 }, signal()),
      controller.retry({ runId: 'run-task-1-1', expectedRevision: 0 }, signal()),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const attempts = store.listRuns().filter(item => item.taskId === TaskId('task-1'))
    expect(attempts.map(item => item.id)).toEqual([
      RunId('run-task-1-1'),
      RunId('run-task-1-2'),
    ])
    expect(store.getRun(RunId('run-task-1-2'))).toMatchObject({
      attempt: 2,
      state: 'ready',
      revision: 0,
    })
    await expect(controller.retry(
      { runId: 'run-task-1-1', expectedRevision: 0 },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-transition',
    })
  })

  it('records one audited skip against the observed needs-attention revision', async () => {
    const { controller, store } = await setup()
    await store.createRun(run({ state: 'needs-attention' }))
    const receipt = await controller.skipTask(
      { runId: 'run-1', expectedRevision: 0, actor: 'alice', reason: 'handled manually' },
      signal(),
    )
    expect(receipt).toMatchObject({ skipped: true, taskId: 'task-1', runId: 'run-1' })
    expect(receipt).not.toHaveProperty('actor')
    expect(receipt).not.toHaveProperty('reason')
    expect(store.getSkip(RunId('run-1'))).toMatchObject({
      taskId: TaskId('task-1'),
      actor: 'alice',
      reason: 'handled manually',
      runRevision: 0,
    })
    expect(controller.getRun({ runId: 'run-1' }).run.skipped).toBe(true)

    await expect(controller.skipTask(
      { runId: 'run-1', expectedRevision: 0, actor: 'alice', reason: 'again' },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/conflict',
    })
    await store.createRun(run({ id: RunId('run-other'), taskId: TaskId('task-2'), state: 'failed' }))
    await expect(controller.skipTask(
      { runId: 'run-other', expectedRevision: 0, actor: 'alice', reason: 'failed' },
      signal(),
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-transition',
    })

    const retried = await controller.retry(
      { runId: 'run-1', expectedRevision: 0 },
      signal(),
    )
    expect(retried.run).toMatchObject({
      id: 'run-task-1-2',
      attempt: 2,
      state: 'ready',
      skipped: false,
    })
    expect(store.getSkip(RunId('run-1'))).toBeDefined()
  })

  it('updates settings under revision CAS and ignores host identity in the draft', async () => {
    const { controller } = await setup()
    expect(controller.getSettings().settings).toMatchObject({
      revision: 0,
      paused: true,
      maxConcurrentRuns: 8,
    })
    await controller.pause({ expectedRevision: 0 }, signal())
    const resumed = await controller.resume({ expectedRevision: 1 }, signal())
    expect(resumed.settings).toMatchObject({ paused: false, revision: 2 })
    await expect(controller.resume({ expectedRevision: 1 }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/revision-conflict',
      details: { resource: 'settings', id: 'global', expectedRevision: 1 },
    })
    const updated = await controller.updateSettings({
      expectedRevision: 2,
      draft: {
        paused: true,
        maxConcurrentRuns: 2,
        providerQuotas: { deepseek: 1 },
        hostInstanceId: 'draft-canary',
      } as never,
    }, signal())
    expect(updated.settings).toMatchObject({
      revision: 3,
      paused: true,
      maxConcurrentRuns: 2,
      providerQuotas: { deepseek: 1 },
    })
    await expect(controller.updateSettings({
      expectedRevision: 3,
      draft: { paused: true, maxConcurrentRuns: 0, providerQuotas: {} },
    }, signal())).rejects.toMatchObject({
      code: 'sessionOrchestrator/invalid-request',
      details: { field: 'maxConcurrentRuns' },
    })
  })

  it('projects handoffs without their rendered body', async () => {
    const { controller, store } = await setup()
    await store.recordHandoff(handoff())
    const list = controller.listHandoffs()
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      operationId: 'operation-1',
      parentSession: { sessionId: 'session-parent', linkable: false },
      childSession: { sessionId: 'session-child', linkable: false },
      bodyHash: 'body-hash',
      bodyTokens: 120,
      sourceSeq: 42,
    })
    expect(list.items[0]).not.toHaveProperty('body')
    expect(controller.getHandoff({ operationId: 'operation-1' })).toEqual({
      handoff: list.items[0],
    })
    expect(failure(() => controller.getHandoff({ operationId: 'missing' }))).toMatchObject({
      code: 'sessionOrchestrator/not-found',
      details: { resource: 'handoff', id: 'missing' },
    })
  })

  it('streams revisioned snapshots and a reconnect starts from the newest revision', async () => {
    const { controller } = await setup()
    const firstAbort = new AbortController()
    const first = controller.changed(firstAbort.signal)[Symbol.asyncIterator]()
    const baselineFrame = await nextFrame(first)
    expect(baselineFrame).toMatchObject({ type: 'snapshot', revision: 0, queues: [] })

    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    const changed = await nextFrame(first)
    expect(changed.revision).toBeGreaterThan(baselineFrame.revision)
    expect(changed.queues.map(queue => queue.id)).toEqual(['queue-1'])

    firstAbort.abort()
    expect((await first.next()).done).toBe(true)

    await controller.createQueue({
      expectedRevision: 0,
      draft: queueDraft({ id: 'queue-2', title: 'Queue two' }),
    }, signal())
    const secondAbort = new AbortController()
    const second = controller.changed(secondAbort.signal)[Symbol.asyncIterator]()
    const reconnected = await nextFrame(second)
    expect(reconnected.revision).toBeGreaterThan(changed.revision)
    expect(reconnected.queues.map(queue => queue.id)).toEqual(['queue-1', 'queue-2'])
    secondAbort.abort()
    expect((await second.next()).done).toBe(true)
  })

  it('ends a cancelled stream and rejects one denied by the access policy', async () => {
    const { controller } = await setup()
    const preAborted = new AbortController()
    preAborted.abort()
    const cancelledStream = controller.changed(preAborted.signal)[Symbol.asyncIterator]()
    await expect(cancelledStream.next()).rejects.toMatchObject({
      code: 'sessionOrchestrator/cancelled',
    })

    const denied = await setup({ access: { role: () => 'none' } })
    const deniedStream = denied.controller.changed(signal())[Symbol.asyncIterator]()
    await expect(deniedStream.next()).rejects.toMatchObject({
      code: 'sessionOrchestrator/forbidden',
      details: { action: 'read', resource: 'stream' },
    })
  })

  it('checks cancellation before a mutation writes anything', async () => {
    const { controller } = await setup()
    const abort = new AbortController()
    abort.abort()
    await expect(controller.createQueue(
      { expectedRevision: 0, draft: queueDraft() },
      abort.signal,
    )).rejects.toMatchObject({
      code: 'sessionOrchestrator/cancelled',
    })
    expect(controller.listQueues().items).toEqual([])
  })

  it('reports an unsupported Session link without the optional Web controller', async () => {
    const withoutWeb = await setup()
    await withoutWeb.store.createRun(run({
      activeSessionId: SessionId('session-1'),
      sessionLineage: [SessionId('session-1')],
      generation: 0,
    }))
    expect(withoutWeb.controller.getRun({ runId: 'run-1' }).run.activeSession).toEqual({
      sessionId: 'session-1',
      linkable: false,
      openState: 'unsupported',
    })
  })

  it('addresses every Session by identity: workspace, route and open state', async () => {
    const withWeb = await setup({
      sessionController: true,
      webServer: true,
      workspaceClaims: [{ workspaceId: 'workspace-1', path: '/work/one', sessionIds: ['session-1', 'session-2'] }],
      archivedSessions: ['session-2'],
    })
    await withWeb.store.createRun(run({
      activeSessionId: SessionId('session-1'),
      sessionLineage: [SessionId('session-1')],
      generation: 0,
    }))
    const projected = withWeb.controller.getRun({ runId: 'run-1' }).run
    expect(projected.activeSession).toEqual({
      sessionId: 'session-1',
      linkable: true,
      openState: 'ready',
      workspaceId: 'workspace-1',
      route: '/session/session-1',
    })
    // A settled attempt still has to be openable: `session` mirrors `activeSession`.
    expect(projected.session).toEqual(projected.activeSession)
    expect(projected.sessionLineage).toEqual([projected.activeSession])
  })

  it('marks an archived Session and keeps the route addressable', async () => {
    const { controller, store } = await setup({
      sessionController: true,
      webServer: true,
      workspaceClaims: [{ workspaceId: 'workspace-1', path: '/work/one', sessionIds: ['session-1'] }],
      archivedSessions: ['session-1'],
    })
    await store.createRun(run({
      activeSessionId: SessionId('session-1'),
      sessionLineage: [SessionId('session-1')],
      generation: 0,
    }))
    expect(controller.getRun({ runId: 'run-1' }).run.session).toMatchObject({
      sessionId: 'session-1',
      openState: 'archived',
      route: '/session/session-1',
    })
  })

  it('offers the same open target from the task and from the intervention that acted on it', async () => {
    const { controller, store } = await setup({
      sessionController: true,
      webServer: true,
      workspaceClaims: [{ workspaceId: 'workspace-1', path: '/work/one', sessionIds: ['session-1'] }],
    })
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask({ taskId: 'task-1', expectedRevision: 0, draft: taskDraft() }, signal())
    await store.createRun(run({
      activeSessionId: SessionId('session-1'),
      sessionLineage: [SessionId('session-1')],
      generation: 0,
    }))
    await store.recordIntervention({
      id: 'iv-run-1-g0-pause-context',
      runId: RunId('run-1'),
      taskId: TaskId('task-1'),
      generation: 0,
      kind: 'pause-context',
      phase: 'settled',
      reason: 'context reached the switch point',
      trigger: { contextRatio: 0.61 },
      childTaskIds: [],
      createdAt: 1,
      updatedAt: 2,
    } as never)
    const expected = {
      sessionId: 'session-1',
      linkable: true,
      openState: 'ready',
      workspaceId: 'workspace-1',
      route: '/session/session-1',
    }
    expect(controller.getQueue({ queueId: 'queue-1' }).tasks[0]?.session).toEqual(expected)
    expect(controller.listRuns().items[0]?.session).toEqual(expected)
    expect(controller.listInterventions().items[0]?.session).toEqual(expected)
  })

  it('projects who judged an intervention, who paid for it and every review row', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask({ taskId: 'task-1', expectedRevision: 0, draft: taskDraft() }, signal())
    await store.createRun(run())
    await store.recordIntervention({
      id: 'iv-run-1-g0-pause-context',
      runId: RunId('run-1'),
      taskId: TaskId('task-1'),
      generation: 0,
      kind: 'pause-context',
      phase: 'settled',
      reason: 'the model asked for a hand-over',
      warden: { mode: 'model', verdict: 'decompose', provider: 'reviewer', model: 'reviewer-small' },
      paidBy: { provider: 'worker', model: 'worker-large' },
      trigger: { contextRatio: 0.58 },
      childTaskIds: [],
      createdAt: 1,
      updatedAt: 2,
    })
    await store.recordWardenAudit({
      id: 'wa-run-1-g0-1',
      runId: RunId('run-1'),
      taskId: TaskId('task-1'),
      generation: 0,
      mode: 'model',
      verdict: 'decompose',
      reason: 'the model asked for a hand-over',
      provider: 'reviewer',
      model: 'reviewer-small',
      latencyMs: 900,
      inputTokens: 700,
      outputTokens: 20,
      createdAt: 1,
    })
    await store.recordWardenAudit({
      id: 'wa-run-1-g0-2',
      runId: RunId('run-1'),
      taskId: TaskId('task-1'),
      generation: 0,
      mode: 'rule-fallback',
      verdict: 'continue',
      reason: 'healthy',
      error: 'timeout',
      createdAt: 3,
    })
    expect(controller.listInterventions().items[0]).toMatchObject({
      warden: { mode: 'model', verdict: 'decompose', provider: 'reviewer', model: 'reviewer-small' },
      paidBy: { provider: 'worker', model: 'worker-large' },
    })
    const frame = await baseline(controller)
    expect(frame.wardenAudits.map(row => row.id)).toEqual(['wa-run-1-g0-2', 'wa-run-1-g0-1'])
    expect(frame.wardenAudits[1]).toMatchObject({
      mode: 'model',
      verdict: 'decompose',
      provider: 'reviewer',
      inputTokens: 700,
      outputTokens: 20,
    })
    expect(frame.wardenAudits[0]).toMatchObject({ mode: 'rule-fallback', error: 'timeout' })
  })

  it('serves /session/<id> as a redirect that carries the identity, not a title', async () => {
    const { routes } = await setup({ sessionController: true, webServer: true })
    expect(routes.map(route => route.path)).toEqual(['/session'])
    const found = callRoute(routes, '/session/session-1?from=board')
    expect(found.statusCode).toBe(302)
    expect(found.headers.location).toBe('/?dsh-session=session-1')
    expect(found.headers['cache-control']).toBe('no-store')
    expect(callRoute(routes, '/session/session%2D1').headers.location).toBe('/?dsh-session=session-1')
    expect(callRoute(routes, '/session/').statusCode).toBe(404)
    expect(callRoute(routes, '/session/a/b').statusCode).toBe(404)
    expect(callRoute(routes, '/session/session-1', 'POST').statusCode).toBe(405)
  })

  it('registers no Session route without the Web carrier', async () => {
    const { routes } = await setup({ sessionController: true })
    expect(routes).toEqual([])
  })
})

describe('sessionOrchestrator redaction', () => {
  const FORBIDDEN_KEYS = new Set([
    'body',
    'context',
    'cookie',
    'ctx',
    'handle',
    'headers',
    'hostinstanceid',
    'lease',
    'ownerid',
    'password',
    'requesthash',
    'secret',
    'submittedmessageid',
    'token',
    'apikey',
    'authorization',
    'credential',
  ])

  function scan(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) scan(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value)) {
      expect(FORBIDDEN_KEYS.has(key.toLowerCase())).toBe(false)
      scan(child)
    }
  }

  it('omits handles, contexts, leases, host identity and internal messages from every payload', async () => {
    const { controller, store } = await setup()
    await controller.createQueue({ expectedRevision: 0, draft: queueDraft() }, signal())
    await controller.upsertTask(
      { taskId: 'task-1', expectedRevision: 0, draft: taskDraft() },
      signal(),
    )
    await store.planOperation({
      id: OperationId('operation-run-1-0'),
      runId: RunId('run-1'),
      generation: 0,
      attempt: 1,
      kind: 'initial-prompt',
      phase: 'planned',
      requestHash: 'HASH-CANARY',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await store.createRun(run({
      state: 'needs-attention',
      operationId: OperationId('operation-run-1-0'),
      lease: { ownerId: 'LEASE-CANARY', expiresAt: 9_999 },
      submittedMessageId: 'MESSAGE-CANARY',
      lastError: { code: 'turn-error', message: 'ERROR-CANARY', retryable: false },
    }))
    const settings = store.getSettings()
    await store.updateSettings(settings.revision, {
      ...settings,
      hostInstanceId: 'HOST-CANARY',
      revision: settings.revision + 1,
      updatedAt: 2_000,
    })
    await store.recordHandoff(handoff())

    const payloads: unknown[] = [
      controller.listQueues(),
      controller.getQueue({ queueId: 'queue-1' }),
      controller.listRuns(),
      controller.getRun({ runId: 'run-1' }),
      controller.listHandoffs(),
      controller.getHandoff({ operationId: 'operation-1' }),
      controller.getSettings(),
      await baseline(controller),
    ]
    for (const payload of payloads) {
      scan(payload)
      const text = JSON.stringify(payload)
      expect(text).not.toContain('LEASE-CANARY')
      expect(text).not.toContain('MESSAGE-CANARY')
      expect(text).not.toContain('ERROR-CANARY')
      expect(text).not.toContain('HASH-CANARY')
      expect(text).not.toContain('HOST-CANARY')
    }
    expect(controller.getRun({ runId: 'run-1' }).run.lastError).toEqual({
      code: 'turn-error',
      retryable: false,
    })
    expect(controller.getSettings().settings).not.toHaveProperty('hostInstanceId')
    expect(controller.getRun({ runId: 'run-1' }).run).not.toHaveProperty('lease')
  })
})
