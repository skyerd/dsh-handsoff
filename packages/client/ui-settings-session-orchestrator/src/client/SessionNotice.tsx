/**
 * Frame-wide notice for a conversation link that could not be opened.
 *
 * It lives in `shell.overlay`, not in the settings page, because the two ways a
 * link fails are exactly the two ways the reviewer is *not* looking at
 * settings: a stale route opened in a fresh tab, or an archived Session the
 * host refused. The banner states the stable reason and the Session identity it
 * was about, and stays until dismissed.
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { errorExplanationKey } from './copy.ts'
import type { OrchestratorDraftState } from './service.ts'
import css from './SessionNotice.module.css'

/** Locale namespace owned by this plugin. */
const NS = 'settings.sessionOrchestrator'

/**
 * Props the frame binds for the overlay entry.
 *
 * Only the seats this banner reads are named: a slot supplies more, and a
 * narrower requirement keeps the entry registrable in any frame composition.
 */
export type SessionNoticeProps = PropsLocale<typeof NS> & {
  /** Selector hook over the retained failure records. */
  readonly useDrafts: <R>(selector: (state: OrchestratorDraftState) => R) => R
  /** Drop one retained failure. */
  readonly dismissError: (id: string) => void
}

/**
 * Render the one retained `openSession` failure, if any.
 * @param props - retained failures, their dismissal, and localized copy.
 * @returns the notice, or null while no link failed.
 */
export function SessionNotice({ useDrafts, dismissError, t }: SessionNoticeProps) {
  const drafts = useDrafts(snapshot => snapshot)
  const failure = drafts.errors.find(error => error.operation === 'openSession')
  if (failure === undefined) return null
  return (
    <div className={css.notice} role="alert" data-error-code={failure.code}>
      <div className={css.head}>
        <strong>{t('sessionNoticeTitle')}</strong>
        <Button size="sm" variant="ghost" onClick={() => { dismissError(failure.id) }}>
          {t('dismiss')}
        </Button>
      </div>
      <p className={css.reason}>{t(errorExplanationKey(failure.code))}</p>
      {failure.detail !== undefined && (
        <code className={css.detail}>{t('sessionNoticeDetail', { sessionId: failure.detail })}</code>
      )}
    </div>
  )
}
