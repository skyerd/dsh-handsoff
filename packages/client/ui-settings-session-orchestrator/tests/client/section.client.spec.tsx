// @vitest-environment jsdom
/** Settings page presentation: queue composer, running tasks, errors and tab isolation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { en, zh } from '../../src/client/locales.ts'
import { PIPELINE_DRAFT_STORAGE_KEY } from '../../src/client/PipelineCreateDialog.tsx'
import { queue, run, sessionLink, task, taskSummary } from './fixtures.client.ts'
import { draftState, errorRecord, liveState, renderSection } from './render.client.tsx'

afterEach(cleanup)

/**
 * Pick one row of a bounded select the way a person does: open the trigger,
 * then click the row. Native `<select>` change events no longer apply.
 */
function chooseOption(scope: HTMLElement, label: string, option: RegExp): void {
  fireEvent.click(within(scope).getByRole('button', { name: label }))
  fireEvent.click(within(scope).getByRole('option', { name: option }))
}

const workspace = { workspaceId: 'w1', title: 'Workspace one', path: '/work/one' }

const taskDraft = {
  mode: 'edit' as const,
  draft: {
    ...task(),
    id: 't1',
    queueId: 'q1',
    title: 'Local title',
  },
  baseRevision: 1,
  dirty: true,
  saving: false,
}

describe('section shell', () => {
  it('uses the HandsOff name and the two primary view names', () => {
    const { view } = renderSection({
      live: liveState({ queues: [queue()], tasks: [taskSummary()] }),
      drafts: draftState({ selectedQueueId: 'q1' }),
    })
    expect(view.getByText(en.title)).toBeTruthy()
    expect(view.getByRole('tab', { name: en.tabQueue })).toBeTruthy()
    expect(view.getByRole('tab', { name: en.tabBoard })).toBeTruthy()
    expect(view.queryByRole('tab', { name: en.tabGraph })).toBeNull()
    expect(en.tabQueue).toBe('Create task queue')
    expect(en.tabBoard).toBe('Running tasks')
  })

  it('keeps a failure plain-language and survives a broken tab', () => {
    const { view } = renderSection({ drafts: draftState({ errors: [errorRecord()] }) })
    expect(view.getByText(en.explanationRevisionConflict)).toBeTruthy()
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    expect(view.getByText(en.explanationRevisionConflict)).toBeTruthy()
  })
})

describe('queue composer', () => {
  it('creates tasks from message boxes without asking for ids or task titles', async () => {
    window.localStorage.clear()
    const { view, actions } = renderSection({ workspaces: [workspace] })
    const form = view.getByRole('region', { name: en.pipelineCreateTitle })
    expect(within(form).queryByLabelText(en.queueId)).toBeNull()
    expect(within(form).getAllByLabelText(en.pipelineCreatePrompt)).toHaveLength(1)

    fireEvent.change(within(form).getAllByLabelText(en.pipelineCreatePrompt)[0]!, {
      target: { value: 'Design the queue' },
    })
    fireEvent.click(within(form).getByRole('button', { name: en.composerSend }))
    expect(within(form).getAllByLabelText(en.pipelineCreatePrompt)).toHaveLength(2)
    fireEvent.change(within(form).getAllByLabelText(en.pipelineCreatePrompt)[1]!, {
      target: { value: 'Implement the queue' },
    })

    const start = within(form).getByRole('button', { name: en.composerStart })
    expect(start.hasAttribute('disabled')).toBe(false)
    fireEvent.click(start)
    await waitFor(() => { expect(actions.createPipeline).toHaveBeenCalledTimes(1) })
    expect(actions.createPipeline).toHaveBeenCalledWith({
      tasks: [
        { prompt: 'Design the queue' },
        { prompt: 'Implement the queue' },
      ],
      workspaceId: 'w1',
      cwd: '/work/one',
    })
  })

  it('names one composer row from its own menu and keeps that label in the task', async () => {
    window.localStorage.clear()
    const { view, actions } = renderSection({ workspaces: [workspace] })
    const form = view.getByRole('region', { name: en.pipelineCreateTitle })
    fireEvent.change(within(form).getByLabelText(en.pipelineCreatePrompt), { target: { value: 'Design the queue' } })

    fireEvent.click(within(form).getByRole('button', { name: `${en.taskMenu} Task 1` }))
    fireEvent.click(within(form).getByRole('menuitem', { name: en.renameTask }))
    const dialog = view.getByRole('dialog', { name: en.renameTask })
    fireEvent.change(within(dialog).getByLabelText(en.taskNameField), { target: { value: '架构阶段' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
    expect(within(form).getByText('架构阶段')).toBeTruthy()

    fireEvent.click(within(form).getByRole('button', { name: en.composerStart }))
    await waitFor(() => { expect(actions.createPipeline).toHaveBeenCalledTimes(1) })
    expect(actions.createPipeline).toHaveBeenCalledWith({
      tasks: [{ prompt: 'Design the queue', title: '架构阶段' }],
      workspaceId: 'w1',
      cwd: '/work/one',
    })
  })

  it('binds a model and a skill preset to an individual task', async () => {
    window.localStorage.clear()
    const { view, actions } = renderSection({
      workspaces: [workspace],
      live: liveState({
        models: {
          phase: 'ready',
          choices: [{
            provider: 'deepseek',
            providerName: 'DeepSeek',
            model: 'deepseek-chat',
            modelName: 'DeepSeek Chat',
            reasoningEfforts: [],
          }],
        },
        presets: {
          phase: 'ready',
          choices: [{ id: 'coding', name: 'Coding', isDefault: true }],
        },
      }),
    })
    const form = view.getByRole('region', { name: en.pipelineCreateTitle })
    fireEvent.change(within(form).getByLabelText(en.pipelineCreatePrompt), { target: { value: 'Write it' } })
    fireEvent.click(within(form).getByRole('button', { name: new RegExp(`^${en.modelName}`, 'u') }))
    fireEvent.click(within(form).getByRole('option', { name: /DeepSeek Chat/u }))
    chooseOption(form, en.composerSkills, /^Coding/u)
    fireEvent.click(within(form).getByRole('button', { name: en.composerStart }))
    await waitFor(() => {
      expect(actions.createPipeline).toHaveBeenCalledWith({
        tasks: [{
          prompt: 'Write it',
          model: { kind: 'fixed', provider: 'deepseek', model: 'deepseek-chat' },
          presetId: 'coding',
        }],
        workspaceId: 'w1',
        cwd: '/work/one',
      })
    })
  })

  it('saves a local draft and restores it after remounting', () => {
    window.localStorage.clear()
    const first = renderSection({ workspaces: [workspace] })
    const form = first.view.getByRole('region', { name: en.pipelineCreateTitle })
    fireEvent.change(within(form).getByLabelText(en.pipelineCreatePrompt), {
      target: { value: 'Keep this goal' },
    })
    expect(window.localStorage.getItem(PIPELINE_DRAFT_STORAGE_KEY)).toContain('Keep this goal')
    cleanup()
    const second = renderSection({ workspaces: [workspace] })
    const restored = second.view.getByRole('region', { name: en.pipelineCreateTitle })
    expect(within(restored).getByText(en.pipelineCreateRestored)).toBeTruthy()
    expect((within(restored).getByLabelText(en.pipelineCreatePrompt) as HTMLTextAreaElement).value)
      .toBe('Keep this goal')
  })

  it('submits once while the first create is still in flight', async () => {
    window.localStorage.clear()
    let settle: ((created: boolean) => void) | undefined
    const createPipeline = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const { view } = renderSection({ workspaces: [workspace], actions: { createPipeline } })
    const form = view.getByRole('region', { name: en.pipelineCreateTitle })
    fireEvent.change(within(form).getByLabelText(en.pipelineCreatePrompt), { target: { value: 'One goal' } })
    const start = within(form).getByRole('button', { name: en.composerStart })
    fireEvent.click(start)
    expect(start.hasAttribute('disabled')).toBe(true)
    fireEvent.click(start)
    expect(createPipeline).toHaveBeenCalledTimes(1)
    settle?.(true)
    await waitFor(() => { expect(view.queryByRole('region', { name: en.pipelineCreateTitle })).toBeNull() })
  })

  it('keeps the optional AI template behind a disclosure', () => {
    window.localStorage.clear()
    const { view } = renderSection({ workspaces: [workspace] })
    expect(view.queryByText(en.pipelineTemplateTitle)).toBeNull()
    fireEvent.click(view.getByText(en.pipelineCreateMore))
    fireEvent.click(view.getByRole('button', { name: en.pipelineCreateTemplateOption }))
    expect(view.getByText(en.pipelineTemplateDraftNote)).toBeTruthy()
  })
})

describe('task editor (advanced)', () => {
  it('retains the task draft callbacks inside queue management', () => {
    const { view, actions } = renderSection({
      live: liveState({
        revision: 2,
        queues: [queue({ revision: 2 })],
        tasks: [taskSummary({ revision: 2, title: 'Server title' })],
      }),
      drafts: draftState({
        selectedQueueId: 'q1',
        queue: {
          draft: { id: 'q1', title: 'Queue one', paused: false },
          baseRevision: 2,
          dirty: false,
          saving: false,
        },
        task: taskDraft,
        queueTasks: [task({ revision: 1 })],
      }),
    })
    expect(view.getByText(en.staleDraft)).toBeTruthy()
    fireEvent.change(view.getByLabelText(en.taskTitle), { target: { value: 'changed locally' } })
    expect(actions.editTask).toHaveBeenCalledWith({ title: 'changed locally' })
    fireEvent.click(view.getByRole('button', { name: en.taskSave }))
    expect(actions.saveTask).toHaveBeenCalledTimes(1)
  })

  it('blocks start and offers repair for invalid dependencies', () => {
    const { view, actions } = renderSection({
      live: liveState({
        queues: [queue({ taskOrder: ['a', 'b'] })],
        tasks: [
          taskSummary({ id: 'a', dependsOn: ['missing'], title: 'Alpha' }),
          taskSummary({ id: 'b', dependsOn: ['b'], title: 'Beta' }),
        ],
      }),
      drafts: draftState({ selectedQueueId: 'q1' }),
    })
    expect(view.getByText(en.taskListBlocked)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: en.repairTaskList }))
    expect(actions.repairTaskList).toHaveBeenCalledTimes(1)
  })
})

describe('queue deletion', () => {
  it('warns that workspace files stay and forwards the archive choice', () => {
    const { view, actions } = renderSection({
      live: liveState({ queues: [queue()], tasks: [taskSummary()] }),
      drafts: draftState({
        selectedQueueId: 'q1',
        queue: {
          draft: { id: 'q1', title: 'Queue one', paused: false },
          baseRevision: 1,
          dirty: false,
          saving: false,
        },
      }),
    })
    fireEvent.click(view.getByRole('button', { name: en.deleteQueue }))
    const dialog = view.getByRole('dialog', { name: en.deleteQueueTitle })
    expect(within(dialog).getByText(en.deleteQueueBody.replace('{title}', 'Queue one'))).toBeTruthy()
    fireEvent.click(within(dialog).getByLabelText(en.deleteQueueAcknowledge))
    fireEvent.click(within(dialog).getByLabelText(en.deleteQueueArchive))
    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteQueue }))
    expect(actions.deleteQueue).toHaveBeenCalledWith({ archiveSessions: true })
  })
})

describe('running tasks', () => {
  it('shows a queued task without a run and its execution metrics', () => {
    const item = taskSummary({ title: 'Build page' })
    const active = run({
      state: 'running',
      createdAt: 1_000,
      updatedAt: 62_000,
      pressure: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        totalTokens: 12_000,
        baselineKind: 'estimated',
        threshold: 0.6,
        routeFingerprint: 'route',
        measuredAt: 60_000,
        decision: 'no-handoff',
      },
      health: {
        cacheHitRate: 0.87,
        idleMs: 500,
        lastActivityAt: 61_500,
        turnOpen: true,
        baselineKind: 'estimated',
        sampledAt: 62_000,
      },
    })
    const { view } = renderSection({
      live: liveState({
        queues: [queue({ state: 'running' })],
        tasks: [item],
        runs: [active],
      }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    const panel = view.getByRole('tabpanel')
    expect(within(panel).getByText('Build page')).toBeTruthy()
    expect(within(panel).getByText(`${en.runningElapsed} 1:01`)).toBeTruthy()
    expect(within(panel).getByText(`${en.runningCredits} 12.0K`)).toBeTruthy()
    expect(within(panel).getByText(`${en.runningHitRate} 87%`)).toBeTruthy()
    expect(within(panel).getByRole('button', { name: en.queuePause })).toBeTruthy()
  })

  it('renders child tasks indented and offers a temporary message box', () => {
    const child = taskSummary({
      id: 't-child',
      title: 'Child work',
      parentTaskId: 't1',
      dependsOn: [],
    })
    const { view, actions } = renderSection({
      live: liveState({
        queues: [queue({ taskOrder: ['t1'], state: 'running' })],
        tasks: [taskSummary(), child],
        presets: {
          phase: 'ready',
          choices: [{ id: 'coding', name: 'Coding', isDefault: true }],
        },
      }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    const panel = view.getByRole('tabpanel')
    expect(within(panel).getByText(en.runningChild.replace('{title}', 'Child work'))).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: `+ ${en.runningTempAdd}` }))
    const box = within(panel).getByLabelText(en.runningTempAdd)
    fireEvent.change(box, { target: { value: 'Add this mid-run' } })
    chooseOption(panel, en.composerSkills, /^Coding/u)
    fireEvent.click(within(panel).getByRole('button', { name: en.composerSend }))
    expect(actions.appendTask).toHaveBeenCalledWith({
      queueId: 'q1',
      prompt: 'Add this mid-run',
      presetId: 'coding',
    })
  })

  it('keeps cancel behind the task details acknowledgement', () => {
    const attention = run({ state: 'needs-attention' })
    const { view, actions } = renderSection({
      live: liveState({ queues: [queue()], tasks: [taskSummary()], runs: [attention] }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    fireEvent.click(view.getByRole('button', { name: `${en.conversationMenu} Task one` }))
    fireEvent.click(view.getByRole('menuitem', { name: en.conversationRunActions }))
    fireEvent.click(view.getByRole('button', { name: `${en.runCardCancel} Task one` }))
    expect(view.getByRole('dialog', { name: en.cancelTitle })).toBeTruthy()
    fireEvent.click(view.getByLabelText(en.acknowledge))
    fireEvent.click(view.getByRole('button', { name: en.confirm }))
    expect(actions.cancelRun).toHaveBeenCalledWith(attention.id)
  })

  it('opens the stable conversation route from a task row', () => {
    const linked = taskSummary({
      session: sessionLink({ sessionId: 'session-1', route: '/session/session-1' }),
    })
    const { view, actions } = renderSection({
      live: liveState({ queues: [queue()], tasks: [linked] }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    fireEvent.click(view.getByRole('button', { name: `${en.runOpenSession} Task one` }))
    expect(actions.openSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
  })

  it('deletes a pipeline from the card menu and offers to archive its conversations', () => {
    const linked = taskSummary({ session: sessionLink({ sessionId: 'session-1' }) })
    const { view, actions } = renderSection({
      live: liveState({ queues: [queue()], tasks: [linked] }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    fireEvent.click(view.getByRole('button', { name: en.queueMenu }))
    fireEvent.click(view.getByRole('menuitem', { name: en.deleteQueue }))
    const dialog = view.getByRole('dialog', { name: en.deleteQueueTitle })
    expect(within(dialog).getByText(en.deleteQueueArchiveHint)).toBeTruthy()
    fireEvent.click(within(dialog).getByLabelText(en.deleteQueueArchive))
    fireEvent.click(within(dialog).getByLabelText(en.deleteQueueAcknowledge))
    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteQueue }))
    expect(actions.deleteQueue).toHaveBeenCalledWith({ queueId: 'q1', archiveSessions: true })
  })

  it('renames a pipeline from the card menu', () => {
    const { view, actions } = renderSection({
      live: liveState({ queues: [queue({ title: 'Old name' })], tasks: [taskSummary()] }),
    })
    fireEvent.click(view.getByRole('tab', { name: en.tabBoard }))
    fireEvent.click(view.getByRole('button', { name: en.queueMenu }))
    fireEvent.click(view.getByRole('menuitem', { name: en.renameQueue }))
    const dialog = view.getByRole('dialog', { name: en.renameQueue })
    fireEvent.change(within(dialog).getByLabelText(en.queueTitle), { target: { value: 'New name' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
    expect(actions.renameQueue).toHaveBeenCalledWith('q1', 'New name')
  })
})

describe('Chinese terminology', () => {
  it('uses the requested primary names', () => {
    expect(zh.title).toBe('HandsOff')
    expect(zh.tabQueue).toBe('创建任务队列')
    expect(zh.tabBoard).toBe('运行中的任务')
    expect(zh.tabHosts).toBe('运行平台')
  })
})
