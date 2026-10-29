/** Test harness for the orchestrator store: real domain storage over an in-memory medium. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SessionOrchestrator from '../src/store.ts'

/** Services and medium one orchestrator store runs against. */
export interface Harness {
  /** Context that owns the store and the domain facility. */
  readonly ctx: Context
  /** Shared medium, reusable by a second harness to simulate a restart. */
  readonly pool: MemoryMediaPool
  /** The store service, available as `ctx.sessionOrchestrator`. */
  readonly store: SessionOrchestrator
  /** Close the store and release the backend. */
  readonly close: () => Promise<void>
}

/**
 * Compose one orchestrator store over a memory-backed domain facility.
 * @param pool - Shared medium; pass the pool of a closed harness to reopen the same data.
 * @returns the harness handles.
 */
export async function harness(pool: MemoryMediaPool = new MemoryMediaPool()): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  await ctx.plugin(SessionOrchestrator)
  return {
    ctx,
    pool,
    store: ctx.sessionOrchestrator,
    close: async () => {
      await ctx.sessionOrchestrator.close()
      await facility.closeAll()
      await backend.close()
    },
  }
}
