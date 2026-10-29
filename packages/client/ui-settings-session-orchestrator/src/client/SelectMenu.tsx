/**
 * The one bounded dropdown used by every orchestration field.
 *
 * A native `<select>` popup is drawn by the operating system: it ignores the
 * trigger width, keeps square corners and can cover content far outside the
 * card. This control owns its own list instead, so the menu never leaves the
 * field's column, scrolls inside a capped height and shares one visual recipe
 * with the workspace picker that already behaved that way.
 */

import {
  useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react'
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMenuFlip } from './useMenuFlip.ts'
import css from './SelectMenu.module.css'

/** One selectable row; `description` renders the optional second line. */
export interface SelectMenuOption<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly description?: string
  /** Placeholder row: drawn in the muted tone like the workspace "none" entry. */
  readonly muted?: boolean | undefined
}

/** Props of the bounded dropdown. */
export interface SelectMenuProps<Value extends string> {
  readonly label: string
  readonly value: Value
  readonly options: readonly SelectMenuOption<Value>[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean | undefined
  /** Muted text shown when the current value has no row. */
  readonly placeholder?: string | undefined
  /** Optional leading glyph, e.g. the workspace folder. */
  readonly icon?: ReactNode
}

/** Gap between the trigger and its menu, mirrored by the flip threshold. */
const MENU_GAP = 4

/**
 * Render one bounded dropdown.
 * @param props - localized label, options, current value and the change callback.
 * @returns the trigger and, while open, its contained menu.
 */
export function SelectMenu<Value extends string>({
  label, value, options, onChange, disabled = false, placeholder, icon,
}: SelectMenuProps<Value>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const { anchorRef: trigger, menuRef: menu, flipped } = useMenuFlip<HTMLButtonElement>(open, MENU_GAP)
  const base = useId().replaceAll(':', '')
  const listId = `${base}-list`
  const selectedIndex = options.findIndex(option => option.value === value)
  const current = selectedIndex < 0 ? undefined : options[selectedIndex]
  const activeOption = active >= 0 && active < options.length ? options[active] : undefined

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    // Escape belongs to the open menu. Listening in the capture phase keeps the
    // surrounding settings dialog from closing on the same press, which is what
    // a native select used to guarantee on its own.
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  // Follow the keyboard cursor without dragging the page: the menu scrolls.
  useEffect(() => {
    if (!open) return
    const row = menu.current?.children[active]
    if (row === undefined || !(row instanceof HTMLElement)) return
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const choose = (option: SelectMenuOption<Value>): void => {
    onChange(option.value)
    setOpen(false)
    trigger.current?.focus()
  }

  const show = (): void => {
    if (disabled) return
    setOpen(true)
    setActive(selectedIndex < 0 ? 0 : selectedIndex)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      setOpen(false)
      return
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        show()
        if (event.key === 'ArrowUp' && options.length > 0) setActive(options.length - 1)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive(index => Math.min(index + 1, options.length - 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive(index => Math.max(index - 1, 0))
        return
      case 'Home':
        event.preventDefault()
        setActive(0)
        return
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        return
      case 'Enter':
      case ' ': {
        event.preventDefault()
        if (activeOption !== undefined) choose(activeOption)
        return
      }
      default:
    }
  }

  return (
    <div className={css.root} ref={root}>
      <button
        type="button"
        ref={trigger}
        className={css.trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeOption !== undefined ? `${base}-opt-${String(active)}` : undefined}
        title={current?.description ?? current?.label ?? placeholder}
        disabled={disabled}
        onClick={() => { if (open) setOpen(false); else show() }}
        onKeyDown={onTriggerKeyDown}
      >
        {icon !== undefined && <span className={css.leading} aria-hidden="true">{icon}</span>}
        <span className={css.value}>
          {current !== undefined && current.muted !== true
            ? current.label
            : <span className={css.placeholder}>{current?.label ?? placeholder ?? ''}</span>}
        </span>
        <IconChevronDownOutlineRegular
          size={12}
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
        />
      </button>
      {open && (
        <div
          ref={menu}
          id={listId}
          role="listbox"
          aria-label={label}
          className={flipped ? `${css.menu} ${css.menuUp}` : css.menu}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              id={`${base}-opt-${String(index)}`}
              role="option"
              aria-selected={option.value === value}
              data-active={index === active}
              className={css.option}
              onClick={() => { choose(option) }}
              onPointerEnter={() => { setActive(index) }}
            >
              <span className={css.optionText}>
                <span className={option.muted === true ? css.optionMuted : css.optionLabel}>{option.label}</span>
                {option.description !== undefined && option.description !== '' && (
                  <span className={css.optionDescription} title={option.description}>{option.description}</span>
                )}
              </span>
              {option.value === value && <IconCheckOutlineRegular size={12} className={css.check} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
