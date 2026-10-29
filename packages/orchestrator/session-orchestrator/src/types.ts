/**
 * Public record and policy types for durable session orchestration.
 *
 * The stored record types are inferred from the zod schemas in `schema.ts`, so
 * the durable validation and this compile-time surface cannot drift. This
 * module carries types only.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/types
 */

export type * from './schema.ts'
