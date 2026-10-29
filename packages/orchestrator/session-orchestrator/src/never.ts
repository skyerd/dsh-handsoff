/**
 * Exhaustiveness guard for closed discriminated unions.
 *
 * A closed union is one whose members this package owns; switching over it must
 * list every member, so the `default` branch receives `never` and the guard
 * rejects any member added later without a matching branch.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/never
 */

/**
 * Assert that a closed union was fully handled.
 * @param value - The value the surrounding switch did not match; typed `never`.
 * @param subject - Name of the switched value, for the diagnostic.
 * @returns never; the call always throws.
 * @throws Error when a union member is unhandled.
 */
export function assertNever(value: never, subject: string): never {
  throw new Error(`unhandled ${subject} member: ${String(value)}`)
}
