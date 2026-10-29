/** Acknowledgement-gated destructive confirmation built on the shared primitive. */

import { useEffect, useState } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorTranslate } from './copy.ts'

/** Props for one acknowledgement-gated action. */
export interface DangerConfirmProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly disabled?: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * Render the page's one confirmation contract: a description, an explicit
 * acknowledgement checkbox, and a primary action that stays disabled until the
 * user checks it. The acknowledgement resets whenever the dialog reopens or
 * closes, so a previous decision never authorizes a later action.
 * @param props - localized copy and the requested action.
 * @returns the confirmation dialog, or null while closed.
 */
export function DangerConfirm({ t, open, title, body, disabled = false, onCancel, onConfirm }: DangerConfirmProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    if (!open) setAcknowledged(false)
  }, [open])
  return (
    <RiskConfirmation
      open={open}
      title={title}
      description={body}
      acknowledgeLabel={t('acknowledge')}
      cancelLabel={t('cancel')}
      closeLabel={t('close')}
      confirmLabel={t('confirm')}
      acknowledged={acknowledged}
      disabled={disabled}
      onAcknowledgedChange={setAcknowledged}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
