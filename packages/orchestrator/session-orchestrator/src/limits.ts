/**
 * Fixed execution limits for the queue pipeline.
 *
 * Concurrency is a product decision, not a per-queue or per-user setting: one
 * queue is serial and the host runs at most eight tasks at once. The stored
 * `maxConcurrentRuns` value remains readable for old records, but it can only
 * lower the hard ceiling, never raise it.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/limits
 */

/** Hard ceiling on runs active at the same time across every queue. */
export const MAX_CONCURRENT_RUNS = 8
