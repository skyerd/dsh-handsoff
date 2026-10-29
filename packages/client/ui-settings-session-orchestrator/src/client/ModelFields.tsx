/**
 * Model policy fields shared by the pipeline default and one task override.
 *
 * The route list is the host's native model catalog; this component only
 * projects it. When the catalog is unavailable, `inherit` stays selectable and
 * a pinned route the catalog does not advertise stays visible, so a draft is
 * never silently rewritten to a different model.
 */

import type { ModelPolicy } from './contract.ts'
import type { OrchestratorTranslate } from './copy.ts'
import { pinnedRouteOf } from './model.ts'
import type { ModelCatalogState, ModelChoice } from './service.ts'
import { SelectField, TextField } from './Fields.tsx'

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
 * Render one model policy selector plus its route and reasoning controls.
 * @param props - localized copy, the current policy, the catalog and the change callback.
 * @returns the model policy fields.
 */
export function ModelPolicyFields({
  t, inheritLabel, value, models, disabled, onChange,
}: ModelPolicyFieldsProps) {
  const policy: ModelPolicy = value ?? { kind: 'inherit' }
  const available = models.phase === 'ready' && models.choices.length > 0
  const options = available || policy.kind === 'fixed'
    ? [
      { value: 'inherit', label: inheritLabel },
      { value: 'fixed', label: t('modelFixed') },
    ]
    : [{ value: 'inherit', label: inheritLabel }]
  const unavailableHint = models.phase === 'loading'
    ? t('modelCatalogLoading')
    : t('modelCatalogUnavailable', { reason: models.error ?? t('modelCatalogMissing') })

  const setFixed = (choice: ModelChoice, reasoningEffort?: string): void => {
    onChange({
      kind: 'fixed',
      provider: choice.provider,
      model: choice.model,
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    })
  }

  const currentKey = policy.kind === 'fixed' ? routeKey(policy.provider, policy.model) : ''
  const currentChoice = policy.kind === 'fixed' ? choiceOf(models.choices, currentKey) : undefined
  const routeOptions = models.choices.map(choice => ({
    value: routeKey(choice.provider, choice.model),
    label: choice.isDefault === true
      ? `${choice.providerName} · ${choice.modelName} · ${t('modelDefaultTag')}`
      : `${choice.providerName} · ${choice.modelName}`,
  }))
  if (policy.kind === 'fixed' && currentChoice === undefined) {
    routeOptions.unshift({ value: currentKey, label: `${policy.provider} · ${policy.model}` })
  }
  const reasoningOptions = currentChoice === undefined
    ? []
    : [
      { value: '', label: t('modelReasoningDefault') },
      ...currentChoice.reasoningEfforts.map(effort => ({ value: effort.id, label: effort.name })),
    ]

  return (
    <>
      <SelectField
        label={t('modelPolicy')}
        hint={available ? (policy.kind === 'fixed' ? t('modelFixedHint') : undefined) : unavailableHint}
        value={policy.kind}
        options={options}
        disabled={disabled}
        onChange={(kind) => {
          if (kind === 'inherit') {
            onChange({ kind: 'inherit' })
            return
          }
          // Pinning without asking must adopt the route an unconfigured Session
          // already uses; the catalog's first row is an arbitrary provider.
          const first = pinnedRouteOf(models.choices)
          if (first === undefined) return
          setFixed(first, first.defaultReasoningEffort)
        }}
      />
      {policy.kind === 'fixed' && (
        currentChoice === undefined
          ? (
            <TextField
              label={t('modelName')}
              hint={available ? t('modelChoiceMissing') : unavailableHint}
              value={currentKey}
              disabled
              onChange={() => {}}
            />
          )
          : (
            <SelectField
              label={t('modelName')}
              value={currentKey}
              options={routeOptions}
              disabled={disabled}
              onChange={(key) => {
                const choice = choiceOf(models.choices, key)
                if (choice !== undefined) setFixed(choice, choice.defaultReasoningEffort)
              }}
            />
          )
      )}
      {policy.kind === 'fixed' && currentChoice !== undefined && currentChoice.reasoningEfforts.length > 0 && (
        <SelectField
          label={t('modelReasoning')}
          value={policy.reasoningEffort ?? ''}
          options={reasoningOptions}
          disabled={disabled}
          onChange={(effort) => {
            if (currentChoice !== undefined) setFixed(currentChoice, effort)
          }}
        />
      )}
    </>
  )
}
