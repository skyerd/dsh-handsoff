/**
 * Compact workspace picker used by the queue composer, queue settings and task
 * editor. It is the shared bounded dropdown plus the folder glyph, so the menu
 * keeps the card's width, caps its height and separates the workspace title
 * from its path.
 */

import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SelectMenu, type SelectMenuOption } from './SelectMenu.tsx'
import css from './WorkspaceField.module.css'

/** One selectable workspace, already projected to display fields. */
export interface WorkspaceOption {
  readonly value: string
  readonly title: string
  readonly path: string
}

/** Props of the compact workspace picker. */
export interface WorkspaceFieldProps {
  readonly label: string
  readonly placeholder: string
  readonly value: string
  readonly options: readonly WorkspaceOption[]
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}

/**
 * Render the picker trigger and its bounded menu.
 * @param props - localized labels, workspaces and the selected identity.
 * @returns the field.
 */
export function WorkspaceField({
  label, placeholder, value, options, disabled = false, onChange,
}: WorkspaceFieldProps) {
  const menuOptions: SelectMenuOption<string>[] = [
    { value: '', label: placeholder, muted: true },
    ...options.map(option => ({
      value: option.value,
      label: option.title,
      description: option.path,
    })),
  ]

  return (
    <div className={css.field}>
      <span className={css.label}>{label}</span>
      <SelectMenu
        label={label}
        value={value}
        options={menuOptions}
        disabled={disabled}
        placeholder={placeholder}
        icon={<IconFolderOpenOutlineRegular size={13} />}
        onChange={onChange}
      />
    </div>
  )
}
