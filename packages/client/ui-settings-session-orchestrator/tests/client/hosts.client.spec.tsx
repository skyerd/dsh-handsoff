// @vitest-environment jsdom
/**
 * Platform diagnostics: three highlighted states, folded technical detail,
 * localized boundaries, and honest unsupported rows.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, within } from '@testing-library/react'
import { HostsTab } from '../../src/client/HostsTab.tsx'
import type { HostCapabilityDto, HostCapabilityNameDto } from '@deepseek-ai/dsh-session-orchestrator'
import { en, zh } from '../../src/client/locales.ts'
import type { SessionOrchestratorSettingsLocaleKey } from '../../src/client/locales.ts'
import { createActions, draftState, liveState } from './render.client.tsx'

afterEach(cleanup)

const ALL_CAPABILITIES = [
  'listWorkspaces',
  'createSession',
  'sendPrompt',
  'openSession',
  'subscribeEvents',
  'getUsage',
  'selectModel',
  'listModels',
  'skills',
  'permissions',
  'compaction',
] as const

/** Build one matrix whose listed capabilities are the only disabled ones. */
function matrix(unsupported: readonly HostCapabilityNameDto[]): HostCapabilityDto['capabilities'] {
  return ALL_CAPABILITIES.map(capability => unsupported.includes(capability)
    ? { capability, status: 'unsupported', reason: 'adapter-supplied reason' }
    : { capability, status: 'supported', detail: 'adapter-supplied boundary' })
}

const DSH: HostCapabilityDto = {
  host: 'dsh',
  displayName: 'DeepSeek Harness',
  available: true,
  runnable: true,
  queueBackend: true,
  capabilities: matrix([]),
}

/** Five of seven conversation operations, but no complete queue execution. */
const WORKBUDDY: HostCapabilityDto = {
  host: 'workbuddy',
  displayName: 'WorkBuddy',
  available: true,
  runnable: true,
  queueBackend: false,
  capabilities: matrix(['listWorkspaces', 'openSession', 'listModels', 'skills', 'permissions', 'compaction']),
}

const TRAE: HostCapabilityDto = {
  host: 'trae',
  displayName: 'Trae',
  available: true,
  runnable: false,
  queueBackend: false,
  capabilities: matrix(ALL_CAPABILITIES),
}

/** Interpolate one dictionary entry behind the typed translate seat. */
function translateWith(dictionary: Readonly<Record<string, string>>) {
  return (key: SessionOrchestratorSettingsLocaleKey, params: Record<string, unknown> = {}): string =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

/** Render the diagnostics against the real three-platform matrix. */
function renderHosts(dictionary: Readonly<Record<string, string>> = en) {
  return {
    view: render(
      <HostsTab
        t={translateWith(dictionary)}
        live={liveState({ hosts: [DSH, WORKBUDDY, TRAE] })}
        drafts={draftState()}
        actions={createActions()}
        workspaces={[]}
        now={0}
      />,
    ),
  }
}

describe('platform diagnostics', () => {
  it('highlights available, partially available and unavailable without conflating them', () => {
    const { view } = renderHosts()
    const dsh = view.getByRole('article', { name: 'DeepSeek Harness' })
    const workbuddy = view.getByRole('article', { name: 'WorkBuddy' })
    const trae = view.getByRole('article', { name: 'Trae' })

    expect(within(dsh).getByText(en.platformDshSummary)).toBeTruthy()
    expect(within(dsh).getByText(en.hostsQueueBackendTag)).toBeTruthy()

    expect(within(workbuddy).getByText(en.platformWorkBuddySummary)).toBeTruthy()
    expect(within(workbuddy).queryByText(en.hostsQueueBackendTag)).toBeNull()

    expect(within(trae).getByText(en.platformTraeSummary)).toBeTruthy()
    expect(within(trae).queryByText(en.hostsQueueBackendTag)).toBeNull()
  })

  it('does not show the capability-diagnostic introduction', () => {
    const { view } = renderHosts()
    expect(en.hostsIntro).toBe('')
    expect(view.getByText(en.hostsApiHint)).toBeTruthy()
  })

  it('keeps the capability report and per-row technical detail folded', () => {
    const { view } = renderHosts()
    expect(view.getAllByText(en.hostsTechnicalSummary)).toHaveLength(3)
    expect(view.getAllByRole('table')).toHaveLength(3)
    expect(within(view.getByRole('article', { name: 'DeepSeek Harness' }))
      .getByText(en.platformDshListWorkspaces)).toBeTruthy()
  })

  it('shows connected providers, their models and run limits', () => {
    const view = render(
      <HostsTab
        t={translateWith(en)}
        live={liveState({
          hosts: [DSH],
          models: {
            phase: 'ready',
            choices: [
              { provider: 'deepseek', providerName: 'DeepSeek', model: 'chat', modelName: 'DeepSeek Chat', reasoningEfforts: [] },
              { provider: 'trae', providerName: 'Trae', model: 'solo', modelName: 'Trae Solo', reasoningEfforts: [] },
            ],
          },
        })}
        drafts={draftState()}
        actions={createActions()}
        workspaces={[]}
        now={0}
      />,
    )
    expect(view.getByText('DeepSeek')).toBeTruthy()
    expect(view.getByText('DeepSeek Chat')).toBeTruthy()
    expect(view.getByLabelText(`${en.hostsProviderQuota} DeepSeek`)).toBeTruthy()
    expect(view.getByRole('button', { name: en.hostsProviderSave })).toBeTruthy()
  })

  it('preserves every unsupported result instead of simulating success', () => {
    const { view } = renderHosts()
    const workbuddy = view.getByRole('article', { name: 'WorkBuddy' })
    const trae = view.getByRole('article', { name: 'Trae' })
    expect(within(within(workbuddy).getByRole('table')).getAllByText(en.hostsUnsupported)).toHaveLength(6)
    expect(within(within(trae).getByRole('table')).getAllByText(en.hostsUnsupported)).toHaveLength(11)
  })

  it('renders Chinese boundary reasons instead of the adapters’ English prose', () => {
    const { view } = renderHosts(zh)
    expect(view.queryByText('adapter-supplied reason')).toBeNull()
    expect(view.queryByText(/no public conversation API/u)).toBeNull()
    expect(view.getByText(zh.platformWorkBuddyListWorkspaces)).toBeTruthy()
    expect(view.getAllByText(zh.platformTraeReason)).toHaveLength(4)
    expect(view.getByText(zh.platformDshSummary)).toBeTruthy()
    expect(view.getByText(zh.hostsApiHint)).toBeTruthy()
  })

  it('ships the same keys in both languages', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
