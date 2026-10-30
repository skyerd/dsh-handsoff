/**
 * Front-end-owned state for the automation studio additions.
 *
 * The orchestration snapshot stays the authority for queues, tasks and runs.
 * This store only holds what this page lets a person configure locally: model
 * choices per queue, automation thresholds, engineering constraints, skills,
 * pipeline skill references, improvements and the butler conversation.
 *
 * Keeping it in one external store lets the Automation, Skill and Memory views
 * see the same edits without adding a second Remote namespace.
 */

import { useSyncExternalStore } from 'react'
import type { OrchestratorTranslate } from './copy.ts'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'

/** One product-owned string: a dictionary key before editing, text afterwards. */
export type StudioText =
  | { readonly kind: 'key'; readonly value: SessionOrchestratorSettingsLocaleKey }
  | { readonly kind: 'text'; readonly value: string }

/** Resolve one studio string against the active dictionary. */
export function studioText(value: StudioText, t: OrchestratorTranslate): string {
  return value.kind === 'key' ? t(value.value) : value.value
}

/** Editable numeric automation thresholds. */
export interface AutomationParams {
  /** Context occupancy percentage that starts a handoff. */
  readonly contextThreshold: number
  /** Silence window in minutes before the host probes a task. */
  readonly idleMinutes: number
  /** Cache-hit rate above which the scheduler may split remaining work. */
  readonly cacheWarn: number
  /** Cache-hit rate below which every queue stops. */
  readonly cacheAbort: number
  /** Per-model token budget; reaching it hands the task over. */
  readonly tokenLimit: number
}

/** Engineering guardrails shown alongside the automation thresholds. */
export interface EngineeringConstraints {
  /** Largest source paragraph a task may add before splitting the file. */
  readonly codeParagraphLimit: number
  /** How a deliverable should be split across files. */
  readonly fileSplit: string
  /** Paths and symbols a task should read first. */
  readonly readScope: string
  /** Paths a task must not open. */
  readonly excludeScope: string
  /** Content a compression pass must keep even when the context is trimmed. */
  readonly preserveContent: string
}

/** Model routes one queue uses for its two automatic roles. */
export interface QueueModelSelection {
  /** Model that supervises the queue. */
  readonly supervisor: string
  /** Model that decomposes remaining work into tasks. */
  readonly splitter: string
}

/** Where a skill belongs in the management page. */
export type SkillScope = 'global' | 'professional'

/** Badge describing where a skill came from. */
export type SkillBadge = 'user' | 'professional' | 'preset' | 'custom'

/** One stored skill document revision. */
export interface SkillVersion {
  readonly id: string
  readonly at: number
  readonly content: StudioText
  readonly note: StudioText
}

/** One editable skill card. */
export interface StudioSkill {
  readonly id: string
  readonly name: StudioText
  readonly description: StudioText
  readonly scope: SkillScope
  readonly badge: SkillBadge
  /** Folder identity; `null` means the ungrouped root. */
  readonly groupId: string | null
  readonly enabled: boolean
  readonly content: StudioText
  /** Number of projects where this improvement was observed. */
  readonly projectCount: number
  readonly versions: readonly SkillVersion[]
}

/** One nested skill folder. */
export interface SkillGroup {
  readonly id: string
  readonly name: StudioText
  /** Parent folder; `null` means a top-level folder. */
  readonly parentId: string | null
}

/** Skill references owned by one pipeline and its tasks. */
export interface QueueSkillRefs {
  /** Pipeline-wide skills, referenced by every task. */
  readonly global: readonly string[]
  /** Task id to task-local skill ids. */
  readonly tasks: Readonly<Record<string, readonly string[]>>
}

/** One observed improvement, shown in the global improvement area. */
export interface Improvement {
  readonly id: string
  readonly title: string
  readonly cause: string
  readonly action: string
  readonly result: string
  /** Projects where the same problem appeared. */
  readonly projects: readonly string[]
  readonly at: number
}

/** One proactive reminder from the butler. */
export interface ButlerNotice {
  readonly id: string
  readonly title: StudioText
  readonly body: StudioText
  readonly at: number
}

/** One message in the butler conversation. */
export interface MemoryMessage {
  readonly id: string
  readonly role: 'user' | 'butler'
  readonly text: StudioText
  readonly at: number
}

/** Everything this front-end owns outside the live snapshot. */
export interface StudioState {
  readonly automation: AutomationParams
  readonly engineering: EngineeringConstraints
  readonly queueModels: Readonly<Record<string, QueueModelSelection>>
  readonly skills: readonly StudioSkill[]
  readonly groups: readonly SkillGroup[]
  readonly refs: Readonly<Record<string, QueueSkillRefs>>
  readonly improvements: readonly Improvement[]
  readonly notices: readonly ButlerNotice[]
  readonly messages: readonly MemoryMessage[]
  /** Requested automatic optimisation, so one condition never nags twice. */
  readonly alertHandled: boolean
}

const DEFAULT_AUTOMATION: AutomationParams = {
  contextThreshold: 60,
  idleMinutes: 20,
  cacheWarn: 90,
  cacheAbort: 50,
  tokenLimit: 120_000,
}

const DEFAULT_ENGINEERING: EngineeringConstraints = {
  codeParagraphLimit: 700,
  fileSplit: '',
  readScope: '',
  excludeScope: '',
  preserveContent: '',
}

function key(value: SessionOrchestratorSettingsLocaleKey): StudioText {
  return { kind: 'key', value }
}

function text(value: string): StudioText {
  return { kind: 'text', value }
}

function versions(
  seed: string,
  current: SessionOrchestratorSettingsLocaleKey,
  notes: readonly SessionOrchestratorSettingsLocaleKey[],
): readonly SkillVersion[] {
  const last = notes.length - 1
  return notes.map((note, index) => ({
    id: `${seed}-v${String(index + 1)}`,
    at: index,
    content: key(index === last ? current : 'skillSeedVersionContent'),
    note: key(note),
  }))
}

const DEFAULT_SKILLS: readonly StudioSkill[] = [
  {
    id: 'global-user-confirm',
    name: key('skillSeedUserConfirmName'),
    description: key('skillSeedUserConfirmDesc'),
    scope: 'global',
    badge: 'user',
    groupId: null,
    enabled: true,
    content: key('skillSeedUserConfirmBody'),
    projectCount: 3,
    versions: versions('global-user-confirm', 'skillSeedUserConfirmBody', ['skillVersionNoteInitial', 'skillVersionNoteImproved']),
  },
  {
    id: 'global-user-cross',
    name: key('skillSeedUserCrossName'),
    description: key('skillSeedUserCrossDesc'),
    scope: 'global',
    badge: 'user',
    groupId: null,
    enabled: true,
    content: key('skillSeedUserCrossBody'),
    projectCount: 2,
    versions: versions('global-user-cross', 'skillSeedUserCrossBody', ['skillVersionNoteInitial', 'skillVersionNoteImproved']),
  },
  {
    id: 'global-pro-no-read',
    name: key('skillSeedNoReadName'),
    description: key('skillSeedNoReadDesc'),
    scope: 'global',
    badge: 'professional',
    groupId: null,
    enabled: true,
    content: key('skillSeedNoReadBody'),
    projectCount: 4,
    versions: versions('global-pro-no-read', 'skillSeedNoReadBody', ['skillVersionNoteInitial', 'skillVersionNoteImproved']),
  },
  {
    id: 'global-pro-ask',
    name: key('skillSeedAskName'),
    description: key('skillSeedAskDesc'),
    scope: 'global',
    badge: 'professional',
    groupId: null,
    enabled: true,
    content: key('skillSeedAskBody'),
    projectCount: 2,
    versions: versions('global-pro-ask', 'skillSeedAskBody', ['skillVersionNoteInitial']),
  },
  {
    id: 'global-pro-doc',
    name: key('skillSeedDocName'),
    description: key('skillSeedDocDesc'),
    scope: 'global',
    badge: 'professional',
    groupId: null,
    enabled: true,
    content: key('skillSeedDocBody'),
    projectCount: 3,
    versions: versions('global-pro-doc', 'skillSeedDocBody', ['skillVersionNoteInitial']),
  },
  {
    id: 'pro-preset-review',
    name: key('skillSeedReviewName'),
    description: key('skillSeedReviewDesc'),
    scope: 'professional',
    badge: 'preset',
    groupId: 'group-backend',
    enabled: true,
    content: key('skillSeedReviewBody'),
    projectCount: 1,
    versions: versions('pro-preset-review', 'skillSeedReviewBody', ['skillVersionNoteInitial']),
  },
  {
    id: 'pro-preset-split',
    name: key('skillSeedSplitName'),
    description: key('skillSeedSplitDesc'),
    scope: 'professional',
    badge: 'preset',
    groupId: 'group-frontend',
    enabled: true,
    content: key('skillSeedSplitBody'),
    projectCount: 1,
    versions: versions('pro-preset-split', 'skillSeedSplitBody', ['skillVersionNoteInitial']),
  },
  {
    id: 'pro-user-migration',
    name: key('skillSeedMigrationName'),
    description: key('skillSeedMigrationDesc'),
    scope: 'professional',
    badge: 'custom',
    groupId: 'group-database',
    enabled: false,
    content: key('skillSeedMigrationBody'),
    projectCount: 1,
    versions: versions('pro-user-migration', 'skillSeedMigrationBody', ['skillVersionNoteInitial']),
  },
]

const DEFAULT_GROUPS: readonly SkillGroup[] = [
  { id: 'group-backend', name: key('skillGroupBackend'), parentId: null },
  { id: 'group-database', name: key('skillGroupDatabase'), parentId: 'group-backend' },
  { id: 'group-frontend', name: key('skillGroupFrontend'), parentId: null },
]

let state: StudioState = {
  automation: DEFAULT_AUTOMATION,
  engineering: DEFAULT_ENGINEERING,
  queueModels: {},
  skills: DEFAULT_SKILLS,
  groups: DEFAULT_GROUPS,
  refs: {},
  improvements: [],
  notices: [],
  messages: [{ id: 'butler-greeting', role: 'butler', text: key('memoryGreeting'), at: 0 }],
  alertHandled: false,
}

const listeners = new Set<() => void>()
let sequence = 0

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${String(sequence)}`
}

function publish(next: StudioState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Subscribe to local studio changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Read the current local studio state.
 * @returns the immutable snapshot.
 */
export function getStudioState(): StudioState {
  return state
}

/** Read local studio state from a React component. */
export function useStudio(): StudioState {
  return useSyncExternalStore(subscribe, getStudioState, getStudioState)
}

/** Replace automation thresholds. */
export function saveAutomation(automation: AutomationParams): void {
  publish({ ...state, automation, alertHandled: false })
}

/** Replace engineering constraints. */
export function saveEngineering(engineering: EngineeringConstraints): void {
  publish({ ...state, engineering })
}

/** Store one queue's two model routes. */
export function saveQueueModels(queueId: string, selection: QueueModelSelection): void {
  publish({ ...state, queueModels: { ...state.queueModels, [queueId]: selection } })
}

/** Mark the current alert as handled so it does not reopen this session. */
export function markAlertHandled(): void {
  publish({ ...state, alertHandled: true })
}

/** Toggle one skill's enabled flag. */
export function setSkillEnabled(skillId: string, enabled: boolean): void {
  publish({
    ...state,
    skills: state.skills.map(skill => skill.id === skillId ? { ...skill, enabled } : skill),
  })
}

/** Patch one skill's editable fields and record a document revision. */
export function editSkill(skillId: string, patch: {
  readonly name?: StudioText
  readonly description?: StudioText
  readonly content?: StudioText
  readonly groupId?: string | null
}): void {
  publish({
    ...state,
    skills: state.skills.map((skill) => {
      if (skill.id !== skillId) return skill
      const content = patch.content ?? skill.content
      const versions = patch.content === undefined
        ? skill.versions
        : [
          ...skill.versions,
          {
            id: nextId(`${skillId}-v`),
            at: Date.now(),
            content,
            note: key('skillVersionNoteEdited'),
          },
        ]
      return {
        ...skill,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        content,
        ...(patch.groupId === undefined ? {} : { groupId: patch.groupId }),
        versions,
      }
    }),
  })
}

/** Restore one stored document version and keep the restore as a new revision. */
export function restoreSkill(skillId: string, versionId: string): void {
  const skill = state.skills.find(candidate => candidate.id === skillId)
  const version = skill?.versions.find(candidate => candidate.id === versionId)
  if (skill === undefined || version === undefined) return
  publish({
    ...state,
    skills: state.skills.map((candidate) => {
      if (candidate.id !== skillId) return candidate
      return {
        ...candidate,
        content: version.content,
        versions: [
          ...candidate.versions,
          {
            id: nextId(`${skillId}-v`),
            at: Date.now(),
            content: version.content,
            note: key('skillVersionNoteRestore'),
          },
        ],
      }
    }),
  })
}

/** Add a user-owned professional skill. */
export function addSkill(input: {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly groupId: string | null
  readonly preset: boolean
  /** Where the skill appears; defaults to the professional library. */
  readonly scope?: SkillScope | undefined
  /** Source badge; defaults from the preset flag. */
  readonly badge?: SkillBadge | undefined
}): void {
  const id = nextId('skill')
  const skill: StudioSkill = {
    id,
    name: text(input.name),
    description: text(input.description),
    scope: input.scope ?? 'professional',
    badge: input.badge ?? (input.preset ? 'preset' : 'custom'),
    groupId: input.groupId,
    enabled: true,
    content: text(input.content),
    projectCount: 1,
    versions: [{
      id: `${id}-v1`,
      at: Date.now(),
      content: text(input.content),
      note: key('skillVersionNoteInitial'),
    }],
  }
  publish({ ...state, skills: [...state.skills, skill] })
}

/** Add one nested or top-level skill folder. */
export function addSkillGroup(name: string, parentId: string | null): void {
  const group: SkillGroup = { id: nextId('group'), name: text(name), parentId }
  publish({ ...state, groups: [...state.groups, group] })
}

/** Add or remove one skill reference for a pipeline or one of its tasks. */
export function toggleSkillReference(
  queueId: string,
  taskId: string | null,
  skillId: string,
): boolean {
  const current: QueueSkillRefs = state.refs[queueId] ?? { global: [], tasks: {} }
  if (taskId === null) {
    const exists = current.global.includes(skillId)
    publish({
      ...state,
      refs: {
        ...state.refs,
        [queueId]: {
          ...current,
          global: exists
            ? current.global.filter(id => id !== skillId)
            : [...current.global, skillId],
        },
      },
    })
    return !exists
  }
  const taskRefs = current.tasks[taskId] ?? []
  const exists = taskRefs.includes(skillId)
  publish({
    ...state,
    refs: {
      ...state.refs,
      [queueId]: {
        ...current,
        tasks: {
          ...current.tasks,
          [taskId]: exists ? taskRefs.filter(id => id !== skillId) : [...taskRefs, skillId],
        },
      },
    },
  })
  return !exists
}

/** Append one improvement to the global improvement area. */
export function addImprovement(improvement: Omit<Improvement, 'id' | 'at'>): void {
  publish({
    ...state,
    improvements: [{ ...improvement, id: nextId('improvement'), at: Date.now() }, ...state.improvements],
  })
}

/** Push one proactive reminder from the butler. */
export function addNotice(notice: Omit<ButlerNotice, 'id' | 'at'>): void {
  publish({
    ...state,
    notices: [{ ...notice, id: nextId('notice'), at: Date.now() }, ...state.notices],
  })
}

/** Dismiss one proactive reminder. */
export function dismissNotice(noticeId: string): void {
  publish({ ...state, notices: state.notices.filter(notice => notice.id !== noticeId) })
}

/** Append one user message and the butler reply the caller composed. */
export function sendMemoryMessage(userText: string, reply: StudioText): void {
  publish({
    ...state,
    messages: [
      ...state.messages,
      { id: nextId('message'), role: 'user', text: text(userText), at: Date.now() },
      { id: nextId('message'), role: 'butler', text: reply, at: Date.now() },
    ],
  })
}

/** Reset local state for tests and for a fresh page mount. */
export function resetStudioState(): void {
  state = {
    automation: DEFAULT_AUTOMATION,
    engineering: DEFAULT_ENGINEERING,
    queueModels: {},
    skills: DEFAULT_SKILLS,
    groups: DEFAULT_GROUPS,
    refs: {},
    improvements: [],
    notices: [],
    messages: [{ id: 'butler-greeting', role: 'butler', text: key('memoryGreeting'), at: 0 }],
    alertHandled: false,
  }
  for (const listener of listeners) listener()
}
