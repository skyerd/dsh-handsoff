/**
 * The pipeline warden: one bounded review of one running task.
 *
 * The warden never sees a transcript. It receives a small state packet — queue
 * brief, task prompt head, three health signals, at most five recent events and
 * the child states — and returns exactly one verdict. The default implementation
 * is a pure rule engine (`RuleWarden`), so a tick costs no tokens and every
 * decision is reproducible from the packet. An opt-in model-backed review lives
 * in `model-warden.ts` and returns the same verdict vocabulary; the rules stay
 * the floor (`protectHardGate`), so a model can add judgement but never suppress
 * the context ceiling or the abort line.
 *
 * Decomposition is deliberately *not* a second model call: the instruction in
 * {@link FIXED_DECOMPOSE_PROMPT} is sent into the running conversation, and the
 * answer is parsed by {@link parseDecomposition}. One prompt, one bill, and the
 * produced prompt stays readable in the session log.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/warden
 */

import { assertNever } from './never.ts'
import type { InterventionKind, WardenVerdict } from './types.ts'

export type { WardenVerdict } from './types.ts'

/**
 * The exact instruction the host sends when a task must hand over its remainder.
 *
 * Kept as one constant because it is the contract between the pipeline and the
 * executor: a reviewer can grep for it, and an intervention record quotes it
 * verbatim.
 */
export const FIXED_DECOMPOSE_PROMPT =
  '当前任务过长，请为我生成将剩余任务分块分步骤完成的提示词。'
  + '要求：按可独立执行的任务逐条列出，每条以“1. 标题：提示词”的格式给出，不要输出其他内容。'

/** The lightweight probe sent before an idle task is declared stuck. */
export const IDLE_PING_PROMPT =
  '请用一句话汇报当前进度与剩余工作。若你仍在正常运行，请忽略这条消息。'

/** Health signals one review sees. */
export interface WardenHealth {
  /** Occupied share of the context window, when known. */
  readonly contextRatio?: number
  /** Advertised context capacity, when known. */
  readonly contextWindow?: number
  /** Cache-read share of prompt tokens, once enough calls were seen. */
  readonly cacheHitRate?: number
  /** Milliseconds since the last visible activity. */
  readonly idleMs: number
  /** Milliseconds since the attempt started. */
  readonly elapsedMs: number
  /** Whether a turn was open at sampling time. */
  readonly turnOpen: boolean
  /**
   * Policy thresholds the signals are judged against.
   *
   * The rule warden applies its own copy of these values; they travel with the
   * packet so a model review can judge a reading relative to the configured
   * gates instead of guessing what the host considers healthy.
   */
  readonly ceiling?: number
  /** Silence window after which the pipeline probes and then stops the task. */
  readonly idleLimitMs?: number
  /** Cache-hit rate below which the pipeline refines in place. */
  readonly hitRateWarn?: number
  /** Cache-hit rate below which every queue aborts. */
  readonly hitRateAbort?: number
}

/** One recent visible event, already flattened for the packet. */
export interface WardenRecentEvent {
  readonly kind: 'tool' | 'assistant' | 'user'
  readonly name?: string
  readonly ok?: boolean
  readonly ms?: number
}

/** The bounded state packet handed to a warden. */
export interface WardenPacket {
  readonly queue: { readonly brief: string; readonly state: string }
  readonly task: {
    readonly title: string
    readonly prompt: string
    readonly stage?: string
    readonly generation: number
  }
  readonly health: WardenHealth
  readonly recent: readonly WardenRecentEvent[]
  readonly children: readonly { readonly title: string; readonly state: string }[]
}

/** One verdict plus the sentence a human reads in the intervention log. */
export interface WardenDecision {
  readonly verdict: WardenVerdict
  readonly reason: string
}

/** Thresholds the rule warden applies, in the order it applies them. */
export interface WardenThresholds {
  /** Context occupancy that triggers a hand-over. */
  readonly contextCeiling: number
  /** Silence after which the task is probed, then stopped. */
  readonly idleMs: number
  /** Cache hit rate below which the task is refined in place. */
  readonly hitRateWarn: number
  /** Cache hit rate below which every queue stops for good. */
  readonly hitRateAbort: number
  /** Assistant calls required before a hit rate is judged at all. */
  readonly minRateSamples: number
}

/** A warden: one packet in, one verdict out. */
export interface Warden {
  /**
   * Review one running task.
   * @param packet - the bounded state packet.
   * @returns the verdict and its human-readable reason.
   */
  review(packet: WardenPacket): WardenDecision
}

/** The default, token-free warden. */
export class RuleWarden implements Warden {
  private readonly thresholds: WardenThresholds

  /**
   * @param thresholds - gate values, typically taken from the runtime config.
   */
  constructor(thresholds: WardenThresholds) {
    this.thresholds = thresholds
  }

  /**
   * Apply the gates in severity order: abort, decompose, refine, idle, continue.
   * @param packet - the bounded state packet.
   * @returns the verdict and its reason.
   */
  review(packet: WardenPacket): WardenDecision {
    const { health } = packet
    const t = this.thresholds
    if (health.cacheHitRate !== undefined && health.cacheHitRate < t.hitRateAbort) {
      return {
        verdict: 'abort-all',
        reason: `cache hit rate ${formatPercent(health.cacheHitRate)} is below the abort line ${formatPercent(t.hitRateAbort)}`,
      }
    }
    if (health.contextRatio !== undefined && health.contextRatio >= t.contextCeiling) {
      return {
        verdict: 'decompose',
        reason: `context occupancy ${formatPercent(health.contextRatio)} reached the switch point ${formatPercent(t.contextCeiling)}`,
      }
    }
    if (health.cacheHitRate !== undefined && health.cacheHitRate < t.hitRateWarn) {
      return {
        verdict: 'refine',
        reason: `cache hit rate ${formatPercent(health.cacheHitRate)} is below the warn line ${formatPercent(t.hitRateWarn)}`,
      }
    }
    if (health.idleMs >= t.idleMs) {
      return {
        verdict: 'stop-and-notify',
        reason: `no visible activity for ${Math.round(health.idleMs / 60000)} minutes`,
      }
    }
    return { verdict: 'continue', reason: 'healthy' }
  }
}

/** One child task parsed out of a session answer. */
export interface DecomposedTask {
  readonly title: string
  readonly prompt: string
}

/** Bounds applied while parsing an answer. */
export interface DecomposeLimits {
  /** Maximum number of child tasks one answer may produce. */
  readonly maxTasks: number
  /** Maximum characters kept from one produced prompt. */
  readonly maxPromptChars: number
  /** Maximum characters kept from the whole answer. */
  readonly maxProducedChars: number
}

/** Defaults for {@link parseDecomposition}. */
export const DEFAULT_DECOMPOSE_LIMITS: DecomposeLimits = Object.freeze({
  maxTasks: 8,
  maxPromptChars: 2000,
  maxProducedChars: 8000,
})

/** A list marker: `1.`, `1)`, `1、`, `-`, `*`, `•`. */
const LIST_MARKER = /^\s*(?:\d+[.)、]|[-*•])\s+/

/** Emphasis and heading decoration stripped from a produced title. */
const TITLE_NOISE = /[*_`#>]/g

/**
 * Parse a session's decomposition answer into child tasks.
 *
 * The parser is deliberately tolerant: a numbered list is preferred, a fenced
 * block is unwrapped, and anything without markers becomes a single child whose
 * prompt is the whole answer. Silence or whitespace yields no children, which
 * the caller records as a failed intervention rather than inventing work.
 * @param answer - the assistant text captured for the instruction turn.
 * @param limits - bounds for count and length.
 * @returns the child tasks, in answer order.
 */
export function parseDecomposition(
  answer: string,
  limits: DecomposeLimits = DEFAULT_DECOMPOSE_LIMITS,
): readonly DecomposedTask[] {
  const trimmed = answer.trim()
  if (trimmed === '') return []

  const body = unwrapFence(trimmed).slice(0, limits.maxProducedChars)
  const items: DecomposedTask[] = []
  let current: string[] = []

  const flush = (): void => {
    const text = current.join('\n').trim()
    current = []
    if (text === '') return
    items.push(toTask(text, limits))
  }

  for (const line of body.split(/\r?\n/)) {
    if (LIST_MARKER.test(line)) {
      flush()
      current.push(line.replace(LIST_MARKER, '').trim())
      continue
    }
    // A blank line inside an item keeps it going only when the item already
    // started; a blank line outside one is just spacing.
    if (line.trim() === '') {
      if (current.length > 0) current.push('')
      continue
    }
    if (current.length > 0) current.push(line.trim())
  }
  flush()

  const usable = items.filter(item => item.prompt.length >= 8)
  if (usable.length > 0) return usable.slice(0, limits.maxTasks)
  if (trimmed.length < 8) return []
  return [toTask(body.trim(), limits)]
}

/**
 * Whether one verdict is a safety floor a model review may not downgrade.
 *
 * `abort-all` protects every queue from a run that is burning its context
 * cache, and `decompose` protects the task from overflowing its window. Both
 * are decided from durable health facts, so a model judgement can add
 * judgement above them but never suppress them.
 * @param verdict - the verdict to test.
 * @returns true for a floor verdict.
 */
export function isHardGateVerdict(verdict: WardenVerdict): boolean {
  switch (verdict) {
    case 'abort-all':
    case 'decompose':
      return true
    case 'continue':
    case 'refine':
    case 'stop-and-notify':
      return false
    default:
      return assertNever(verdict, 'warden verdict')
  }
}

/**
 * Combine the local rule verdict with a model review.
 *
 * With no model review, the rules decide. With one, the model decides except
 * where the rules named a hard gate, so an unusable or over-confident model can
 * never stop the local safety floor from acting.
 * @param rule - the verdict the local rules produced.
 * @param judged - the verdict a model review produced.
 * @returns the verdict the host must act on.
 */
export function protectHardGate(rule: WardenDecision, judged: WardenDecision): WardenDecision {
  return isHardGateVerdict(rule.verdict) ? rule : judged
}

/**
 * Derive the idempotency identity of one warden review.
 *
 * A review is identified by the attempt and the sampling instant, so a restart
 * that samples the same run again cannot append a duplicate ledger row.
 * @param runId - run identity.
 * @param generation - attempt generation.
 * @param sampledAt - epoch milliseconds of the sample.
 * @returns a stable identity string.
 */
export function wardenAuditId(runId: string, generation: number, sampledAt: number): string {
  return `wa-${runId}-g${generation}-${sampledAt}`
}

/**
 * Derive the idempotency identity of one intervention.
 * @param runId - run identity.
 * @param generation - attempt generation.
 * @param kind - verdict family.
 * @returns a stable identity string.
 */
export function interventionId(runId: string, generation: number, kind: InterventionKind): string {
  return `iv-${runId}-g${generation}-${kind}`
}

/**
 * Map one verdict to the intervention kind it records.
 * @param verdict - the warden verdict.
 * @returns the durable kind, or `undefined` for `continue`.
 */
export function kindOfVerdict(verdict: WardenVerdict): InterventionKind | undefined {
  switch (verdict) {
    case 'continue':
      return undefined
    case 'decompose':
      return 'pause-context'
    case 'refine':
      return 'refine'
    case 'stop-and-notify':
      return 'pause-idle'
    case 'abort-all':
      return 'abort-all'
    default:
      return assertNever(verdict, 'warden verdict')
  }
}

/**
 * Render one ratio as a percentage with no decimals.
 * @param value - ratio in `[0, 1]`.
 * @returns the percentage text.
 */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Strip one surrounding code fence.
 * @param text - the trimmed answer.
 * @returns the fence body when the whole answer is fenced, else the input.
 */
function unwrapFence(text: string): string {
  const match = /^```[a-zA-Z0-9-]*\r?\n([\s\S]*?)\r?\n```$/.exec(text)
  return match?.[1] ?? text
}

/**
 * Turn one list item into a child task.
 * @param text - the item body.
 * @param limits - length bounds.
 * @returns the title and prompt.
 */
function toTask(text: string, limits: DecomposeLimits): DecomposedTask {
  const prompt = text.slice(0, limits.maxPromptChars)
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? prompt
  const colon = /[:：]/.exec(firstLine)
  const head = colon === null ? firstLine : firstLine.slice(0, colon.index)
  const title = head.replace(TITLE_NOISE, '').trim().slice(0, 40)
  return {
    title: title === '' ? `子任务 ${prompt.slice(0, 12)}` : title,
    prompt,
  }
}
