/**
 * The row-level "more" control: one ellipsis trigger and a rounded action list.
 *
 * A queue card and a composer row each own destructive actions, and repeating
 * `Delete` as a bare button puts the one irreversible choice at the same weight
 * as Start. The list opens upward because the trigger sits in a card footer, and
 * it closes on an outside pointer, on Escape, and on every selection.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RowMenu.module.css'

/** One selectable action inside the menu. */
export interface RowMenuItem {
  /** Stable identity for React and for tests. */
  readonly id: string
  readonly label: string
  /** Destructive rows are tinted and never the accidental first target. */
  readonly tone?: 'default' | 'danger'
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** Props of the ellipsis menu. */
export interface RowMenuProps {
  /** Accessible name of the trigger, for example `Queue actions`. */
  readonly label: string
  readonly items: readonly RowMenuItem[]
  readonly disabled?: boolean
}

/**
 * Render one ellipsis trigger and its action list.
 * @param props - trigger name, actions and the shared busy flag.
 * @returns the menu control.
 */
export function RowMenu({ label, items, disabled = false }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current !== null && event.target instanceof Node && root.current.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={css.root} ref={root}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconEllipsisOutlineRegular size={14} />
      </Button>
      {open && (
        <div className={css.list} role="menu" aria-label={label}>
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.tone === 'danger' ? `${css.item} ${css.danger}` : css.item}
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
