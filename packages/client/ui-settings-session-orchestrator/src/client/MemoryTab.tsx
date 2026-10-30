/** The project butler: conversation, persona, memory, reminders and boundaries. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QueueDto } from './contract.ts'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import { timeLabel } from './copy.ts'
import { TextAreaField } from './Fields.tsx'
import { Summary } from './Summary.tsx'
import {
  dismissNotice, sendMemoryMessage, studioText, useStudio,
} from './studioStore.ts'
import { petDetail, petSnapshotOf, petSpeech } from './petModel.ts'
import { togglePetMode, usePetPrefs } from './petPrefs.ts'
import { usePetArt } from './petArtStore.ts'
import { PetArtDialog } from './PetArtDialog.tsx'
import { PetBubble } from './PetBubble.tsx'
import { PetSprite } from './PetSprite.tsx'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './MemoryTab.module.css'

/** One mail in the butler inbox. */
interface MailItem {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly at: number
  readonly body: string
}

/** Mood key chosen from the current hour; the AI may replace it later. */
function moodKeyOf(now: number): SessionOrchestratorSettingsLocaleKey {
  const hour = new Date(now).getHours()
  if (hour < 6) return 'memoryMoodSpaced'
  if (hour < 9) return 'memoryMoodThinking'
  if (hour < 12) return 'memoryMoodFocusedState'
  if (hour < 14) return 'memoryMoodBored'
  if (hour < 19) return 'memoryMoodExcited'
  if (hour < 22) return 'memoryMoodFocusedState'
  return 'memoryMoodDrooling'
}

/** A small, professional mail glyph for the summary strip. */
function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m3.5 7 8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/** Format one mail timestamp with the browser locale. */
function mailDate(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  } catch {
    return new Date(at).toLocaleString()
  }
}

/** Compact a token count for the context reading. */
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

/** Render one queue column in the queue-watch panel. */
function QueueWatchColumn({ label, queues, tasks, empty, t }: {
  readonly label: string
  readonly queues: readonly QueueDto[]
  readonly tasks: OrchestrationTabProps['live']['tasks']
  readonly empty: string
  readonly t: OrchestrationTabProps['t']
}) {
  return (
    <div className={css.watchColumn}>
      <span className={css.eyebrow}>{label}</span>
      {queues.length === 0
        ? <p className={css.empty}>{empty}</p>
        : (
          <ul className={css.queueList}>
            {queues.map((queue) => {
              const count = tasks.filter(task => task.queueId === queue.id).length
              return (
                <li key={queue.id} className={css.queueRow}>
                  <span className={css.queueName}>{queue.title}</span>
                  <span className={css.queueMeta}>{t('memoryQueuedTasks', { count })}</span>
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}

/**
 * Render the butler's conversation, persona growth, memory summary, proactive
 * reminders and its deliberate capability boundary.
 * @param props - live queues plus localized copy.
 * @returns the fish-memory tab.
 */
export function MemoryTab({ t, live, now }: OrchestrationTabProps) {
  const studio = useStudio()
  const petPrefs = usePetPrefs()
  const petArt = usePetArt()
  const floating = petPrefs.mode === 'floating'
  const [petBubbleOpen, setPetBubbleOpen] = useState(true)
  const [artOpen, setArtOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [defaultNoticeHidden, setDefaultNoticeHidden] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [stateOpen, setStateOpen] = useState(false)
  const [mailOpen, setMailOpen] = useState(false)
  const [selectedMailId, setSelectedMailId] = useState<string | undefined>()
  const [reply, setReply] = useState('')
  const [mailSent, setMailSent] = useState(false)
  const [repliedMails, setRepliedMails] = useState<readonly string[]>([])
  const runningQueues = live.queues.filter(queue => queue.state === 'running')
  const scheduledQueues = live.queues.filter(queue => queue.state !== 'running')
  const armed = studio.notices.length + (defaultNoticeHidden ? 0 : 1)
  const pet = petSnapshotOf(live, now)
  const petSentence = petSpeech(pet, t)
  const petSubline = petDetail(pet, t, armed)
  const mood = t(moodKeyOf(now))
  const contextUsed = 840 + studio.messages.length * 36 + studio.notices.length * 20
  const contextLimit = 8_000
  const mails: readonly MailItem[] = [
    {
      id: 'dispatch',
      subject: t('memoryMailSubjectDispatch'),
      from: t('memoryMailFromScheduler'),
      at: now - 2 * 60 * 60 * 1000,
      body: t('memoryMailBodyDispatch'),
    },
    {
      id: 'waiting',
      subject: t('memoryMailSubjectWaiting'),
      from: t('memoryMailFromAutomation'),
      at: now - 26 * 60 * 1000,
      body: t('memoryMailBodyWaiting'),
    },
  ]
  const selectedMail = mails.find(mail => mail.id === selectedMailId)
  const unread = repliedMails.includes('dispatch') ? 0 : 1

  return (
    <div className={css.tab}>
      <Summary
        label={t('memoryTitle')}
        metrics={[
          {
            label: t('memoryMetricQueues'),
            value: runningQueues.length,
            onClick: () => { setQueueOpen(value => !value) },
          },
          {
            label: t('memoryMetricMail'),
            value: unread,
            icon: <MailIcon />,
            onClick: () => { setMailOpen(true); setMailSent(false) },
          },
          {
            label: t('memoryMetricState'),
            value: mood,
            onClick: () => { setStateOpen(value => !value) },
          },
        ]}
      />

      {queueOpen && (
        <section className={css.drawer} aria-label={t('memoryQueuesTitle')}>
          <header className={css.drawerHead}>
            <div>
              <span className={css.eyebrow}>{t('memoryMetricQueues')}</span>
              <h3 className={css.title}>{t('memoryQueuesTitle')}</h3>
            </div>
            <Button size="sm" variant="ghost" onClick={() => { setQueueOpen(false) }}>{t('close')}</Button>
          </header>
          <div className={css.watchGrid}>
            <QueueWatchColumn
              label={t('memoryManaging')}
              queues={runningQueues}
              tasks={live.tasks}
              empty={t('memoryNoManaging')}
              t={t}
            />
            <QueueWatchColumn
              label={t('memoryScheduled')}
              queues={scheduledQueues}
              tasks={live.tasks}
              empty={t('memoryNoScheduled')}
              t={t}
            />
          </div>
        </section>
      )}

      {stateOpen && (
        <section className={css.drawer} aria-label={t('memoryStatusDetailTitle')}>
          <header className={css.drawerHead}>
            <div>
              <span className={css.eyebrow}>{t('memoryStatusHint')}</span>
              <h3 className={css.title}>{t('memoryStatusDetailTitle')}</h3>
            </div>
            <Button size="sm" variant="ghost" onClick={() => { setStateOpen(false) }}>{t('close')}</Button>
          </header>
          <div className={css.stateGrid}>
            <div className={css.stateItem}>
              <span className={css.eyebrow}>{t('memoryThoughtsTitle')}</span>
              <p className={css.bodyText}>{t('memoryThoughtsBody')}</p>
            </div>
            <div className={css.stateItem}>
              <span className={css.eyebrow}>{t('memoryCurrentMood')}</span>
              <div className={css.stateValueLine}>
                <span className={css.stateValue}>{mood}</span>
                <Tag tone="outline">{t('memoryMoodAuto')}</Tag>
              </div>
            </div>
            <div className={css.stateItem}>
              <span className={css.eyebrow}>{t('memoryContextLength')}</span>
              <span className={css.stateValue}>
                {t('memoryContextValue', {
                  used: tokenLabel(contextUsed),
                  limit: tokenLabel(contextLimit),
                })}
              </span>
              <div className={css.contextBar} role="progressbar" aria-valuemin={0} aria-valuemax={contextLimit} aria-valuenow={contextUsed}>
                <span className={css.contextFill} style={{ width: `${String(Math.min(100, (contextUsed / contextLimit) * 100))}%` }} />
              </div>
            </div>
          </div>
        </section>
      )}

      <section className={css.hero} aria-label={t('memoryTitle')}>
        <div className={css.persona}>
          {floating
            ? (
              <div className={css.petPreview} aria-hidden="true">
                <PetSprite mood={pet.mood} size="inline" art={petArt.art[pet.mood]} />
              </div>
            )
            : (
              <button
                type="button"
                className={css.petButton}
                aria-label={t(petBubbleOpen ? 'petHideBubble' : 'petShowBubble')}
                aria-expanded={petBubbleOpen}
                onClick={() => { setPetBubbleOpen(open => !open) }}
              >
                <PetSprite mood={pet.mood} size="inline" art={petArt.art[pet.mood]} />
              </button>
            )}
          <div className={css.personaText}>
            <div className={css.personaNameLine}>
              <h3 className={css.personaName}>{t('memoryPersonaName')}</h3>
              <Tag tone="success">{t('memoryOnline')}</Tag>
              {floating && <Tag tone="info">{t('petFloatingTag')}</Tag>}
            </div>
            <p className={css.personaRole}>{t('memoryPersonaRole')}</p>
            <p className={css.personaIntro}>{t('memorySubtitle')}</p>
            {petBubbleOpen && !floating && (
              <div className={css.personaBubble}>
                <PetBubble
                  text={petSentence}
                  tone={pet.tone}
                  {...(petSubline === undefined ? {} : { detail: petSubline })}
                  {...(pet.progress.total === 0 ? {} : { ratio: pet.progress.ratio })}
                  onDismiss={() => { setPetBubbleOpen(false) }}
                  dismissLabel={t('petHideBubble')}
                />
              </div>
            )}
          </div>
        </div>
        <div className={css.roleCard}>
          <span className={css.eyebrow}>{t('memoryRoleTitle')}</span>
          <p className={css.roleText}>{t('memoryRoleBody')}</p>
          <div className={css.statusLine}>
            <span className={css.statusPill}>{t('memoryDispatchActive', { count: runningQueues.length })}</span>
            <span className={css.statusPill}>
              {armed === 0 ? t('memoryReminderWaiting') : t('memoryReminderArmed', { count: armed })}
            </span>
            <Button size="sm" variant={floating ? 'primary' : 'ghost'} onClick={togglePetMode}>
              {floating ? t('petDockBack') : t('petSendToDesktop')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setArtOpen(true) }}>
              {t('petArtButton')}
            </Button>
          </div>
        </div>
      </section>

      <div className={css.grid}>
        <section className={css.card} aria-label={t('memoryGrowth')}>
          <header className={css.cardHead}>
            <span className={css.eyebrow}>{t('memoryPersonaName')}</span>
            <h3 className={css.title}>{t('memoryGrowth')}</h3>
          </header>
          <div className={css.growthRow}>
            <div className={css.growthBar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={72}>
              <span className={css.growthFill} style={{ width: '72%' }} />
            </div>
            <span className={css.growthValue}>72%</span>
          </div>
          <div className={css.traitRow}>
            <Tag tone="outline">{t('memoryTraitWarm')}</Tag>
            <Tag tone="outline">{t('memoryTraitPrecise')}</Tag>
            <Tag tone="outline">{t('memoryTraitCurious')}</Tag>
            <Tag tone="outline">{t('memoryTraitSteady')}</Tag>
          </div>
          <div className={css.littleThought}>
            <span className={css.eyebrow}>{t('memoryLittleThoughtTitle')}</span>
            <p className={css.thoughtText}>{t('memoryLittleThought')}</p>
          </div>
        </section>

        <section className={css.card} aria-label={t('memoryCognitionTitle')}>
          <header className={css.cardHead}>
            <span className={css.eyebrow}>{t('memoryMetricState')}</span>
            <h3 className={css.title}>{t('memoryCognitionTitle')}</h3>
          </header>
          <ul className={css.habitList}>
            <li>{t('memoryCognitionHabit')}</li>
            <li>{t('memoryCognitionFocus')}</li>
            <li>{t('memoryCognitionRhythm')}</li>
          </ul>
          <div className={css.memoryBox}>
            <h4 className={css.subtitle}>{t('memoryMemoryTitle')}</h4>
            <p className={css.bodyText}>{t('memoryMemorySummary')}</p>
            <div className={css.memoryChips}>
              <Tag tone="info">{t('memoryMemoryProjects', { count: Math.max(live.queues.length, 1) })}</Tag>
              <Tag tone="quiet">{t('memoryMemoryPreference')}</Tag>
            </div>
          </div>
        </section>
      </div>

      <section className={css.card} aria-label={t('memoryChatTitle')}>
        <header className={css.cardHead}>
          <span className={css.eyebrow}>{t('memoryPersonaRole')}</span>
          <h3 className={css.title}>{t('memoryChatTitle')}</h3>
          <Tag tone="success">{t('memoryOnline')}</Tag>
        </header>
        <div className={css.chat} aria-live="polite">
          {studio.messages.map(item => (
            <div
              key={item.id}
              className={item.role === 'user'
                ? `${css.bubbleRow} ${css.bubbleRowUser}`
                : css.bubbleRow}
            >
              <div className={item.role === 'user' ? `${css.bubble} ${css.bubbleUser}` : css.bubble}>
                <span className={css.bubbleRole}>
                  {item.role === 'user' ? t('memoryUserLabel') : t('memoryButlerLabel')}
                </span>
                <p className={css.bubbleText}>{studioText(item.text, t)}</p>
                {item.at > 0 && <span className={css.bubbleTime}>{timeLabel(item.at, now, t)}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className={css.composer}>
          <TextAreaField
            label={t('memoryChatInput')}
            value={message}
            rows={2}
            placeholder={t('memoryChatPlaceholder')}
            onChange={setMessage}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={message.trim() === ''}
            onClick={() => {
              const text = message.trim()
              if (text === '') return
              const statusQuestion = /status|状态|进度|queue|队列/iu.test(text)
              const replyText = statusQuestion ? t('memoryReplyStatus') : t('memoryReply', { text })
              sendMemoryMessage(text, { kind: 'text', value: replyText })
              setMessage('')
            }}
          >
            {t('memoryChatSend')}
          </Button>
        </div>
      </section>

      <section className={css.card} aria-label={t('memoryNoticesTitle')}>
        <header className={css.cardHead}>
          <span className={css.eyebrow}>{t('memoryMetricNotices')}</span>
          <h3 className={css.title}>{t('memoryNoticesTitle')}</h3>
          <Tag tone={armed > 0 ? 'warning' : 'success'}>{String(armed)}</Tag>
        </header>
        {armed === 0 && <p className={css.empty}>{t('memoryReminderWaiting')}</p>}
        {!defaultNoticeHidden && (
          <article className={css.notice}>
            <div className={css.noticeText}>
              <h4 className={css.subtitle}>{t('memoryNoticeDefaultTitle')}</h4>
              <p className={css.bodyText}>{t('memoryNoticeDefaultBody')}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('memoryNoticeDismiss')}
              onClick={() => { setDefaultNoticeHidden(true) }}
            >
              {t('memoryNoticeDismiss')}
            </Button>
          </article>
        )}
        {studio.notices.map(notice => (
          <article key={notice.id} className={css.notice}>
            <div className={css.noticeText}>
              <h4 className={css.subtitle}>{studioText(notice.title, t)}</h4>
              <p className={css.bodyText}>{studioText(notice.body, t)}</p>
              <span className={css.noticeTime}>{timeLabel(notice.at, now, t)}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${t('memoryNoticeDismiss')} ${studioText(notice.title, t)}`}
              onClick={() => { dismissNotice(notice.id) }}
            >
              {t('memoryNoticeDismiss')}
            </Button>
          </article>
        ))}
      </section>

      <section className={css.card} aria-label={t('memoryBoundaryTitle')}>
        <header className={css.cardHead}>
          <span className={css.eyebrow}>{t('memoryRoleTitle')}</span>
          <h3 className={css.title}>{t('memoryBoundaryTitle')}</h3>
        </header>
        <ul className={css.boundaryList}>
          <li>{t('memoryBoundaryRead')}</li>
          <li>{t('memoryBoundaryInteract')}</li>
          <li>{t('memoryBoundaryDispatch')}</li>
        </ul>
        <div className={css.boundaryFooter}>
          <span className={css.statusPill}>{t('memoryDispatchStatus')}</span>
          <span className={css.statusPill}>{t('memoryReminderStatus')}</span>
        </div>
      </section>

      {artOpen && <PetArtDialog t={t} onClose={() => { setArtOpen(false) }} />}

      {mailOpen && (
        <div className={css.overlay} role="presentation">
          <section className={css.mailDialog} role="dialog" aria-modal="true" aria-label={t('memoryMailTitle')}>
            <header className={css.drawerHead}>
              <div>
                <span className={css.eyebrow}>{t('memoryMetricMail')}</span>
                <h3 className={css.title}>{t('memoryMailTitle')}</h3>
              </div>
              <Button size="sm" variant="ghost" onClick={() => { setMailOpen(false) }}>{t('close')}</Button>
            </header>
            <div className={css.mailLayout}>
              <div className={css.mailList} role="list">
                {mails.map(mail => (
                  <button
                    key={mail.id}
                    type="button"
                    role="listitem"
                    className={selectedMailId === mail.id ? `${css.mailRow} ${css.mailRowActive}` : css.mailRow}
                    onClick={() => {
                      setSelectedMailId(mail.id)
                      setReply('')
                      setMailSent(false)
                    }}
                  >
                    <span className={css.mailSubject}>
                      {!repliedMails.includes(mail.id) && mail.id === 'dispatch' && <span className={css.unreadDot} aria-hidden="true" />}
                      {mail.subject}
                    </span>
                    <span className={css.mailDate}>{mailDate(mail.at)}</span>
                  </button>
                ))}
              </div>
              <div className={css.mailDetail}>
                {selectedMail === undefined
                  ? <p className={css.empty}>{t('memoryMailSelect')}</p>
                  : (
                    <>
                      <h4 className={css.mailDetailTitle}>{selectedMail.subject}</h4>
                      <div className={css.mailMeta}>
                        <span>{selectedMail.from}</span>
                        <span>{t('memoryMailDate')}: {mailDate(selectedMail.at)}</span>
                      </div>
                      <p className={css.mailBody}>{selectedMail.body}</p>
                      <TextAreaField
                        label={t('memoryMailReply')}
                        value={reply}
                        rows={3}
                        placeholder={t('memoryMailReplyPlaceholder')}
                        onChange={setReply}
                      />
                      <div className={css.mailActions}>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={reply.trim() === ''}
                          onClick={() => {
                            const text = reply.trim()
                            if (text === '') return
                            sendMemoryMessage(text, {
                              kind: 'text',
                              value: t('memoryReply', { text }),
                            })
                            setRepliedMails(previous => (
                              previous.includes(selectedMail.id) ? previous : [...previous, selectedMail.id]
                            ))
                            setReply('')
                            setMailSent(true)
                          }}
                        >
                          {t('memoryMailSend')}
                        </Button>
                        {mailSent && <span className={css.successText} role="status">{t('memoryMailSent')}</span>}
                      </div>
                    </>
                  )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
