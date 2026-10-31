/**
 * Inline line icons for the desktop pet rail.
 *
 * The geometry follows the standard Lucide icon vocabulary (ISC): 24×24 view,
 * 1.8 stroke, round caps. Keeping them inline avoids adding an icon package and
 * lets every future rail action reuse the same visual weight. Add a new icon in
 * this file and reference it from `PetRail.tsx`.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetIcons
 */

import type { ReactNode, SVGProps } from 'react'

/** Shared frame for one line icon. */
export function PetIcon({ children, ...props }: SVGProps<SVGSVGElement> & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

/** Three dots, used for the speech-bubble toggle. */
export function EllipsisIcon() {
  return (
    <PetIcon>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </PetIcon>
  )
}

/** A house, used to send the fish back to the settings page. */
export function HomeIcon() {
  return (
    <PetIcon>
      <path d="m3 10 9-7 9 7" />
      <path d="M5 9.2V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.2" />
      <path d="M9.5 21v-6h5v6" />
    </PetIcon>
  )
}

/** An open eye, shown when the aura is hidden and can be restored. */
export function EyeIcon() {
  return (
    <PetIcon>
      <path d="M2 12s3.2-7 10-7 10 7 10 7-3.2 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </PetIcon>
  )
}

/** A crossed-out eye, shown while the aura is visible. */
export function EyeOffIcon() {
  return (
    <PetIcon>
      <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7" />
      <path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 1 0 4.2 4.2" />
      <path d="m2 2 20 20" />
    </PetIcon>
  )
}

/** Four outward arrows, used to open the size panel. */
export function ExpandIcon() {
  return (
    <PetIcon>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </PetIcon>
  )
}

/** Four inward arrows, used while the size panel is open. */
export function MinimizeIcon() {
  return (
    <PetIcon>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="m14 10 7-7" />
      <path d="m3 21 7-7" />
    </PetIcon>
  )
}
