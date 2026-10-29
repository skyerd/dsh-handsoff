/**
 * Queue deletion confirmation.
 *
 * The dialog states that removing a pipeline only changes HandsOff records; it
 * never deletes workspace files. The optional archive row archives the
 * pipeline's conversations in the Workspace sidebar before removal.
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorTranslate } from './copy.ts'
import css from './QueueDeleteDialog.module.css'

/** Props of the queue deletion confirmation. */
export interface QueueDeleteDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  readonly title: string
  readonly queueTitle: string
  readonly disabled?: boolean
  readonly hasSessions: boolean
  readonly onCancel: () => void
  readonly onConfirm: (options: { readonly archiveSessions: boolean }) => void
}

/**
 * Render the acknowledgement-gated queue removal dialog.
 * @param props - localized copy and the requested deletion.
 * @returns the dialog, or null while closed.
 */
export function QueueDeleteDialog({
  t, open, title, queueTitle, disabled = false, hasSessions, onCancel, onConfirm,
}: QueueDeleteDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [archive, setArchive] = useState(false)

  useEffect(() => {
    if (!open) {
      setAcknowledged(false)
      setArchive(false)
    }
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={t('close')}
      className={css.dialog!}
      contentClassName={css.content!}
      footer={(
        <>
          <Button variant="outline" className={css.action} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            className={css.confirm}
            disabled={disabled || !acknowledged}
            onClick={() => { onConfirm({ archiveSessions: archive }) }}
          >
            {t('deleteQueue')}
          </Button>
        </>
      )}
    >
      <p className={css.notice}>{t('deleteQueueBody', { title: queueTitle })}</p>
      <div className={css.archiveBlock}>
        <Checkbox
          checked={archive}
          disabled={disabled}
          label={t('deleteQueueArchive')}
          onChange={setArchive}
        />
        <p className={css.hint}>
          {hasSessions ? t('deleteQueueArchiveHint') : t('deleteQueueArchiveEmpty')}
        </p>
      </div>
      <div className={css.acknowledgeRow}>
        <Checkbox
          checked={acknowledged}
          disabled={disabled}
          label={t('deleteQueueAcknowledge')}
          onChange={setAcknowledged}
        />
      </div>
    </Modal>
  )
}
