/**
 * Placement helper for popovers anchored inside a scrolling panel.
 *
 * A menu that only ever opens downward runs past the bottom of the card it
 * belongs to and disappears behind the panel's clip. This measures the room
 * below the anchor — bounded by the viewport and every scrolling ancestor —
 * and asks the caller to flip the menu above the anchor when the list cannot
 * fit there.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Room kept free between a menu and the edge it would touch. */
const EDGE_MARGIN = 8

/** Vertical neighbourhood a popover may use: the viewport narrowed by clipping ancestors. */
function clipBounds(anchor: HTMLElement): { readonly top: number; readonly bottom: number } {
  let top = 0
  let bottom = window.innerHeight
  for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'hidden') continue
    const rect = node.getBoundingClientRect()
    top = Math.max(top, rect.top)
    bottom = Math.min(bottom, rect.bottom)
  }
  return { top, bottom }
}

/** Refs and placement flag for one popover. */
export interface MenuFlip<Anchor extends HTMLElement = HTMLElement> {
  readonly anchorRef: RefObject<Anchor>
  readonly menuRef: RefObject<HTMLDivElement>
  /** True when the menu must render above its anchor instead of below. */
  readonly flipped: boolean
}

/**
 * Decide whether a popover opens upward.
 * @param open - whether the popover is currently mounted.
 * @param gap - pixels between the anchor and the menu.
 * @returns the anchors to attach and the resolved side.
 */
export function useMenuFlip<Anchor extends HTMLElement = HTMLElement>(
  open: boolean,
  gap = 4,
): MenuFlip<Anchor> {
  const anchorRef = useRef<Anchor>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [flipped, setFlipped] = useState(false)

  useLayoutEffect(() => {
    if (!open) {
      setFlipped(false)
      return
    }
    const anchor = anchorRef.current?.getBoundingClientRect()
    const height = menuRef.current?.offsetHeight ?? 0
    if (anchor === undefined || anchorRef.current === null || height === 0) return
    const bounds = clipBounds(anchorRef.current)
    const below = bounds.bottom - anchor.bottom - gap - EDGE_MARGIN
    const above = anchor.top - bounds.top - gap - EDGE_MARGIN
    setFlipped(height > below && above >= height)
  }, [open, gap])

  return { anchorRef, menuRef, flipped }
}
