/**
 * Session orchestration settings page, browser half.
 *
 * The page registers one `settings.section` entry while the generated
 * `sessionOrchestrator` Remote namespace is mounted. It reads one whole
 * snapshot stream, keeps edits in a separate draft store, and never touches a
 * Host file, the orchestration domain, or a Session directly.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings SlotMap merge for `settings.section`.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the renderer's Context merge for `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the layout package's SlotMap merge for the frame-wide `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { OrchestratorRemote } from './contract.ts'
import {
  OrchestratorClient, type ModelCatalogSource, type PresetCatalogSource, type SessionOpenSurface,
} from './service.ts'
import { en, zh, type SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import { SessionOrchestratorSection } from './Section.tsx'
import { SessionNotice } from './SessionNotice.tsx'

export type { SessionOrchestratorSectionProps } from './Section.tsx'
export type {
  ClientError,
} from './errors.ts'
export type {
  LivePhase, MoveDirection, OrchestratorActions, OrchestratorClientFace, OrchestratorClientOptions,
  OrchestratorDraftState, OrchestratorLiveState, PipelineCreateInput, PipelineCreateTaskInput,
  PipelineTemplateInput, PresetCatalogSource, PresetCatalogState, PresetChoice,
  QueueDraftFields, QueueDraftPatch,
  QueueDraftState, SettingsDraftPatch, SettingsDraftState, TaskDraftPatch, TaskDraftState,
  DeleteQueueOptions,
} from './service.ts'
export type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session orchestration settings page copy. */
    'settings.sessionOrchestrator': SessionOrchestratorSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.sessionOrchestrator'

/** Required services: the settings section slot, dictionaries, and the generated Remote namespace. */
export const inject = ['slots', 'locale', 'remote.sessionOrchestrator']

/** Query parameter the host's `/session/<id>` redirect writes. */
const SESSION_OPEN_PARAM = 'dsh-session'

/** The structural slice of `ctx.uiWorkspace` this plugin navigates with. */
interface WorkspaceNavigator {
  openSession(sessionId: string): void
  archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
}

/** The structural slice of the browser Session catalog this plugin reads. */
interface SessionCatalog {
  readonly list: {
    getSnapshot(): {
      readonly phase: string
      readonly byId: Readonly<Record<string, unknown>>
    }
    subscribe(listener: () => void): () => void
  }
}

/** The structural slice of `ctx.workspaces` this plugin reads archive state from. */
interface WorkspaceArchive {
  readonly list: {
    getSnapshot(): { readonly archivedSessionIds: readonly string[] }
  }
}

/** Read one optional service without a hard package dependency. */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined
}

/**
 * Build the navigation surface the page opens Sessions through.
 *
 * Every service is resolved on use, not at mount: the Workspace navigator and
 * the Session catalog are provided by other plugins whose activation can land
 * after this one, and a captured-undefined surface would turn every click into
 * "this host cannot open a conversation" for the rest of the page's life.
 *
 * A host without the Workspace controller still renders the page: the surface
 * is then absent, and every link reports that this composition cannot open a
 * conversation instead of navigating nowhere.
 * @param ctx - the browser plugin context.
 * @returns the surface, or undefined when no Session navigator is mounted yet.
 */
function sessionSurface(ctx: ClientContext): SessionOpenSurface | undefined {
  const workspace = optionalService<WorkspaceNavigator>(ctx, 'uiWorkspace')
  if (workspace === undefined) return undefined
  return {
    open: (sessionId) => {
      const navigator = optionalService<WorkspaceNavigator>(ctx, 'uiWorkspace') ?? workspace
      navigator.openSession(sessionId)
    },
    knows: (sessionId) => {
      const snapshot = optionalService<SessionCatalog>(ctx, 'sessions')?.list.getSnapshot()
      // A catalog that is still connecting cannot prove absence, so the click
      // proceeds and the Session controller resolves it.
      if (snapshot === undefined || snapshot.phase !== 'ready') return undefined
      return snapshot.byId[sessionId] !== undefined
    },
    archived: (sessionId) =>
      optionalService<WorkspaceArchive>(ctx, 'workspaces')
        ?.list.getSnapshot().archivedSessionIds.includes(sessionId) === true,
    ...(workspace.archiveSession === undefined
      ? {}
      : {
        archive: async (sessionId: string): Promise<void> => {
          const navigator = optionalService<WorkspaceNavigator>(ctx, 'uiWorkspace')
          if (navigator?.archiveSession === undefined) throw new Error('workspace archive is unavailable')
          await navigator.archiveSession(sessionId, { stopActivity: true })
        },
      }),
  }
}

/** Whether every service a route needs has finished activating. */
function sessionRouteReady(ctx: ClientContext): boolean {
  const catalog = optionalService<SessionCatalog>(ctx, 'sessions')?.list.getSnapshot()
  return catalog !== undefined
    && catalog.phase === 'ready'
    && optionalService<WorkspaceNavigator>(ctx, 'uiWorkspace') !== undefined
}

/**
 * The structural slice of the native `session/modelCatalog` remote.
 *
 * The page never assembles its own provider/model list: this service is the
 * Harness catalog, reached through `ctx.get` because its namespace may activate
 * after this section mounts. A missing service leaves the catalog unavailable.
 */
interface HostModelCatalogRemote {
  modelCatalog(): Promise<
    | {
      readonly ok: true
      readonly value: {
        /** Deployment default an unconfigured Session would use. */
        readonly default?: {
          readonly provider: string
          readonly model: string
        }
        readonly groups: readonly {
          readonly id: string
          readonly name: string
          readonly models: readonly {
            readonly id: string
            readonly name: string
            readonly reasoning?: {
              readonly efforts: readonly { readonly id: string; readonly name: string }[]
              readonly defaultEffort?: string
            }
          }[]
        }[]
      }
    }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >
}

/**
 * Adapt the native host catalog to the page's model source.
 * @param ctx - the browser plugin context.
 * @returns the source, or undefined when no catalog namespace is mounted.
 */
function modelSurface(ctx: ClientContext): ModelCatalogSource | undefined {
  const remote = optionalService<HostModelCatalogRemote>(ctx, 'remote.session')
  if (remote === undefined) return undefined
  return {
    load: async () => {
      const response = await remote.modelCatalog()
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      const fallback = response.value.default
      return response.value.groups.flatMap(group => group.models.map(model => ({
        provider: group.id,
        providerName: group.name,
        model: model.id,
        modelName: model.name,
        reasoningEfforts: model.reasoning?.efforts ?? [],
        ...(model.reasoning?.defaultEffort === undefined
          ? {}
          : { defaultReasoningEffort: model.reasoning.defaultEffort }),
        ...(fallback === undefined || fallback.provider !== group.id || fallback.model !== model.id
          ? {}
          : { isDefault: true }),
      })))
    },
  }
}

/** Structural slice of the native agent-preset remote. */
interface HostAgentPresetRemote {
  list(): Promise<
    | {
      readonly ok: true
      readonly value: {
        readonly presets: readonly {
          readonly id: string
          readonly isDefault: boolean
          readonly name?: string
          readonly description?: string
          readonly broken?: string
        }[]
      }
    }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >
}

/**
 * Adapt one resolved preset namespace to the composer's skill source.
 * @param remote - mounted `remote.agentPresets` namespace.
 * @returns the source.
 */
function presetSurface(remote: HostAgentPresetRemote): PresetCatalogSource {
  return {
    load: async () => {
      const response = await remote.list()
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.value.presets
        .filter(preset => preset.broken === undefined)
        .map(preset => ({
          id: preset.id,
          name: preset.name ?? preset.id,
          ...(preset.description === undefined ? {} : { description: preset.description }),
          isDefault: preset.isDefault,
        }))
    },
  }
}

/** Delay between route-readiness probes. */
const ROUTE_PROBE_MS = 250

/** Probes before a route gives up waiting and reports what is missing. */
const ROUTE_PROBES = 40

/**
 * Consume the Session identity a route carried, once its services can answer.
 *
 * The parameter is deliberately left in the address bar: a refresh re-runs this
 * consumer, so a link keeps working even after the browser storage that
 * remembers the last selection is cleared.
 * @param ctx - the browser plugin context.
 * @param client - the page client that owns failure records.
 * @returns disposer releasing any pending probe.
 */
function consumeSessionRoute(ctx: ClientContext, client: OrchestratorClient): () => void {
  if (typeof window === 'undefined') return () => {}
  const sessionId = new URLSearchParams(window.location.search).get(SESSION_OPEN_PARAM)
  if (sessionId === null || sessionId === '') return () => {}
  let attempts = 0
  const timer: { handle?: ReturnType<typeof setTimeout> } = {}
  const probe = (): void => {
    attempts += 1
    if (!sessionRouteReady(ctx) && attempts < ROUTE_PROBES) {
      timer.handle = setTimeout(probe, ROUTE_PROBE_MS)
      return
    }
    // Ready, or out of patience: the client keeps the specific reason either way.
    void client.openSessionById(sessionId)
  }
  probe()
  return () => { if (timer.handle !== undefined) clearTimeout(timer.handle) }
}

/**
 * Mount the orchestration section and its snapshot/draft sources.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-session-orchestrator: dictionaries')
  const remote = ctx.get('remote.sessionOrchestrator') as OrchestratorRemote | undefined
  if (remote === undefined) {
    throw new Error('ui-settings-session-orchestrator: remote.sessionOrchestrator is not mounted')
  }
  let presetRemote: HostAgentPresetRemote | undefined
  const client = new OrchestratorClient(remote, {
    sessions: () => sessionSurface(ctx),
    models: () => modelSurface(ctx),
    presets: () => presetRemote === undefined ? undefined : presetSurface(presetRemote),
  })
  ctx.effect(() => {
    client.start()
    return () => client.dispose()
  }, 'ui-settings-session-orchestrator: snapshot stream')
  ctx.inject(['remote', 'remote.agentPresets'], (scope) => {
    const namespace = (scope as unknown as {
      remote: { agentPresets: HostAgentPresetRemote }
    }).remote.agentPresets
    presetRemote = namespace
    void client.loadPresetCatalog()
    return () => { presetRemote = undefined }
  })
  ctx.effect(() => consumeSessionRoute(ctx, client), 'ui-settings-session-orchestrator: Session route')
  const face = client.inject()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-orchestrator-session-notice',
    locale: NS,
    inject: () => face,
  }, SessionNotice))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-orchestrator',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: () => face,
  }, SessionOrchestratorSection))
}
