﻿/** Live snapshot, draft separation, retained failures, and revision-bound writes. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestratorClient, type SessionOpenSurface } from '../../src/client/service.ts'
import type { QueueDto } from '../../src/client/contract.ts'
import { FakeOrchestratorRemote } from './fake-remote.client.ts'
import {
  frame, ok, queue, queueDetail, revisionConflict, run, sessionLink, settings, task, taskSummary,
} from './fixtures.client.ts'

const NOW = 10_000

function makeClient(remote: FakeOrchestratorRemote): OrchestratorClient {
  return new OrchestratorClient(remote, { now: () => NOW, retryDelayMs: 5 })
}

async function settle(service: OrchestratorClient, revision: number): Promise<void> {
  await vi.waitFor(() => { expect(service.live.getSnapshot().revision).toBe(revision) })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('model catalog', () => {
  it('reads the native host catalog once and keeps an absent or failed catalog explicit', async () => {
    const remote = new FakeOrchestratorRemote()
    const choice = {
      provider: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-chat',
      modelName: 'DeepSeek Chat',
      reasoningEfforts: [],
    }
    const load = vi.fn(async () => [choice])
    const service = new OrchestratorClient(remote, {
      now: () => NOW,
      retryDelayMs: 5,
      models: () => ({ load }),
    })
    cleanups.push(() => service.dispose())
    await service.loadModelCatalog()
    expect(service.live.getSnapshot().models).toEqual({ phase: 'ready', choices: [choice] })
    await service.loadModelCatalog()
    expect(load).toHaveBeenCalledTimes(1)

    const absent = new OrchestratorClient(new FakeOrchestratorRemote(), {
      now: () => NOW,
      retryDelayMs: 5,
      models: () => undefined,
    })
    cleanups.push(() => absent.dispose())
    await absent.loadModelCatalog()
    expect(absent.live.getSnapshot().models).toMatchObject({
      phase: 'error',
      error: 'this host exposes no model catalog service',
    })

    const failing = new OrchestratorClient(new FakeOrchestratorRemote(), {
      now: () => NOW,
      retryDelayMs: 5,
      models: () => ({ load: async () => { throw new Error('provider route refused') } }),
    })
    cleanups.push(() => failing.dispose())
    await failing.loadModelCatalog()
    expect(failing.live.getSnapshot().models).toMatchObject({
      phase: 'error',
      error: 'provider route refused',
    })
  })
})

describe('live snapshot', () => {
  it('accepts the newest generation and ignores a stale frame', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 2, queues: [queue({ id: 'q2' })] }))
    await settle(service, 2)
    expect(service.live.getSnapshot().phase).toBe('ready')
    remote.stream.push(frame({ revision: 1, queues: [queue({ id: 'q1' })] }))
    await Promise.resolve()
    expect(service.live.getSnapshot().revision).toBe(2)
    expect(service.live.getSnapshot().queues.map(item => item.id)).toEqual(['q2'])
  })

  it('keeps the last snapshot and retains a stream failure', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [queue({ id: 'kept' })] }))
    await settle(service, 1)
    remote.stream.fail(new Error('offline'))
    await vi.waitFor(() => {
      expect(service.live.getSnapshot().phase).toBe('error')
    })
    expect(service.live.getSnapshot().queues.map(item => item.id)).toEqual(['kept'])
    expect(service.drafts.getSnapshot().errors[0]?.message).toContain('offline')
  })
})

describe('drafts and revision CAS', () => {
  it('keeps a dirty task draft across newer live snapshots and saves the loaded revision', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, tasks: [taskSummary({ revision: 1, title: 'server one' })] }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail({ tasks: [task({ revision: 1, title: 'server one' })] }))
    await service.selectQueue('q1')
    await service.loadTask('t1')
    expect(service.drafts.getSnapshot().task?.baseRevision).toBe(1)
    service.editTask({ title: 'local edit' })
    expect(service.drafts.getSnapshot().task?.dirty).toBe(true)

    remote.stream.push(frame({ revision: 2, tasks: [taskSummary({ revision: 2, title: 'server two' })] }))
    await settle(service, 2)
    expect(service.live.getSnapshot().tasks[0]?.title).toBe('server two')
    expect(service.drafts.getSnapshot().task?.draft.title).toBe('local edit')
    expect(service.drafts.getSnapshot().task?.dirty).toBe(true)

    remote.upsertTaskResult = ok({ task: task({ revision: 2, title: 'local edit' }) })
    await service.saveTask()
    expect(remote.upsertTask).toHaveBeenCalledTimes(1)
    expect(remote.upsertTask.mock.calls[0]?.[0]).toMatchObject({
      taskId: 't1',
      expectedRevision: 1,
      draft: { title: 'local edit' },
    })
    expect(service.drafts.getSnapshot().task).toMatchObject({
      baseRevision: 2,
      dirty: false,
      saving: false,
    })
    expect(service.live.getSnapshot().tasks[0]?.title).toBe('local edit')
  })

  it('retains a revision conflict and never relabels the draft as saved', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1 }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail())
    await service.selectQueue('q1')
    await service.loadTask('t1')
    service.editTask({ title: 'kept local' })
    remote.upsertTaskResult = revisionConflict({ resource: 'task', id: 't1', expectedRevision: 1 })
    await service.saveTask()
    expect(remote.upsertTask).toHaveBeenCalledTimes(1)
    expect(service.drafts.getSnapshot().task).toMatchObject({
      baseRevision: 1,
      dirty: true,
      saving: false,
    })
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('sessionOrchestrator/revision-conflict')
    expect(service.drafts.getSnapshot().errors[0]?.detail).toContain('expectedRevision')
    expect(service.drafts.getSnapshot().task?.draft.title).toBe('kept local')

    remote.stream.push(frame({ revision: 2 }))
    await settle(service, 2)
    expect(service.drafts.getSnapshot().errors).toHaveLength(1)
    expect(service.drafts.getSnapshot().task?.draft.title).toBe('kept local')
  })

  it('blocks a queue switch while a task draft is dirty', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1 }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail())
    await service.selectQueue('q1')
    await service.loadTask('t1')
    service.editTask({ title: 'draft' })
    const before = remote.getQueue.mock.calls.length
    await service.selectQueue('q1')
    expect(remote.getQueue).toHaveBeenCalledTimes(before)
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('ui/unsaved-task')
  })
})

describe('pipeline template', () => {
  it('creates a four-stage draft, selects it, and never starts it', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [], tasks: [] }))
    await settle(service, 1)
    const stages = ['architecture', 'breakdown', 'implement', 'test'] as const
    const tasks = stages.map((stage, index) => task({
      id: `p1-${stage}`,
      queueId: 'p1',
      title: stage,
      prompt: `Do ${stage} for the requirement`,
      stage,
      dependsOn: index === 0 ? [] : [`p1-${stages[index - 1]}`],
    }))
    remote.createPipelineTemplateResult = ok({
      queue: queue({
        id: 'p1',
        title: 'Pipeline one',
        taskOrder: tasks.map(item => item.id),
        paused: true,
        state: 'idle',
        workspaceId: 'w1',
        cwd: '/workspace',
        brief: 'Ship the requirement',
      }),
      tasks,
    })

    const created = await service.createPipelineTemplate({
      queueId: 'p1',
      brief: 'Ship the requirement',
      workspaceId: 'w1',
      cwd: '/workspace',
    })

    expect(created).toBe(true)
    expect(remote.createPipelineTemplate).toHaveBeenCalledTimes(1)
    expect(remote.createPipelineTemplate.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 0,
      queueId: 'p1',
      brief: 'Ship the requirement',
      workspaceId: 'w1',
      cwd: '/workspace',
    })
    expect(service.live.getSnapshot().queues.map(item => item.id)).toEqual(['p1'])
    expect(service.live.getSnapshot().tasks.map(item => item.id)).toEqual(tasks.map(item => item.id))
    expect(service.live.getSnapshot().tasks.map(item => item.stage)).toEqual([...stages])
    expect(service.drafts.getSnapshot()).toMatchObject({
      selectedQueueId: 'p1',
      queueTasks: tasks,
    })
    expect(service.drafts.getSnapshot().queue?.draft).toMatchObject({
      id: 'p1',
      title: 'Pipeline one',
      brief: 'Ship the requirement',
      workspaceId: 'w1',
      cwd: '/workspace',
    })
    expect(remote.startQueue).not.toHaveBeenCalled()
    expect(remote.pause).not.toHaveBeenCalled()
  })

  it('requires the workspace and requirement before any host call', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    await service.createPipelineTemplate({ queueId: 'p1', brief: 'do it', workspaceId: '' })
    await service.createPipelineTemplate({ queueId: 'p1', brief: '   ', workspaceId: 'w1' })
    expect(remote.createPipelineTemplate).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors.map(error => error.code)).toEqual([
      'ui/template-brief-required',
      'ui/workspace-required',
    ])
  })

  it('carries a template stage back when its prompt is edited', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, tasks: [taskSummary({ id: 't1', stage: 'implement' })] }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail({ tasks: [task({ id: 't1', stage: 'implement' })] }))
    await service.loadTask('t1')
    expect(service.drafts.getSnapshot().task?.draft.stage).toBe('implement')
    service.editTask({ prompt: 'Run the next block and record the evidence.' })
    remote.upsertTaskResult = ok({
      task: task({ id: 't1', stage: 'implement', prompt: 'Run the next block and record the evidence.', revision: 2 }),
    })
    await service.saveTask()
    expect(remote.upsertTask.mock.calls[0]?.[0]).toMatchObject({
      taskId: 't1',
      expectedRevision: 1,
      draft: { stage: 'implement', prompt: 'Run the next block and record the evidence.' },
    })
  })
})

describe('manual pipeline creation', () => {
  it('creates three ordered tasks under generated identities before starting once', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [], tasks: [] }))
    await settle(service, 1)

    const prompts = [
      'Design the acceptance pipeline',
      'Implement the acceptance pipeline',
      'Test the acceptance pipeline',
    ]
    let createdId = ''
    let currentQueue: QueueDto | undefined
    remote.createQueueHandler = (request) => {
      createdId = request.draft.id
      currentQueue = {
        id: createdId,
        title: request.draft.title,
        taskOrder: [],
        paused: true,
        state: 'idle',
        workspaceId: 'w1',
        cwd: '/workspace',
        brief: request.draft.brief,
        revision: 1,
      }
      return ok({ queue: currentQueue })
    }
    remote.upsertTaskHandler = (request) => {
      if (currentQueue === undefined) throw new Error('queue not created')
      const taskOrder = [...currentQueue.taskOrder, request.taskId]
      currentQueue = {
        ...currentQueue,
        taskOrder,
        revision: currentQueue.revision + 1,
      }
      return ok({
        task: { ...request.draft, id: request.taskId, revision: 1 },
        queue: currentQueue,
      })
    }
    remote.startQueueHandler = request => ok({
      queue: {
        ...currentQueue,
        id: request.queueId,
        paused: false,
        state: 'running',
        revision: (currentQueue?.revision ?? 0) + 1,
      } as QueueDto,
    })

    const created = await service.createPipeline({
      prompts,
      workspaceId: 'w1',
      cwd: '/workspace',
    })

    expect(created).toBe(true)
    expect(remote.createQueue).toHaveBeenCalledTimes(1)
    const queueRequest = remote.createQueue.mock.calls[0]?.[0]
    expect(queueRequest?.draft.id).toMatch(/^q-/u)
    expect(queueRequest?.draft.title).toBe(prompts[0])
    expect(queueRequest?.draft.paused).toBe(true)
    expect(queueRequest?.draft.taskOrder).toEqual([])
    expect(queueRequest?.draft).not.toHaveProperty('maxConcurrentRuns')
    expect(queueRequest?.draft).not.toHaveProperty('state')

    expect(remote.upsertTask).toHaveBeenCalledTimes(3)
    prompts.forEach((prompt, index) => {
      const taskRequest = remote.upsertTask.mock.calls[index]?.[0]
      expect(taskRequest?.taskId).toBe(`${createdId}-t${index + 1}`)
      expect(taskRequest?.position).toBe(index)
      expect(taskRequest?.queueRevision).toBe(index + 1)
      expect(taskRequest?.draft).toMatchObject({
        title: prompt,
        prompt,
        workspaceId: 'w1',
        cwd: '/workspace',
        priority: 0,
        enabled: true,
      })
      expect(taskRequest?.draft).not.toHaveProperty('concurrencyGroup')
      expect(taskRequest?.draft).not.toHaveProperty('stage')
    })

    expect(remote.startQueue).toHaveBeenCalledTimes(1)
    expect(remote.startQueue).toHaveBeenCalledWith({ queueId: createdId, expectedRevision: 4 })
    expect(remote.pause).not.toHaveBeenCalled()
    expect(service.live.getSnapshot().queues[0]).toMatchObject({ id: createdId, state: 'running' })
    expect(service.drafts.getSnapshot().selectedQueueId).toBe(createdId)
    expect(service.drafts.getSnapshot().queueTasks.map(item => item.prompt)).toEqual(prompts)
    // Starting is a mutation this page performed: the clean draft must follow the
    // revision the start wrote (the fake returns start-time revision + 1), or the
    // next edit saves under a stale one and the page reports a conflict the user
    // cannot act on.
    expect(service.drafts.getSnapshot().queue?.baseRevision).toBe(5)
  })

  it('requires a folder, a working directory and every prompt before any host call', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    await service.createPipeline({ prompts: ['   ', 'two', 'three'], workspaceId: 'w1', cwd: '/workspace' })
    await service.createPipeline({ prompts: ['one', 'two', 'three'], workspaceId: '  ', cwd: '/workspace' })
    await service.createPipeline({ prompts: ['one', 'two', 'three'], workspaceId: 'w1', cwd: '  ' })
    expect(remote.createQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors.map(error => error.code)).toEqual([
      'ui/workspace-path-required',
      'ui/workspace-required',
      'ui/pipeline-prompt-required',
    ])
  })

  it('deletes the empty queue when the first task cannot be written', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [], tasks: [] }))
    await settle(service, 1)
    let createdId = ''
    remote.createQueueHandler = (request) => {
      createdId = request.draft.id
      return ok({
        queue: {
          id: createdId,
          title: request.draft.title,
          taskOrder: [],
          paused: true,
          state: 'idle',
          revision: 1,
        },
      })
    }
    remote.upsertTaskHandler = () => revisionConflict({ resource: 'task' })
    remote.deleteDraftQueueHandler = () => ok({ queueId: createdId, deleted: true })

    const created = await service.createPipeline({
      prompts: ['Do the thing', 'Second step', 'Third step'],
      workspaceId: 'w1',
      cwd: '/workspace',
    })

    expect(created).toBe(false)
    expect(remote.deleteDraftQueue).toHaveBeenCalledWith({
      queueId: createdId,
      expectedRevision: 1,
    })
    expect(remote.startQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('sessionOrchestrator/revision-conflict')
  })
})

describe('run controls', () => {
  it('retries a skipped attempt under its revision and appends the new attempt', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    const skipped = run({ skipped: true, state: 'needs-attention', revision: 3 })
    remote.stream.push(frame({ revision: 1, runs: [skipped] }))
    await settle(service, 1)
    await service.retryRun(skipped.id)
    expect(remote.retry).toHaveBeenCalledWith({ runId: skipped.id, expectedRevision: 3 })
    expect(service.live.getSnapshot().runs.map(item => item.id)).toEqual(['run-t1-1', 'run-t1-2'])
    expect(service.drafts.getSnapshot().errors).toHaveLength(0)
  })

  it('requires actor and reason before a skip and passes the live revision', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    const attention = run({ state: 'needs-attention', revision: 7 })
    remote.stream.push(frame({ revision: 1, runs: [attention] }))
    await settle(service, 1)
    await service.skipRun(attention.id, '', 'reason')
    expect(remote.skipTask).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('ui/audit-required')
    await service.skipRun(attention.id, 'alice', 'not needed')
    expect(remote.skipTask).toHaveBeenCalledWith({
      runId: attention.id,
      expectedRevision: 7,
      actor: 'alice',
      reason: 'not needed',
    })
    expect(service.live.getSnapshot().runs[0]?.skipped).toBe(true)
  })

  it('cancels under the live revision and merges the returned run', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    const running = run({ state: 'running', revision: 9 })
    remote.stream.push(frame({ revision: 1, runs: [running] }))
    await settle(service, 1)
    await service.cancelRun(running.id)
    expect(remote.cancel).toHaveBeenCalledWith({ runId: running.id, expectedRevision: 9 })
    expect(service.live.getSnapshot().runs[0]?.state).toBe('cancelled')
  })
})

describe('settings and queue writes', () => {
  it('saves settings from the draft revision, then pauses from the newer live revision', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, settings: settings({ revision: 4 }) }))
    await settle(service, 1)
    service.loadSettingsDraft()
    service.editSettings({ maxConcurrentRuns: 6 })
    remote.stream.push(frame({ revision: 2, settings: settings({ revision: 5 }) }))
    await settle(service, 2)
    expect(service.drafts.getSnapshot().settings?.baseRevision).toBe(4)
    remote.updateSettingsResult = ok({ settings: settings({ revision: 5, maxConcurrentRuns: 6 }) })
    await service.saveSettings()
    expect(remote.updateSettings).toHaveBeenCalledWith({
      expectedRevision: 4,
      draft: { paused: false, maxConcurrentRuns: 6, providerQuotas: { deepseek: 3 } },
    })
    remote.pauseResult = ok({ settings: settings({ revision: 5, paused: true }) })
    await service.pause()
    expect(remote.pause).toHaveBeenCalledWith({ expectedRevision: 5 })
    expect(service.live.getSnapshot().settings?.paused).toBe(true)
  })

  it('updates an existing queue at its revision and creates a new one at zero', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [queue({ revision: 1 })] }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail())
    await service.selectQueue('q1')
    service.editQueue({ title: 'renamed' })
    remote.updateQueueResult = ok({ queue: queue({ revision: 2, title: 'renamed' }) })
    await service.saveQueue()
    expect(remote.updateQueue).toHaveBeenCalledWith({
      queueId: 'q1',
      expectedRevision: 1,
      draft: { id: 'q1', title: 'renamed', taskOrder: ['t1', 't2'], paused: false },
    })

    service.newQueue()
    service.editQueue({ id: 'q9', title: 'fresh' })
    remote.createQueueResult = ok({ queue: queue({ id: 'q9', revision: 0, title: 'fresh', taskOrder: [] }) })
    await service.saveQueue()
    expect(remote.createQueue).toHaveBeenCalledWith({
      expectedRevision: 0,
      draft: { id: 'q9', title: 'fresh', taskOrder: [], paused: false, model: { kind: 'inherit' } },
    })
  })

  it('refuses to overwrite order when the live queue disappeared', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [queue({ revision: 1 })] }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail())
    await service.selectQueue('q1')
    service.editQueue({ title: 'renamed' })
    remote.stream.push(frame({ revision: 2, queues: [] }))
    await settle(service, 2)
    await service.saveQueue()
    expect(remote.updateQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('ui/queue-missing')
    expect(service.drafts.getSnapshot().queue?.draft.title).toBe('renamed')
  })

  it('drops a task into a new position, marks a parallel group, copies and deletes', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue({ id: 'q1', taskOrder: ['t1', 't2'], revision: 1 })],
      tasks: [
        taskSummary({ revision: 1 }),
        taskSummary({ id: 't2', title: 'Task two', revision: 1, parallelWithPrevious: true }),
      ],
    }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail({ tasks: [task(), task({ id: 't2', title: 'Task two' })] }))
    await service.selectQueue('q1')
    await service.moveTaskTo('t1', 1)
    expect(remote.reorderTasks).toHaveBeenLastCalledWith({
      queueId: 'q1',
      expectedRevision: 1,
      taskOrder: ['t2', 't1'],
      parallelWithPrevious: ['t2'],
    })
    await service.setTaskParallelWithPrevious('t1', true)
    expect(remote.reorderTasks).toHaveBeenLastCalledWith({
      queueId: 'q1',
      expectedRevision: 2,
      taskOrder: ['t2', 't1'],
      parallelWithPrevious: ['t2', 't1'],
    })
    await service.duplicateTask('t1')
    expect(remote.duplicateTask).toHaveBeenCalledWith({
      queueId: 'q1',
      taskId: 't1',
      expectedRevision: 2,
    })
    expect(service.live.getSnapshot().tasks.map(task => task.id)).toContain('t1-copy')
    await service.deleteTask('t1')
    expect(remote.deleteTask).toHaveBeenCalledWith({
      queueId: 'q1',
      taskId: 't1',
      expectedRevision: 2,
    })
    expect(service.live.getSnapshot().tasks.map(task => task.id)).not.toContain('t1')
  })

  it('refuses to delete a task that already started', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue({ id: 'q1', taskOrder: ['t1'], revision: 1 })],
      tasks: [taskSummary({ session: sessionLink() })],
    }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail({ tasks: [task({ session: sessionLink() })] }))
    await service.selectQueue('q1')
    await service.deleteTask('t1')
    expect(remote.deleteTask).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]?.code).toBe('ui/task-has-run')
  })

  it('reorders through the queue revision and toggles a task under its summary revision', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      tasks: [taskSummary({ revision: 1 }), taskSummary({ id: 't2', title: 'Task two', revision: 1 })],
    }))
    await settle(service, 1)
    remote.getQueueResult = ok(queueDetail({ tasks: [task(), task({ id: 't2', title: 'Task two' })] }))
    await service.selectQueue('q1')
    await service.moveTask('t1', 'down')
    expect(remote.reorderTasks).toHaveBeenCalledWith({
      queueId: 'q1',
      expectedRevision: 1,
      taskOrder: ['t2', 't1'],
      parallelWithPrevious: [],
    })
    await service.setTaskEnabled('t1', false)
    expect(remote.setTaskEnabled).toHaveBeenCalledWith({
      taskId: 't1',
      expectedRevision: 1,
      enabled: false,
    })
  })

  it('deletes a queue with tasks and archives its conversations on request', async () => {
    const remote = new FakeOrchestratorRemote()
    const archived: string[] = []
    const surface: SessionOpenSurface = {
      open: vi.fn(),
      knows: () => true,
      archive: async (sessionId) => { archived.push(sessionId) },
    }
    const service = new OrchestratorClient(remote, {
      now: () => NOW, retryDelayMs: 5, sessions: () => surface,
    })
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue()],
      tasks: [taskSummary({ session: sessionLink({ sessionId: 'session-1' }) })],
    }))
    await settle(service, 1)
    await service.selectQueue('q1')

    await service.inject().deleteQueue({ archiveSessions: true })

    expect(archived).toEqual(['session-1'])
    expect(remote.deleteDraftQueue).toHaveBeenCalledWith({ queueId: 'q1', expectedRevision: 1 })
    expect(service.live.getSnapshot().queues).toEqual([])
  })

  it('keeps the queue when archiving a conversation fails', async () => {
    const remote = new FakeOrchestratorRemote()
    const surface: SessionOpenSurface = {
      open: vi.fn(),
      knows: () => true,
      archive: async () => { throw new Error('archive refused') },
    }
    const service = new OrchestratorClient(remote, {
      now: () => NOW, retryDelayMs: 5, sessions: () => surface,
    })
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue()],
      tasks: [taskSummary({ session: sessionLink({ sessionId: 'session-1' }) })],
    }))
    await settle(service, 1)
    await service.selectQueue('q1')

    await service.inject().deleteQueue({ archiveSessions: true })

    expect(remote.deleteDraftQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({
      code: 'ui/archive-failed',
      detail: 'session-1',
    })
  })

  it('removes a queue the page has not selected without disturbing the open draft', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue({ id: 'q1' }), queue({ id: 'q2', title: 'Second' })],
      tasks: [taskSummary({ id: 't1' }), taskSummary({ id: 't2', queueId: 'q2', title: 'Two' })],
    }))
    await settle(service, 1)
    await service.selectQueue('q1')

    await service.inject().deleteQueue({ queueId: 'q2' })

    expect(remote.deleteDraftQueue).toHaveBeenCalledWith({ queueId: 'q2', expectedRevision: 1 })
    expect(service.drafts.getSnapshot().selectedQueueId).toBe('q1')
    expect(service.drafts.getSnapshot().queue).not.toBeNull()
    expect(service.live.getSnapshot().queues.map(item => item.id)).toEqual(['q1'])
    expect(service.live.getSnapshot().tasks.map(item => item.id)).toEqual(['t1'])
  })

  it('refuses to delete a running queue so its live attempts keep an owner', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [queue({ state: 'running' })] }))
    await settle(service, 1)

    await service.inject().deleteQueue({ queueId: 'q1' })

    expect(remote.deleteDraftQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/queue-running' })
  })

  it('refuses to delete a queue while one of its attempts is still live', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue()],
      tasks: [taskSummary()],
      runs: [run({ state: 'running' })],
    }))
    await settle(service, 1)

    await service.inject().deleteQueue({ queueId: 'q1' })

    expect(remote.deleteDraftQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/queue-running' })
  })

  it('renames one pipeline under the revision the snapshot reports', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({
      revision: 1,
      queues: [queue({ title: 'Old name', revision: 3, taskOrder: ['t1'] })],
      tasks: [taskSummary({ id: 't1' })],
    }))
    await settle(service, 1)

    await service.inject().renameQueue('q1', '  New name  ')

    expect(remote.updateQueue).toHaveBeenCalledWith({
      queueId: 'q1',
      expectedRevision: 3,
      draft: expect.objectContaining({ id: 'q1', title: 'New name', taskOrder: ['t1'] }),
    })
  })

  it('keeps a blank rename out of the Host and reports why', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    service.start()
    remote.stream.push(frame({ revision: 1, queues: [queue()] }))
    await settle(service, 1)

    await service.inject().renameQueue('q1', '   ')

    expect(remote.updateQueue).not.toHaveBeenCalled()
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/queue-title-required' })
  })

  it('stores a custom composer label instead of the prompt-derived one', async () => {
    const remote = new FakeOrchestratorRemote()
    const service = makeClient(remote)
    cleanups.push(() => service.dispose())
    let currentQueue: QueueDto | undefined
    remote.createQueueHandler = (request) => {
      currentQueue = { ...request.draft, revision: 0 } as QueueDto
      return ok({ queue: currentQueue })
    }
    remote.upsertTaskHandler = (request) => {
      currentQueue = { ...currentQueue, revision: (currentQueue?.revision ?? 0) + 1 } as QueueDto
      return ok({ task: { ...request.draft, id: request.taskId, revision: 1 }, queue: currentQueue })
    }

    await service.inject().createPipeline({
      tasks: [{ prompt: 'run the tests', title: '验收阶段' }],
      workspaceId: 'w1',
      cwd: '/workspace',
    })

    expect(remote.upsertTask.mock.calls[0]?.[0].draft.title).toBe('验收阶段')
  })
})

/** One fake Session surface that records what the page tried to open. */
function fakeSurface(options: {
  readonly known?: boolean
  readonly archived?: boolean
  readonly fail?: Error
} = {}): { readonly opened: string[]; readonly surface: SessionOpenSurface } {
  const opened: string[] = []
  const surface: SessionOpenSurface = {
    open: (sessionId) => {
      if (options.fail !== undefined) throw options.fail
      opened.push(sessionId)
    },
    knows: () => options.known,
    ...(options.archived === undefined ? {} : { archived: () => options.archived === true }),
  }
  return { opened, surface }
}

function makeLinkedClient(
  remote: FakeOrchestratorRemote,
  surface: SessionOpenSurface,
): OrchestratorClient {
  return new OrchestratorClient(remote, { now: () => NOW, retryDelayMs: 5, sessions: () => surface })
}

describe('conversation links', () => {
  it('opens the exact Session identity the host projected', async () => {
    const remote = new FakeOrchestratorRemote()
    const { opened, surface } = fakeSurface({ known: true })
    const service = makeLinkedClient(remote, surface)
    cleanups.push(() => service.dispose())

    await service.openSession(sessionLink({ sessionId: 'session-42', route: '/session/session-42' }))

    expect(opened).toEqual(['session-42'])
    expect(service.drafts.getSnapshot().errors).toEqual([])
  })

  it('refuses an archived and an unsupported link with a stable reason', async () => {
    const remote = new FakeOrchestratorRemote()
    const { opened, surface } = fakeSurface({ known: true })
    const service = makeLinkedClient(remote, surface)
    cleanups.push(() => service.dispose())

    await service.openSession(sessionLink({ openState: 'archived' }))
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({
      operation: 'openSession',
      code: 'ui/session-archived',
      detail: 'session-1',
    })
    await service.openSession(sessionLink({ linkable: false, openState: 'unsupported' }))
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/session-unsupported' })
    expect(opened).toEqual([])
  })

  it('refuses a Session the browser catalog no longer lists', async () => {
    const remote = new FakeOrchestratorRemote()
    const { opened, surface } = fakeSurface({ known: false })
    const service = makeLinkedClient(remote, surface)
    cleanups.push(() => service.dispose())

    await service.openSession(sessionLink())
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({
      code: 'ui/session-missing',
      detail: 'session-1',
    })
    expect(opened).toEqual([])
  })

  it('opens a route by identity and reports what the catalog and archive say', async () => {
    const remote = new FakeOrchestratorRemote()
    const ready = fakeSurface({ known: true })
    const service = makeLinkedClient(remote, ready.surface)
    cleanups.push(() => service.dispose())
    await service.openSessionById('session-9')
    expect(ready.opened).toEqual(['session-9'])

    const archived = fakeSurface({ known: true, archived: true })
    const archivedClient = makeLinkedClient(remote, archived.surface)
    cleanups.push(() => archivedClient.dispose())
    await archivedClient.openSessionById('session-8')
    expect(archived.opened).toEqual([])
    expect(archivedClient.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/session-archived' })
  })

  it('retains the thrown reason when the surface itself fails', async () => {
    const remote = new FakeOrchestratorRemote()
    const { surface } = fakeSurface({ known: true, fail: new Error('no main view') })
    const service = makeLinkedClient(remote, surface)
    cleanups.push(() => service.dispose())

    await service.openSession(sessionLink())
    expect(service.drafts.getSnapshot().errors[0]).toMatchObject({ code: 'ui/error' })
    expect(service.drafts.getSnapshot().errors[0]?.message).toContain('no main view')
  })
})
