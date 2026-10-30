/**
 * Model policy as two compact property rows.
 *
 * A row shows its label, the current value and the expansion glyph next to the
 * value. Opening a row shows one floating panel beside the row, so choosing a
 * model or a reasoning effort never pushes the surrounding form down.
 */

import { useEffect, useRef, useState } from 'react'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelPolicy } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { pinnedRouteOf } from './model.ts'
import type { ModelCatalogState, ModelChoice } from './service.ts'
import { useMenuFlip } from './useMenuFlip.ts'
import css from './ModelFields.module.css'

/** One selectable model route's form value. */
function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Find one advertised route by its form value. */
function choiceOf(choices: readonly ModelChoice[], key: string): ModelChoice | undefined {
  return choices.find(choice => routeKey(choice.provider, choice.model) === key)
}

/** Props for the shared model policy control. */
export interface ModelPolicyFieldsProps {
  readonly t: OrchestratorTranslate
  /** Label for the inheritance option: pipeline default or host default. */
  readonly inheritLabel: string
  readonly value: ModelPolicy | undefined
  readonly models: ModelCatalogState
  readonly disabled: boolean
  readonly onChange: (next: ModelPolicy) => void
}

/**
 * Render the model and reasoning property rows.
 * @param props - localized copy, current policy, catalog and change callback.
 * @returns the property-row group.
 */
export function ModelPolicyFields({
  t, inheritLabel, value, models, disabled, onChange,
}: ModelPolicyFieldsProps) {
  const [open, setOpen] = useState<'model' | 'reasoning' | undefined>()
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const modelMenu = useMenuFlip<HTMLButtonElement>(open === 'model')
  const reasoningMenu = useMenuFlip<HTMLButtonElement>(open === 'reasoning')
  const policy: ModelPolicy = value ?? { kind: 'inherit' }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const available = models.phase === 'ready' && models.choices.length > 0
  const currentKey = policy.kind === 'fixed' ? routeKey(policy.provider, policy.model) : ''
  const currentChoice = policy.kind === 'fixed' ? choiceOf(models.choices, currentKey) : undefined
  const modelValue = policy.kind === 'inherit'
    ? inheritLabel
    : currentChoice === undefined
      ? currentKey
      : `${currentChoice.providerName} · ${currentChoice.modelName}`
  const currentEffort = policy.kind === 'fixed' && currentChoice !== undefined
    ? currentChoice.reasoningEfforts.find(effort => effort.id === policy.reasoningEffort)
    : undefined
  const reasoningLabel = currentEffort?.name ?? t('modelReasoningDefault')
  const unavailableHint = models.phase === 'loading'
    ? t('modelCatalogLoading')
    : t('modelCatalogUnavailable', { reason: models.error ?? t('modelCatalogMissing') })

  useEffect(() => {
    if (open === undefined) return
    const closeOutside = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(undefined)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setOpen(undefined)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  const filteredChoices = normalizedQuery === ''
    ? models.choices
    : models.choices.filter(choice => (
      `${choice.providerName} ${choice.modelName} ${choice.provider} ${choice.model}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ))
  const setFixed = (choice: ModelChoice, reasoningEffort?: string): void => {
    onChange({
      kind: 'fixed',
      provider: choice.provider,
      model: choice.model,
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    })
  }

  return (
    <div className={css.group} ref={root}>
      <div className={css.rowWrap}>
        <button
          ref={modelMenu.anchorRef}
          type="button"
          className={css.row}
          disabled={disabled}
          aria-expanded={open === 'model'}
          onClick={() => { setOpen(open === 'model' ? undefined : 'model') }}
        >
          <span className={css.rowLabel}>{t('modelName')}</span>
          <span className={css.rowValue} title={modelValue}>{modelValue}</span>
          <IconChevronDownOutlineRegular
            size={12}
            className={open === 'model' ? `${css.chevron} ${css.chevronUp}` : css.chevron}
          />
        </button>
        {open === 'model' && (
          <div
            ref={modelMenu.menuRef}
            className={modelMenu.flipped ? `${css.popover} ${css.popoverUp}` : css.popover}
          >
            <div className={css.optionList} role="listbox" aria-label={t('modelName')}>
            {models.choices.length > 4 && (
              <input
                className={css.search}
                value={query}
                placeholder={t('modelSearchPlaceholder')}
                aria-label={t('modelSearchPlaceholder')}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            )}
            <button
              type="button"
              role="option"
              aria-selected={policy.kind === 'inherit'}
              className={css.option}
              onClick={() => {
                onChange({ kind: 'inherit' })
                setOpen(undefined)
              }}
            >
              <span className={css.optionLabel}>{inheritLabel}</span>
              {policy.kind === 'inherit' && <IconCheckOutlineRegular size={12} className={css.check} />}
            </button>
            {policy.kind === 'fixed' && currentChoice === undefined && (
              <button
                type="button"
                role="option"
                aria-selected="true"
                className={`${css.option} ${css.optionSelected}`}
                onClick={() => { setOpen(undefined) }}
              >
                <span className={css.optionLabel}>{currentKey}</span>
                <IconCheckOutlineRegular size={12} className={css.check} />
              </button>
            )}
            {filteredChoices.map(choice => (
              <button
                key={routeKey(choice.provider, choice.model)}
                type="button"
                role="option"
                aria-selected={currentKey === routeKey(choice.provider, choice.model)}
                className={css.option}
                onClick={() => {
                  setFixed(choice, choice.defaultReasoningEffort)
                  setOpen(undefined)
                }}
              >
                <span className={css.optionText}>
                  <span className={css.optionLabel}>
                    {choice.providerName} · {choice.modelName}
                  </span>
                  {choice.isDefault === true && (
                    <span className={css.optionDescription}>{t('modelDefaultTag')}</span>
                  )}
                </span>
                {currentKey === routeKey(choice.provider, choice.model) && (
                  <IconCheckOutlineRegular size={12} className={css.check} />
                )}
              </button>
            ))}
          </div>
          {!available && <span className={css.hint}>{unavailableHint}</span>}
          </div>
        )}
      </div>

      {policy.kind === 'fixed' && currentChoice !== undefined && currentChoice.reasoningEfforts.length > 0 && (
        <div className={css.rowWrap}>
          <button
            ref={reasoningMenu.anchorRef}
            type="button"
            className={css.row}
            disabled={disabled}
            aria-expanded={open === 'reasoning'}
            onClick={() => { setOpen(open === 'reasoning' ? undefined : 'reasoning') }}
          >
            <span className={css.rowLabel}>{t('modelReasoning')}</span>
            <span className={css.rowValue} title={reasoningLabel}>{reasoningLabel}</span>
            <IconChevronDownOutlineRegular
              size={12}
              className={open === 'reasoning' ? `${css.chevron} ${css.chevronUp}` : css.chevron}
            />
          </button>
          {open === 'reasoning' && (
            <div
              ref={reasoningMenu.menuRef}
              className={reasoningMenu.flipped ? `${css.popover} ${css.popoverUp}` : css.popover}
            >
              <div className={css.optionList} role="listbox" aria-label={t('modelReasoning')}>
                <button
                  type="button"
                  role="option"
                  aria-selected={policy.reasoningEffort === undefined}
                  className={css.option}
                  onClick={() => {
                    setFixed(currentChoice)
                    setOpen(undefined)
                  }}
                >
                  <span className={css.optionLabel}>{t('modelReasoningDefault')}</span>
                  {policy.reasoningEffort === undefined && <IconCheckOutlineRegular size={12} className={css.check} />}
                </button>
                {currentChoice.reasoningEfforts.map(effort => (
                  <button
                    key={effort.id}
                    type="button"
                    role="option"
                    aria-selected={policy.reasoningEffort === effort.id}
                    className={css.option}
                    onClick={() => {
                      setFixed(currentChoice, effort.id)
                      setOpen(undefined)
                    }}
                  >
                    <span className={css.optionLabel}>{effort.name}</span>
                    {policy.reasoningEffort === effort.id && (
                      <IconCheckOutlineRegular size={12} className={css.check} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
