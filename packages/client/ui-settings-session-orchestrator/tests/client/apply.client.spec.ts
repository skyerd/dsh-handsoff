/** Reversible settings-section registration over a real Cordis fiber. */

import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { OrchestratorSnapshotFrame } from '../../src/client/contract.ts'
import { en } from '../../src/client/locales.ts'
import { apply, inject, NS } from '../../src/client/index.ts'

interface Entry {
  readonly options: {
    readonly name: string
    readonly id?: string
    readonly order?: number
    readonly label?: () => string
    readonly locale?: string
    readonly inject?: () => object
  }
  readonly component: unknown
}

class FakeLocale extends Service {
  private readonly dictionaries = new Map<string, Record<string, Record<string, string>>>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void {
    this.dictionaries.set(namespace, dictionaries)
    return () => { this.dictionaries.delete(namespace) }
  }

  bind(namespace: string): (key: string) => string {
    return (key) => {
      const dictionary = this.dictionaries.get(namespace)?.en
      return dictionary?.[key] ?? key
    }
  }
}

class FakeSlots extends Service {
  readonly entries: Entry[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, factory: () => () => void): () => void {
    return this.ctx.effect(() => factory())
  }

  register(options: Entry['options'], component: unknown): () => void {
    const entry: Entry = { options, component }
    this.entries.push(entry)
    return this.ctx.effect(() => () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    })
  }
}

class FakeRemote extends Service {
  opened = false
  signal: AbortSignal | undefined

  constructor(ctx: Context) {
    super(ctx, 'remote.sessionOrchestrator')
  }

  changed(signal: AbortSignal): AsyncIterable<OrchestratorSnapshotFrame> {
    this.opened = true
    this.signal = signal
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    }
  }
}

describe('settings section contribution', () => {
  it('registers one owned section and removes it when the plugin fiber unloads', async () => {
    const root = new Context()
    const locale = new FakeLocale(root)
    const slots = new FakeSlots(root)
    const remote = new FakeRemote(root)
    expect(inject).toEqual(['slots', 'locale', 'remote.sessionOrchestrator'])

    const fiber = root.plugin({ inject, apply })
    await fiber

    expect(locale.bind(NS)('nav')).toBe(en.nav)
    // The page owns three seats: the settings section, the frame-wide notice
    // for a conversation link this browser could not open, and the opt-in
    // desktop pet that floats over the whole Harness window.
    expect(slots.entries.map(entry => entry.options.name)).toEqual([
      'shell.overlay', 'shell.overlay', 'settings.section',
    ])
    const entry = slots.entries.find(candidate => candidate.options.name === 'settings.section')
    expect(entry?.options).toMatchObject({
      name: 'settings.section',
      id: 'session-orchestrator',
      order: 40,
      locale: NS,
    })
    expect(entry?.options.label?.()).toBe(en.nav)
    expect(typeof entry?.options.inject).toBe('function')
    const notice = slots.entries.find(candidate => candidate.options.id === 'session-orchestrator-session-notice')
    expect(notice?.options).toMatchObject({ id: 'session-orchestrator-session-notice', locale: NS })
    expect(typeof notice?.options.inject).toBe('function')
    const pet = slots.entries.find(candidate => candidate.options.id === 'session-orchestrator-desktop-pet')
    expect(pet?.options).toMatchObject({ id: 'session-orchestrator-desktop-pet', locale: NS })
    expect(typeof pet?.options.inject).toBe('function')
    expect(remote.opened).toBe(true)
    expect(remote.signal?.aborted).toBe(false)

    await fiber.dispose()
    expect(slots.entries).toHaveLength(0)
    expect(remote.signal?.aborted).toBe(true)
    expect(locale.bind(NS)('nav')).toBe('nav')
  })
})
