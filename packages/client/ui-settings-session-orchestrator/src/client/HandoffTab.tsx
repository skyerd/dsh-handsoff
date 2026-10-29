/**
 * Handoff chains, the observable audit projection, and human controls.
 *
 * The Remote contract never returns a handoff body, an audit actor, or an audit
 * reason, so this page shows only session identities, hashes, counts, and the
 * facts the snapshot actually carries.
 */

import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionLinkDto } from './contract.ts'
import {
  auditKindKey, baselineKey, handoffModeKey, operationPhaseKey, timeLabel,
} from './copy.ts'
import {
  buildHandoffChains, deriveAuditEvents, taskTitleOf, type AuditEvent,
} from './model.ts'
import { RunActions } from './RunActions.tsx'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './HandoffTab.module.css'

/** Collect every linkable Session identity the snapshot exposes. */
function linkableSessions({ live }: Pick<OrchestrationTabProps, 'live'>): Set<string> {
  const ids = new Set<string>()
  const add = (link: SessionLinkDto | undefined): void => {
    if (link?.linkable === true) ids.add(link.sessionId)
  }
  for (const run of live.runs) {
    add(run.activeSession)
    for (const link of run.sessionLineage) add(link)
  }
  for (const handoff of live.handoffs) {
    add(handoff.parentSession)
    add(handoff.childSession)
  }
  return ids
}

/** Localize the enum or code an audit fact carries. */
function auditCodeLabel(event: AuditEvent, t: OrchestrationTabProps['t']): string {
  switch (event.kind) {
    case 'operation-phase': return t(operationPhaseKey(event.code))
    case 'pressure': return t(baselineKey(event.code))
    case 'handoff': return t(handoffModeKey(event.code))
    case 'run-error': return event.code
    case 'run-created':
    case 'run-updated':
    case 'human-skip':
      return ''
  }
}

/** Render one Session identity with only the facts the DTO carries. */
function SessionIdentity({ id, linkable, t }: {
  readonly id: string
  readonly linkable: boolean
  readonly t: OrchestrationTabProps['t']
}) {
  return (
    <span className={css.session}>
      <code>{id}</code>
      {linkable
        ? <Tag tone="info">{t('chainLinkable')}</Tag>
        : <Tag tone="quiet">{t('chainPlainSession')}</Tag>}
    </span>
  )
}

/**
 * Render handoff chains, the audit projection, and per-run controls.
 * @param props - snapshots, localized copy, and section callbacks.
 * @returns the handoff-and-audit tab.
 */
export function HandoffTab({ t, live, drafts, now, actions }: OrchestrationTabProps) {
  const busy = drafts.busy !== undefined
  const chains = buildHandoffChains(live.runs, live.handoffs)
  const audit = deriveAuditEvents(live.runs, live.handoffs)
  const linkable = linkableSessions({ live })
  const runs = [...live.runs].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))

  return (
    <div className={css.tab}>
      <section className={css.block} aria-label={t('chainTitle')}>
        <h3 className={css.title}>{t('chainTitle')}</h3>
        {chains.length === 0
          ? <p className={css.empty}>{t('emptyRuns')}</p>
          : (
            <div className={css.chains}>
              {chains.map(chain => (
                <article key={chain.runId} className={css.chain} data-run-id={chain.runId}>
                  <header className={css.chainHead}>
                    <span className={css.chainTitle}>{taskTitleOf(live.tasks, chain.taskId) ?? chain.taskId}</span>
                    <Tag tone="outline">{t('chainRun', { run: chain.runId })}</Tag>
                    <Tag tone="quiet">{t('runAttempt', { attempt: chain.attempt })}</Tag>
                    <Tag tone="quiet">{t('runGeneration', { generation: chain.generation })}</Tag>
                  </header>
                  <div className={css.sessions}>
                    <span className={css.subLabel}>{t('chainSessions')}</span>
                    {chain.sessions.length === 0
                      ? <span>{t('runNoSession')}</span>
                      : chain.sessions.map(id => (
                        <SessionIdentity key={id} id={id} linkable={linkable.has(id)} t={t} />
                      ))}
                  </div>
                  {chain.links.length === 0
                    ? <p className={css.empty}>{t('chainNoLinks')}</p>
                    : (
                      <ul className={css.links}>
                        {chain.links.map(link => (
                          <li key={`${link.handoff.operationId}:${String(link.handoff.generation)}`}>
                            <div className={css.linkHead}>
                              <Tag tone="info">{t('chainGeneration', { generation: link.handoff.generation })}</Tag>
                              <span>{t('chainEdge', { from: link.parentSession, to: link.childSession })}</span>
                            </div>
                            <div className={css.linkMeta}>
                              <span>{t('chainMode')}: {t(handoffModeKey(link.handoff.mode))}</span>
                              <span>{t('chainBody', { hash: link.handoff.bodyHash.slice(0, 12) })}</span>
                              {link.handoff.bodyTokens !== undefined && (
                                <span>{t('chainBodyTokens', { tokens: link.handoff.bodyTokens })}</span>
                              )}
                              <span>{t('chainCreatedAt')}: {timeLabel(link.handoff.createdAt, now, t)}</span>
                              <Tag tone="outline">{link.handoff.configSnapshot.provider}</Tag>
                              <Tag tone="outline">{link.handoff.configSnapshot.model}</Tag>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                </article>
              ))}
            </div>
          )}
      </section>

      <section className={css.block} aria-label={t('auditTitle')}>
        <h3 className={css.title}>{t('auditTitle')}</h3>
        <p className={css.notice}>{t('auditNotice')}</p>
        {audit.length === 0
          ? <p className={css.empty}>{t('emptyRuns')}</p>
          : (
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('errorAt')}</th>
                  <th>{t('auditTitle')}</th>
                  <th>{t('runTask')}</th>
                  <th>{t('runOperation')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map(event => (
                  <tr key={event.id} data-audit-kind={event.kind}>
                    <td>{timeLabel(event.at, now, t)}</td>
                    <td>{t(auditKindKey(event.kind))}</td>
                    <td>
                      <span>{taskTitleOf(live.tasks, event.taskId) ?? event.taskId}</span>
                      <code>{event.runId}</code>
                    </td>
                    <td>{auditCodeLabel(event, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      <section className={css.block} aria-label={t('manualControls')}>
        <h3 className={css.title}>{t('manualControls')}</h3>
        <p className={css.notice}>{t('manualControlsHint')}</p>
        {runs.length === 0
          ? <p className={css.empty}>{t('emptyRuns')}</p>
          : (
            <div className={css.controls}>
              {runs.map(run => (
                <div key={run.id} className={css.controlRow}>
                  <div className={css.controlHead}>
                    <span className={css.chainTitle}>{taskTitleOf(live.tasks, run.taskId) ?? run.taskId}</span>
                    <code>{run.id}</code>
                  </div>
                  <RunActions
                    t={t}
                    run={run}
                    taskTitle={taskTitleOf(live.tasks, run.taskId) ?? run.taskId}
                    disabled={busy}
                    onCancel={actions.cancelRun}
                    onRetry={actions.retryRun}
                    onSkip={actions.skipRun}
                  />
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  )
}
