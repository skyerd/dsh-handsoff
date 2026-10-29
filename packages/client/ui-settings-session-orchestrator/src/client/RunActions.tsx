/** Per-run human controls with acknowledgement-gated destructive actions. */

import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunDto } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { canCancelRun, canRetryRun, canSkipRun } from './model.ts'
import { DangerConfirm } from './DangerConfirm.tsx'
import css from './RunActions.module.css'

/** Props for one run's controls. */
export interface RunActionsProps {
  readonly t: OrchestratorTranslate
  readonly run: RunDto
  readonly taskTitle: string
  readonly disabled: boolean
  readonly onCancel: (runId: string) => Promise<void>
  readonly onRetry: (runId: string) => Promise<void>
  readonly onSkip: (runId: string, actor: string, reason: string) => Promise<void>
}

type PendingAction = 'cancel' | 'retry' | 'skip'

/**
 * Render cancel, retry, and audited human-skip controls for one run.
 *
 * Every path that writes goes through the shared acknowledgement dialog; the
 * skip decision additionally collects the actor and reason the Host audits.
 * @param props - run state, localized copy, and callbacks from the section.
 * @returns the control row and at most one confirmation dialog.
 */
export function RunActions({ t, run, taskTitle, disabled, onCancel, onRetry, onSkip }: RunActionsProps) {
  const [pending, setPending] = useState<PendingAction | undefined>()
  const [actor, setActor] = useState('')
  const [reason, setReason] = useState('')
  const acting = disabled
  const requiredSkipsMissing = actor.trim() === '' || reason.trim() === ''

  const confirm = (): void => {
    const action = pending
    setPending(undefined)
    if (action === 'cancel') void onCancel(run.id)
    if (action === 'retry') void onRetry(run.id)
    if (action === 'skip') void onSkip(run.id, actor, reason)
  }

  return (
    <div className={css.controls}>
      <div className={css.buttons}>
        {canCancelRun(run.state) && (
          <Button
            size="sm"
            variant="outline"
            disabled={acting}
            aria-label={`${t('runCardCancel')} ${taskTitle}`}
            onClick={() => { setPending('cancel') }}
          >
            {t('runCardCancel')}
          </Button>
        )}
        {canRetryRun(run) && (
          <Button
            size="sm"
            variant="outline"
            disabled={acting}
            title={run.state === 'needs-attention' ? t('runRequeueHint') : undefined}
            aria-label={`${run.state === 'needs-attention' ? t('runRequeue') : t('runCardRetry')} ${taskTitle}`}
            onClick={() => { setPending('retry') }}
          >
            {/* A taken-over attempt returns to the queue as a fresh attempt. */}
            {run.state === 'needs-attention' ? t('runRequeue') : t('runCardRetry')}
          </Button>
        )}
      </div>
      {canSkipRun(run) && (
        <div className={css.skip}>
          <label className={css.skipField}>
            <span>{t('skipActor')}</span>
            <Input
              value={actor}
              disabled={acting}
              onChange={(event) => { setActor(event.currentTarget.value) }}
            />
          </label>
          <label className={css.skipField}>
            <span>{t('skipReason')}</span>
            <Input
              value={reason}
              disabled={acting}
              onChange={(event) => { setReason(event.currentTarget.value) }}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={acting || requiredSkipsMissing}
            aria-label={`${t('runCardSkip')} ${taskTitle}`}
            onClick={() => { setPending('skip') }}
          >
            {t('runCardSkip')}
          </Button>
        </div>
      )}
      <DangerConfirm
        t={t}
        open={pending !== undefined}
        title={pending === 'cancel' ? t('cancelTitle') : pending === 'retry' ? t('retryTitle') : t('skipTitle')}
        body={pending === 'cancel'
          ? t('cancelBody', { run: run.id, task: taskTitle })
          : pending === 'retry'
            ? t('retryBody', { task: taskTitle })
            : t('skipBody', { run: run.id, actor, reason })}
        disabled={acting}
        onCancel={() => { setPending(undefined) }}
        onConfirm={confirm}
      />
    </div>
  )
}
