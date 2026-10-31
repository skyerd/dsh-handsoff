/** The bundled sprite grid resolves deterministic rows and frames. */

import { describe, expect, it } from 'vitest'
import { frameAt, gazeFrame, motionForMood } from '../../src/client/petFrames.ts'

describe('pet sprite frame timing', () => {
  it('plays the idle row in order and holds the last frame', () => {
    expect(frameAt('idle', 0)).toEqual({ row: 0, column: 0 })
    expect(frameAt('idle', 300)).toEqual({ row: 0, column: 1 })
    expect(frameAt('idle', 1_060)).toEqual({ row: 0, column: 5 })
  })

  it('freezes the first frame when reduced motion is requested', () => {
    expect(frameAt('working', 0, true)).toEqual({ row: 7, column: 0 })
    expect(frameAt('working', 900, true)).toEqual({ row: 7, column: 0 })
  })

  it('uses the resting pose for sleep', () => {
    expect(frameAt('sleep', 0)).toEqual({ row: 0, column: 3 })
    expect(frameAt('sleep', 10_000)).toEqual({ row: 0, column: 3 })
  })

  it('maps every mood to one action row', () => {
    expect(motionForMood('connecting')).toBe('waiting')
    expect(motionForMood('working')).toBe('working')
    expect(motionForMood('attention')).toBe('waiting')
    expect(motionForMood('done')).toBe('jump')
    expect(motionForMood('error')).toBe('failed')
    expect(motionForMood('sleeping')).toBe('sleep')
    expect(motionForMood('idle')).toBe('idle')
  })

  it('maps pointer offsets to the sixteen gaze cells', () => {
    expect(gazeFrame({ dx: 0, dy: 0 })).toBeUndefined()
    expect(gazeFrame({ dx: 0, dy: -100 })).toEqual({ row: 9, column: 0 })
    expect(gazeFrame({ dx: 100, dy: 0 })).toEqual({ row: 9, column: 4 })
    expect(gazeFrame({ dx: 0, dy: 100 })).toEqual({ row: 10, column: 0 })
    expect(gazeFrame({ dx: -100, dy: 0 })).toEqual({ row: 10, column: 4 })
  })
})
