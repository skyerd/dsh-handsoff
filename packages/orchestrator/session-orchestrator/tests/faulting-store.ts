/**
 * Durable-store wrapper that crashes before or after exactly one write.
 *
 * `before` leaves durable state untouched, the state a crashed process sees if
 * the write never reached the medium. `after` performs the real write and then
 * throws, modelling "the side effect landed but the response was lost". The
 * manager must never treat the second case as a reason to repeat the effect.
 */
import type { RecoveryStore } from '../src/recovery.ts'
import type { OperationId, RunId } from '../src/brand.ts'
import type { GlobalSettings, OperationRecord, RunRecord, TaskSpec } from '../src/schema.ts'

/** Durable writes the recovery manager performs. */
export type FaultMethod = 'updateRun' | 'advanceOperation' | 'updateSettings'

/** Where the injected crash happens relative to the durable write. */
export type FaultTiming = 'before' | 'after'

/** One armed or consumed crash point. */
export interface FaultRecord {
  readonly method: FaultMethod
  readonly timing: FaultTiming
  readonly reason: string
}

/** Transparent store wrapper with one-shot crash injection. */
export class FaultingRecoveryStore implements RecoveryStore {
  readonly faults: FaultRecord[] = []
  private next: FaultRecord | undefined

  /**
   * @param inner - real durable store.
   */
  constructor(private readonly inner: RecoveryStore) {}

  /** Arm one crash on the next write of `method`. */
  arm(method: FaultMethod, timing: FaultTiming, reason = `injected-${timing}-${method}`): void {
    this.next = { method, timing, reason }
  }

  /** Whether a crash is still armed. */
  get armed(): boolean {
    return this.next !== undefined
  }

  listRuns(): readonly RunRecord[] {
    return this.inner.listRuns()
  }

  getRun(id: RunId): RunRecord | undefined {
    return this.inner.getRun(id)
  }

  listOperations(): readonly OperationRecord[] {
    return this.inner.listOperations()
  }

  getOperation(id: OperationId): OperationRecord | undefined {
    return this.inner.getOperation(id)
  }

  getTask(id: TaskSpec['id']): TaskSpec | undefined {
    return this.inner.getTask(id)
  }

  getSettings(): GlobalSettings {
    return this.inner.getSettings()
  }

  async updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord> {
    return await this.write('updateRun', async () => await this.inner.updateRun(id, expectedRevision, next))
  }

  async advanceOperation(
    id: OperationId,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord> {
    return await this.write(
      'advanceOperation',
      async () => await this.inner.advanceOperation(id, expectedPhase, next),
    )
  }

  async updateSettings(expectedRevision: number, next: GlobalSettings): Promise<GlobalSettings> {
    return await this.write('updateSettings', async () => await this.inner.updateSettings(expectedRevision, next))
  }

  private async write<T>(method: FaultMethod, action: () => Promise<T>): Promise<T> {
    const fault = this.next
    if (fault === undefined || fault.method !== method) return await action()
    this.next = undefined
    this.faults.push(fault)
    if (fault.timing === 'before') throw new Error(fault.reason)
    await action()
    throw new Error(fault.reason)
  }
}
