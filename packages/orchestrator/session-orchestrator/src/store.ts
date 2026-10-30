/**
 * Durable orchestration store.
 *
 * Every mutation runs on one FIFO chain, so two callers cannot interleave a
 * read-modify-write that spans more than one record. Each transition carries the
 * revision it expects: the compare happens inside the table's atomic
 * read-modify-write slot, so a stale caller rejects instead of overwriting. The
 * store never starts an agent, calls a model, or appends a session event.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { OrchestratorError } from './errors.ts'
import { sessionOrchestratorDomain } from './storage.ts'
import type {
  GlobalSettings,
  HandoffRecord,
  InterventionRecord,
  OperationRecord,
  QueueRecord,
  RunRecord,
  SkipRecord,
  TaskSpec,
  WardenAuditRecord,
} from './types.ts'
import type { OperationId, QueueId, RunId, TaskId } from './brand.ts'

/** A record that participates in optimistic-concurrency revision checks. */
interface Revisioned {
  readonly revision: number
}

/** Tables the store writes, resolved once when the domain opens. */
interface StoreTables {
  readonly queues: KvTable<QueueId, QueueRecord>
  readonly tasks: KvTable<TaskId, TaskSpec>
  readonly runs: KvTable<RunId, RunRecord>
  readonly operations: KvTable<OperationId, OperationRecord>
  readonly handoffs: KvTable<OperationId, HandoffRecord>
  readonly skips: KvTable<RunId, SkipRecord>
  readonly interventions: KvTable<string, InterventionRecord>
  readonly wardenAudits: KvTable<string, WardenAuditRecord>
}

/**
 * Durable orchestration state: queues, tasks, runs, operations, handoffs and
 * host-wide settings.
 *
 * Reads are synchronous from validated in-memory state. Writes are durable
 * before they resolve and reject a stale `revision` instead of overwriting a
 * newer one. `close()` rejects new writes immediately and drains the writes
 * already queued.
 */
export class SessionOrchestrator extends Service {
  static inject = ['storageDomain']

  private domain: Domain<typeof sessionOrchestratorDomain> | undefined
  private tables: StoreTables | undefined

  /** Tail of the store's FIFO chain; every link settles so one failure cannot stall the queue. */
  private chain: Promise<void> = Promise.resolve()

  /** Set when close begins: new writes reject while already-queued writes drain. */
  private disposing = false

  /** Shared teardown so repeated close calls observe one drain. */
  private closing?: Promise<void>

  /**
   * @param ctx - Context that carries the storage domain facility and the
   * `domain/changed` emissions.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionOrchestrator')
  }

  /**
   * Open the authoritative domain and resolve the table handles.
   *
   * A stored record that fails its schema rejects here, so the host refuses to
   * start with silently dropped orchestration state.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionOrchestratorDomain)
    this.ctx.effect(() => () => this.close(), 'sessionOrchestrator.domainClose')
    this.domain = domain
    this.tables = {
      queues: domain.table('queues'),
      tasks: domain.table('tasks'),
      runs: domain.table('runs'),
      operations: domain.table('operations'),
      handoffs: domain.table('handoffs'),
      skips: domain.table('skips'),
      interventions: domain.table('interventions'),
      wardenAudits: domain.table('warden_audits'),
    }
  }

  /**
   * Read every stored task.
   * @returns a snapshot of the stored tasks, in key order.
   */
  listTasks(): readonly TaskSpec[] {
    return [...this.requireTables().tasks.entries()].map(([, task]) => task)
  }

  /**
   * Read one stored task.
   * @param id - Task identity.
   * @returns the stored task, or `undefined` when absent.
   */
  getTask(id: TaskId): TaskSpec | undefined {
    return this.requireTables().tasks.get(id)
  }

  /**
   * Insert one task at revision 0.
   * @param spec - The task to store; its `revision` must be 0.
   * @returns the stored task.
   * @throws OrchestratorError with `already-exists` when the id is taken, or
   * `invalid-transition` when the spec does not start at revision 0.
   */
  createTask(spec: TaskSpec): Promise<TaskSpec> {
    if (spec.revision !== 0) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `task '${spec.id}' must be created at revision 0, not ${spec.revision}`,
      ))
    }
    return this.enqueue(async () => {
      const { tasks } = this.requireTables()
      if (tasks.get(spec.id) !== undefined) {
        throw new OrchestratorError('already-exists', `task '${spec.id}' already exists`)
      }
      await tasks.put(spec.id, spec)
      return spec
    })
  }

  /**
   * Replace one task under revision CAS.
   * @param id - Task identity.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement record; its `revision` must be one past the expected revision.
   * @returns the stored task.
   * @throws OrchestratorError with `revision-conflict`, `not-found`, or
   * `invalid-transition` when the replacement does not advance the revision.
   */
  updateTask(id: TaskId, expectedRevision: number, next: TaskSpec): Promise<TaskSpec> {
    if (next.revision !== expectedRevision + 1) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `task '${id}' replacement must carry revision ${expectedRevision + 1}, not ${next.revision}`,
      ))
    }
    return this.casUpdate(this.requireTables().tasks, id, expectedRevision, () => next)
  }

  /**
   * Read every stored queue.
   * @returns a snapshot of the stored queues, in key order.
   */
  listQueues(): readonly QueueRecord[] {
    return [...this.requireTables().queues.entries()].map(([, queue]) => queue)
  }

  /**
   * Read one stored queue.
   * @param id - Queue identity.
   * @returns the stored queue, or `undefined` when absent.
   */
  getQueue(id: QueueId): QueueRecord | undefined {
    return this.requireTables().queues.get(id)
  }

  /**
   * Insert one queue at revision 0.
   * @param record - The queue to store; its `revision` must be 0.
   * @returns the stored queue.
   * @throws OrchestratorError with `already-exists` or `invalid-transition`.
   */
  createQueue(record: QueueRecord): Promise<QueueRecord> {
    if (record.revision !== 0) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `queue '${record.id}' must be created at revision 0, not ${record.revision}`,
      ))
    }
    return this.enqueue(async () => {
      const { queues } = this.requireTables()
      if (queues.get(record.id) !== undefined) {
        throw new OrchestratorError('already-exists', `queue '${record.id}' already exists`)
      }
      await queues.put(record.id, record)
      return record
    })
  }

  /**
   * Replace one queue under revision CAS.
   * @param id - Queue identity.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement record; its `revision` must be one past the expected revision.
   * @returns the stored queue.
   * @throws OrchestratorError with `revision-conflict`, `not-found`, or `invalid-transition`.
   */
  updateQueue(id: QueueId, expectedRevision: number, next: QueueRecord): Promise<QueueRecord> {
    if (next.revision !== expectedRevision + 1) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `queue '${id}' replacement must carry revision ${expectedRevision + 1}, not ${next.revision}`,
      ))
    }
    return this.casUpdate(this.requireTables().queues, id, expectedRevision, () => next)
  }

  /**
   * Delete one queue and every orchestration record it owns.
   *
   * A queue's task definitions, run attempts, operations, handoffs, skips,
   * interventions and warden audits all name the queue through their task or run
   * identity. Removing the queue without them would leave records no view can
   * address. Workspace files and Sessions are outside this domain and stay
   * untouched; the caller archives conversations separately when requested.
   * @param id - Queue identity.
   * @param expectedRevision - Revision the caller last observed.
   * @returns the deleted record.
   * @throws OrchestratorError with `not-found` or `revision-conflict`.
   */
  deleteQueue(id: QueueId, expectedRevision: number): Promise<QueueRecord> {
    return this.enqueue(async () => {
      const {
        queues, tasks, runs, operations, handoffs, skips, interventions, wardenAudits,
      } = this.requireTables()
      const current = queues.get(id)
      if (current === undefined) {
        throw new OrchestratorError('not-found', `no queue '${id}' to delete`)
      }
      if (current.revision !== expectedRevision) {
        throw new OrchestratorError(
          'revision-conflict',
          `queue '${id}' is at revision ${current.revision}, not ${expectedRevision}`,
        )
      }
      const taskIds = new Set<TaskId>()
      for (const [taskId, task] of tasks.entries()) {
        if (task.queueId === id) taskIds.add(taskId)
      }
      const runIds = new Set<RunId>()
      for (const [runId, run] of runs.entries()) {
        if (taskIds.has(run.taskId)) runIds.add(runId)
      }
      const operationIds = new Set<OperationId>()
      for (const [operationId, operation] of operations.entries()) {
        if (runIds.has(operation.runId)) operationIds.add(operationId)
      }
      for (const [operationId, handoff] of handoffs.entries()) {
        if (operationIds.has(handoff.operationId)) await handoffs.delete(operationId)
      }
      for (const [runId] of skips.entries()) {
        if (runIds.has(runId)) await skips.delete(runId)
      }
      for (const [recordId, record] of interventions.entries()) {
        if (runIds.has(record.runId) || taskIds.has(record.taskId)) await interventions.delete(recordId)
      }
      for (const [recordId, record] of wardenAudits.entries()) {
        if (runIds.has(record.runId) || taskIds.has(record.taskId)) await wardenAudits.delete(recordId)
      }
      for (const operationId of operationIds) await operations.delete(operationId)
      for (const runId of runIds) await runs.delete(runId)
      for (const taskId of taskIds) await tasks.delete(taskId)
      await queues.delete(id)
      return current
    })
  }

  /**
   * Remove every orchestration record owned by one task identity.
   *
   * A conversation deletion removes the task's attempts, operations, handoffs,
   * skips, interventions and warden audits while leaving every other task in the
   * queue untouched. The task definition itself is deleted with it. Workspace
   * files and Sessions are outside this domain; the caller archives them
   * separately when requested.
   * @param id - Task identity whose records must be removed.
   * @returns resolution after durability.
   */
  deleteTaskRecords(id: TaskId): Promise<void> {
    return this.enqueue(async () => {
      const {
        tasks, runs, operations, handoffs, skips, interventions, wardenAudits,
      } = this.requireTables()
      const runIds = new Set<RunId>()
      for (const [runId, run] of runs.entries()) {
        if (run.taskId === id) runIds.add(runId)
      }
      const operationIds = new Set<OperationId>()
      for (const [operationId, operation] of operations.entries()) {
        if (runIds.has(operation.runId)) operationIds.add(operationId)
      }
      for (const [operationId, handoff] of handoffs.entries()) {
        if (operationIds.has(handoff.operationId)) await handoffs.delete(operationId)
      }
      for (const [runId] of skips.entries()) {
        if (runIds.has(runId)) await skips.delete(runId)
      }
      for (const [recordId, record] of interventions.entries()) {
        if (runIds.has(record.runId) || record.taskId === id) await interventions.delete(recordId)
      }
      for (const [recordId, record] of wardenAudits.entries()) {
        if (runIds.has(record.runId) || record.taskId === id) await wardenAudits.delete(recordId)
      }
      for (const operationId of operationIds) await operations.delete(operationId)
      for (const runId of runIds) await runs.delete(runId)
      await tasks.delete(id)
    })
  }

  /**
   * Apply one ordered-list edit as a single store-chain job.
   *
   * Deletes, rewritten dependencies, new tasks and the queue revision are
   * written together so no observer can see a queue whose order still names a
   * deleted task, or a task whose dependency names an id that no longer exists.
   * The domain backend has no cross-table transaction, so a failed backend write
   * rolls the already-applied records back in reverse order.
   * @param queueId - queue whose order and members change.
   * @param expectedRevision - queue revision the caller observed.
   * @param nextQueue - queue record carrying the new order and revision.
   * @param commit - task creates, replacements and deletions.
   * @returns the stored queue.
   * @throws OrchestratorError with `not-found`, `revision-conflict` or
   * `invalid-transition` when the observed records moved.
   */
  commitTaskList(
    queueId: QueueId,
    expectedRevision: number,
    nextQueue: QueueRecord,
    commit: {
      readonly creates: readonly TaskSpec[]
      readonly updates: readonly TaskSpec[]
      readonly deletes: readonly TaskId[]
    },
  ): Promise<QueueRecord> {
    if (nextQueue.id !== queueId || nextQueue.revision !== expectedRevision + 1) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `queue '${queueId}' replacement must carry revision ${expectedRevision + 1}`,
      ))
    }
    return this.enqueue(async () => {
      const { queues, tasks } = this.requireTables()
      const currentQueue = queues.get(queueId)
      if (currentQueue === undefined) {
        throw new OrchestratorError('not-found', `no queue '${queueId}' to update`)
      }
      if (currentQueue.revision !== expectedRevision) {
        throw new OrchestratorError(
          'revision-conflict',
          `queue '${queueId}' is at revision ${currentQueue.revision}, not ${expectedRevision}`,
        )
      }
      const originals = new Map<TaskId, TaskSpec | undefined>()
      const remember = (id: TaskId): void => {
        if (!originals.has(id)) originals.set(id, tasks.get(id))
      }
      const applied: TaskId[] = []
      try {
        for (const spec of commit.creates) {
          remember(spec.id)
          if (tasks.get(spec.id) !== undefined) {
            throw new OrchestratorError('already-exists', `task '${spec.id}' already exists`)
          }
          await tasks.put(spec.id, spec)
          applied.push(spec.id)
        }
        for (const spec of commit.updates) {
          remember(spec.id)
          const current = tasks.get(spec.id)
          if (current === undefined) {
            throw new OrchestratorError('not-found', `no task '${spec.id}' to update`)
          }
          if (current.revision !== spec.revision - 1) {
            throw new OrchestratorError(
              'revision-conflict',
              `task '${spec.id}' is at revision ${current.revision}, not ${spec.revision - 1}`,
            )
          }
          await tasks.put(spec.id, spec)
          applied.push(spec.id)
        }
        for (const id of commit.deletes) {
          remember(id)
          if (tasks.get(id) === undefined) {
            throw new OrchestratorError('not-found', `no task '${id}' to delete`)
          }
          await tasks.delete(id)
          applied.push(id)
        }
        await queues.put(queueId, nextQueue)
      } catch (error) {
        for (const id of [...applied].reverse()) {
          const original = originals.get(id)
          try {
            if (original === undefined) await tasks.delete(id)
            else await tasks.put(id, original)
          } catch {
            // A backend that refused the original write also refuses the
            // compensating write; the caller still receives the first failure.
          }
        }
        throw error
      }
      return nextQueue
    })
  }

  /**
   * Read one stored run.
   * @param id - Run identity.
   * @returns the stored run, or `undefined` when absent.
   */
  getRun(id: RunId): RunRecord | undefined {
    return this.requireTables().runs.get(id)
  }

  /**
   * Read every stored run.
   * @returns a snapshot of the stored runs, in key order.
   */
  listRuns(): readonly RunRecord[] {
    return [...this.requireTables().runs.entries()].map(([, run]) => run)
  }

  /**
   * Insert one run at revision 0.
   * @param record - The run to store; its `revision` must be 0.
   * @returns the stored run.
   * @throws OrchestratorError with `already-exists` or `invalid-transition`.
   */
  createRun(record: RunRecord): Promise<RunRecord> {
    if (record.revision !== 0) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `run '${record.id}' must be created at revision 0, not ${record.revision}`,
      ))
    }
    return this.enqueue(async () => {
      const { runs } = this.requireTables()
      if (runs.get(record.id) !== undefined) {
        throw new OrchestratorError('already-exists', `run '${record.id}' already exists`)
      }
      await runs.put(record.id, record)
      return record
    })
  }

  /**
   * Replace one run under revision CAS.
   *
   * The transition itself is validated by the caller that owns the state
   * machine; this method owns only durability and the revision check.
   * @param id - Run identity.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement record; its `revision` must be one past the expected revision.
   * @returns the stored run.
   * @throws OrchestratorError with `revision-conflict`, `not-found`, or `invalid-transition`.
   */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord> {
    if (next.revision !== expectedRevision + 1) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `run '${id}' replacement must carry revision ${expectedRevision + 1}, not ${next.revision}`,
      ))
    }
    return this.casUpdate(this.requireTables().runs, id, expectedRevision, () => next)
  }

  /**
   * Read one stored operation.
   * @param id - Operation identity.
   * @returns the stored operation, or `undefined` when absent.
   */
  getOperation(id: OperationId): OperationRecord | undefined {
    return this.requireTables().operations.get(id)
  }

  /**
   * Read every stored operation.
   * @returns a snapshot of the stored operations, in key order.
   */
  listOperations(): readonly OperationRecord[] {
    return [...this.requireTables().operations.entries()].map(([, operation]) => operation)
  }

  /**
   * Record one operation, idempotently by operation id.
   *
   * A repeat with the same `requestHash` is the same operation and returns the
   * stored record unchanged. A repeat with a different `requestHash` is a
   * conflict: two different requests must never share one identity.
   * @param record - The operation to record.
   * @returns the stored operation, which may predate this call.
   * @throws OrchestratorError with `operation-hash-conflict` when the identity
   * is reused for different content.
   */
  planOperation(record: OperationRecord): Promise<OperationRecord> {
    return this.enqueue(async () => {
      const { operations } = this.requireTables()
      const existing = operations.get(record.id)
      if (existing !== undefined) {
        if (existing.requestHash !== record.requestHash) {
          throw new OrchestratorError(
            'operation-hash-conflict',
            `operation '${record.id}' was planned with a different request hash`,
          )
        }
        return existing
      }
      await operations.put(record.id, record)
      return record
    })
  }

  /**
   * Advance one operation phase under revision-less CAS.
   *
   * Operations carry no `revision`: their lifecycle is linear and every phase
   * is written by the single supervisor that owns the run, so the phase itself
   * is the compare key.
   * @param id - Operation identity.
   * @param expectedPhase - Phase the caller last observed.
   * @param next - Replacement record.
   * @returns the stored operation.
   * @throws OrchestratorError with `not-found` or `revision-conflict` when the
   * stored phase is no longer the expected one.
   */
  advanceOperation(
    id: OperationId,
    expectedPhase: OperationRecord['phase'],
    next: OperationRecord,
  ): Promise<OperationRecord> {
    return this.enqueue(async () => {
      const { operations } = this.requireTables()
      return await operations.update(id, (current) => {
        if (current.phase !== expectedPhase) {
          throw new OrchestratorError(
            'revision-conflict',
            `operation '${id}' is in phase '${current.phase}', not '${expectedPhase}'`,
          )
        }
        return next
      })
    })
  }

  /**
   * Read one stored handoff.
   * @param id - Operation identity that produced the handoff.
   * @returns the stored handoff, or `undefined` when absent.
   */
  getHandoff(id: OperationId): HandoffRecord | undefined {
    return this.requireTables().handoffs.get(id)
  }

  /**
   * Read every stored handoff.
   * @returns a snapshot of the stored handoffs, in key order.
   */
  listHandoffs(): readonly HandoffRecord[] {
    return [...this.requireTables().handoffs.entries()].map(([, handoff]) => handoff)
  }

  /**
   * Record one completed handoff, keyed by the operation that produced it.
   * @param record - The handoff to record.
   * @returns the stored handoff.
   * @throws OrchestratorError with `already-exists` when the operation already
   * recorded a handoff, which would mean one operation produced two successors.
   */
  recordHandoff(record: HandoffRecord): Promise<HandoffRecord> {
    return this.enqueue(async () => {
      const { handoffs } = this.requireTables()
      if (handoffs.get(record.operationId) !== undefined) {
        throw new OrchestratorError(
          'already-exists',
          `operation '${record.operationId}' already recorded a handoff`,
        )
      }
      await handoffs.put(record.operationId, record)
      return record
    })
  }

  /**
   * Read one audited human skip.
   * @param id - Run identity the skip applies to.
   * @returns the skip record, or `undefined` when absent.
   */
  getSkip(id: RunId): SkipRecord | undefined {
    return this.requireTables().skips.get(id)
  }

  /**
   * Read every audited human skip.
   * @returns a snapshot of the stored skips, in key order.
   */
  listSkips(): readonly SkipRecord[] {
    return [...this.requireTables().skips.entries()].map(([, skip]) => skip)
  }

  /**
   * Record one audited human skip against the run revision the human observed.
   *
   * Only the latest attempt of a task may be skipped, and only while it is
   * `needs-attention`. The skip is append-only: a repeat for the same run is a
   * conflict, and a stale `runRevision` rejects without overwriting.
   * @param record - The audit record to store.
   * @returns the stored skip.
   * @throws OrchestratorError with `not-found`, `revision-conflict`,
   * `invalid-transition`, or `already-exists`.
   */
  recordSkip(record: SkipRecord): Promise<SkipRecord> {
    return this.enqueue(async () => {
      const { runs, skips } = this.requireTables()
      const run = runs.get(record.runId)
      if (run === undefined) {
        throw new OrchestratorError('not-found', `no run '${record.runId}' to skip`)
      }
      if (run.taskId !== record.taskId) {
        throw new OrchestratorError(
          'invalid-transition',
          `run '${record.runId}' does not belong to task '${record.taskId}'`,
        )
      }
      if (run.state !== 'needs-attention') {
        throw new OrchestratorError(
          'invalid-transition',
          `run '${record.runId}' is '${run.state}'; only needs-attention may be skipped`,
        )
      }
      if (run.revision !== record.runRevision) {
        throw new OrchestratorError(
          'revision-conflict',
          `run '${record.runId}' is at revision ${run.revision}, not ${record.runRevision}`,
        )
      }
      if (skips.get(record.runId) !== undefined) {
        throw new OrchestratorError(
          'already-exists',
          `run '${record.runId}' already recorded a skip`,
        )
      }
      for (const [, other] of runs.entries()) {
        if (other.taskId === run.taskId && other.attempt > run.attempt) {
          throw new OrchestratorError(
            'invalid-transition',
            `task '${run.taskId}' already advanced past attempt ${run.attempt}`,
          )
        }
      }
      await skips.put(record.runId, record)
      return record
    })
  }

  /**
   * Read one audited pipeline intervention.
   * @param id - Intervention identity.
   * @returns the stored record, or `undefined` when absent.
   */
  getIntervention(id: string): InterventionRecord | undefined {
    return this.requireTables().interventions.get(id)
  }

  /**
   * Read every audited pipeline intervention.
   * @returns a snapshot of the stored records, in key order.
   */
  listInterventions(): readonly InterventionRecord[] {
    return [...this.requireTables().interventions.entries()].map(([, record]) => record)
  }

  /**
   * Record one intervention at the start of its transaction.
   *
   * The identity is derived from `(runId, generation, kind)`, so a retry that
   * computes the same identity observes the existing record instead of opening a
   * second transaction. A caller that already observed a record must continue
   * from its `phase` rather than calling this again.
   * @param record - The planned intervention.
   * @returns the stored record, existing or new.
   */
  recordIntervention(record: InterventionRecord): Promise<InterventionRecord> {
    return this.enqueue(async () => {
      const { interventions } = this.requireTables()
      const existing = interventions.get(record.id)
      if (existing !== undefined) return existing
      await interventions.put(record.id, record)
      return record
    })
  }

  /**
   * Advance one intervention phase under phase CAS.
   * @param id - Intervention identity.
   * @param expectedPhase - Phase the caller last observed.
   * @param next - Replacement record.
   * @returns the stored record.
   * @throws OrchestratorError with `not-found` or `revision-conflict`.
   */
  advanceIntervention(
    id: string,
    expectedPhase: InterventionRecord['phase'],
    next: InterventionRecord,
  ): Promise<InterventionRecord> {
    return this.enqueue(async () => {
      const { interventions } = this.requireTables()
      const current = interventions.get(id)
      if (current === undefined) {
        throw new OrchestratorError('not-found', `intervention '${id}' is not stored`)
      }
      if (current.phase !== expectedPhase) {
        throw new OrchestratorError(
          'revision-conflict',
          `intervention '${id}' is '${current.phase}', not '${expectedPhase}'`,
        )
      }
      await interventions.put(id, next)
      return next
    })
  }

  /**
   * Read every audited warden review.
   * @returns a snapshot of the stored rows, in key order.
   */
  listWardenAudits(): readonly WardenAuditRecord[] {
    return [...this.requireTables().wardenAudits.entries()].map(([, record]) => record)
  }

  /**
   * Record one warden review, idempotently by row identity.
   *
   * A repeat identity is the same review and returns the stored row unchanged,
   * so a retried tick can never bill the same review twice in the ledger.
   * @param record - The review to record.
   * @returns the stored row, which may predate this call.
   */
  recordWardenAudit(record: WardenAuditRecord): Promise<WardenAuditRecord> {
    return this.enqueue(async () => {
      const { wardenAudits } = this.requireTables()
      const existing = wardenAudits.get(record.id)
      if (existing !== undefined) return existing
      await wardenAudits.put(record.id, record)
      return record
    })
  }

  /**
   * Delete one warden review row.
   *
   * Retention is bounded per run by the runtime that owns the ledger, so this
   * is the only way a row leaves the table.
   * @param id - Row identity.
   * @returns whether a row was deleted.
   */
  deleteWardenAudit(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const { wardenAudits } = this.requireTables()
      if (wardenAudits.get(id) === undefined) return false
      await wardenAudits.delete(id)
      return true
    })
  }

  /**
   * Read the host-wide settings.
   * @returns the current settings value, synchronously from memory.
   */
  getSettings(): GlobalSettings {
    return this.requireDomain().global.get()
  }  /**
   * Replace the host-wide settings under revision CAS.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement settings; its `revision` must be one past the expected revision.
   * @returns the stored settings.
   * @throws OrchestratorError with `revision-conflict` or `invalid-transition`.
   */
  updateSettings(expectedRevision: number, next: GlobalSettings): Promise<GlobalSettings> {
    if (next.revision !== expectedRevision + 1) {
      return Promise.reject(new OrchestratorError(
        'invalid-transition',
        `settings replacement must carry revision ${expectedRevision + 1}, not ${next.revision}`,
      ))
    }
    return this.enqueue(async () => {
      const global = this.requireDomain().global
      const current = global.get()
      if (current.revision !== expectedRevision) {
        throw new OrchestratorError(
          'revision-conflict',
          `settings are at revision ${current.revision}, not ${expectedRevision}`,
        )
      }
      await global.set(next)
      return next
    })
  }

  /**
   * Reject new writes, drain the writes already queued, then release the domain.
   *
   * Reads stay valid while queued writes drain; after teardown every read
   * throws. Repeated calls share one teardown.
   * @returns resolution after the domain is released.
   */
  close(): Promise<void> {
    this.disposing = true
    this.closing ??= this.drainAndRelease()
    return this.closing
  }

  /**
   * Queue one write on the store's FIFO chain.
   * @param job - The work to run at its queue slot.
   * @returns the job's result, or a `closed` rejection after close begins.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new OrchestratorError('closed', 'session orchestrator is closed'))
    }
    const result = this.chain.then(job)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  /**
   * Compare and replace one revisioned record at its atomic slot.
   * @param table - Table holding the record.
   * @param key - Record key.
   * @param expectedRevision - Revision the caller last observed.
   * @param next - Replacement record.
   * @returns the stored record.
   */
  private casUpdate<K extends string, V extends Revisioned>(
    table: KvTable<K, V>,
    key: K,
    expectedRevision: number,
    next: (current: V) => V,
  ): Promise<V> {
    return this.enqueue(async () => {
      const current = table.get(key)
      if (current === undefined) {
        throw new OrchestratorError('not-found', `no record '${key}' to update`)
      }
      if (current.revision !== expectedRevision) {
        throw new OrchestratorError(
          'revision-conflict',
          `record '${key}' is at revision ${current.revision}, not ${expectedRevision}`,
        )
      }
      return await table.update(key, next)
    })
  }

  /** Drain queued writes, then close the domain. */
  private async drainAndRelease(): Promise<void> {
    await this.chain
    await this.domain?.close()
    this.domain = undefined
    this.tables = undefined
  }

  /**
   * The open domain handle.
   * @returns the open domain.
   * @throws Error when the service has not finished starting or has closed.
   */
  private requireDomain(): Domain<typeof sessionOrchestratorDomain> {
    if (this.domain === undefined) {
      throw new Error('session orchestrator is not open')
    }
    return this.domain
  }

  /**
   * The resolved table handles.
   * @returns the table handles.
   * @throws Error when the service has not finished starting or has closed.
   */
  private requireTables(): StoreTables {
    if (this.tables === undefined) {
      throw new Error('session orchestrator is not open')
    }
    return this.tables
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionOrchestrator: SessionOrchestrator
  }
}

export default SessionOrchestrator
