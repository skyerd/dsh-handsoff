/** Skill document history, version comparison and one-click restore. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { timeLabel } from './copy.ts'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import { restoreSkill, studioText, type StudioSkill } from './studioStore.ts'
import css from './SkillsTab.module.css'

/** Props for the document-history modal. */
export interface SkillHistoryDialogProps {
  readonly t: OrchestrationTabProps['t']
  readonly skill: StudioSkill
  readonly now: number
  readonly onClose: () => void
}

/**
 * Render stored revisions with the current document beside the selected one.
 * @param props - skill, clock and close callback.
 * @returns the history dialog.
 */
export function SkillHistoryDialog({ t, skill, now, onClose }: SkillHistoryDialogProps) {
  const [selectedId, setSelectedId] = useState(skill.versions.at(-1)?.id ?? '')
  const [restored, setRestored] = useState(false)
  const selected = skill.versions.find(version => version.id === selectedId)
  const currentText = studioText(skill.content, t)
  const selectedText = selected === undefined ? currentText : studioText(selected.content, t)

  return (
    <div className={css.overlay} role="presentation">
      <section className={css.historyDialog} role="dialog" aria-modal="true" aria-label={t('skillsHistoryTitle')}>
        <header className={css.dialogHead}>
          <span className={css.dialogKicker}>{studioText(skill.name, t)}</span>
          <h3 className={css.dialogTitle}>{t('skillsHistoryTitle')}</h3>
          <p className={css.dialogBody}>{t('skillsHistoryHint')}</p>
        </header>
        {skill.versions.length === 0
          ? <p className={css.empty}>{t('skillsHistoryEmpty')}</p>
          : (
            <div className={css.historyList} role="list">
              {skill.versions.map((version, index) => (
                <button
                  key={version.id}
                  type="button"
                  role="listitem"
                  className={selectedId === version.id
                    ? `${css.historyRow} ${css.historyRowActive}`
                    : css.historyRow}
                  onClick={() => {
                    setSelectedId(version.id)
                    setRestored(false)
                  }}
                >
                  <span className={css.historyRowTop}>
                    <span className={css.historyIndex}>
                      {t('skillsHistoryVersionNote', {
                        index: index + 1,
                        note: studioText(version.note, t),
                      })}
                    </span>
                    <Tag tone="quiet">{timeLabel(version.at, now, t)}</Tag>
                  </span>
                  <span className={css.historyPreview}>{studioText(version.content, t)}</span>
                </button>
              ))}
            </div>
          )}
        <div className={css.diffGrid}>
          <div className={css.diffPane}>
            <span className={css.diffLabel}>{t('skillsHistoryCurrent')}</span>
            <pre className={css.diffText}>{currentText}</pre>
          </div>
          <div className={css.diffPane}>
            <span className={css.diffLabel}>{t('skillsHistorySelected')}</span>
            <pre className={css.diffText}>{selectedText}</pre>
          </div>
        </div>
        <p className={css.diffCaption}>{t('skillsHistoryDiff')}</p>
        {restored && <p className={css.successNote} role="status">{t('skillsHistoryRestored')}</p>}
        <div className={css.dialogActions}>
          <Button
            size="sm"
            variant="primary"
            disabled={selected === undefined}
            onClick={() => {
              if (selected === undefined) return
              restoreSkill(skill.id, selected.id)
              setRestored(true)
            }}
          >
            {t('skillsHistoryRestore')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('close')}</Button>
        </div>
      </section>
    </div>
  )
}
