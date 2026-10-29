/**
 * The authoritative `session_orchestrator` storage domain.
 *
 * Every record the orchestrator treats as truth lives here. The domain is
 * declared with the rejecting default for invalid records: a stored record that
 * fails its schema refuses the whole open rather than silently dropping
 * orchestration state. The global slot rejects unconditionally.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/storage
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { OperationId, QueueId, RunId, TaskId } from './brand.ts'
import { MAX_CONCURRENT_RUNS } from './limits.ts'
import {
  globalSettingsSchema,
  handoffRecordSchema,
  interventionRecordSchema,
  operationRecordSchema,
  queueRecordSchema,
  runRecordSchema,
  skipRecordSchema,
  taskSpecSchema,
  wardenAuditRecordSchema,
} from './schema.ts'
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

/** Initial global value served before the first settings write. */
export const INITIAL_GLOBAL_SETTINGS: GlobalSettings = globalSettingsSchema.parse({
  schemaVersion: 1,
  paused: true,
  maxConcurrentRuns: MAX_CONCURRENT_RUNS,
  providerQuotas: {},
  hostInstanceId: 'unclaimed',
  revision: 0,
  updatedAt: 0,
})

/** Authoritative orchestration storage; any malformed record refuses the open. */
export const sessionOrchestratorDomain = defineDomain({
  name: 'session_orchestrator',
  /**
   * The pipeline vocabulary was added *inside* version 1: queue lifecycle, task
   * lineage, sampled run health and the intervention ledger are all optional or
   * defaulted, so a stored unit written before them still validates unchanged.
   * The warden review ledger is a later table, and a stored unit without it
   * opens with that table empty.
   *
   * The version is deliberately not bumped. The single-document backend rejects
   * any stored unit whose version differs from the spec, and this layer has no
   * migration hook, so a bump would refuse to open an existing store instead of
   * upgrading it. A future format change that cannot be expressed as optional
   * fields must land with a real migration in the backend, not here.
   */
  version: 1,
  tables: {
    queues: domainTable<QueueId, QueueRecord>(queueRecordSchema),
    tasks: domainTable<TaskId, TaskSpec>(taskSpecSchema),
    runs: domainTable<RunId, RunRecord>(runRecordSchema),
    operations: domainTable<OperationId, OperationRecord>(operationRecordSchema),
    handoffs: domainTable<OperationId, HandoffRecord>(handoffRecordSchema),
    skips: domainTable<RunId, SkipRecord>(skipRecordSchema),
    interventions: domainTable<string, InterventionRecord>(interventionRecordSchema),
    /**
     * Warden review ledger. A table added inside version 1: a version-1 unit
     * written before it opens with the table empty, and the runtime prunes rows
     * per run, so the ledger stays bounded without rewriting older records.
     */
    warden_audits: domainTable<string, WardenAuditRecord>(wardenAuditRecordSchema),
  },
  global: { schema: globalSettingsSchema, initial: INITIAL_GLOBAL_SETTINGS },
})
