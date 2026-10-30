/**
 * Local-only artwork importer for the butler fish.
 *
 * Files selected here are written to IndexedDB and rendered as blob URLs. They
 * never enter the npm package, never reach the Host, and never leave the
 * browser. This is the supported way to use a personally licensed, non-commercial
 * whale-maid sprite without redistributing it.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetArtDialog
 */

import { useRef, useState } from 'react'
import { Button, Checkbox, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrchestratorTranslate } from './copy.ts'
import {
  clearPetArt, importPetArt, PET_ART_KEYS, usePetArt,
} from './petArtStore.ts'
import css from './PetArtDialog.module.css'

/** Props of the local artwork dialog. */
export interface PetArtDialogProps {
  readonly t: OrchestratorTranslate
  readonly onClose: () => void
}

/**
 * Render the import dialog.
 * @param props - localized copy and close callback.
 * @returns the modal.
 */
export function PetArtDialog({ t, onClose }: PetArtDialogProps) {
  const art = usePetArt()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  /** Read selected files, store them locally, and report what was accepted. */
  const handleFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await importPetArt(files)
      const accepted = result.imported.length > 0
        ? t('petArtImported', { count: result.imported.length })
        : t('petArtNone')
      const skipped = result.skipped.length > 0
        ? ` ${t('petArtSkipped', { count: result.skipped.length })}`
        : ''
      setMessage(`${accepted}${skipped}`)
    } catch (error) {
      setMessage(t('petArtError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** Remove every locally imported sprite. */
  const handleClear = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await clearPetArt()
      setMessage(t('petArtCleared'))
    } catch (error) {
      setMessage(t('petArtError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.overlay} role="presentation">
      <section className={css.dialog} role="dialog" aria-modal="true" aria-label={t('petArtTitle')}>
        <header className={css.head}>
          <div>
            <span className={css.eyebrow}>{t('memoryPersonaName')}</span>
            <h3 className={css.title}>{t('petArtTitle')}</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('close')}</Button>
        </header>

        <p className={css.intro}>{t('petArtIntro')}</p>
        <p className={css.note}>{t('petArtLive2DNote')}</p>
        <p className={css.localOnly}>{t('petArtLocalOnly')}</p>
        <Checkbox
          checked={confirmed}
          label={t('petArtConfirm')}
          onChange={setConfirmed}
        />

        <div className={css.expected}>
          <span className={css.eyebrow}>{t('petArtExpected')}</span>
          <div className={css.names}>
            {PET_ART_KEYS.map(key => (
              <Tag key={key} tone="outline">{key}.png</Tag>
            ))}
          </div>
        </div>

        <div className={css.actions}>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !confirmed}
            onClick={() => { input.current?.click() }}
          >
            {busy ? t('petArtImporting') : t('petArtChoose')}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/webp,image/jpeg"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void handleFiles(files)
            }}
          />
          {art.customKeys.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void handleClear() }}>
              {t('petArtClear')}
            </Button>
          )}
        </div>

        {message !== undefined && <p className={css.message} role="status">{message}</p>}
        {art.status === 'error' && (
          <p className={css.error} role="alert">
            {t('petArtError', { message: art.error ?? '' })}
          </p>
        )}

        <div className={css.installed}>
          <span className={css.eyebrow}>{t('petArtInstalled')}</span>
          {art.customKeys.length === 0
            ? <p className={css.empty}>{t('petArtNone')}</p>
            : (
              <div className={css.chips}>
                {art.customKeys.map(key => <Tag key={key} tone="info">{key}</Tag>)}
              </div>
            )}
        </div>

        <p className={css.license}>{t('petArtLicense')}</p>
      </section>
    </div>
  )
}
