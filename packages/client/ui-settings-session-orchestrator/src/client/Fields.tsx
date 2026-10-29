/** Small labeled form wrappers shared by the orchestration settings tabs. */

import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { SelectMenu } from './SelectMenu.tsx'
import css from './Fields.module.css'

/** One labeled control with optional hint. */
export function Field({ label, hint, children }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly children: ReactNode
}) {
  return (
    <div className={css.field}>
      <span className={css.label}>{label}</span>
      {children}
      {hint !== undefined && <span className={css.hint}>{hint}</span>}
    </div>
  )
}

/** One single-line text field. */
export function TextField({ label, hint, value, onChange, disabled, placeholder, id }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly placeholder?: string | undefined
  readonly id?: string
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.currentTarget.value) }}
      />
    </Field>
  )
}

/** One numeric field; invalid or empty text never reaches the caller. */
export function NumberField({ label, hint, value, onChange, disabled, min, max, step = 1 }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly value: number | undefined
  readonly onChange: (value: number) => void
  readonly disabled?: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value === undefined ? '' : String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.currentTarget.value)
          if (event.currentTarget.value === '' || !Number.isFinite(next)) return
          onChange(next)
        }}
      />
    </Field>
  )
}

/**
 * One enum select. The list is drawn by this package rather than by the
 * operating system, so it keeps the field's width, round corners and a capped
 * height in every panel it appears in.
 */
export function SelectField<Value extends string>({ label, hint, value, options, onChange, disabled }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly value: Value
  readonly options: readonly {
    readonly value: Value
    readonly label: string
    /** Draw the row as a placeholder (muted), e.g. the empty choice. */
    readonly muted?: boolean | undefined
  }[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean
}) {
  return (
    <Field label={label} hint={hint}>
      <SelectMenu
        label={label}
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
      />
    </Field>
  )
}

/** One multi-line prompt field. */
export function TextAreaField({ label, hint, value, onChange, disabled, rows = 5, placeholder }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly rows?: number
  readonly placeholder?: string | undefined
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={css.textarea}
        aria-label={label}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => { onChange(event.currentTarget.value) }}
      />
    </Field>
  )
}
