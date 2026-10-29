/**
 * The Session orchestration settings section: four tabs over one live snapshot
 * source and one separate draft source, with retained failures above both.
 */

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { SegmentedTabs, Tag, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Workspace standard hook merge (`useWorkspaces`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import type { OrchestratorClientFace } from './service.ts'
import { ErrorPanel } from './ErrorPanel.tsx'
import { TaskTab } from './TaskTab.tsx'
import { BoardTab } from './BoardTab.tsx'
import { PressureTab } from './PressureTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { HANDSOFF_AVATAR } from './avatar.ts'
import css from './Section.module.css'

/** Locale namespace owned by this plugin. */
export const NS = 'settings.sessionOrchestrator'

/** Tab identity. */
type TabId = 'queue' | 'board' | 'pressure' | 'hosts'

/** Keep one failing tab from blanking the whole settings panel. */
class TabErrorBoundary extends Component<
  { readonly children: ReactNode; readonly message: string; readonly retry: string },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('session-orchestrator UI: tab render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert">
        <p>{this.props.message}</p>
        <button type="button" onClick={() => { this.setState({ failed: false }) }}>{this.props.retry}</button>
      </div>
    )
  }
}

/** Props the renderer binds for the settings section. */
export type SessionOrchestratorSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>
  & InjectFace<OrchestratorClientFace>

/**
 * Render the six-tab orchestration page.
 * @param props - owner close, localized copy, bound snapshot hooks, and callbacks.
 * @returns the section content.
 */
export function SessionOrchestratorSection(props: SessionOrchestratorSectionProps) {
  const { t } = props
  const live = props.useLive(snapshot => snapshot)
  const drafts = props.useDrafts(snapshot => snapshot)
  const workspaces = props.useWorkspaces(snapshot => snapshot.items)
  const [tab, setTab] = useState<TabId>('queue')
  const now = Date.now()

  // The native catalogs can activate after this settings section mounts. Retry
  // once after the surrounding shell has finished wiring its remote namespaces;
  // otherwise a first-mount miss would disable model and preset selection for
  // the rest of the page's life.
  useEffect(() => {
    const timer = setTimeout(() => {
      void props.loadModelCatalog()
      void props.loadPresetCatalog()
    }, 2_000)
    return () => { clearTimeout(timer) }
  }, [props.loadModelCatalog, props.loadPresetCatalog])

  const items: readonly [SegmentedTab<TabId>, ...SegmentedTab<TabId>[]] = [
    { value: 'queue', label: t('tabQueue'), id: 'session-orchestrator-tab-queue', panelId: 'session-orchestrator-panel-queue' },
    { value: 'board', label: t('tabBoard'), id: 'session-orchestrator-tab-board', panelId: 'session-orchestrator-panel-board' },
    { value: 'pressure', label: t('tabPressure'), id: 'session-orchestrator-tab-pressure', panelId: 'session-orchestrator-panel-pressure' },
    { value: 'hosts', label: t('tabHosts'), id: 'session-orchestrator-tab-hosts', panelId: 'session-orchestrator-panel-hosts' },
  ]
  const shared = { t, live, drafts, workspaces, now, actions: props }
  const panelId = items.find(item => item.value === tab)?.panelId ?? items[0].panelId

  return (
    <section className={css.section} aria-label={t('title')}>
      <header className={css.hero}>
        <div className={css.identity}>
          <img
            className={css.avatar}
            src={HANDSOFF_AVATAR}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <div className={css.titleBlock}>
            <h2 className={css.title}>{t('title')}</h2>
            <p className={css.description}>{t('description')}</p>
          </div>
        </div>
        <div className={css.status}>
          {live.phase === 'connecting' && <Tag tone="warning">{t('connecting')}</Tag>}
          {live.phase === 'error' && <Tag tone="danger">{t('reconnecting')}</Tag>}
          {live.revision >= 0 && <Tag tone="outline">{t('liveRevision', { revision: live.revision })}</Tag>}
        </div>
      </header>
      <ErrorPanel
        t={t}
        errors={drafts.errors}
        now={now}
        onDismiss={props.dismissError}
        onClear={props.clearErrors}
      />
      <SegmentedTabs items={items} value={tab} onChange={setTab} label={t('tabLabel')} className={css.tabs} />
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={items.find(item => item.value === tab)?.id}
        className={css.panel}
      >
        <TabErrorBoundary key={tab} message={t('panelError')} retry={t('panelRetry')}>
          {tab === 'queue' && <TaskTab {...shared} />}
          {tab === 'board' && <BoardTab {...shared} />}
          {tab === 'pressure' && <PressureTab {...shared} />}
          {tab === 'hosts' && <HostsTab {...shared} />}
        </TabErrorBoundary>
      </div>
    </section>
  )
}

/** Re-export the locale key union for package tests. */
export type { SessionOrchestratorSettingsLocaleKey }
