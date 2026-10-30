/**
 * The React-free data object for the orchestration settings page.
 *
 * Two sources stay separate:
 * - `live` is the read-only whole-orchestration snapshot streamed by
 *   `sessionOrchestrator/changed`; every mutation result may refresh one
 *   record, but the stream remains the authority a reconnect replaces.
 * - `drafts` holds edits, loaded queue detail, the pending action, and retained
 *   failures. A live frame never overwrites a dirty draft.
 *
 * Every mutation carries the revision observed when its draft or action was
 * prepared. A stale revision surfaces the Host's conflict and leaves the draft
 * intact; the page never rebases silently.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/service
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  CancelRunRequest, CreatePipelineTemplateRequest, CreateQueueRequest, DeleteDraftQueueRequest,
  DeleteTaskRequest, DeleteTaskValue, DuplicateTaskRequest, DuplicateTaskValue, GetQueueRequest,
  HandoffDto, HostCapabilityDto, InterventionDto, ModelPolicy, OrchestratorSnapshotFrame,
  PipelineTemplateValue, QueueDetailValue, QueueDto, QueueDraft, QueueValue, ReorderTasksRequest,
  RepairTaskListRequest, RetryRunRequest, RunDto, RunValue, SetTaskEnabledRequest, SettingsDto, SettingsDraft,
  SettingsRevisionRequest, SettingsValue, SessionLinkDto, SkipTaskRequest, SkipTaskValue, TaskDraft,
  TaskDto, TaskSummaryDto, TaskValue, UpdateQueueRequest, UpdateSettingsRequest, UpsertTaskRequest,
  WardenAuditDto,
} from './contract.ts'
import { emptyQueueDraft, emptyTaskDraft, type OrchestratorRemote } from './contract.ts'
import { clientErrorFrom, type ClientError } from './errors.ts'
import { canCancelRun, canRetryRun, canSkipRun } from './model.ts'

/** Connection phase of the snapshot stream. */
export type LivePhase = 'connecting' | 'ready' | 'error'

/** Browser-local preference: pipelines that no longer ask about future models. */
const MODEL_SWITCH_MUTE_KEY = 'dsh-handsoff:model-switch-muted'

/** Read the muted-pipeline set without letting storage failures break the page. */
function mutedModelSwitchQueues(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_SWITCH_MUTE_KEY)
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Persist the muted-pipeline set without letting storage failures break the page. */
function writeMutedModelSwitchQueues(ids: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(MODEL_SWITCH_MUTE_KEY, JSON.stringify([...ids]))
  } catch {
    // A browser with storage disabled simply asks again on the next switch.
  }
}

/** One creation-time model route the host catalog advertises. */
export interface ModelChoice {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
  /** Adapter-owned reasoning efforts; empty when the route has none. */
  readonly reasoningEfforts: readonly { readonly id: string; readonly name: string }[]
  /** Effort the host applies when a selection names none. */
  readonly defaultReasoningEffort?: string
  /**
   * True for the deployment default the host applies to an unconfigured Session.
   *
   * Pinning a task without asking must land on this route, not on whichever
   * route the catalog happens to list first: a pinned route outranks both the
   * pipeline and the host default, so an arbitrary pick silently moves every
   * run of that task onto a provider the deployment may hold no credential for.
   */
  readonly isDefault?: boolean
}

/** One host model catalog read: choices, or the reason it cannot answer. */
export interface ModelCatalogState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly choices: readonly ModelChoice[]
  readonly error?: string
}

/**
 * The native model catalog a task editor reads.
 *
 * The page never builds a provider/model list of its own: production binds this
 * to the host's `session/modelCatalog` remote, and a composition without that
 * service leaves the catalog unavailable instead of inventing routes.
 */
export interface ModelCatalogSource {
  /**
   * Read the current host generation's catalog.
   * @returns selectable routes.
   */
  load(): Promise<readonly ModelChoice[]>
}

/** One agent preset a task may use for its skills and permissions. */
export interface PresetChoice {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly isDefault: boolean
}

/** One host preset catalog read. */
export interface PresetCatalogState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly choices: readonly PresetChoice[]
  readonly error?: string
}

/** The native preset catalog a task composer reads. */
export interface PresetCatalogSource {
  load(): Promise<readonly PresetChoice[]>
}

/** Whole-orchestration snapshot. Consumers treat it as read-only; the owner store replaces fields. */
export interface OrchestratorLiveState {
  phase: LivePhase
  /** Host generation of the newest accepted frame; `-1` before the baseline. */
  revision: number
  generatedAt: number
  settings: SettingsDto | undefined
  queues: readonly QueueDto[]
  tasks: readonly TaskSummaryDto[]
  runs: readonly RunDto[]
  handoffs: readonly HandoffDto[]
  /** Audited pipeline interventions, as the newest snapshot delivered them. */
  interventions: readonly InterventionDto[]
  /** Warden reviews of one pipeline decision; empty while the rules judge. */
  wardenAudits: readonly WardenAuditDto[]
  /** Host conversation capability matrix; empty without a mounted runtime. */
  hosts: readonly HostCapabilityDto[]
  /** Creation-time model routes the native host catalog advertises. */
  models: ModelCatalogState
  /** Agent presets that decide skills and permissions for a new task. */
  presets: PresetCatalogState
}

/** Editable queue fields; task order comes from the live queue at save time. */
export interface QueueDraftFields {
  readonly id: string
  readonly title: string
  readonly paused: boolean
  /** Original requirement this pipeline decomposes. */
  readonly brief?: string
  /** Workspace new tasks inherit. */
  readonly workspaceId?: string
  /** Canonical directory captured with the selected workspace. */
  readonly cwd?: string
  /** Route new tasks inherit when their own policy is `inherit`. */
  readonly model?: ModelPolicy
  readonly maxConcurrentRuns?: number
}

/** One task row in the manual queue composer. */
export interface PipelineCreateTaskInput {
  readonly prompt: string
  /** Optional task label; empty derives one from the prompt's first line. */
  readonly title?: string
  /** Route used only by this task; absent inherits the queue or host route. */
  readonly model?: ModelPolicy
  /** Agent preset used by this task; absent inherits the host preset. */
  readonly presetId?: string
}

/** Values the manual pipeline form collects; every identity stays internal. */
export interface PipelineCreateInput {
  /** Ordered task rows; each becomes one task in the same serial pipeline. */
  readonly tasks?: readonly PipelineCreateTaskInput[]
  /** Legacy ordered prompts, still accepted by existing callers. */
  readonly prompts?: readonly string[]
  /** Registered host Workspace the new task inherits. */
  readonly workspaceId: string
  /** Canonical directory; the form seeds it from the Workspace and lets the user edit it. */
  readonly cwd: string
  /** Optional label; empty derives one from the first prompt's first line. */
  readonly title?: string
}

/** One task appended to an existing queue while it is running. */
export interface AppendTaskInput {
  readonly queueId: string
  readonly prompt: string
  readonly model?: ModelPolicy
  readonly presetId?: string
}

/** One conversation model switch and the tasks it should also retarget. */
export interface SwitchConversationModelInput {
  /** Task whose latest conversation is being retargeted. */
  readonly taskId: string
  /** Session to retarget in place; absent when the task has no conversation yet. */
  readonly sessionId?: string
  /** Fixed route the user picked. */
  readonly model: ModelPolicy
  /** Not-yet-started tasks in the same pipeline that should receive the same route. */
  readonly applyFutureTaskIds?: readonly string[]
  /** Persist "do not ask again" for this pipeline. */
  readonly muteQueuePrompt?: boolean
}

/** One follow-up instruction that becomes a child conversation in the queue. */
export interface FollowUpConversationInput {
  /** Parent task whose conversation is being continued. */
  readonly taskId: string
  /** User text for the child conversation. */
  readonly prompt: string
}

/** One conversation deletion and whether its DSH Session is archived. */
export interface DeleteConversationInput {
  /** Task that owns the conversation. */
  readonly taskId: string
  /** Archive the DSH Session while removing the HandsOff records. */
  readonly archiveSession: boolean
}

/** Values the one-click pipeline template form collects. */
export interface PipelineTemplateInput {
  /** Stable identity of the draft; reusing it makes a retry idempotent. */
  readonly queueId: string
  /** Optional label; the host derives one from the requirement when absent. */
  readonly title?: string
  /** The original requirement, written once and embedded in all four prompts. */
  readonly brief: string
  readonly workspaceId: string
  /** Canonical directory; the host fills it from the Workspace registry. */
  readonly cwd?: string
  readonly maxConcurrentRuns?: number
}

/** One queue draft and the revision it was based on. */
export interface QueueDraftState {
  draft: QueueDraftFields
  baseRevision: number
  dirty: boolean
  saving: boolean
}

/** One task draft and the revision it was based on. */
export interface TaskDraftState {
  mode: 'create' | 'edit'
  draft: TaskDraft
  baseRevision: number
  dirty: boolean
  saving: boolean
  /** Zero-based list position a create or move should land on. */
  insertIndex?: number
}

/** One host-settings draft and the revision it was based on. */
export interface SettingsDraftState {
  draft: SettingsDraft
  baseRevision: number
  dirty: boolean
  saving: boolean
}

/** Draft, detail, failure, and action state owned by the page. */
export interface OrchestratorDraftState {
  selectedQueueId: string | undefined
  queue: QueueDraftState | null
  task: TaskDraftState | null
  settings: SettingsDraftState | null
  /** Full task projections of the last queue read; never the live authority. */
  queueTasks: readonly TaskDto[]
  /** Failures retained until the user dismisses each one. */
  errors: readonly ClientError[]
  /** Operation currently in flight, or undefined. */
  busy: string | undefined
}

/** Fields the task editor may replace. */
export type TaskDraftPatch =
  Partial<Omit<TaskDraft, 'concurrencyGroup'>>
  & { readonly concurrencyGroup?: string | undefined }

/** Fields the queue editor may replace; `null` removes the optional run limit. */
export type QueueDraftPatch =
  Partial<Omit<QueueDraftFields, 'maxConcurrentRuns'>>
  & { readonly maxConcurrentRuns?: number | null | undefined }

/** Host settings fields the page may replace. */
export type SettingsDraftPatch =
  Partial<Omit<SettingsDraft, 'providerQuotas'>>
  & { readonly providerQuotas?: Readonly<Record<string, number>> }

/** One direction a queue order move may take. */
export type MoveDirection = 'up' | 'down'

/**
 * The browser's Session surface, narrowed to what opening one Session needs.
 *
 * The page never imports the Workspace controller: a host composition without
 * it still renders, and every Session link reports `ui/session-unsupported`
 * instead of navigating nowhere.
 */
export interface SessionOpenSurface {
  /**
   * Select one Session in the main view.
   * @param sessionId - Session identity the host projected.
   */
  open(sessionId: string): void
  /**
   * Whether the browser Session catalog contains one identity.
   * @param sessionId - Session identity to look up.
   * @returns `true`/`false` once the catalog is ready, `undefined` while it is not.
   */
  knows(sessionId: string): boolean | undefined
  /**
   * Pull the catalog again before trusting an absence.
   *
   * HandsOff creates its Sessions on the Host through the Agent registry, not
   * through the browser's Session creation, so the browser catalog is not told
   * about them and only refreshes when the connection is re-established. A
   * catalog that is ready but stale therefore reports every automated Session
   * as absent until the page is reloaded; refreshing on demand closes that gap.
   * @returns completion of the current or newly started catalog pull.
   */
  refresh?(): Promise<void>
  /**
   * Switch the model one live conversation uses for its next turn.
   * @param sessionId - Session identity to retarget.
   * @param selection - fixed provider, model and optional reasoning effort.
   * @returns completion after the Host installed the selection.
   */
  selectModel?(sessionId: string, selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<void>
  /**
   * Deliver one follow-up instruction into a live conversation.
   * @param sessionId - Session identity that receives the message.
   * @param prompt - non-empty user text.
   * @returns completion after the Host admitted the prompt.
   */
  prompt?(sessionId: string, prompt: string): Promise<void>
  /**
   * Whether one Session is archived, so opening it would be refused.
   * @param sessionId - Session identity to look up.
   * @returns `true` when the Workspace registry reports it archived.
   */
  archived?(sessionId: string): boolean
  /**
   * Archive one Session in the Workspace sidebar.
   * @param sessionId - Session identity to archive.
   * @returns completion after the Host archived the Session.
   */
  archive?(sessionId: string): Promise<void>
}

/** Options carried by one queue removal. */
export interface DeleteQueueOptions {
  /**
   * Queue to remove; defaults to the queue this page has selected.
   *
   * The running-task view lists every queue at once, so a card action names its
   * own queue instead of relying on a selection the user never made.
   */
  readonly queueId?: string
  /** Archive the queue's conversations before removing its HandsOff records. */
  readonly archiveSessions?: boolean
}

/** Plain callbacks and observable sources the section component receives. */
export interface OrchestratorClientFace extends OrchestratorActions {
  readonly hooks: {
    readonly live: SnapshotStore<OrchestratorLiveState>
    readonly drafts: SnapshotStore<OrchestratorDraftState>
  }
}

/** The callback half of the face; no observable source leaks into tab props. */
export interface OrchestratorActions {
  readonly selectQueue: (queueId: string) => Promise<void>
  readonly newQueue: () => void
  readonly editQueue: (patch: QueueDraftPatch) => void
  readonly saveQueue: () => Promise<void>
  /** Create one prompt-driven pipeline and start it. */
  readonly createPipeline: (input: PipelineCreateInput) => Promise<boolean>
  /** Append one prompt to an already stored queue. */
  readonly appendTask: (input: AppendTaskInput) => Promise<boolean>
  /** Create the four-stage draft; `false` keeps the form open on failure. */
  readonly createPipelineTemplate: (input: PipelineTemplateInput) => Promise<boolean>
  readonly discardQueue: () => void
  /** Delete one queue's HandsOff records, optionally archiving its conversations. */
  readonly deleteQueue: (options?: DeleteQueueOptions) => Promise<void>
  /** Rename one stored pipeline without touching its tasks or Workspace. */
  readonly renameQueue: (queueId: string, title: string) => Promise<void>
  readonly startQueue: (queueId: string) => Promise<void>
  readonly pauseQueue: (queueId: string) => Promise<void>
  readonly abortQueue: (queueId: string) => Promise<void>
  readonly loadTask: (taskId: string) => Promise<void>
  /** Read the native host model catalog; a repeated call is a no-op once ready. */
  readonly loadModelCatalog: () => Promise<void>
  /** Read the native agent-preset roster; a repeated call is a no-op once ready. */
  readonly loadPresetCatalog: () => Promise<void>
  /** Start a blank task at the end, or at one list position when given. */
  readonly newTask: (atIndex?: number) => void
  readonly editTask: (patch: TaskDraftPatch) => void
  readonly saveTask: () => Promise<void>
  readonly discardTask: () => void
  readonly setTaskEnabled: (taskId: string, enabled: boolean) => Promise<void>
  readonly moveTask: (taskId: string, direction: MoveDirection) => Promise<void>
  /** Move one task to a zero-based list position after a drag. */
  readonly moveTaskTo: (taskId: string, index: number) => Promise<void>
  /** Mark one task as running together with the item above it. */
  readonly setTaskParallelWithPrevious: (taskId: string, parallel: boolean) => Promise<void>
  /** Duplicate one task immediately below itself. */
  readonly duplicateTask: (taskId: string) => Promise<void>
  /** Delete one task and repair every dependency in the same host commit. */
  readonly deleteTask: (taskId: string) => Promise<void>
  /** Rewrite every dependency from the current list order. */
  readonly repairTaskList: () => Promise<void>
  readonly loadSettingsDraft: () => void
  readonly editSettings: (patch: SettingsDraftPatch) => void
  readonly setProviderQuota: (provider: string, quota: number | undefined) => void
  readonly saveSettings: () => Promise<void>
  readonly discardSettings: () => void
  readonly pause: () => Promise<void>
  readonly resume: () => Promise<void>
  readonly cancelRun: (runId: string) => Promise<void>
  readonly retryRun: (runId: string) => Promise<void>
  readonly skipRun: (runId: string, actor: string, reason: string) => Promise<void>
  readonly openSession: (session: SessionLinkDto) => Promise<void>
  /** Retarget one conversation's model and optionally the pipeline's future tasks. */
  readonly switchConversationModel: (input: SwitchConversationModelInput) => Promise<boolean>
  /** Insert one follow-up child conversation immediately after its parent. */
  readonly followUpConversation: (input: FollowUpConversationInput) => Promise<boolean>
  /** Insert one child conversation that reruns the unfinished part of its parent. */
  readonly rerunConversation: (taskId: string, title: string) => Promise<boolean>
  /** Remove one conversation's HandsOff records, optionally archiving its DSH Session. */
  readonly deleteConversation: (input: DeleteConversationInput) => Promise<boolean>
  /** Whether this pipeline suppresses the future-task model prompt. */
  readonly modelSwitchPromptMuted: (queueId: string) => boolean
  /** Persist the current pipeline's "do not ask again" choice. */
  readonly muteModelSwitchPrompt: (queueId: string) => void
  readonly dismissError: (id: string) => void
  readonly clearErrors: () => void
}

/** Replaceable clock, reconnect delay and Session surface. */
export interface OrchestratorClientOptions {
  /** Clock used for failure records. */
  readonly now?: () => number
  /** Delay before reopening a closed stream generation. */
  readonly retryDelayMs?: number
  /**
   * Resolve the browser Session surface on use.
   *
   * A function, not a value: the Workspace navigator and the Session catalog
   * are provided by peer plugins whose activation can finish after this page
   * mounts, so a captured snapshot would be permanently undefined.
   */
  readonly sessions?: () => SessionOpenSurface | undefined
  /**
   * Resolve the native host model catalog on use.
   *
   * A function for the same reason as `sessions`: the Remote namespace that
   * serves `session/modelCatalog` can activate after this page mounts.
   */
  readonly models?: () => ModelCatalogSource | undefined
  /** Resolve the native agent-preset roster on use. */
  readonly presets?: () => PresetCatalogSource | undefined
}

/** Initial live snapshot before any frame arrives. */
function initialLive(): OrchestratorLiveState {
  return {
    phase: 'connecting',
    revision: -1,
    generatedAt: 0,
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
  }
}

/** Initial draft state. */
function initialDrafts(): OrchestratorDraftState {
  return {
    selectedQueueId: undefined,
    queue: null,
    task: null,
    settings: null,
    queueTasks: [],
    errors: [],
    busy: undefined,
  }
}

/** One in-flight snapshot generation. */
interface StreamControl {
  readonly abort: AbortController
  readonly done: Promise<void>
}

/**
 * Own the page's live snapshot, draft edits, retained failures, and mutations.
 *
 * This class never calls a model, registers no tool, creates no Agent, and
 * writes no Session event. It only invokes the `sessionOrchestrator` Remote
 * methods and projects their results.
 */
export class OrchestratorClient {
  /** Whole-snapshot live state accepted from `changed`. */
  readonly live: SnapshotStore<OrchestratorLiveState>
  /** Local drafts, loaded details, busy flags and retained failures. */
  readonly drafts: SnapshotStore<OrchestratorDraftState>
  private readonly now: () => number
  private readonly retryDelayMs: number
  private control: StreamControl | undefined
  private disposed = false
  private errorSequence = 0
  private readonly resolveSurface: (() => SessionOpenSurface | undefined) | undefined
  private readonly resolveModels: (() => ModelCatalogSource | undefined) | undefined
  private readonly resolvePresets: (() => PresetCatalogSource | undefined) | undefined

  /**
   * @param remote - generated `sessionOrchestrator` namespace face.
   * @param options - clock and reconnect delay overrides.
   */
  constructor(
    private readonly remote: OrchestratorRemote,
    options: OrchestratorClientOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.resolveSurface = options.sessions
    this.resolveModels = options.models
    this.resolvePresets = options.presets
    this.live = createSnapshotStore(initialLive())
    this.drafts = createSnapshotStore(initialDrafts())
  }

  /**
   * Open one snapshot stream generation.
   *
   * A clean end or a carrier throw classifies the connection as reconnecting:
   * the last accepted snapshot stays visible until a newer generation arrives,
   * and the failure remains in the error list.
   */
  start(): void {
    if (this.disposed || this.control !== undefined) return
    const abort = new AbortController()
    const done = this.pump(abort.signal).finally(() => {
      if (this.control?.abort === abort) this.control = undefined
    })
    this.control = { abort, done }
    // The task editor needs the host routes before a draft can pin one. A
    // composition without the native catalog keeps the choice disabled.
    void this.loadModelCatalog()
    void this.loadPresetCatalog()
  }

  /**
   * Close the current generation and reopen one for a new connection.
   */
  restart(): void {
    if (this.disposed) return
    void this.stop().then(() => {
      if (!this.disposed) this.start()
    })
  }

  /**
   * Abort the stream generation and wait for its loop to settle.
   * @returns completion after the carrier iterator closes.
   */
  async stop(): Promise<void> {
    const current = this.control
    if (current === undefined) return
    this.control = undefined
    current.abort.abort()
    await current.done
  }

  /**
   * Stop permanently; later start or mutation calls do nothing.
   * @returns completion after the carrier iterator closes.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /**
   * Plain callback and observable face the slot inject returns.
   * @returns the inject face bound to this client instance.
   */
  inject(): OrchestratorClientFace {
    return {
      hooks: { live: this.live, drafts: this.drafts },
      selectQueue: async (queueId) => { await this.selectQueue(queueId) },
      newQueue: () => { this.newQueue() },
      editQueue: (patch) => { this.editQueue(patch) },
      saveQueue: async () => { await this.saveQueue() },
      createPipeline: async input => await this.createPipeline(input),
      appendTask: async input => await this.appendTask(input),
      createPipelineTemplate: async (input) => await this.createPipelineTemplate(input),
      discardQueue: () => { this.discardQueue() },
      deleteQueue: async (options) => { await this.deleteQueue(options) },
      renameQueue: async (queueId, title) => { await this.renameQueue(queueId, title) },
      startQueue: async (queueId) => { await this.controlQueue('startQueue', queueId) },
      pauseQueue: async (queueId) => { await this.controlQueue('pauseQueue', queueId) },
      abortQueue: async (queueId) => { await this.controlQueue('abortQueue', queueId) },
      loadTask: async (taskId) => { await this.loadTask(taskId) },
      loadModelCatalog: async () => { await this.loadModelCatalog() },
      loadPresetCatalog: async () => { await this.loadPresetCatalog() },
      newTask: (atIndex) => { this.newTask(atIndex) },
      editTask: (patch) => { this.editTask(patch) },
      saveTask: async () => { await this.saveTask() },
      discardTask: () => { this.discardTask() },
      setTaskEnabled: async (taskId, enabled) => { await this.setTaskEnabled(taskId, enabled) },
      moveTask: async (taskId, direction) => { await this.moveTask(taskId, direction) },
      moveTaskTo: async (taskId, index) => { await this.moveTaskTo(taskId, index) },
      setTaskParallelWithPrevious: async (taskId, parallel) => {
        await this.setTaskParallelWithPrevious(taskId, parallel)
      },
      duplicateTask: async (taskId) => { await this.duplicateTask(taskId) },
      deleteTask: async (taskId) => { await this.deleteTask(taskId) },
      repairTaskList: async () => { await this.repairTaskList() },
      loadSettingsDraft: () => { this.loadSettingsDraft() },
      editSettings: (patch) => { this.editSettings(patch) },
      setProviderQuota: (provider, quota) => { this.setProviderQuota(provider, quota) },
      saveSettings: async () => { await this.saveSettings() },
      discardSettings: () => { this.discardSettings() },
      pause: async () => { await this.setPaused(true) },
      resume: async () => { await this.setPaused(false) },
      cancelRun: async (runId) => { await this.cancelRun(runId) },
      retryRun: async (runId) => { await this.retryRun(runId) },
      skipRun: async (runId, actor, reason) => { await this.skipRun(runId, actor, reason) },
      openSession: async (session) => { await this.openSession(session) },
      switchConversationModel: async input => await this.switchConversationModel(input),
      followUpConversation: async input => await this.followUpConversation(input),
      rerunConversation: async (taskId, title) => await this.rerunConversation(taskId, title),
      deleteConversation: async input => await this.deleteConversation(input),
      modelSwitchPromptMuted: queueId => mutedModelSwitchQueues().has(queueId),
      muteModelSwitchPrompt: (queueId) => {
        const muted = mutedModelSwitchQueues()
        muted.add(queueId)
        writeMutedModelSwitchQueues(muted)
      },
      dismissError: (id) => { this.dismissError(id) },
      clearErrors: () => { this.clearErrors() },
    }
  }

  /** Reopen the stream after an abrupt carrier failure. */
  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.live.update((state) => {
        if (state.phase !== 'ready') state.phase = 'connecting'
      })
      try {
        for await (const frame of this.remote.changed(signal)) {
          if (signal.aborted) break
          this.accept(frame)
        }
      } catch (error) {
        if (signal.aborted) break
        this.live.update((state) => { state.phase = 'error' })
        this.recordFailure('stream', error)
      }
      if (signal.aborted) break
      await this.delay(signal)
    }
  }

  /** Accept one whole snapshot unless a newer generation already won. */
  private accept(frame: OrchestratorSnapshotFrame): void {
    this.live.update((state) => {
      if (frame.revision < state.revision) return
      state.phase = 'ready'
      state.revision = frame.revision
      state.generatedAt = frame.generatedAt
      state.settings = frame.settings
      state.queues = frame.queues
      state.tasks = frame.tasks
      state.runs = frame.runs
      state.handoffs = frame.handoffs
      state.interventions = frame.interventions
      state.wardenAudits = frame.wardenAudits
      state.hosts = frame.hosts
    })
    if (frame.revision === this.live.getSnapshot().revision) this.rebaseCleanQueueDraft(frame.queues)
  }

  /** Wait for the next reconnect unless the caller aborted. */
  private async delay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, this.retryDelayMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Load one queue's full task projections and seed a clean queue draft.
   * @param queueId - queue identity to load.
   */
  async selectQueue(queueId: string): Promise<void> {
    if (this.blockDirty('selectQueue')) return
    const value = await this.call<QueueDetailValue>('getQueue', () => this.remote.getQueue({ queueId }))
    if (value === undefined) return
    this.drafts.update((state) => {
      state.selectedQueueId = value.queue.id
      state.queue = {
        draft: queueDraftOf(value.queue),
        baseRevision: value.queue.revision,
        dirty: false,
        saving: false,
      }
      state.queueTasks = value.tasks
    })
  }

  /** Start a blank queue draft at revision zero. */
  newQueue(): void {
    if (this.blockDirty('newQueue')) return
    this.drafts.update((state) => {
      state.queue = { draft: emptyQueueDraft(), baseRevision: 0, dirty: false, saving: false }
      state.task = null
      state.queueTasks = []
      state.selectedQueueId = undefined
    })
  }

  /**
   * Replace queue fields locally without touching the task order.
   * @param patch - changed queue fields.
   */
  editQueue(patch: QueueDraftPatch): void {
    this.drafts.update((state) => {
      const current = state.queue
      if (current === null) return
      state.queue = {
        ...current,
        draft: {
          id: patch.id ?? current.draft.id,
          title: patch.title ?? current.draft.title,
          paused: patch.paused ?? current.draft.paused,
          ...(patch.brief === undefined
            ? (current.draft.brief === undefined ? {} : { brief: current.draft.brief })
            : patch.brief === ''
              ? {}
              : { brief: patch.brief }),
          ...(patch.workspaceId === undefined
            ? {
              ...(current.draft.workspaceId === undefined ? {} : { workspaceId: current.draft.workspaceId }),
              ...(current.draft.cwd === undefined ? {} : { cwd: current.draft.cwd }),
            }
            : patch.workspaceId === ''
              ? {}
              : { workspaceId: patch.workspaceId, cwd: patch.cwd ?? current.draft.cwd ?? '' }),
          ...(patch.model === undefined
            ? (current.draft.model === undefined ? {} : { model: current.draft.model })
            : { model: patch.model }),
          ...(patch.maxConcurrentRuns === undefined
            ? (current.draft.maxConcurrentRuns === undefined
              ? {}
              : { maxConcurrentRuns: current.draft.maxConcurrentRuns })
            : patch.maxConcurrentRuns === null
              ? {}
              : { maxConcurrentRuns: patch.maxConcurrentRuns }),
        },
        dirty: true,
      }
    })
  }

  /** Create or update the queue draft under the revision it was based on. */
  async saveQueue(): Promise<void> {
    const current = this.drafts.getSnapshot().queue
    if (current === null) return this.localError('saveQueue', 'ui/no-queue')
    const live = this.live.getSnapshot()
    const liveQueue = live.queues.find(queue => queue.id === current.draft.id)
    if (current.baseRevision > 0 && liveQueue === undefined) {
      return this.localError('saveQueue', 'ui/queue-missing')
    }
    const taskOrder = liveQueue?.taskOrder ?? []
    const draft: QueueDraft = {
      id: current.draft.id,
      title: current.draft.title,
      taskOrder,
      paused: current.draft.paused,
      ...(current.draft.brief === undefined ? {} : { brief: current.draft.brief }),
      ...(current.draft.workspaceId === undefined ? {} : { workspaceId: current.draft.workspaceId }),
      ...(current.draft.cwd === undefined ? {} : { cwd: current.draft.cwd }),
      ...(current.draft.model === undefined ? {} : { model: current.draft.model }),
      ...(current.draft.maxConcurrentRuns === undefined
        ? {}
        : { maxConcurrentRuns: current.draft.maxConcurrentRuns }),
    }
    this.setSaving('queue', true)
    const value = current.baseRevision === 0
      ? await this.call<QueueValue>('createQueue', () => this.remote.createQueue({
        expectedRevision: 0,
        draft,
      } satisfies CreateQueueRequest))
      : await this.call<QueueValue>('updateQueue', () => this.remote.updateQueue({
        queueId: current.draft.id,
        expectedRevision: current.baseRevision,
        draft,
      } satisfies UpdateQueueRequest))
    this.setSaving('queue', false)
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.drafts.update((state) => {
      state.selectedQueueId = value.queue.id
      state.queue = {
        draft: queueDraftOf(value.queue),
        baseRevision: value.queue.revision,
        dirty: false,
        saving: false,
      }
    })
  }

  /**
   * Create the four-stage pipeline as a draft and select it for inspection.
   *
   * The stable `queueId` is half of the idempotency: the host adopts an existing
   * template under the same id, and the in-flight guard refuses a second call
   * while the first is still running. Nothing is dispatched here: the created
   * queue is `idle` and paused until the user presses "Start pipeline".
   * @param input - workspace, original requirement and optional label.
   * @returns whether the draft was created or adopted.
   */
  async createPipelineTemplate(input: PipelineTemplateInput): Promise<boolean> {
    if (this.blockDirty('createPipelineTemplate')) return false
    if (input.queueId.trim() === '') {
      this.localError('createPipelineTemplate', 'ui/queue-id-required')
      return false
    }
    if (input.workspaceId.trim() === '') {
      this.localError('createPipelineTemplate', 'ui/workspace-required')
      return false
    }
    if (input.brief.trim() === '') {
      this.localError('createPipelineTemplate', 'ui/template-brief-required')
      return false
    }
    const value = await this.call<PipelineTemplateValue>('createPipelineTemplate', () =>
      this.remote.createPipelineTemplate({
        expectedRevision: 0,
        queueId: input.queueId,
        brief: input.brief,
        workspaceId: input.workspaceId,
        ...(input.title === undefined || input.title.trim() === '' ? {} : { title: input.title }),
        ...(input.cwd === undefined || input.cwd === '' ? {} : { cwd: input.cwd }),
        ...(input.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: input.maxConcurrentRuns }),
      } satisfies CreatePipelineTemplateRequest))
    if (value === undefined) return false
    this.mergeQueue(value.queue)
    for (const task of value.tasks) this.mergeTask(task)
    this.drafts.update((state) => {
      state.selectedQueueId = value.queue.id
      state.queue = {
        draft: queueDraftOf(value.queue),
        baseRevision: value.queue.revision,
        dirty: false,
        saving: false,
      }
      state.queueTasks = value.tasks
      state.task = null
    })
    return true
  }

  /**
   * Create one prompt-driven pipeline, add every ordered prompt as a task, and
   * start it only after all tasks are stored.
   *
   * The queue and task identities are generated here, so the form never asks
   * the user for an ID or a task title. The queue starts paused with an empty
   * order; each task upsert appends at its requested position and returns the
   * queue revision the next insert needs. Only after every task exists does the
   * existing `startQueue` control own the lifecycle change. A failed write
   * removes the tasks already written and the empty queue, so a retry does not
   * leave an orphan behind.
   * @param input - ordered prompts, workspace, working directory and optional label.
   * @returns whether the pipeline and all its tasks were created and started.
   */
  async createPipeline(input: PipelineCreateInput): Promise<boolean> {
    if (this.blockDirty('createPipeline')) return false
    const workspaceId = input.workspaceId.trim()
    const cwd = input.cwd.trim()
    const taskInputs: readonly PipelineCreateTaskInput[] = input.tasks
      ?? (input.prompts ?? []).map(prompt => ({ prompt }))
    const prompts = taskInputs.map(task => task.prompt.trim())
    if (workspaceId === '') {
      this.localError('createPipeline', 'ui/workspace-required')
      return false
    }
    if (cwd === '') {
      this.localError('createPipeline', 'ui/workspace-path-required')
      return false
    }
    if (prompts.length === 0 || prompts.some(prompt => prompt === '')) {
      this.localError('createPipeline', 'ui/pipeline-prompt-required')
      return false
    }
    const queueId = internalQueueId(this.now())
    const requestedTitle = input.title?.trim() ?? ''
    const title = requestedTitle === '' ? titleFromPrompt(prompts[0] ?? '') : requestedTitle
    const queueDraft: QueueDraft = {
      id: queueId,
      title,
      taskOrder: [],
      paused: true,
      brief: prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n'),
      workspaceId,
      cwd,
    }
    const created = await this.call<QueueValue>('createPipeline', () => this.remote.createQueue({
      expectedRevision: 0,
      draft: queueDraft,
    } satisfies CreateQueueRequest))
    if (created === undefined) return false
    let queue = created.queue
    this.mergeQueue(queue)
    const tasks: TaskDto[] = []
    const rollback = async (): Promise<void> => {
      for (const task of [...tasks].reverse()) {
        const removed = await this.call<DeleteTaskValue>('createPipeline-rollback', () => this.remote.deleteTask({
          queueId,
          taskId: task.id,
          expectedRevision: queue.revision,
        } satisfies DeleteTaskRequest))
        if (removed !== undefined) queue = removed.queue
      }
      await this.call('createPipeline-rollback', () => this.remote.deleteDraftQueue({
        queueId,
        expectedRevision: queue.revision,
      } satisfies DeleteDraftQueueRequest))
    }
    for (const [index, taskInput] of taskInputs.entries()) {
      const prompt = prompts[index] ?? ''
      const taskTitle = taskInput.title?.trim() ?? ''
      const taskDraft: TaskDraft = {
        ...emptyTaskDraft(queueId),
        id: `${queueId}-t${index + 1}`,
        title: taskTitle === '' ? titleFromPrompt(prompt) : taskTitle,
        prompt,
        workspaceId,
        cwd,
        ...(taskInput.model === undefined ? {} : { model: taskInput.model }),
        ...(taskInput.presetId === undefined
          ? {}
          : {
            preset: { kind: 'fixed' as const, id: taskInput.presetId },
            skills: { kind: 'preset' as const, presetId: taskInput.presetId },
          }),
      }
      const taskValue = await this.call<TaskValue>('createPipeline', () => this.remote.upsertTask({
        taskId: taskDraft.id,
        expectedRevision: 0,
        draft: taskDraft,
        position: index,
        queueRevision: queue.revision,
      } satisfies UpsertTaskRequest))
      if (taskValue === undefined) {
        await rollback()
        return false
      }
      tasks.push(taskValue.task)
      this.mergeTask(taskValue.task)
      if (taskValue.queue !== undefined) {
        queue = taskValue.queue
        this.mergeQueue(queue)
        continue
      }
      const detail = await this.call<QueueDetailValue>('createPipeline', () =>
        this.remote.getQueue({ queueId }))
      if (detail === undefined) {
        await rollback()
        return false
      }
      queue = detail.queue
      this.mergeQueue(queue)
    }
    this.drafts.update((state) => {
      state.selectedQueueId = queueId
      state.queue = {
        draft: queueDraftOf(queue),
        baseRevision: queue.revision,
        dirty: false,
        saving: false,
      }
      state.queueTasks = tasks
      state.task = null
    })
    await this.controlQueue('startQueue', queueId)
    return true
  }

  /**
   * Append one prompt to a stored queue without replacing its other tasks.
   * @param input - queue identity, prompt, task route and optional preset.
   * @returns whether the task was stored.
   */
  async appendTask(input: AppendTaskInput): Promise<boolean> {
    const prompt = input.prompt.trim()
    const queue = this.live.getSnapshot().queues.find(candidate => candidate.id === input.queueId)
    if (queue === undefined) {
      this.localError('appendTask', 'ui/queue-missing')
      return false
    }
    if (prompt === '') {
      this.localError('appendTask', 'ui/pipeline-prompt-required')
      return false
    }
    const taskId = internalTaskId(queue.id, this.now())
    const draft: TaskDraft = {
      ...emptyTaskDraft(queue.id),
      id: taskId,
      title: titleFromPrompt(prompt),
      prompt,
      workspaceId: queue.workspaceId ?? '',
      cwd: queue.cwd ?? '',
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.presetId === undefined
        ? {}
        : {
          preset: { kind: 'fixed' as const, id: input.presetId },
          skills: { kind: 'preset' as const, presetId: input.presetId },
        }),
    }
    const value = await this.call<TaskValue>('appendTask', () => this.remote.upsertTask({
      taskId,
      expectedRevision: 0,
      draft,
      position: queue.taskOrder.length,
      queueRevision: queue.revision,
    } satisfies UpsertTaskRequest))
    if (value === undefined) return false
    this.mergeTask(value.task)
    if (value.queue !== undefined) this.mergeQueue(value.queue)
    return true
  }

  /** Reload the selected queue from the live snapshot, or clear the draft. */
  private discardQueue(): void {
    this.drafts.update((state) => {
      const id = state.selectedQueueId
      const queue = id === undefined
        ? undefined
        : this.live.getSnapshot().queues.find(candidate => candidate.id === id)
      state.queue = queue === undefined
        ? null
        : {
          draft: queueDraftOf(queue),
          baseRevision: queue.revision,
          dirty: false,
          saving: false,
        }
      state.task = null
      state.queueTasks = []
      if (queue === undefined) state.selectedQueueId = undefined
    })
  }

  /**
   * Delete one queue and every stored record it owns.
   *
   * Deleting only changes HandsOff state. Workspace files and conversations stay
   * untouched unless the caller explicitly asks to archive the queue's Sessions
   * first; a failed archive keeps the queue so the caller can retry or choose
   * deletion without archiving. A card action names its own queue, so removing a
   * queue the page has not selected leaves the current draft alone.
   * @param options - which queue to remove and whether to archive its conversations.
   */
  private async deleteQueue(options: DeleteQueueOptions = {}): Promise<void> {
    const selected = this.drafts.getSnapshot().selectedQueueId
    const id = options.queueId ?? selected
    if (id === undefined) return this.localError('deleteQueue', 'ui/no-queue')
    const live = this.live.getSnapshot()
    const queue = live.queues.find(candidate => candidate.id === id)
    if (queue === undefined) return this.localError('deleteQueue', 'ui/queue-missing')
    const queueTasks = live.tasks.filter(task => task.queueId === id)
    // A live attempt still owns a Session and a run record; removing the queue
    // underneath it would leave an agent writing into deleted state.
    const taskIds = new Set(queueTasks.map(task => task.id))
    const liveRun = live.runs.some(run => taskIds.has(run.taskId) && canCancelRun(run.state))
    if (queue.state === 'running' || liveRun) return this.localError('deleteQueue', 'ui/queue-running')
    if (options.archiveSessions === true && queueTasks.length > 0) {
      const sessions = new Map<string, SessionLinkDto>()
      for (const task of queueTasks) {
        if (task.session !== undefined) sessions.set(task.session.sessionId, task.session)
      }
      for (const run of live.runs) {
        if (!taskIds.has(run.taskId)) continue
        if (run.session !== undefined) sessions.set(run.session.sessionId, run.session)
        for (const link of run.sessionLineage) sessions.set(link.sessionId, link)
      }
      if (sessions.size > 0) {
        const surface = this.resolveSurface?.()
        if (surface?.archive === undefined) {
          return this.localError('deleteQueue', 'ui/archive-unavailable')
        }
        for (const link of sessions.values()) {
          if (link.openState === 'archived' || surface.archived?.(link.sessionId) === true) continue
          try {
            await surface.archive(link.sessionId)
          } catch (error) {
            console.warn('session-orchestrator UI: could not archive the queue Session', error)
            return this.localError('deleteQueue', 'ui/archive-failed', link.sessionId)
          }
        }
      }
    }
    const value = await this.call('deleteDraftQueue', () => this.remote.deleteDraftQueue({
      queueId: id,
      expectedRevision: queue.revision,
    } satisfies DeleteDraftQueueRequest))
    if (value === undefined) return
    this.live.update((state) => {
      state.queues = state.queues.filter(candidate => candidate.id !== id)
      state.tasks = state.tasks.filter(task => task.queueId !== id)
      state.runs = state.runs.filter(run => !queueTasks.some(task => task.id === run.taskId))
    })
    if (selected !== id) return
    this.drafts.update((state) => {
      state.queue = null
      state.task = null
      state.queueTasks = []
      state.selectedQueueId = undefined
    })
  }

  /**
   * Rename one stored pipeline.
   *
   * Only the label this plugin owns changes: the Host Workspace, its folder and
   * every conversation stay where they are. The update carries the revision the
   * live snapshot just reported, so renaming a card cannot resurrect a stale
   * draft, and a dirty editor draft keeps its own revision for the next save.
   * @param queueId - queue whose label changes.
   * @param title - new non-empty label.
   */
  async renameQueue(queueId: string, title: string): Promise<void> {
    const next = title.trim()
    if (next === '') return this.localError('renameQueue', 'ui/queue-title-required')
    const queue = this.live.getSnapshot().queues.find(candidate => candidate.id === queueId)
    if (queue === undefined) return this.localError('renameQueue', 'ui/queue-missing')
    const draft: QueueDraft = {
      ...queueDraftOf(queue),
      taskOrder: queue.taskOrder,
      title: next,
    }
    const value = await this.call<QueueValue>('renameQueue', () => this.remote.updateQueue({
      queueId,
      expectedRevision: queue.revision,
      draft,
    } satisfies UpdateQueueRequest))
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.drafts.update((state) => {
      if (state.queue === null || state.queue.draft.id !== queueId || state.queue.dirty) return
      state.queue = {
        draft: queueDraftOf(value.queue),
        baseRevision: value.queue.revision,
        dirty: false,
        saving: false,
      }
    })
  }

  /**
   * Read the native host model catalog once.
   *
   * The page never invents routes: an absent `session/modelCatalog` service or
   * a rejected read leaves the fixed-model control disabled with that reason,
   * and only `inherit` stays selectable.
   */
  async loadModelCatalog(): Promise<void> {
    const current = this.live.getSnapshot().models
    if (current.phase === 'ready' || current.phase === 'loading') return
    const source = this.resolveModels?.()
    if (source === undefined) {
      this.live.update((state) => {
        state.models = {
          phase: 'error',
          choices: [],
          error: 'this host exposes no model catalog service',
        }
      })
      return
    }
    this.live.update((state) => {
      state.models = { phase: 'loading', choices: [] }
    })
    try {
      const choices = await source.load()
      this.live.update((state) => {
        state.models = { phase: 'ready', choices }
      })
    } catch (error) {
      this.live.update((state) => {
        state.models = {
          phase: 'error',
          choices: [],
          error: error instanceof Error ? error.message : String(error),
        }
      })
    }
  }

  /**
   * Read the native agent-preset roster once.
   *
   * Skills and permission presets are host-owned. A missing service leaves the
   * composer on "inherit" instead of inventing a skill list.
   */
  async loadPresetCatalog(): Promise<void> {
    const current = this.live.getSnapshot().presets
    if (current.phase === 'ready' || current.phase === 'loading') return
    const source = this.resolvePresets?.()
    if (source === undefined) {
      this.live.update((state) => {
        state.presets = {
          phase: 'error',
          choices: [],
          error: 'this host exposes no agent-preset catalog',
        }
      })
      return
    }
    this.live.update((state) => {
      state.presets = { phase: 'loading', choices: [] }
    })
    try {
      const choices = await source.load()
      this.live.update((state) => {
        state.presets = { phase: 'ready', choices }
      })
    } catch (error) {
      this.live.update((state) => {
        state.presets = {
          phase: 'error',
          choices: [],
          error: error instanceof Error ? error.message : String(error),
        }
      })
    }
  }

  /**
   * Load one task's full detail and seed its draft.
   * @param taskId - task identity to load.
   */
  async loadTask(taskId: string): Promise<void> {
    if (this.drafts.getSnapshot().task?.dirty === true) {
      return this.localError('loadTask', 'ui/unsaved-task')
    }
    const live = this.live.getSnapshot()
    const summary = live.tasks.find(task => task.id === taskId)
    if (summary === undefined) return this.localError('loadTask', 'ui/task-missing')
    const queueId = summary.queueId
    const value = await this.call<QueueDetailValue>('getQueue', () => this.remote.getQueue({ queueId }))
    if (value === undefined) return
    const detail = value.tasks.find(task => task.id === taskId)
    if (detail === undefined) return this.localError('loadTask', 'ui/task-hidden')
    this.drafts.update((state) => {
      const queueWasClean = state.queue === null || state.queue.dirty !== true
      if (queueWasClean) {
        state.selectedQueueId = value.queue.id
        state.queue = {
          draft: queueDraftOf(value.queue),
          baseRevision: value.queue.revision,
          dirty: false,
          saving: false,
        }
      }
      state.queueTasks = value.tasks
      state.task = {
        mode: 'edit',
        draft: taskDraftOf(detail),
        baseRevision: detail.revision,
        dirty: false,
        saving: false,
      }
    })
  }

  /**
   * Start a blank task at the end, or at one list position when given.
   * @param atIndex - zero-based insert position; the end when absent.
   */
  private newTask(atIndex?: number): void {
    if (this.blockDirtyTask('newTask')) return
    const state = this.drafts.getSnapshot()
    const queueId = state.selectedQueueId ?? state.queue?.draft.id
    if (queueId === undefined || queueId === '') return this.localError('newTask', 'ui/no-queue')
    this.drafts.update((draft) => {
      const inherited = draft.queue?.draft
      const initial = emptyTaskDraft(queueId)
      const workspace = inherited?.workspaceId === undefined
        ? initial
        : {
          ...initial,
          workspaceId: inherited.workspaceId,
          cwd: inherited.cwd ?? '',
        }
      draft.task = {
        mode: 'create',
        draft: workspace,
        baseRevision: 0,
        dirty: false,
        saving: false,
        ...(atIndex === undefined ? {} : { insertIndex: atIndex }),
      }
    })
  }

  /**
   * Replace editable task fields locally.
   * @param patch - changed task fields.
   */
  editTask(patch: TaskDraftPatch): void {
    this.drafts.update((state) => {
      const current = state.task
      if (current === null) return
      const next: TaskDraft = {
        ...current.draft,
        ...(patch.id === undefined ? {} : { id: patch.id }),
        ...(patch.queueId === undefined ? {} : { queueId: patch.queueId }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
        ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
        ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
        ...(patch.preset === undefined ? {} : { preset: patch.preset }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.skills === undefined ? {} : { skills: patch.skills }),
        ...(patch.dependsOn === undefined ? {} : { dependsOn: patch.dependsOn }),
        ...(patch.parallelWithPrevious === undefined
          ? (current.draft.parallelWithPrevious === undefined
            ? {}
            : { parallelWithPrevious: current.draft.parallelWithPrevious })
          : { parallelWithPrevious: patch.parallelWithPrevious }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.handoff === undefined ? {} : { handoff: patch.handoff }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.concurrencyGroup === undefined
          ? (current.draft.concurrencyGroup === undefined
            ? {}
            : { concurrencyGroup: current.draft.concurrencyGroup })
          : patch.concurrencyGroup === ''
            ? {}
            : { concurrencyGroup: patch.concurrencyGroup }),
      }
      state.task = { ...current, draft: next, dirty: true }
    })
  }

  /** Create or update the task under its draft revision. */
  async saveTask(): Promise<void> {
    const current = this.drafts.getSnapshot().task
    if (current === null) return this.localError('saveTask', 'ui/no-task')
    if (current.draft.queueId === '') return this.localError('saveTask', 'ui/queue-id-required')
    if (current.draft.prompt.trim() === '') return this.localError('saveTask', 'ui/task-prompt-required')
    if (current.draft.workspaceId.trim() === '') {
      return this.localError('saveTask', 'ui/workspace-required')
    }
    if (current.draft.cwd.trim() === '') return this.localError('saveTask', 'ui/workspace-path-required')
    const live = this.live.getSnapshot()
    const queue = live.queues.find(candidate => candidate.id === current.draft.queueId)
    if (queue === undefined) return this.localError('saveTask', 'ui/queue-missing')
    const order = orderedQueueTaskIds(queue, live.tasks)
    const position = current.mode === 'create'
      ? Math.min(current.insertIndex ?? order.length, order.length)
      : Math.max(order.indexOf(current.draft.id), 0)
    const draft: TaskDraft = current.mode === 'create' && current.draft.id === ''
      ? { ...current.draft, id: internalTaskId(queue.id, this.now()) }
      : current.draft
    this.setSaving('task', true)
    const value = await this.call<TaskValue>('upsertTask', () => this.remote.upsertTask({
      taskId: draft.id,
      expectedRevision: current.baseRevision,
      draft,
      position,
      queueRevision: queue.revision,
    } satisfies UpsertTaskRequest))
    this.setSaving('task', false)
    if (value === undefined) return
    this.mergeTask(value.task)
    if (value.queue !== undefined) this.mergeQueue(value.queue)
    this.drafts.update((state) => {
      const latest = state.task
      if (latest === null) return
      state.task = {
        mode: 'edit',
        draft: taskDraftOf(value.task),
        baseRevision: value.task.revision,
        dirty: false,
        saving: false,
      }
      state.queueTasks = replaceTask(state.queueTasks, value.task)
      if (state.queue !== null && state.queue.dirty !== true && value.queue !== undefined) {
        state.queue = {
          ...state.queue,
          draft: queueDraftOf(value.queue),
          baseRevision: value.queue.revision,
        }
      }
    })
  }

  /** Discard the task draft without writing. */
  private discardTask(): void {
    this.drafts.update((state) => { state.task = null })
  }

  /**
   * Toggle one task under the live summary revision.
   * @param taskId - task identity.
   * @param enabled - requested enabled flag.
   */
  async setTaskEnabled(taskId: string, enabled: boolean): Promise<void> {
    const summary = this.live.getSnapshot().tasks.find(task => task.id === taskId)
    if (summary === undefined) return this.localError('setTaskEnabled', 'ui/task-missing')
    const value = await this.call<TaskValue>('setTaskEnabled', () => this.remote.setTaskEnabled({
      taskId,
      expectedRevision: summary.revision,
      enabled,
    } satisfies SetTaskEnabledRequest))
    if (value === undefined) return
    this.mergeTask(value.task)
  }

  /**
   * Move one task one position in the live queue order.
   * @param taskId - task identity.
   * @param direction - move direction.
   */
  async moveTask(taskId: string, direction: MoveDirection): Promise<void> {
    const queue = this.selectedLiveQueue('moveTask')
    if (queue === undefined) return
    const order = orderedQueueTaskIds(queue, this.live.getSnapshot().tasks)
    const index = order.indexOf(taskId)
    if (index < 0) return this.localError('moveTask', 'ui/task-missing')
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= order.length) return
    await this.moveTaskTo(taskId, target)
  }

  /**
   * Move one task to a zero-based list position after a drag or a button move.
   *
   * The host rewrites every dependency from the resulting groups, so the move is
   * one durable commit rather than a client-side array shuffle.
   * @param taskId - task identity to move.
   * @param index - destination zero-based position.
   */
  async moveTaskTo(taskId: string, index: number): Promise<void> {
    const queue = this.selectedLiveQueue('moveTaskTo')
    if (queue === undefined) return
    const tasks = this.live.getSnapshot().tasks
    const order = orderedQueueTaskIds(queue, tasks)
    const from = order.indexOf(taskId)
    if (from < 0) return this.localError('moveTaskTo', 'ui/task-missing')
    const target = Math.max(0, Math.min(Math.trunc(index), order.length - 1))
    if (target === from) return
    order.splice(from, 1)
    order.splice(target, 0, taskId)
    const parallel = tasks
      .filter(task => task.queueId === queue.id && task.parallelWithPrevious === true)
      .map(task => task.id)
    await this.writeOrder(queue, order, parallel, 'moveTaskTo')
  }

  /**
   * Mark one task as running together with the item above it.
   * @param taskId - task identity whose marker changes.
   * @param parallel - whether the task joins the previous group.
   */
  async setTaskParallelWithPrevious(taskId: string, parallel: boolean): Promise<void> {
    const queue = this.selectedLiveQueue('setTaskParallelWithPrevious')
    if (queue === undefined) return
    const tasks = this.live.getSnapshot().tasks
    const order = orderedQueueTaskIds(queue, tasks)
    if (!order.includes(taskId)) return this.localError('setTaskParallelWithPrevious', 'ui/task-missing')
    const markers = new Set(tasks
      .filter(task => task.queueId === queue.id && task.parallelWithPrevious === true)
      .map(task => task.id))
    if (parallel) markers.add(taskId)
    else markers.delete(taskId)
    await this.writeOrder(queue, order, [...markers], 'setTaskParallelWithPrevious')
  }

  /**
   * Duplicate one task immediately below itself.
   * @param taskId - task identity to copy.
   */
  async duplicateTask(taskId: string): Promise<void> {
    const queue = this.selectedLiveQueue('duplicateTask')
    if (queue === undefined) return
    const value = await this.call<DuplicateTaskValue>('duplicateTask', () => this.remote.duplicateTask({
      queueId: queue.id,
      taskId,
      expectedRevision: queue.revision,
    } satisfies DuplicateTaskRequest))
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.mergeTask(value.task)
    this.adoptQueueRevision(value.queue)
  }

  /**
   * Delete one task and let the host repair every remaining dependency.
   * @param taskId - task identity to delete.
   */
  async deleteTask(taskId: string): Promise<void> {
    const queue = this.selectedLiveQueue('deleteTask')
    if (queue === undefined) return
    const task = this.live.getSnapshot().tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) return this.localError('deleteTask', 'ui/task-missing')
    if (task.session !== undefined) return this.localError('deleteTask', 'ui/task-has-run')
    const value = await this.call<DeleteTaskValue>('deleteTask', () => this.remote.deleteTask({
      queueId: queue.id,
      taskId,
      expectedRevision: queue.revision,
    } satisfies DeleteTaskRequest))
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.adoptQueueRevision(value.queue)
    this.live.update((state) => {
      state.tasks = state.tasks.filter(candidate => candidate.id !== taskId)
    })
    this.drafts.update((state) => {
      state.queueTasks = state.queueTasks.filter(candidate => candidate.id !== taskId)
      if (state.task?.draft.id === taskId) state.task = null
    })
  }

  /** Rewrite every dependency from the current list order. */
  async repairTaskList(): Promise<void> {
    const queue = this.selectedLiveQueue('repairTaskList')
    if (queue === undefined) return
    const value = await this.call<QueueValue>('repairTaskList', () => this.remote.repairTaskList({
      queueId: queue.id,
      expectedRevision: queue.revision,
    } satisfies RepairTaskListRequest))
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.adoptQueueRevision(value.queue)
  }

  /** Read the selected queue from the live snapshot or retain a failure. */
  private selectedLiveQueue(operation: string): QueueDto | undefined {
    const queueId = this.drafts.getSnapshot().selectedQueueId
    if (queueId === undefined) {
      this.localError(operation, 'ui/no-queue')
      return undefined
    }
    const queue = this.live.getSnapshot().queues.find(candidate => candidate.id === queueId)
    if (queue === undefined) this.localError(operation, 'ui/queue-missing')
    return queue
  }

  /** Send one complete order and marker set, then adopt the new queue revision. */
  private async writeOrder(
    queue: QueueDto,
    order: string[],
    parallel: readonly string[],
    operation: string,
  ): Promise<void> {
    const value = await this.call<QueueValue>(operation, () => this.remote.reorderTasks({
      queueId: queue.id,
      expectedRevision: queue.revision,
      taskOrder: order,
      parallelWithPrevious: parallel,
    } satisfies ReorderTasksRequest))
    if (value === undefined) return
    this.mergeQueue(value.queue)
    this.adoptQueueRevision(value.queue)
  }

  /** Keep a clean queue draft on the new revision after an order commit. */
  private adoptQueueRevision(queue: QueueDto): void {
    this.drafts.update((state) => {
      if (state.selectedQueueId !== queue.id) return
      if (state.queue === null || state.queue.dirty === true) return
      state.queue = {
        ...state.queue,
        draft: queueDraftOf(queue),
        baseRevision: queue.revision,
      }
    })
  }

  /** Seed the settings draft from the live settings record. */
  loadSettingsDraft(): void {
    const current = this.drafts.getSnapshot().settings
    if (current?.dirty === true) return
    const settings = this.live.getSnapshot().settings
    if (settings === undefined) return
    this.drafts.update((state) => {
      state.settings = {
        draft: {
          paused: settings.paused,
          maxConcurrentRuns: settings.maxConcurrentRuns,
          providerQuotas: { ...settings.providerQuotas },
        },
        baseRevision: settings.revision,
        dirty: false,
        saving: false,
      }
    })
  }

  /**
   * Replace settings draft fields.
   * @param patch - changed settings fields.
   */
  editSettings(patch: SettingsDraftPatch): void {
    this.drafts.update((state) => {
      const current = state.settings
      if (current === null) return
      state.settings = {
        ...current,
        draft: {
          paused: patch.paused ?? current.draft.paused,
          maxConcurrentRuns: patch.maxConcurrentRuns ?? current.draft.maxConcurrentRuns,
          providerQuotas: patch.providerQuotas ?? current.draft.providerQuotas,
        },
        dirty: true,
      }
    })
  }

  /** Add, replace, or remove one provider quota in the draft. */
  private setProviderQuota(provider: string, quota: number | undefined): void {
    this.drafts.update((state) => {
      const current = state.settings
      if (current === null) return
      const quotas = { ...current.draft.providerQuotas }
      if (quota === undefined) delete quotas[provider]
      else quotas[provider] = quota
      state.settings = { ...current, draft: { ...current.draft, providerQuotas: quotas }, dirty: true }
    })
  }

  /** Replace host settings under the settings draft revision. */
  async saveSettings(): Promise<void> {
    const current = this.drafts.getSnapshot().settings
    if (current === null) return this.localError('saveSettings', 'ui/no-settings')
    this.setSaving('settings', true)
    const value = await this.call<SettingsValue>('updateSettings', () => this.remote.updateSettings({
      expectedRevision: current.baseRevision,
      draft: current.draft,
    } satisfies UpdateSettingsRequest))
    this.setSaving('settings', false)
    if (value === undefined) return
    this.mergeSettings(value.settings)
    this.drafts.update((state) => {
      state.settings = {
        draft: {
          paused: value.settings.paused,
          maxConcurrentRuns: value.settings.maxConcurrentRuns,
          providerQuotas: { ...value.settings.providerQuotas },
        },
        baseRevision: value.settings.revision,
        dirty: false,
        saving: false,
      }
    })
  }

  /** Seed or reload the settings draft from the live record. */
  private discardSettings(): void {
    this.drafts.update((state) => { state.settings = null })
    this.loadSettingsDraft()
  }

  /** Pause the host scheduler under the live settings revision. */
  pause(): Promise<void> {
    return this.setPaused(true)
  }

  /** Resume the host scheduler under the live settings revision. */
  resume(): Promise<void> {
    return this.setPaused(false)
  }

  /**
   * Drive one queue lifecycle under the live queue revision.
   * @param action - which control to send.
   * @param queueId - queue identity.
   */
  async controlQueue(action: 'startQueue' | 'pauseQueue' | 'abortQueue', queueId: string): Promise<void> {
    const queue = this.live.getSnapshot().queues.find(candidate => candidate.id === queueId)
    if (queue === undefined) return this.localError(action, 'ui/queue-missing')
    const request = { queueId, expectedRevision: queue.revision }
    const value = await this.call<QueueValue>(action, () => this.remote[action](request))
    if (value === undefined) return
    this.mergeQueue(value.queue)
  }

  /** Pause or resume the host scheduler under the live settings revision. */
  private async setPaused(paused: boolean): Promise<void> {
    const settings = this.live.getSnapshot().settings
    if (settings === undefined) return this.localError(paused ? 'pause' : 'resume', 'ui/settings-unavailable')
    const request = { expectedRevision: settings.revision } satisfies SettingsRevisionRequest
    const value = await this.call<SettingsValue>(
      paused ? 'pause' : 'resume',
      () => paused ? this.remote.pause(request) : this.remote.resume(request),
    )
    if (value === undefined) return
    this.mergeSettings(value.settings)
  }

  /**
   * Cancel one run under the live run revision.
   * @param runId - run identity.
   */
  async cancelRun(runId: string): Promise<void> {
    const run = this.live.getSnapshot().runs.find(candidate => candidate.id === runId)
    if (run === undefined) return this.localError('cancelRun', 'ui/run-missing')
    const value = await this.call<RunValue>('cancel', () => this.remote.cancel({
      runId,
      expectedRevision: run.revision,
    } satisfies CancelRunRequest))
    if (value === undefined) return
    this.mergeRun(value.run)
  }

  /**
   * Start a fresh attempt under the live run revision.
   * @param runId - settled run identity.
   */
  async retryRun(runId: string): Promise<void> {
    const runs = this.live.getSnapshot().runs
    const run = runs.find(candidate => candidate.id === runId)
    if (run === undefined) return this.localError('retryRun', 'ui/run-missing')
    if (!canRetryRun(run)) return this.localError('retryRun', 'ui/run-not-retryable')
    if (runs.some(candidate => candidate.taskId === run.taskId && candidate.attempt > run.attempt)) {
      return this.localError('retryRun', 'ui/run-not-retryable')
    }
    const value = await this.call<RunValue>('retry', () => this.remote.retry({
      runId,
      expectedRevision: run.revision,
    } satisfies RetryRunRequest))
    if (value === undefined) return
    this.mergeRun(value.run)
  }

  /**
   * Record one audited human skip under the live run revision.
   * @param runId - run awaiting attention.
   * @param actor - operator recorded with the skip.
   * @param reason - operator's reason recorded with the skip.
   */
  async skipRun(runId: string, actor: string, reason: string): Promise<void> {
    const run = this.live.getSnapshot().runs.find(candidate => candidate.id === runId)
    if (run === undefined) return this.localError('skipRun', 'ui/run-missing')
    if (!canSkipRun(run)) return this.localError('skipRun', 'ui/run-not-skippable')
    if (actor.trim() === '' || reason.trim() === '') {
      return this.localError('skipRun', 'ui/audit-required')
    }
    const value = await this.call<SkipTaskValue>('skipTask', () => this.remote.skipTask({
      runId,
      expectedRevision: run.revision,
      actor,
      reason,
    } satisfies SkipTaskRequest))
    if (value === undefined) return
    this.live.update((state) => {
      state.runs = state.runs.map(candidate =>
        candidate.id === runId ? { ...candidate, skipped: true } : candidate)
    })
  }

  /**
   * Open the Session a run, task or intervention actually executed in.
   *
   * The identity the host projected is the only navigation key: no title is
   * searched, no "newest Session" is substituted, and no draft is dropped to
   * make room. Every refusal is retained as a stable code so the page can say
   * which of the four reasons it was.
   * @param session - host-projected link.
   */
  async openSession(session: SessionLinkDto): Promise<void> {
    if (!session.linkable || session.openState === 'unsupported') {
      return this.localError('openSession', 'ui/session-unsupported', session.sessionId)
    }
    if (session.openState === 'archived') {
      return this.localError('openSession', 'ui/session-archived', session.sessionId)
    }
    await this.openSessionById(session.sessionId)
  }

  /**
   * Open one Session by identity alone, for a link that outlived this page.
   *
   * A route carries no DTO, so the surface is the authority here: the catalog
   * decides whether the Session still exists and the Workspace registry whether
   * it was archived. The catalog is refreshed once before an absence is trusted,
   * because a Session created by an automated run never entered it through the
   * browser's own creation path.
   * @param sessionId - Session identity a route named.
   */
  async openSessionById(sessionId: string): Promise<void> {
    const surface = this.resolveSurface?.()
    if (surface === undefined) {
      return this.localError('openSession', 'ui/session-unsupported', sessionId)
    }
    // Automated runs create their Session on the Host, bypassing the browser's
    // own Session creation, so a ready catalog can still predate that Session.
    // Pull once before an absence is treated as proof; a still-missing identity
    // after the refresh keeps the explicit refusal instead of failing silently.
    if (surface.knows(sessionId) !== true && surface.refresh !== undefined) {
      try {
        await surface.refresh()
      } catch (error) {
        console.warn('session-orchestrator UI: could not refresh the Session catalog', error)
      }
    }
    if (surface.knows(sessionId) === false) {
      return this.localError('openSession', 'ui/session-missing', sessionId)
    }
    if (surface.archived?.(sessionId) === true) {
      return this.localError('openSession', 'ui/session-archived', sessionId)
    }
    try {
      surface.open(sessionId)
    } catch (error) {
      this.recordFailure('openSession', error)
    }
  }

  /**
   * Retarget one conversation and, when asked, the pipeline's unstarted tasks.
   *
   * A live conversation takes the route through the native Session controller,
   * so its next turn uses the chosen model. Nothing else changes unless the
   * caller explicitly names future tasks: switching one conversation never
   * silently alters its successors.
   * @param input - task, optional live Session, fixed route and future task ids.
   * @returns whether the switch was applied.
   */
  async switchConversationModel(input: SwitchConversationModelInput): Promise<boolean> {
    if (input.model.kind !== 'fixed') {
      this.localError('switchConversationModel', 'ui/model-route-required')
      return false
    }
    const context = await this.conversationDetail(input.taskId, 'switchConversationModel')
    if (context === undefined) return false
    if (input.sessionId !== undefined) {
      const surface = this.resolveSurface?.()
      if (surface?.selectModel === undefined) {
        this.localError('switchConversationModel', 'ui/session-unsupported', input.sessionId)
        return false
      }
      try {
        await surface.selectModel(input.sessionId, {
          provider: input.model.provider,
          model: input.model.model,
          ...(input.model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: input.model.reasoningEffort }),
        })
      } catch (error) {
        this.recordFailure('switchConversationModel', error)
        return false
      }
    }
    const targets = new Map<string, TaskDto>()
    for (const taskId of input.applyFutureTaskIds ?? []) {
      if (taskId === context.task.id) continue
      const target = context.detail.tasks.find(candidate => candidate.id === taskId)
      if (target !== undefined) targets.set(target.id, target)
    }
    for (const target of targets.values()) {
      const value = await this.call<TaskValue>('switchConversationModel', () => this.remote.upsertTask({
        taskId: target.id,
        expectedRevision: target.revision,
        draft: { ...taskDraftOf(target), model: input.model },
      } satisfies UpsertTaskRequest))
      if (value === undefined) return false
      this.mergeTask(value.task)
      if (value.queue !== undefined) this.mergeQueue(value.queue)
    }
    if (input.muteQueuePrompt === true) {
      const muted = mutedModelSwitchQueues()
      muted.add(context.queue.id)
      writeMutedModelSwitchQueues(muted)
    }
    return true
  }

  /**
   * Insert one follow-up child conversation immediately after its parent.
   *
   * The child is a normal queued task with `parentTaskId` and a dependency on the
   * parent, so it persists, inherits the parent's workspace/preset, and is
   * scheduled before the parent can count as complete. The chosen text becomes
   * the child prompt with the parent task as context.
   * @param input - parent task and the user's follow-up text.
   * @returns whether the child was stored.
   */
  async followUpConversation(input: FollowUpConversationInput): Promise<boolean> {
    const prompt = input.prompt.trim()
    if (prompt === '') {
      this.localError('followUpConversation', 'ui/pipeline-prompt-required')
      return false
    }
    return await this.createChildConversation(
      input.taskId,
      titleFromPrompt(prompt),
      parent => `继续上一轮对话「${parent.title}」。\n原任务提示词：${parent.prompt}\n\n追问：${prompt}`,
      'followUpConversation',
    )
  }

  /**
   * Insert one child conversation that reruns the unfinished part of its parent.
   * @param taskId - parent task whose conversation is being continued.
   * @param title - localized child title supplied by the page.
   * @returns whether the child was stored.
   */
  async rerunConversation(taskId: string, title: string): Promise<boolean> {
    return await this.createChildConversation(
      taskId,
      title,
      parent => `重新执行上一轮对话未完成部分。\n原任务提示词：${parent.prompt}`,
      'rerunConversation',
    )
  }

  /**
   * Remove one conversation and no other task in its pipeline.
   *
   * The caller may first archive the native Session; the durable Session and
   * workspace files are never deleted here. Removing the task also purges its
   * attempts and operation records through the Host's delete contract.
   * @param input - owning task and whether to archive its Session.
   * @returns whether the conversation was removed.
   */
  async deleteConversation(input: DeleteConversationInput): Promise<boolean> {
    const context = await this.conversationDetail(input.taskId, 'deleteConversation')
    if (context === undefined) return false
    const sessionId = context.task.session?.sessionId
    if (input.archiveSession && sessionId !== undefined) {
      const surface = this.resolveSurface?.()
      if (surface?.archive === undefined) {
        this.localError('deleteConversation', 'ui/archive-unavailable', sessionId)
        return false
      }
      try {
        await surface.archive(sessionId)
      } catch (error) {
        this.recordFailure('deleteConversation', error)
        return false
      }
    }
    const value = await this.call<DeleteTaskValue>('deleteConversation', () => this.remote.deleteTask({
      queueId: context.queue.id,
      taskId: input.taskId,
      expectedRevision: context.queue.revision,
    } satisfies DeleteTaskRequest))
    if (value === undefined) return false
    this.mergeQueue(value.queue)
    this.adoptQueueRevision(value.queue)
    this.live.update((state) => {
      state.tasks = state.tasks.filter(candidate => candidate.id !== input.taskId)
      state.runs = state.runs.filter(candidate => candidate.taskId !== input.taskId)
    })
    this.drafts.update((state) => {
      state.queueTasks = state.queueTasks.filter(candidate => candidate.id !== input.taskId)
      if (state.task?.draft.id === input.taskId) state.task = null
    })
    return true
  }

  /** Read the queue and full task a conversation action addresses. */
  private async conversationDetail(
    taskId: string,
    operation: string,
  ): Promise<{ detail: QueueDetailValue; queue: QueueDto; task: TaskDto } | undefined> {
    const summary = this.live.getSnapshot().tasks.find(candidate => candidate.id === taskId)
    if (summary === undefined) {
      this.localError(operation, 'ui/task-missing')
      return undefined
    }
    const detail = await this.call<QueueDetailValue>(operation, () => this.remote.getQueue({
      queueId: summary.queueId,
    } satisfies GetQueueRequest))
    if (detail === undefined) return undefined
    const task = detail.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) {
      this.localError(operation, 'ui/task-missing')
      return undefined
    }
    return { detail, queue: detail.queue, task }
  }

  /** Build and insert one persistent child conversation under its parent. */
  private async createChildConversation(
    parentTaskId: string,
    title: string,
    promptOf: (parent: TaskDto) => string,
    operation: string,
  ): Promise<boolean> {
    const context = await this.conversationDetail(parentTaskId, operation)
    if (context === undefined) return false
    const { detail, queue, task: parent } = context
    if (parent.session === undefined) {
      this.localError(operation, 'ui/session-missing', parentTaskId)
      return false
    }
    const order = queue.taskOrder
    const parentIndex = order.indexOf(parent.id)
    let position = parentIndex < 0 ? order.length : parentIndex + 1
    const childIds = new Set(detail.tasks
      .filter(candidate => candidate.parentTaskId === parent.id)
      .map(candidate => candidate.id))
    while (position < order.length && childIds.has(order[position]!)) position += 1
    const taskId = internalTaskId(queue.id, this.now())
    const draft: TaskDraft = {
      ...emptyTaskDraft(queue.id),
      id: taskId,
      title,
      prompt: promptOf(parent),
      workspaceId: parent.workspaceId,
      cwd: parent.cwd,
      preset: parent.preset,
      model: { kind: 'inherit' },
      skills: parent.skills,
      dependsOn: [parent.id],
      parentTaskId: parent.id,
      priority: parent.priority,
      handoff: parent.handoff,
      enabled: true,
    }
    const value = await this.call<TaskValue>(operation, () => this.remote.upsertTask({
      taskId,
      expectedRevision: 0,
      draft,
      position,
      queueRevision: queue.revision,
    } satisfies UpsertTaskRequest))
    if (value === undefined) return false
    this.mergeTask(value.task)
    if (value.queue !== undefined) this.mergeQueue(value.queue)
    return true
  }

  /** Remove one retained failure. */
  private dismissError(id: string): void {
    this.drafts.update((state) => {
      state.errors = state.errors.filter(error => error.id !== id)
    })
  }

  /** Remove every retained failure. */
  private clearErrors(): void {
    this.drafts.update((state) => { state.errors = [] })
  }

  /** Invoke one Remote method while marking the page busy and retaining failure. */
  private async call<T>(
    operation: string,
    invoke: () => Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }>,
  ): Promise<T | undefined> {
    if (this.disposed) {
      this.localError(operation, 'ui/disposed')
      return undefined
    }
    if (this.drafts.getSnapshot().busy !== undefined) {
      this.localError(operation, 'ui/busy')
      return undefined
    }
    this.drafts.update((state) => { state.busy = operation })
    try {
      const result = await invoke()
      if (result.ok) return result.value
      this.recordFailure(operation, result.error)
      return undefined
    } catch (error) {
      this.recordFailure(operation, error)
      return undefined
    } finally {
      this.drafts.update((state) => { state.busy = undefined })
    }
  }

  /** Retain one failure record without losing an earlier one. */
  private recordFailure(operation: string, failure: unknown): void {
    this.errorSequence += 1
    const error = clientErrorFrom(operation, failure, this.now(), `error-${this.errorSequence}`)
    this.drafts.update((state) => { state.errors = [error, ...state.errors] })
  }

  /**
   * Retain one local, stable-code failure before any Remote call.
   * @param operation - page operation that failed.
   * @param code - stable local failure code.
   * @param detail - subject the failure names, such as one Session identity.
   */
  private localError(operation: string, code: string, detail?: string): void {
    this.errorSequence += 1
    const error: ClientError = {
      id: `error-${this.errorSequence}`,
      at: this.now(),
      operation,
      code,
      message: '',
      ...(detail === undefined ? {} : { detail }),
    }
    this.drafts.update((state) => { state.errors = [error, ...state.errors] })
  }

  /** Block a queue or task switch while an unsaved draft exists. */
  private blockDirty(operation: string): boolean {
    const state = this.drafts.getSnapshot()
    if (state.queue?.dirty === true) {
      this.localError(operation, 'ui/unsaved-queue')
      return true
    }
    if (state.task?.dirty === true) {
      this.localError(operation, 'ui/unsaved-task')
      return true
    }
    return false
  }

  /** Block a task draft replacement while that draft has unsaved edits. */
  private blockDirtyTask(operation: string): boolean {
    if (this.drafts.getSnapshot().task?.dirty !== true) return false
    this.localError(operation, 'ui/unsaved-task')
    return true
  }

  /** Set one draft's saving flag. */
  private setSaving(field: 'queue' | 'task' | 'settings', saving: boolean): void {
    this.drafts.update((state) => {
      if (field === 'queue' && state.queue !== null) state.queue = { ...state.queue, saving }
      if (field === 'task' && state.task !== null) state.task = { ...state.task, saving }
      if (field === 'settings' && state.settings !== null) state.settings = { ...state.settings, saving }
    })
  }

  /** Replace one live queue projection. */
  private mergeQueue(queue: QueueDto): void {
    this.live.update((state) => {
      const index = state.queues.findIndex(candidate => candidate.id === queue.id)
      const queues = index < 0
        ? [...state.queues, queue]
        : state.queues.map(candidate => candidate.id === queue.id ? queue : candidate)
      state.queues = queues
    })
    this.rebaseCleanQueueDraft(this.live.getSnapshot().queues)
  }

  /**
   * Follow the store's revision for a queue draft the user has not edited.
   *
   * A clean draft carries no edit worth protecting, so its baseline must track
   * the store after every mutation this page performed (create, start, pause,
   * abort) and every revision the runtime writes on its own — otherwise the
   * next save reports a conflict the user cannot act on. A dirty draft keeps
   * the revision it was edited against, so a real concurrent change still
   * surfaces instead of being silently rebased.
   * @param queues - the queue projections now in force.
   */
  private rebaseCleanQueueDraft(queues: readonly QueueDto[]): void {
    const current = this.drafts.getSnapshot().queue
    if (current === null || current.dirty || current.saving || current.baseRevision === 0) return
    const live = queues.find(queue => queue.id === current.draft.id)
    if (live === undefined || live.revision === current.baseRevision) return
    this.drafts.update((state) => {
      state.queue = { ...current, baseRevision: live.revision }
    })
  }

  /** Replace one live run projection, or append a fresh attempt. */
  private mergeRun(run: RunDto): void {
    this.live.update((state) => {
      state.runs = state.runs.some(candidate => candidate.id === run.id)
        ? state.runs.map(candidate => candidate.id === run.id ? run : candidate)
        : [...state.runs, run]
    })
  }

  /** Replace one live task summary and its loaded detail projection. */
  private mergeTask(task: TaskDto): void {
    const summary: TaskSummaryDto = {
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
      revision: task.revision,
    }
    this.live.update((state) => {
      state.tasks = state.tasks.some(candidate => candidate.id === task.id)
        ? state.tasks.map(candidate => candidate.id === task.id ? summary : candidate)
        : [...state.tasks, summary]
    })
    this.drafts.update((state) => {
      state.queueTasks = replaceTask(state.queueTasks, task)
    })
  }

  /** Replace one live settings projection. */
  private mergeSettings(settings: SettingsDto): void {
    this.live.update((state) => { state.settings = settings })
  }
}

/** Return one full task projection with `task` replacing an equal identity. */
function replaceTask(tasks: readonly TaskDto[], task: TaskDto): readonly TaskDto[] {
  return tasks.some(candidate => candidate.id === task.id)
    ? tasks.map(candidate => candidate.id === task.id ? task : candidate)
    : [...tasks, task]
}

/** Generate the opaque queue identity the form never exposes. */
function internalQueueId(now: number): string {
  return `q-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Generate the opaque task identity the form never exposes. */
function internalTaskId(queueId: string, now: number): string {
  return `${queueId}-t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Resolve one queue's visible task ids in list order, then extras by id. */
function orderedQueueTaskIds(queue: QueueDto, tasks: readonly TaskSummaryDto[]): string[] {
  const queueTasks = tasks.filter(task => task.queueId === queue.id)
  const known = new Map(queueTasks.map(task => [task.id, task]))
  const order: string[] = []
  for (const id of queue.taskOrder) {
    if (known.has(id) && !order.includes(id)) order.push(id)
  }
  const extras = [...known.keys()]
    .filter(id => !order.includes(id))
    .sort((left, right) => left.localeCompare(right))
  return [...order, ...extras]
}

/** Derive a short label from the prompt's first non-empty line. */
function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line !== '') ?? prompt.trim()
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

/** Project a stored queue into the editable draft the form owns. */
function queueDraftOf(queue: QueueDto): QueueDraftFields {
  return {
    id: queue.id,
    title: queue.title,
    paused: queue.paused,
    ...(queue.brief === undefined ? {} : { brief: queue.brief }),
    ...(queue.workspaceId === undefined ? {} : { workspaceId: queue.workspaceId }),
    ...(queue.cwd === undefined ? {} : { cwd: queue.cwd }),
    ...(queue.model === undefined ? {} : { model: queue.model }),
    ...(queue.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: queue.maxConcurrentRuns }),
  }
}

/** Project a stored task into the editable draft the form owns. */
function taskDraftOf(task: TaskDto): TaskDraft {
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
    ...(task.concurrencyGroup === undefined ? {} : { concurrencyGroup: task.concurrencyGroup }),
    priority: task.priority,
    handoff: task.handoff,
    enabled: task.enabled,
    // Stage and lineage are structural: an edit that overwrites prompt or model
    // must carry them back, or saving would strip a template stage of its stage.
    ...(task.stage === undefined ? {} : { stage: task.stage }),
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    ...(task.parallelWithPrevious === true ? { parallelWithPrevious: true } : {}),
  }
}
