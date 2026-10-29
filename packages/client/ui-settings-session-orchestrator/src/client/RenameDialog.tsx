/**
 * The one-field rename dialog shared by a queue and a composer task.
 *
 * Both renames only change the label this plugin stores; neither touches the
 * Host Workspace, its folder, or any conversation. The dialog seeds itself from
 * the current name on every open and refuses to save an empty one.
 */

import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorTranslate } from './copy.ts'
import { TextField } from './Fields.tsx'
import css from './RenameDialog.module.css'

/** Props of the rename dialog. */
export interface RenameDialogProps {
  readonly t: OrchestratorTranslate
  readonly open: boolean
  /** Heading shown in the dialog chrome. */
  readonly title: string
  /** Field label, for example `Pipeline name`. */
  readonly label: string
  /** Current name; reseeded on every open. */
  readonly value: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly onCancel: () => void
  readonly onSave: (next: string) => void
}

/**
 * Render the rename dialog.
 * @param props - localized copy, the current name and the save callback.
 * @returns the dialog, or null while closed.
 */
export function RenameDialog({
  t, open, title, label, value, placeholder, disabled = false, onCancel, onSave,
}: RenameDialogProps) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const next = draft.trim()
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
            disabled={disabled || next === ''}
            onClick={() => { onSave(next) }}
          >
            {t('save')}
          </Button>
        </>
      )}
    >
      <TextField
        label={label}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={setDraft}
      />
    </Modal>
  )
}
