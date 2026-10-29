/**
 * Runtime-platform capability diagnostics.
 *
 * This tab is an advanced surface, not part of the ordinary pipeline flow. The
 * page highlights only three platform states and keeps the per-capability
 * technical detail behind a disclosure. Every row reflects the report the
 * adapters really produced: a disabled capability stays disabled with its
 * reason, and nothing here is a simulated success.
 */

import { useEffect, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostCapabilityDto,
  HostCapabilityNameDto,
  HostSessionKindDto,
} from '@deepseek-ai/dsh-session-orchestrator'
import type { OrchestratorTranslate } from './copy.ts'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import { Summary } from './Summary.tsx'
import css from './HostsTab.module.css'

/** Props the platform page needs from the shared section state. */
export type HostsTabProps = OrchestrationTabProps

/** One provider group projected from the native model catalog. */
interface ProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly string[]
}

/** The three platform states the page highlights. */
type PlatformStatus = 'available' | 'partial' | 'unavailable'

/** Status badge copy and tone, one entry per highlighted state. */
const STATUS_TAG: Record<PlatformStatus, {
  readonly key: SessionOrchestratorSettingsLocaleKey
  readonly tone: 'success' | 'warning' | 'danger'
}> = {
  available: { key: 'platformStatusAvailable', tone: 'success' },
  partial: { key: 'platformStatusPartial', tone: 'warning' },
  unavailable: { key: 'platformStatusUnavailable', tone: 'danger' },
}

/** One platform's summary sentence when its installation exists. */
const SUMMARY_KEY: Record<HostSessionKindDto, SessionOrchestratorSettingsLocaleKey> = {
  dsh: 'platformDshSummary',
  workbuddy: 'platformWorkBuddySummary',
  trae: 'platformTraeSummary',
}

/** Localized label for every capability in the closed DTO union. */
const CAPABILITY_KEY: Record<HostCapabilityNameDto, SessionOrchestratorSettingsLocaleKey> = {
  listWorkspaces: 'capListWorkspaces',
  createSession: 'capCreateSession',
  sendPrompt: 'capSendPrompt',
  openSession: 'capOpenSession',
  subscribeEvents: 'capSubscribeEvents',
  getUsage: 'capGetUsage',
  selectModel: 'capSelectModel',
  listModels: 'capListModels',
  skills: 'capSkills',
  permissions: 'capPermissions',
  compaction: 'capCompaction',
}

/** One row's localized boundary or reason per real status. */
type RowCopy = {
  readonly supported?: SessionOrchestratorSettingsLocaleKey
  readonly unsupported?: SessionOrchestratorSettingsLocaleKey
}

/** Row copy for the matrix each adapter really reports. */
const ROW_COPY: Record<HostSessionKindDto, Partial<Record<HostCapabilityNameDto, RowCopy>>> = {
  dsh: {
    listWorkspaces: { supported: 'platformDshListWorkspaces' },
    createSession: { supported: 'platformDshCreateSession' },
    sendPrompt: { supported: 'platformDshSendPrompt' },
    openSession: { supported: 'platformDshOpenSession' },
    subscribeEvents: { supported: 'platformDshSubscribeEvents' },
    getUsage: { supported: 'platformDshGetUsage' },
    selectModel: { supported: 'platformDshSelectModel' },
    listModels: { supported: 'platformDshListModels' },
    skills: { supported: 'platformDshSkills' },
    permissions: { supported: 'platformDshPermissions' },
    compaction: { supported: 'platformDshCompaction' },
  },
  workbuddy: {
    listWorkspaces: { unsupported: 'platformWorkBuddyListWorkspaces' },
    createSession: { supported: 'platformWorkBuddyCreateSession' },
    sendPrompt: { supported: 'platformWorkBuddySendPrompt' },
    openSession: { unsupported: 'platformWorkBuddyOpenSession' },
    subscribeEvents: { supported: 'platformWorkBuddySubscribeEvents' },
    getUsage: { supported: 'platformWorkBuddyGetUsage' },
    selectModel: { supported: 'platformWorkBuddySelectModel' },
    listModels: { unsupported: 'platformWorkBuddyListModels' },
    skills: { unsupported: 'platformWorkBuddySkills' },
    permissions: { unsupported: 'platformWorkBuddyPermissions' },
    compaction: { unsupported: 'platformWorkBuddyCompaction' },
  },
  trae: {
    listWorkspaces: { unsupported: 'platformTraeListWorkspaces' },
    createSession: { unsupported: 'platformTraeReason' },
    sendPrompt: { unsupported: 'platformTraeReason' },
    openSession: { unsupported: 'platformTraeOpenSession' },
    subscribeEvents: { unsupported: 'platformTraeReason' },
    getUsage: { unsupported: 'platformTraeReason' },
    selectModel: { unsupported: 'platformTraeSelectModel' },
    listModels: { unsupported: 'platformTraeListModels' },
    skills: { unsupported: 'platformTraeSkills' },
    permissions: { unsupported: 'platformTraePermissions' },
    compaction: { unsupported: 'platformTraeCompaction' },
  },
}

/**
 * Reduce one verified matrix to the page's three highlighted states.
 * @param host - one verified platform report.
 * @returns available only for the runnable queue backend, unavailable for an
 * uninstalled or empty matrix, and partial otherwise.
 */
function platformStatus(host: HostCapabilityDto): PlatformStatus {
  if (!host.available) return 'unavailable'
  if (host.queueBackend && host.runnable) return 'available'
  return host.capabilities.some(capability => capability.status === 'supported')
    ? 'partial'
    : 'unavailable'
}

/**
 * Resolve one row's localized boundary text.
 * @param host - platform that reported the row.
 * @param capability - one DTO row.
 * @param t - namespace-bound translate function.
 * @returns localized boundary, falling back to an explicit unverified notice.
 */
function rowCopy(
  host: HostCapabilityDto,
  capability: HostCapabilityDto['capabilities'][number],
  t: OrchestratorTranslate,
): string {
  if (host.host === 'trae' && !host.available) return t('platformTraeNotInstalled')
  const entry = ROW_COPY[host.host][capability.capability]
  const key = capability.status === 'supported'
    ? entry?.supported ?? 'hostsSupportedGeneric'
    : entry?.unsupported ?? 'hostsUnsupportedGeneric'
  return t(key)
}

/** Two-character mark for one platform or provider. */
function markOf(name: string): string {
  return [...name.trim()].slice(0, 2).join('').toUpperCase()
}

/** Render one platform and its folded capability matrix. */
function PlatformBlock({ host, t }: { readonly host: HostCapabilityDto; readonly t: OrchestratorTranslate }) {
  const status = platformStatus(host)
  return (
    <article className={css.host} aria-label={host.displayName}>
      <header className={css.hostHead}>
        <div className={css.hostIdentity}>
          <span className={css.hostMark} aria-hidden="true">{markOf(host.displayName)}</span>
          <div className={css.hostText}>
            <h3 className={css.hostName}>{host.displayName}</h3>
            <p className={css.summary}>
              {t(host.available ? SUMMARY_KEY[host.host] : 'platformMissingSummary')}
            </p>
          </div>
        </div>
        <div className={css.tags}>
          <Tag tone={STATUS_TAG[status].tone}>{t(STATUS_TAG[status].key)}</Tag>
          {host.queueBackend && <Tag tone="outline">{t('hostsQueueBackendTag')}</Tag>}
        </div>
      </header>
      <details className={css.details}>
        <summary className={css.disclosure}>{t('hostsTechnicalSummary')}</summary>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">{t('hostsCapability')}</th>
              <th scope="col">{t('hostsState')}</th>
              <th scope="col">{t('hostsTechnicalDetail')}</th>
            </tr>
          </thead>
          <tbody>
            {host.capabilities.map((capability) => (
              <tr key={capability.capability}>
                <td>{t(CAPABILITY_KEY[capability.capability])}</td>
                <td>
                  <Tag tone={capability.status === 'supported' ? 'success' : 'outline'}>
                    {t(capability.status === 'supported' ? 'hostsSupported' : 'hostsUnsupported')}
                  </Tag>
                </td>
                <td className={css.detail}>{rowCopy(host, capability, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </article>
  )
}

/** Group the native model catalog by provider. */
function providerGroups(live: OrchestrationTabProps['live']): readonly ProviderGroup[] {
  const groups = new Map<string, { name: string; models: string[] }>()
  for (const choice of live.models.choices) {
    const current = groups.get(choice.provider) ?? { name: choice.providerName, models: [] }
    if (!current.models.includes(choice.modelName)) current.models.push(choice.modelName)
    groups.set(choice.provider, current)
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, name: group.name, models: group.models }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Render provider models, per-provider run limits and the platform reports.
 * @param props - snapshots, localized copy and section callbacks.
 * @returns the platform page.
 */
export function HostsTab({ t, live, drafts, actions }: HostsTabProps) {
  const providers = providerGroups(live)
  const [saved, setSaved] = useState(false)
  const quotas = drafts.settings?.draft.providerQuotas ?? live.settings?.providerQuotas ?? {}
  const available = live.hosts.filter(host => host.available).length

  useEffect(() => {
    if (drafts.settings === null) actions.loadSettingsDraft()
  }, [actions, drafts.settings])

  return (
    <div className={css.tab}>
      <Summary
        label={t('tabHosts')}
        metrics={[
          { label: t('metricPlatforms'), value: live.hosts.length },
          { label: t('metricAvailable'), value: `${available}/${live.hosts.length}` },
          { label: t('metricProviders'), value: providers.length },
          { label: t('metricModels'), value: live.models.choices.length },
        ]}
      />
      <section className={css.providers} aria-label={t('hostsProvidersTitle')}>
        <header className={css.sectionHead}>
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('tabHosts')}</span>
            <h3 className={css.sectionTitle}>{t('hostsProvidersTitle')}</h3>
            <p className={css.hint}>{t('hostsApiHint')}</p>
          </div>
          {providers.length > 0 && (
            <div className={css.saveRow}>
              <Button
                size="sm"
                variant="primary"
                disabled={drafts.settings === null || drafts.settings.saving}
                onClick={() => {
                  void actions.saveSettings().then(() => { setSaved(true) })
                }}
              >
                {t('hostsProviderSave')}
              </Button>
              {saved && <span className={css.saved}>{t('hostsProvidersSaved')}</span>}
            </div>
          )}
        </header>
        {providers.length === 0
          ? <p className={css.empty}>{t('hostsProvidersEmpty')}</p>
          : (
            <ul className={css.providerList}>
              {providers.map(provider => (
                <li key={provider.id} className={css.provider}>
                  <div className={css.providerHead}>
                    <span className={css.providerMark} aria-hidden="true">{markOf(provider.name)}</span>
                    <div className={css.providerText}>
                      <strong className={css.providerName}>{provider.name}</strong>
                      <Tag tone="outline">{provider.id}</Tag>
                    </div>
                  </div>
                  <div className={css.models}>
                    {provider.models.slice(0, 6).map(model => <Tag key={model} tone="quiet">{model}</Tag>)}
                    {provider.models.length > 6 && (
                      <span className={css.moreModels} title={provider.models.slice(6).join(' · ')}>
                        +{provider.models.length - 6}
                      </span>
                    )}
                  </div>
                  <label className={css.quota}>
                    <span className={css.quotaLabel}>{t('hostsProviderQuota')}</span>
                    <input
                      type="number"
                      min={1}
                      aria-label={`${t('hostsProviderQuota')} ${provider.name}`}
                      value={quotas[provider.id] ?? ''}
                      disabled={drafts.settings === null}
                      placeholder="8"
                      onChange={(event) => {
                        const raw = event.currentTarget.value
                        setSaved(false)
                        actions.setProviderQuota(provider.id, raw === '' ? undefined : Number(raw))
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section className={css.platformSection} aria-label={t('hostsPlatformsTitle')}>
        <header className={css.sectionHead}>
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('hostsTitle')}</span>
            <h3 className={css.sectionTitle}>{t('hostsPlatformsTitle')}</h3>
          </div>
          <Tag tone="outline">{`${available}/${live.hosts.length}`}</Tag>
        </header>
        {live.hosts.length === 0
          ? <p className={css.empty}>{t('hostsEmpty')}</p>
          : (
            <div className={css.list}>
              {live.hosts.map(host => <PlatformBlock key={host.host} host={host} t={t} />)}
            </div>
          )}
      </section>
    </div>
  )
}
