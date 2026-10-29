// @vitest-environment jsdom
/**
 * Session routes: a link that outlives the page still selects one Session, and
 * a link this browser cannot honour states why.
 *
 * The route carries an identity and nothing else, so these tests never stage a
 * title: they set the address bar, mount the real plugin, and assert the one
 * navigation call the page makes.
 */

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { OrchestratorSnapshotFrame } from '../../src/client/contract.ts'
import type { ClientError } from '../../src/client/errors.ts'
import type { OrchestratorDraftState } from '../../src/client/service.ts'
import { en } from '../../src/client/locales.ts'
import { apply, inject, NS } from '../../src/client/index.ts'
import { SessionNotice } from '../../src/client/SessionNotice.tsx'
import { translate } from './render.client.tsx'

interface SlotEntry {
  readonly options: { readonly name: string; readonly inject?: () => object }
  readonly component: unknown
}

class FakeLocale extends Service {
  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(): () => void {
    return () => {}
  }

  bind(namespace: string): (key: string) => string {
    return (key) => (namespace === NS ? (en as Record<string, string>)[key] ?? key : key)
  }
}

class FakeSlots extends Service {
  readonly entries: SlotEntry[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, factory: () => () => void): () => void {
    return this.ctx.effect(() => factory())
  }

  register(options: SlotEntry['options'], component: unknown): () => void {
    const entry: SlotEntry = { options, component }
    this.entries.push(entry)
    return this.ctx.effect(() => () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    })
  }
}

class FakeRemote extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remote.sessionOrchestrator')
  }

  changed(signal: AbortSignal): AsyncIterable<OrchestratorSnapshotFrame> {
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

/** A catalog that already holds the Sessions one test names. */
class FakeSessions extends Service {
  readonly list: {
    getSnapshot(): { readonly phase: string; readonly byId: Readonly<Record<string, unknown>> }
    subscribe(listener: () => void): () => void
  }

  constructor(ctx: Context, ids: readonly string[], phase = 'ready') {
    super(ctx, 'sessions')
    const byId = Object.fromEntries(ids.map(id => [id, { sessionId: id }]))
    this.list = {
      getSnapshot: () => ({ phase, byId }),
      subscribe: () => () => {},
    }
  }
}

/** A Workspace navigator that records every selection. */
class FakeWorkspace extends Service {
  readonly opened: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'uiWorkspace')
  }

  openSession(sessionId: string): void {
    this.opened.push(sessionId)
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  window.history.replaceState({}, '', '/')
})

/** Mount the plugin on a fresh root with the given Session services. */
async function mount(options: { readonly ids: readonly string[]; readonly phase?: string }): Promise<{
  readonly workspace: FakeWorkspace
  readonly slots: FakeSlots
  readonly face: { readonly hooks: { readonly drafts: { getSnapshot(): OrchestratorDraftState } } }
}> {
  const root = new Context()
  roots.push(root)
  new FakeLocale(root)
  const slots = new FakeSlots(root)
  new FakeRemote(root)
  const workspace = new FakeWorkspace(root)
  new FakeSessions(root, options.ids, options.phase ?? 'ready')
  const fiber = root.plugin({ inject, apply })
  await fiber
  const carrier = slots.entries.find(entry => entry.options.name === 'settings.section')
  const face = carrier?.options.inject?.() as {
    readonly hooks: { readonly drafts: { getSnapshot(): OrchestratorDraftState } }
  }
  return { workspace, slots, face }
}

describe('Session route', () => {
  it('selects the Session the address names', async () => {
    window.history.replaceState({}, '', '/?dsh-session=session-1')
    const { workspace } = await mount({ ids: ['session-1'] })
    expect(workspace.opened).toEqual(['session-1'])
  })

  it('keeps the parameter so a refresh re-opens the same Session', async () => {
    window.history.replaceState({}, '', '/?dsh-session=session-1')
    await mount({ ids: ['session-1'] })
    expect(window.location.search).toBe('?dsh-session=session-1')
  })

  it('retains the reason for a Session this browser no longer holds', async () => {
    window.history.replaceState({}, '', '/?dsh-session=session-gone')
    const { workspace, face } = await mount({ ids: ['session-1'] })
    expect(workspace.opened).toEqual([])
    expect(face.hooks.drafts.getSnapshot().errors[0]).toMatchObject({
      operation: 'openSession',
      code: 'ui/session-missing',
      detail: 'session-gone',
    })
  })

  it('opens nothing without a Session parameter', async () => {
    const { workspace, face } = await mount({ ids: ['session-1'] })
    expect(workspace.opened).toEqual([])
    expect(face.hooks.drafts.getSnapshot().errors).toEqual([])
  })
})

describe('Session notice', () => {
  /** One retained link failure. */
  const failure: ClientError = {
    id: 'error-1',
    at: 1,
    operation: 'openSession',
    code: 'ui/session-archived',
    message: '',
    detail: 'session-7',
  }

  const drafts = (errors: readonly ClientError[]): OrchestratorDraftState => ({
    selectedQueueId: undefined,
    queue: null,
    task: null,
    settings: null,
    queueTasks: [],
    errors,
    busy: undefined,
  })

  it('states the stable reason and the Session it was about', () => {
    const dismissed = vi.fn()
    const view = render(
      <SessionNotice
        t={translate}
        dismissError={dismissed}
        useDrafts={selector => selector(drafts([failure]))}
      />,
    )
    expect(view.getByText(en.sessionNoticeTitle)).toBeTruthy()
    expect(view.getByText(en.explanationUiSessionArchived)).toBeTruthy()
    expect(view.getByText(translate('sessionNoticeDetail', { sessionId: 'session-7' }))).toBeTruthy()
    view.getByRole('button', { name: en.dismiss }).click()
    expect(dismissed).toHaveBeenCalledWith('error-1')
    view.unmount()
  })

  it('stays absent while no link failed', () => {
    const view = render(
      <SessionNotice
        t={translate}
        dismissError={() => {}}
        useDrafts={selector => selector(drafts([]))}
      />,
    )
    expect(view.queryByText(en.sessionNoticeTitle)).toBeNull()
    view.unmount()
  })
})
