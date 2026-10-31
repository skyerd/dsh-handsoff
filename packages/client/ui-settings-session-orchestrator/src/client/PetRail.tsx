/**
 * Vertical control rail that appears when the desktop fish is right-clicked.
 *
 * The rail is deliberately data-driven: `DesktopPet` passes one
 * `PetRailAction` per button, so adding a future action only means appending
 * one entry there and (if it needs a new glyph) adding an icon to
 * `PetIcons.tsx`. The panel with the size slider is owned by this component.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/PetRail
 */

import type { ReactNode } from 'react'
import css from './PetRail.module.css'

/** One icon button in the rail. */
export interface PetRailAction {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
  /** Draw the button as currently enabled. */
  readonly active?: boolean
  readonly onPress: () => void
}

/** Props of the rail. */
export interface PetRailProps {
  /** Left of the fish by default; flips right only when the viewport is tight. */
  readonly side: 'left' | 'right'
  readonly label: string
  readonly actions: readonly PetRailAction[]
  readonly scaleOpen: boolean
  readonly scale: number
  readonly minScale: number
  readonly maxScale: number
  readonly scaleLabel: string
  readonly scaleValueLabel: string
  readonly scaleResetLabel: string
  readonly onScaleChange: (value: number) => void
  readonly onScaleReset: () => void
}

/**
 * Render the right-click rail and its optional size panel.
 * @param props - actions, side, and current size state.
 * @returns the floating toolbar.
 */
export function PetRail({
  side, label, actions, scaleOpen, scale, minScale, maxScale,
  scaleLabel, scaleValueLabel, scaleResetLabel, onScaleChange, onScaleReset,
}: PetRailProps) {
  const sideClass = side === 'right' ? css.railRight : css.railLeft
  const panelSideClass = side === 'right' ? css.panelRight : css.panelLeft
  return (
    <div
      className={`${css.rail} ${sideClass}`}
      role="toolbar"
      aria-label={label}
      aria-orientation="vertical"
      onContextMenu={(event) => { event.preventDefault() }}
    >
      <div className={css.buttons}>
        {actions.map(action => (
          <button
            key={action.id}
            type="button"
            className={css.button}
            data-active={action.active === true ? 'true' : 'false'}
            aria-label={action.label}
            aria-pressed={action.active === true}
            title={action.label}
            onClick={action.onPress}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {scaleOpen && (
        <section className={`${css.scalePanel} ${panelSideClass}`} aria-label={scaleLabel}>
          <div className={css.scaleHead}>
            <span>{scaleLabel}</span>
            <span className={css.scaleValue}>{scaleValueLabel}</span>
          </div>
          <input
            className={css.scaleRange}
            type="range"
            min={minScale}
            max={maxScale}
            step={2}
            value={scale}
            aria-label={scaleLabel}
            onChange={(event) => { onScaleChange(Number(event.target.value)) }}
          />
          <button type="button" className={css.scaleReset} onClick={onScaleReset}>
            {scaleResetLabel}
          </button>
        </section>
      )}
    </div>
  )
}
