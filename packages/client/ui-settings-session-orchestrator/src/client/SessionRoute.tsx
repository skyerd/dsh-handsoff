/**
 * The one "open the conversation" control every view shares.
 *
 * The control is driven by the host-projected `SessionLinkDto` and nothing
 * else: the identity it carries is the whole address, so the same button works
 * for a live attempt, a settled one, a retried one, and an intervention that
 * acted on a Session days ago. A link the host says cannot be opened keeps the
 * button live and states the reason, because "nothing happened" is the one
 * answer the reviewer cannot act on.
 */

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionLinkDto } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import css from './SessionRoute.module.css'

/** Props of one Session link control. */
export interface SessionRouteProps {
  readonly session: SessionLinkDto | undefined
  readonly t: OrchestratorTranslate
  readonly disabled: boolean
  readonly onOpen: (session: SessionLinkDto) => void
  /** Accessible target name; defaults to the Session identity. */
  readonly label?: string
  /** Whether the address is printed beside the button; defaults to true. */
  readonly showRoute?: boolean
}

/**
 * Render the open control plus the address it resolves to.
 * @param props - projected link, localized copy, the open callback, and display choices.
 * @returns the control, or null when the record names no Session yet.
 */
export function SessionRoute({
  session, t, disabled, onOpen, label, showRoute = true,
}: SessionRouteProps) {
  if (session === undefined) return null
  const ready = session.openState === 'ready'
  return (
    <span className={css.row} data-session-id={session.sessionId} data-session-state={session.openState}>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        title={t('runOpenSessionHint')}
        aria-label={`${t('runOpenSession')} ${label ?? session.sessionId}`}
        onClick={() => { onOpen(session) }}
      >
        {t('runOpenSession')}
      </Button>
      {showRoute && ready
        ? session.route === undefined
          ? null
          : <code className={css.route} title={session.route}>{session.route}</code>
        : null}
      {ready
        ? null
        : (
          <Tag tone="warning">
            {t(session.openState === 'archived' ? 'runOpenSessionArchived' : 'runOpenSessionUnsupported')}
          </Tag>
        )}
    </span>
  )
}
