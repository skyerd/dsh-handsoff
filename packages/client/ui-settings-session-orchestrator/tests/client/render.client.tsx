/** Component harness: plain snapshots, stable callbacks, and the locale seat. */

import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { SessionOrchestratorSectionProps } from '../../src/client/Section.tsx'
import { SessionOrchestratorSection } from '../../src/client/Section.tsx'
import { en } from '../../src/client/locales.ts'
import type {
  OrchestratorActions, OrchestratorDraftState, OrchestratorLiveState, PipelineCreateInput,
  PipelineTemplateInput,
} from '../../src/client/service.ts'
import type { SessionLinkDto } from '../../src/client/contract.ts'
import type { ClientError } from '../../src/client/errors.ts'
import type { QueueDraftPatch, SettingsDraftPatch, TaskDraftPatch } from '../../src/client/service.ts'

/** A standard hook this section never calls. */
function unusedHook(): never {
  throw new Error('SessionOrchestratorSection reads no global slot source')
}

/** One real-looking workspace row supplied by the framework standard hook. */
export interface TestWorkspace {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

/** Owned dictionary viewed by string key for the section's broad translate seat. */
const dictionary: Readonly<Record<string, string>> = en

/** Interpolate one owned dictionary entry. */
export function translate(key: string, params: Record<string, unknown> = {}): string {
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

/** A ready live snapshot with no records. */
export function liveState(overrides: Partial<OrchestratorLiveState> = {}): OrchestratorLiveState {
  return {
    phase: 'ready',
    revision: 1,
    generatedAt: 5_000,
    settings: undefined,
    queues: [],
    tasks: [],
    runs: [],
    handoffs: [],
    interventions: [],
    wardenAudits: [],
    hosts: [],
    models: { phase: 'idle', choices: [] },
    presets: { phase: 'idle', choices: [] },
    ...overrides,
  }
}

/** An empty draft state. */
export function draftState(overrides: Partial<OrchestratorDraftState> = {}): OrchestratorDraftState {
  return {
    selectedQueueId: undefined,
    queue: null,
    task: null,
    settings: null,
    queueTasks: [],
    errors: [],
    busy: undefined,
    ...overrides,
  }
}

/** One retained error. */
export function errorRecord(overrides: Partial<ClientError> = {}): ClientError {
  return {
    id: 'error-1',
    at: 9_000,
    operation: 'saveTask',
    code: 'sessionOrchestrator/revision-conflict',
    message: 'the request observed a stale orchestration revision',
    detail: '{"resource":"task","expectedRevision":1}',
    ...overrides,
  }
}

/** Callbacks with stable identities for a mounted section. */
export function createActions(): OrchestratorActions {
  return {
    selectQueue: vi.fn(async (_queueId: string) => {}),
    newQueue: vi.fn(() => {}),
    editQueue: vi.fn((_patch: QueueDraftPatch) => {}),
    saveQueue: vi.fn(async () => {}),
    createPipeline: vi.fn(async (_input: PipelineCreateInput) => true),
    appendTask: vi.fn(async () => true),
    createPipelineTemplate: vi.fn(async (_input: PipelineTemplateInput) => true),
    discardQueue: vi.fn(() => {}),
    deleteQueue: vi.fn(async () => {}),
    renameQueue: vi.fn(async (_queueId: string, _title: string) => {}),
    loadTask: vi.fn(async (_taskId: string) => {}),
    loadModelCatalog: vi.fn(async () => {}),
    loadPresetCatalog: vi.fn(async () => {}),
    newTask: vi.fn(() => {}),
    editTask: vi.fn((_patch: TaskDraftPatch) => {}),
    saveTask: vi.fn(async () => {}),
    discardTask: vi.fn(() => {}),
    setTaskEnabled: vi.fn(async (_taskId: string, _enabled: boolean) => {}),
    moveTask: vi.fn(async (_taskId: string, _direction: 'up' | 'down') => {}),
    moveTaskTo: vi.fn(async (_taskId: string, _index: number) => {}),
    setTaskParallelWithPrevious: vi.fn(async (_taskId: string, _parallel: boolean) => {}),
    duplicateTask: vi.fn(async (_taskId: string) => {}),
    deleteTask: vi.fn(async (_taskId: string) => {}),
    repairTaskList: vi.fn(async () => {}),
    loadSettingsDraft: vi.fn(() => {}),
    editSettings: vi.fn((_patch: SettingsDraftPatch) => {}),
    setProviderQuota: vi.fn((_provider: string, _quota: number | undefined) => {}),
    saveSettings: vi.fn(async () => {}),
    discardSettings: vi.fn(() => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    cancelRun: vi.fn(async (_runId: string) => {}),
    retryRun: vi.fn(async (_runId: string) => {}),
    skipRun: vi.fn(async (_runId: string, _actor: string, _reason: string) => {}),
    openSession: vi.fn(async (_session: SessionLinkDto) => {}),
    switchConversationModel: vi.fn(async () => true),
    followUpConversation: vi.fn(async () => true),
    rerunConversation: vi.fn(async () => true),
    deleteConversation: vi.fn(async () => true),
    modelSwitchPromptMuted: vi.fn(() => false),
    muteModelSwitchPrompt: vi.fn(() => {}),
    dismissError: vi.fn((_id: string) => {}),
    clearErrors: vi.fn(() => {}),
  }
}

/**
 * Render the section against mutable snapshots.
 * @param options - initial live and draft state plus optional action overrides.
 * @returns the RTL view, a snapshot updater, and the callbacks.
 */
export function renderSection(options: {
  live?: OrchestratorLiveState
  drafts?: OrchestratorDraftState
  workspaces?: readonly TestWorkspace[]
  actions?: Partial<OrchestratorActions>
} = {}) {
  const box: { live: OrchestratorLiveState; drafts: OrchestratorDraftState } = {
    live: options.live ?? liveState(),
    drafts: options.drafts ?? draftState(),
  }
  const base = createActions()
  const actions: OrchestratorActions = { ...base, ...options.actions }
  const useLive = <R,>(selector: (state: OrchestratorLiveState) => R): R => selector(box.live)
  const useDrafts = <R,>(selector: (state: OrchestratorDraftState) => R): R => selector(box.drafts)
  const workspaceItems = (options.workspaces ?? []).map(workspace => ({
    ...workspace,
    sessionIds: [],
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  }))
  const useWorkspaces = (<R,>(selector: (state: {
    items: typeof workspaceItems
    archivedSessionIds: readonly string[]
    pinnedSessionIds: readonly string[]
    state: 'idle'
    phase: 'ready'
    error: null
  }) => R): R => selector({
    items: workspaceItems,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })) as SessionOrchestratorSectionProps['useWorkspaces']
  const props: SessionOrchestratorSectionProps = {
    close: vi.fn(() => {}),
    t: translate,
    useLive,
    useDrafts,
    // The section reads no global slot source; these seats satisfy the
    // framework-provided standard props without inventing session data.
    usePanelInfo: unusedHook,
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook,
    useWorkspaces,
    useResource: unusedHook,
    ...actions,
  }
  const view = render(<SessionOrchestratorSection {...props} />)
  const update = (next: { live?: OrchestratorLiveState; drafts?: OrchestratorDraftState }): void => {
    if (next.live !== undefined) box.live = next.live
    if (next.drafts !== undefined) box.drafts = next.drafts
    view.rerender(<SessionOrchestratorSection {...props} />)
  }
  return { view, update, actions }
}
