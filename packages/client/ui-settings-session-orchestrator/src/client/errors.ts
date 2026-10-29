/**
 * Persistent Client-side failure records.
 *
 * A Remote result failure, a carrier throw, and a local stream end all become
 * one stable record that the page keeps until the user dismisses it. Records
 * are rendered in-page; no toast owns them, so switching tabs, closing the
 * settings panel, or receiving a newer live snapshot cannot erase the reason a
 * write failed.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/errors
 */

/** One failure the settings page keeps visible. */
export interface ClientError {
  /** Stable record identity for dismissal. */
  readonly id: string
  /** Epoch millisecond instant the failure was observed. */
  readonly at: number
  /** Operation the page attempted, for example `saveTask`. */
  readonly operation: string
  /** Stable Remote or local failure code. */
  readonly code: string
  /** Human-readable failure text supplied by the Host or the local throw. */
  readonly message: string
  /** Bounded, already-redacted detail text when the failure carried any. */
  readonly detail?: string
}

/** Shape of a Host Remote failure as it reaches the browser. */
interface RemoteFailureLike {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Narrow a thrown or returned value to the Remote failure shape. */
function isRemoteFailureLike(value: unknown): value is RemoteFailureLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RemoteFailureLike>
  return typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.details === 'object'
    && candidate.details !== null
}

/** Narrow one value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stable detail text for a failure's small, redacted details object. */
function boundedDetail(details: object): string | undefined {
  if (Object.keys(details).length === 0) return undefined
  try {
    const text = JSON.stringify(details)
    return text.length <= 240 ? text : `${text.slice(0, 237)}...`
  } catch {
    // A details object that cannot serialize (for example a cycle) still names
    // no fields this page may show.
    return undefined
  }
}

/**
 * Convert anything a Remote call returned or threw into one persistent record.
 * @param operation - page operation that failed.
 * @param failure - Remote failure, thrown error, or arbitrary rejection value.
 * @param at - epoch millisecond observation instant.
 * @param id - stable record identity.
 * @returns the record the page stores and renders.
 */
export function clientErrorFrom(
  operation: string,
  failure: unknown,
  at: number,
  id: string,
): ClientError {
  if (isRemoteFailureLike(failure)) {
    const detail = boundedDetail(failure.details)
    return {
      id, at, operation,
      code: failure.code,
      message: failure.message,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  if (failure instanceof Error) {
    return { id, at, operation, code: 'ui/error', message: failure.message }
  }
  if (isRecord(failure) && typeof failure.message === 'string') {
    return {
      id, at, operation,
      code: typeof failure.code === 'string' ? failure.code : 'ui/error',
      message: failure.message,
    }
  }
  return { id, at, operation, code: 'ui/error', message: String(failure) }
}

/**
 * Whether one caught value is a Host Remote failure rather than an assembly
 * fault or a local throw.
 * @param value - caught or returned value.
 * @returns true when the value carries the Remote failure code/message/details.
 */
export function isRemoteFailure(value: unknown): value is RemoteFailureLike {
  return isRemoteFailureLike(value)
}
