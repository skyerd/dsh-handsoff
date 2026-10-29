// @vitest-environment jsdom
/**
 * The bounded dropdown: it draws its own list instead of the operating
 * system's, so the menu stays inside the field's column and behaves for keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectMenu, type SelectMenuOption } from '../../src/client/SelectMenu.tsx'

afterEach(cleanup)

const OPTIONS: readonly SelectMenuOption<string>[] = [
  { value: '', label: 'No workspace', muted: true },
  { value: 'w1', label: 'Workspace one', description: '/work/one' },
  { value: 'w2', label: 'Workspace two', description: '/work/two' },
]

/** Render the menu with a fixed value and a change spy. */
function renderMenu(value = 'w1'): { readonly onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn()
  render(
    <SelectMenu
      label="Folder"
      value={value}
      options={OPTIONS}
      placeholder="No workspace"
      onChange={onChange}
    />,
  )
  return { onChange }
}

describe('select menu', () => {
  it('keeps the list closed until the trigger is used', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Folder' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.textContent).toContain('Workspace one')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens one listbox with every option and marks the current row', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Folder' }))
    const list = screen.getByRole('listbox', { name: 'Folder' })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(3)
    expect(list.contains(rows[1] ?? null)).toBe(true)
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows[2]?.getAttribute('aria-selected')).toBe('false')
    // The path line travels with its option, not the trigger.
    expect(rows[1]?.textContent).toContain('/work/one')
  })

  it('reports the picked value and closes the list', () => {
    const { onChange } = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: /Workspace two/u }))
    expect(onChange).toHaveBeenCalledWith('w2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves the keyboard cursor and commits it with Enter', () => {
    const { onChange } = renderMenu()
    const trigger = screen.getByRole('button', { name: 'Folder' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    // Opens on the current row, so the next press steps to the third option.
    const opened = trigger.getAttribute('aria-activedescendant')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-activedescendant')).not.toBe(opened)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('w2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Escape and on an outside pointer without choosing', () => {
    const { onChange } = renderMenu()
    const trigger = screen.getByRole('button', { name: 'Folder' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stays shut while disabled', () => {
    render(
      <SelectMenu label="Folder" value="w1" options={OPTIONS} disabled onChange={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Folder' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('falls back to the muted placeholder when the value has no row', () => {
    renderMenu('missing')
    expect(screen.getByRole('button', { name: 'Folder' }).textContent).toContain('No workspace')
  })
})
