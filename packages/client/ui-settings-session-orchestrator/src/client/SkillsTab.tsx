/** Global skills, professional task skills and live pipeline references. */

import { useRef, useState } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QueueDto, TaskSummaryDto } from './contract.ts'
import type { SessionOrchestratorSettingsLocaleKey } from './locales.ts'
import { SelectField, TextAreaField, TextField } from './Fields.tsx'
import { Summary } from './Summary.tsx'
import { SkillHistoryDialog } from './SkillHistoryDialog.tsx'
import {
  addSkill, addSkillGroup, editSkill, setSkillEnabled, studioText, toggleSkillReference,
  useStudio, type Improvement, type SkillBadge, type SkillGroup, type SkillScope, type StudioSkill,
  type StudioText,
} from './studioStore.ts'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './SkillsTab.module.css'

/** Sub-view of the skill management page. */
type SkillTabId = 'global' | 'professional' | 'pipeline'

/** One sub-navigation row in the skill management page. */
interface SkillNavItem {
  readonly value: SkillTabId
  readonly label: string
  readonly id: string
  readonly panelId: string
}

/** Build literal text after a user edit. */
function literal(value: string): StudioText {
  return { kind: 'text', value }
}

/** Badge label key for one skill source. */
function badgeKey(badge: SkillBadge): SessionOrchestratorSettingsLocaleKey {
  switch (badge) {
    case 'user': return 'skillsBadgeUser'
    case 'professional': return 'skillsBadgeProfessional'
    case 'preset': return 'skillsBadgePreset'
    case 'custom': return 'skillsBadgeCustom'
  }
}

/** Resolve one folder name. */
function folderLabel(group: SkillGroup | undefined, t: OrchestrationTabProps['t']): string {
  return group === undefined ? t('skillsGroupRoot') : studioText(group.name, t)
}

/** Flatten nested folders into select options with an indent marker. */
function groupOptions(groups: readonly SkillGroup[], t: OrchestrationTabProps['t']): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: '', label: t('skillsGroupRoot') }]
  const visit = (parentId: string | null, depth: number): void => {
    for (const group of groups.filter(candidate => candidate.parentId === parentId)) {
      options.push({ value: group.id, label: `${'· '.repeat(depth)}${studioText(group.name, t)}` })
      visit(group.id, depth + 1)
    }
  }
  visit(null, 0)
  return options
}

/** One skill parsed from a local file. */
interface ImportedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

/** Remove a known skill-file extension from a filename. */
function fileStem(name: string): string {
  return name.replace(/\.(md|markdown|txt|json|yaml|yml)$/iu, '')
}

/** Read one markdown/text skill, including optional simple frontmatter. */
function textSkill(name: string, text: string): ImportedSkill {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
  const meta = front?.[1] ?? ''
  const field = (key: string): string => {
    const match = meta.match(new RegExp(`^${key}:\\s*(.+)$`, 'imu'))
    return match?.[1]?.trim() ?? ''
  }
  const content = front === null ? text : text.slice(front[0].length)
  const firstLine = content.split(/\r?\n/u).find(line => line.trim() !== '') ?? ''
  return {
    name: field('name') || fileStem(name),
    description: field('description') || firstLine.replace(/^#+\s*/u, '').slice(0, 160),
    content: content.trim() || text.trim(),
  }
}

/** Parse a JSON skill document into zero or more skills. */
function jsonSkills(name: string, text: string): ImportedSkill[] {
  const parsed: unknown = JSON.parse(text)
  const nested = parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).skills
    : undefined
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(nested) ? nested : [parsed]
  return rows.flatMap((row, index) => {
    if (typeof row === 'string') {
      return [textSkill(index === 0 ? name : `${name}-${String(index + 1)}`, row)]
    }
    if (row === null || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    const content = typeof record.content === 'string'
      ? record.content
      : typeof record.body === 'string'
        ? record.body
        : typeof record.prompt === 'string' ? record.prompt : ''
    if (content.trim() === '') return []
    return [{
      name: typeof record.name === 'string' && record.name.trim() !== ''
        ? record.name.trim()
        : index === 0 ? fileStem(name) : `${fileStem(name)}-${String(index + 1)}`,
      description: typeof record.description === 'string' ? record.description.trim() : '',
      content,
    }]
  })
}

/** Read selected local skill files. */
async function readSkillFiles(files: readonly File[]): Promise<ImportedSkill[]> {
  const imported: ImportedSkill[] = []
  for (const file of files) {
    const text = await file.text()
    if (text.trim() === '') continue
    if (/\.json$/iu.test(file.name)) {
      try {
        imported.push(...jsonSkills(file.name, text))
      } catch {
        continue
      }
      continue
    }
    imported.push(textSkill(file.name, text))
  }
  return imported
}

/** Local file picker that creates skills in the current scope. */
function LocalSkillImport({ t, scope, groupId }: {
  readonly t: OrchestrationTabProps['t']
  readonly scope: SkillScope
  readonly groupId: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className={css.importRow}>
      <input
        ref={input}
        type="file"
        accept=".md,.markdown,.txt,.json,.yaml,.yml"
        multiple
        hidden
        onChange={() => {
          const selected = input.current?.files
          if (selected === null || selected === undefined) return
          const files: File[] = []
          for (let index = 0; index < selected.length; index += 1) {
            const file = selected.item(index)
            if (file !== null) files.push(file)
          }
          if (files.length === 0) return
          setBusy(true)
          void readSkillFiles(files).then((skills) => {
            for (const skill of skills) {
              addSkill({
                name: skill.name,
                description: skill.description,
                content: skill.content,
                groupId,
                preset: false,
                scope,
                badge: scope === 'global' ? 'user' : 'custom',
              })
            }
            setStatus(skills.length === 0
              ? t('skillsImportInvalid')
              : t('skillsImportDone', { count: skills.length }))
            setBusy(false)
            if (input.current !== null) input.current.value = ''
          })
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => { input.current?.click() }}
      >
        {t('skillsImportLocal')}
      </Button>
      <span className={css.importHint}>{t('skillsImportHint')}</span>
      {status !== '' && <span className={css.successNote} role="status">{status}</span>}
    </div>
  )
}

/** Resolve a queue's tasks in declared order. */
function orderedTasks(queue: QueueDto, tasks: readonly TaskSummaryDto[]): TaskSummaryDto[] {
  const byId = new Map(tasks.filter(task => task.queueId === queue.id).map(task => [task.id, task]))
  const ordered: TaskSummaryDto[] = []
  for (const id of queue.taskOrder) {
    const task = byId.get(id)
    if (task !== undefined) {
      ordered.push(task)
      byId.delete(id)
    }
  }
  return [...ordered, ...byId.values()]
}

/** One editable skill card shared by the global and professional sections. */
function SkillCard({ skill, t, groups, referenced, onAddToPipeline }: {
  readonly skill: StudioSkill
  readonly t: OrchestrationTabProps['t']
  readonly groups: readonly SkillGroup[]
  readonly referenced?: boolean | undefined
  readonly onAddToPipeline?: (() => void) | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(studioText(skill.name, t))
  const [description, setDescription] = useState(studioText(skill.description, t))
  const [content, setContent] = useState(studioText(skill.content, t))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [status, setStatus] = useState('')
  const group = groups.find(candidate => candidate.id === skill.groupId)
  const now = Date.now()

  return (
    <article className={css.skillCard} data-skill-id={skill.id}>
      <header className={css.skillHead}>
        <div className={css.skillIdentity}>
          <h4 className={css.skillName}>{studioText(skill.name, t)}</h4>
          <div className={css.skillBadges}>
            <Tag tone={skill.badge === 'custom' ? 'info' : 'outline'}>{t(badgeKey(skill.badge))}</Tag>
            <Tag tone={skill.enabled ? 'success' : 'quiet'}>
              {skill.enabled ? t('skillsEnabled') : t('skillsDisabled')}
            </Tag>
            {skill.projectCount >= 2 && (
              <Tag tone="warning">{t('skillsCrossProject', { count: skill.projectCount })}</Tag>
            )}
          </div>
        </div>
        <Switch
          checked={skill.enabled}
          label={`${t('skillsEnabled')} ${studioText(skill.name, t)}`}
          onChange={(value) => { setSkillEnabled(skill.id, value) }}
        />
      </header>
      <p className={css.skillDescription}>{studioText(skill.description, t)}</p>
      <div className={css.skillMeta}>
        <span>{t('skillsGroup')}: {folderLabel(group, t)}</span>
        <span>{skill.versions.length} · {t('skillsHistoryTitle')}</span>
      </div>
      {editing
        ? (
          <div className={css.editForm}>
            <TextField label={t('skillsName')} value={name} onChange={setName} />
            <TextField label={t('skillsDescription')} value={description} onChange={setDescription} />
            <TextAreaField label={t('skillsContent')} value={content} rows={5} onChange={setContent} />
            <div className={css.inlineActions}>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  editSkill(skill.id, {
                    name: literal(name),
                    description: literal(description),
                    content: literal(content),
                  })
                  setEditing(false)
                  setStatus(t('pressureParamsSaved'))
                }}
              >
                {t('save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false) }}>{t('cancel')}</Button>
            </div>
          </div>
        )
        : <p className={css.skillContent}>{studioText(skill.content, t)}</p>}
      <div className={css.skillActions}>
        <Button size="sm" variant="outline" onClick={() => { setEditing(value => !value) }}>
          {editing ? t('skillsHideContent') : t('skillsEditContent')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setHistoryOpen(true) }}>
          {t('skillsGitHistory')}
        </Button>
        {onAddToPipeline !== undefined && (
          referenced === true
            ? <Tag tone="success">{t('skillsReferenced')}</Tag>
            : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onAddToPipeline()
                  setStatus(t('skillsAddedToConversation'))
                }}
              >
                {t('skillsAddToConversation')}
              </Button>
            )
        )}
      </div>
      {status !== '' && <p className={css.successNote} role="status">{status}</p>}
      {historyOpen && (
        <SkillHistoryDialog t={t} skill={skill} now={now} onClose={() => { setHistoryOpen(false) }} />
      )}
    </article>
  )
}

/** One clickable skill chip with its add or remove marker. */
function SkillReferencePicker({ label, skills, selected, t, onToggle }: {
  readonly label: string
  readonly skills: readonly StudioSkill[]
  readonly selected: readonly string[]
  readonly t: OrchestrationTabProps['t']
  readonly onToggle: (skillId: string) => void
}) {
  return (
    <div className={css.refBlock} aria-label={label}>
      <span className={css.refLabel}>{label}</span>
      {skills.length === 0
        ? <p className={css.empty}>{t('skillsRefNone')}</p>
        : (
          <div className={css.refChips}>
            {skills.map(skill => {
              const isSelected = selected.includes(skill.id)
              return (
                <button
                  key={skill.id}
                  type="button"
                  className={isSelected ? `${css.refChip} ${css.refChipOn}` : css.refChip}
                  aria-pressed={isSelected}
                  title={isSelected ? t('skillsRemoveRef') : t('skillsAddRef')}
                  onClick={() => { onToggle(skill.id) }}
                >
                  <span className={isSelected ? css.refDotOn : css.refDot} aria-hidden="true" />
                  <span className={css.refName}>{studioText(skill.name, t)}</span>
                  <span className={css.refSign} aria-hidden="true">{isSelected ? '−' : '+'}</span>
                </button>
              )
            })}
          </div>
        )}
    </div>
  )
}

/** Read-only list of one scope's referenced skills. */
function ReferencedSkills({ skills, selected, t }: {
  readonly skills: readonly StudioSkill[]
  readonly selected: readonly string[]
  readonly t: OrchestrationTabProps['t']
}) {
  const referenced = skills.filter(skill => selected.includes(skill.id))
  if (referenced.length === 0) return <p className={css.empty}>{t('skillsRefNone')}</p>
  return (
    <div className={css.refChips}>
      {referenced.map(skill => (
        <Tag key={skill.id} tone="info">{studioText(skill.name, t)}</Tag>
      ))}
    </div>
  )
}

/** Global improvements with cross-project markers. */
function ImprovementList({ t, improvements }: {
  readonly t: OrchestrationTabProps['t']
  readonly improvements: readonly (Improvement & { readonly generated: boolean })[]
}) {
  return (
    <section className={css.block} aria-label={t('skillsGlobalImprovementsTitle')}>
      <header className={css.head}>
        <div className={css.heading}>
          <h3 className={css.title}>{t('skillsGlobalImprovementsTitle')}</h3>
        </div>
        <Tag tone="outline">{String(improvements.length)}</Tag>
      </header>
      {improvements.length === 0
        ? <p className={css.empty}>{t('skillsNoImprovements')}</p>
        : (
          <div className={css.improvementList}>
            {improvements.map(improvement => {
              const cross = improvement.projects.length >= 2
              return (
                <article key={improvement.id} className={css.improvement}>
                  <header className={css.improvementHead}>
                    <h4 className={css.improvementTitle}>{improvement.title}</h4>
                    <div className={css.skillBadges}>
                      <Tag tone={cross ? 'warning' : 'quiet'}>
                        {cross
                          ? t('skillsCrossProject', { count: improvement.projects.length })
                          : t('skillsSingleProject')}
                      </Tag>
                      {improvement.generated && <Tag tone="info">{t('skillsGeneratedBadge')}</Tag>}
                    </div>
                  </header>
                  <p className={css.improvementProjects}>
                    {t('skillsImprovementProjects', { projects: improvement.projects.join(', ') })}
                  </p>
                  <dl className={css.improvementMeta}>
                    <div>
                      <dt>{t('skillsImprovementCause')}</dt>
                      <dd>{improvement.cause}</dd>
                    </div>
                    <div>
                      <dt>{t('skillsImprovementAction')}</dt>
                      <dd>{improvement.action}</dd>
                    </div>
                    <div>
                      <dt>{t('skillsImprovementResult')}</dt>
                      <dd className={css.improvementResult}>{improvement.result}</dd>
                    </div>
                  </dl>
                </article>
              )
            })}
          </div>
        )}
    </section>
  )
}

/**
 * Render the skill-management views and live pipeline references.
 * @param props - live queues/tasks, selected pipeline, localized copy.
 * @returns the skill-management tab.
 */
export function SkillsTab({ t, live, drafts }: OrchestrationTabProps) {
  const studio = useStudio()
  const [view, setView] = useState<SkillTabId>('global')
  const [folderName, setFolderName] = useState('')
  const [folderParent, setFolderParent] = useState('')
  const [addName, setAddName] = useState('')
  const [addDescription, setAddDescription] = useState('')
  const [addContent, setAddContent] = useState('')
  const [addGroup, setAddGroup] = useState('')
  const [addPreset, setAddPreset] = useState('custom')
  const [activeGroup, setActiveGroup] = useState('')
  const [notice, setNotice] = useState('')
  const [refNotice, setRefNotice] = useState('')
  const items: readonly SkillNavItem[] = [
    { value: 'global', label: t('skillsTabGlobal'), id: 'skills-tab-global', panelId: 'skills-panel-global' },
    { value: 'professional', label: t('skillsTabProfessional'), id: 'skills-tab-professional', panelId: 'skills-panel-professional' },
    { value: 'pipeline', label: t('skillsTabPipeline'), id: 'skills-tab-pipeline', panelId: 'skills-panel-pipeline' },
  ]
  const selectedQueue = drafts.selectedQueueId === undefined
    ? undefined
    : live.queues.find(queue => queue.id === drafts.selectedQueueId)
  const currentQueue = selectedQueue ?? live.queues[0]
  const globalSkills = studio.skills.filter(skill => skill.scope === 'global')
  const professionalSkills = studio.skills.filter(skill => skill.scope === 'professional')
  const currentRefs = currentQueue === undefined ? undefined : studio.refs[currentQueue.id]
  const defaultImprovements: readonly (Improvement & { readonly generated: boolean })[] = [
    {
      id: 'default-cross',
      title: t('improvementCrossTitle'),
      cause: t('improvementCrossCause'),
      action: t('improvementCrossAction'),
      result: t('improvementCrossResult'),
      projects: [t('improvementProjectOne'), t('improvementProjectTwo')],
      at: 0,
      generated: false,
    },
    {
      id: 'default-local',
      title: t('improvementLocalTitle'),
      cause: t('improvementLocalCause'),
      action: t('improvementLocalAction'),
      result: t('improvementLocalResult'),
      projects: [t('improvementProjectOne')],
      at: 0,
      generated: false,
    },
  ]
  const improvements = [
    ...studio.improvements.map(improvement => ({ ...improvement, generated: true })),
    ...defaultImprovements,
  ]
  const folderOptions = groupOptions(studio.groups, t)
  const activeGroupId = activeGroup === '' ? null : activeGroup
  const visibleGroupSkills = professionalSkills.filter(skill => skill.groupId === activeGroupId)
  const panelId = items.find(item => item.value === view)?.panelId ?? items[0].panelId

  return (
    <div className={css.tab}>
      <Summary
        label={t('skillsTitle')}
        metrics={[
          { label: t('skillsTabGlobal'), value: globalSkills.length },
          { label: t('skillsTabProfessional'), value: professionalSkills.length },
          { label: t('metricQueues'), value: live.queues.length },
          { label: t('skillsGlobalImprovementsTitle'), value: improvements.length },
        ]}
      />
      <nav className={css.tabs} role="tablist" aria-label={t('skillsTabLabel')}>
        {items.map((item, index) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={item.id}
            aria-selected={view === item.value}
            aria-controls={item.panelId}
            tabIndex={view === item.value ? 0 : -1}
            className={view === item.value ? `${css.tabButton} ${css.tabButtonActive}` : css.tabButton}
            onClick={() => { setView(item.value) }}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
              if (step === 0) return
              event.preventDefault()
              const next = items[(index + step + items.length) % items.length]
              if (next === undefined) return
              setView(next.value)
              document.getElementById(next.id)?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div id={panelId} role="tabpanel" aria-labelledby={items.find(item => item.value === view)?.id}>
        {view === 'global' && (
          <>
            <section className={css.block} aria-label={t('skillsGlobalUserTitle')}>
              <header className={css.head}>
                <div className={css.heading}>
                  <h3 className={css.title}>{t('skillsGlobalUserTitle')}</h3>
                </div>
              </header>
              <LocalSkillImport t={t} scope="global" groupId={null} />
              <div className={css.skillGrid}>
                {globalSkills.filter(skill => skill.badge === 'user').map(skill => (
                  <SkillCard key={skill.id} skill={skill} t={t} groups={studio.groups} />
                ))}
              </div>
            </section>
            <section className={css.block} aria-label={t('skillsGlobalProTitle')}>
              <header className={css.head}>
                <div className={css.heading}>
                  <h3 className={css.title}>{t('skillsGlobalProTitle')}</h3>
                </div>
              </header>
              <div className={css.skillGrid}>
                {globalSkills.filter(skill => skill.badge !== 'user').map(skill => (
                  <SkillCard key={skill.id} skill={skill} t={t} groups={studio.groups} />
                ))}
              </div>
            </section>
          </>
        )}

        {view === 'professional' && (
          <>
            <section className={css.block} aria-label={t('skillsPipelineEntry')}>
              <header className={css.head}>
                <div className={css.heading}>
                  <h3 className={css.title}>{t('skillsPipelineEntry')}</h3>
                </div>
                {currentQueue === undefined
                  ? <Tag tone="quiet">{t('skillsNoPipeline')}</Tag>
                  : <Tag tone="info">{t('skillsCurrentPipeline', { title: currentQueue.title })}</Tag>}
              </header>
              {notice !== '' && <p className={css.successNote} role="status">{notice}</p>}
            </section>

            <section className={css.block} aria-label={t('skillsAddTitle')}>
              <header className={css.head}>
                <div className={css.heading}>
                  <h3 className={css.title}>{t('skillsAddTitle')}</h3>
                </div>
                <Tag tone="outline">{t('skillsBadgeCustom')}</Tag>
              </header>
              <LocalSkillImport
                t={t}
                scope="professional"
                groupId={addGroup === '' ? null : addGroup}
              />
              <div className={css.addGrid}>
                <TextField label={t('skillsName')} value={addName} onChange={setAddName} />
                <TextField label={t('skillsDescription')} value={addDescription} onChange={setAddDescription} />
                <SelectField
                  label={t('skillsType')}
                  value={addPreset}
                  options={[
                    { value: 'custom', label: t('skillsBadgeCustom') },
                    { value: 'preset', label: t('skillsBadgePreset') },
                  ]}
                  onChange={setAddPreset}
                />
                <SelectField
                  label={t('skillsGroup')}
                  value={addGroup}
                  options={folderOptions}
                  onChange={setAddGroup}
                />
              </div>
              <TextAreaField label={t('skillsContent')} value={addContent} rows={3} onChange={setAddContent} />
              <div className={css.inlineActions}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={addName.trim() === '' || addContent.trim() === ''}
                  onClick={() => {
                    addSkill({
                      name: addName.trim(),
                      description: addDescription.trim(),
                      content: addContent.trim(),
                      groupId: addGroup === '' ? null : addGroup,
                      preset: addPreset === 'preset',
                    })
                    setAddName('')
                    setAddDescription('')
                    setAddContent('')
                    setNotice(t('skillsAdded'))
                  }}
                >
                  {t('skillsAdd')}
                </Button>
              </div>
            </section>

            <section className={css.block} aria-label={t('skillsTreeTitle')}>
              <header className={css.head}>
                <div className={css.heading}>
                  <h3 className={css.title}>{t('skillsTreeTitle')}</h3>
                </div>
              </header>
              <div className={css.folderForm}>
                <TextField label={t('skillsGroupName')} value={folderName} onChange={setFolderName} />
                <SelectField
                  label={t('skillsGroup')}
                  value={folderParent}
                  options={folderOptions}
                  onChange={setFolderParent}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={folderName.trim() === ''}
                  onClick={() => {
                    addSkillGroup(folderName.trim(), folderParent === '' ? null : folderParent)
                    setFolderName('')
                    setNotice(t('skillsGroupCreated'))
                  }}
                >
                  {t('skillsGroupAdd')}
                </Button>
              </div>
              <div className={css.groupNav} role="group" aria-label={t('skillsGroup')}>
                {folderOptions.map((option) => {
                  const groupId = option.value === '' ? null : option.value
                  const count = professionalSkills.filter(skill => skill.groupId === groupId).length
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={option.value === activeGroup
                        ? `${css.groupChip} ${css.groupChipActive}`
                        : css.groupChip}
                      aria-pressed={option.value === activeGroup}
                      onClick={() => {
                        setActiveGroup(option.value)
                        setAddGroup(option.value)
                        setFolderParent(option.value)
                      }}
                    >
                      <span>{option.label}</span>
                      <span className={css.groupCount}>{String(count)}</span>
                    </button>
                  )
                })}
              </div>
              <div className={css.skillGrid}>
                {visibleGroupSkills.length === 0
                  ? <p className={css.empty}>{t('skillsGroupEmpty')}</p>
                  : visibleGroupSkills.map(skill => {
                    const referenced = currentRefs?.global.includes(skill.id) ?? false
                    return (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        t={t}
                        groups={studio.groups}
                        referenced={referenced}
                        onAddToPipeline={currentQueue === undefined
                          ? undefined
                          : () => {
                            if (!referenced) toggleSkillReference(currentQueue.id, null, skill.id)
                            setNotice(t('skillsAddedToConversation'))
                          }}
                      />
                    )
                  })}
              </div>
            </section>
          </>
        )}

        {view === 'pipeline' && (
          <section className={css.block} aria-label={t('skillsPipelineTitle')}>
            <header className={css.head}>
              <div className={css.heading}>
                <h3 className={css.title}>{t('skillsPipelineTitle')}</h3>
              </div>
              <Tag tone="outline">{t('skillsRefLive')}</Tag>
            </header>
            {refNotice !== '' && <p className={css.successNote} role="status">{refNotice}</p>}
            {live.queues.length === 0
              ? <p className={css.empty}>{t('skillsPipelineNoQueue')}</p>
              : (
                <div className={css.pipelineList}>
                  {live.queues.map((queue) => {
                    const refs = studio.refs[queue.id] ?? { global: [], tasks: {} }
                    const rows = orderedTasks(queue, live.tasks)
                    const add = (taskId: string | null, skillId: string): void => {
                      const added = toggleSkillReference(queue.id, taskId, skillId)
                      setRefNotice(added ? t('skillsRefAdded') : t('skillsRefRemoved'))
                    }
                    return (
                      <article key={queue.id} className={css.pipeline} data-queue-id={queue.id}>
                        <header className={css.pipelineHead}>
                          <h4 className={css.pipelineTitle}>{queue.title}</h4>
                          <Tag tone="quiet">{t('queueTaskCount', { count: rows.length })}</Tag>
                        </header>
                        <div className={css.pipelineScope}>
                          <span className={css.scopeLabel}>{t('skillsPipelineGlobal')}</span>
                          <SkillReferencePicker
                            label={t('skillsLibraryTitle')}
                            skills={professionalSkills}
                            selected={refs.global}
                            t={t}
                            onToggle={(skillId) => { add(null, skillId) }}
                          />
                        </div>
                        <div className={css.pipelineScope}>
                          <span className={css.scopeLabel}>{t('skillsPipelineTasks')}</span>
                          {rows.length === 0
                            ? <p className={css.empty}>{t('skillsPipelineNoTasks')}</p>
                            : (
                              <div className={css.taskRefs}>
                                {rows.map(task => (
                                  <div key={task.id} className={css.taskRef}>
                                    <div className={css.taskRefHead}>
                                      <span className={css.taskRefTitle}>{task.title}</span>
                                      <ReferencedSkills
                                        skills={professionalSkills}
                                        selected={refs.tasks[task.id] ?? []}
                                        t={t}
                                      />
                                    </div>
                                    <SkillReferencePicker
                                      label={t('skillsPipelineTaskSkills')}
                                      skills={professionalSkills}
                                      selected={refs.tasks[task.id] ?? []}
                                      t={t}
                                      onToggle={(skillId) => { add(task.id, skillId) }}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
          </section>
        )}
      </div>

      <ImprovementList t={t} improvements={improvements} />
    </div>
  )
}
