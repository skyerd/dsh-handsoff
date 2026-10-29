/**
 * Opt-in model-backed warden review.
 *
 * The rule warden spends no tokens and stays the default. A host enables this
 * module only by naming a provider and model: every review is one bounded,
 * stateless model call that receives {@link WardenPacket} as JSON and returns
 * exactly one verdict under {@link WARDEN_REVIEW_SCHEMA}. The call is bounded
 * four ways — packet bytes, output tokens, wall-clock deadline and the JSON
 * contract — and any violation becomes a {@link WardenReviewError} whose stable
 * code the runtime records before it falls back to the local rules.
 *
 * This module is the only one in the package that reaches the `llm` service, so
 * the zero-token default is provable by scanning every other source file.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/model-warden
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReasoningEffortId, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { WARDEN_VERDICTS } from './schema.ts'
import type { WardenFailureCode, WardenVerdict } from './types.ts'
import type { WardenDecision, WardenPacket } from './warden.ts'

/** Longest sentence the review contract accepts, in characters. */
export const MAX_WARDEN_REASON_CHARS = 300

/**
 * The strict JSON object one review must answer.
 *
 * `strict()` rejects unknown keys, so a model that invents a field fails the
 * contract instead of quietly extending the verdict vocabulary.
 */
export const wardenReviewSchema = z.object({
  verdict: z.enum(WARDEN_VERDICTS),
  reason: z.string().trim().min(1).max(MAX_WARDEN_REASON_CHARS),
}).strict()

/** The JSON Schema text the review prompt quotes, kept beside its zod form. */
export const WARDEN_REVIEW_SCHEMA = [
  '{',
  '  "type": "object",',
  '  "additionalProperties": false,',
  '  "required": ["verdict", "reason"],',
  '  "properties": {',
  `    "verdict": { "enum": [${WARDEN_VERDICTS.map(verdict => `"${verdict}"`).join(', ')}] },`,
  `    "reason": { "type": "string", "minLength": 1, "maxLength": ${MAX_WARDEN_REASON_CHARS} }`,
  '  }',
  '}',
].join('\n')

/** System prompt of one review; it names every verdict and the contract. */
export const WARDEN_REVIEW_SYSTEM_PROMPT = [
  'You are the warden of an automated task queue. You review exactly one running task from a bounded state packet and answer with one verdict.',
  'You never see the conversation transcript: judge only from the packet, which carries the queue requirement, the task prompt head, the health signals, at most five recent events and the child task states.',
  '',
  'Verdicts:',
  '- continue: the task is healthy and making visible progress.',
  '- decompose: the task should stop now and hand its remaining work to child tasks.',
  '- refine: the task keeps running, but its remaining work should be split into additional child tasks.',
  '- stop-and-notify: the task looks stuck; pause this queue and wait for a human.',
  '- abort-all: the run is unsafe for the whole pipeline; abort every queue.',
  '',
  'How to read the health block: contextRatio is the occupied share of contextWindow, and ceiling is the switch point the pipeline uses; idleMs is the silence since the last visible activity and idleLimitMs the pause window; cacheHitRate is the share of prompt tokens served from cache and hitRateWarn/hitRateAbort are its warning and abort lines. A missing value means it was not measured, not that it is healthy.',
  'Prefer continue when the evidence is thin. Use abort-all only when the packet shows the run is clearly wasted for the whole pipeline.',
  '',
  'Answer with one JSON object that matches this JSON Schema exactly, and output nothing else:',
  WARDEN_REVIEW_SCHEMA,
].join('\n')

/** One verdict plus what the review cost. */
export interface WardenReview {
  /** Verdict and reason the model returned. */
  readonly decision: WardenDecision
  /** Provider route that answered. */
  readonly provider: string
  /** Model that answered. */
  readonly model: string
  /** Wall-clock duration of the review in milliseconds. */
  readonly latencyMs: number
  /** Prompt tokens the adapter reported, cached and uncached. */
  readonly inputTokens?: number
  /** Completion tokens the adapter reported. */
  readonly outputTokens?: number
}

/** A review that could not be used, with the stable code the ledger records. */
export class WardenReviewError extends Error {
  /** Why the review was unusable. */
  readonly code: WardenFailureCode

  /**
   * @param code - stable fallback code.
   * @param message - diagnostic detail for the host log, never for a model.
   * @param options - optional cause chain.
   */
  constructor(code: WardenFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WardenReviewError'
    this.code = code
  }
}

/** The narrow LLM face a review needs. `ctx.llm` satisfies it. */
export interface WardenLlmPort {
  /**
   * Stream one request.
   * @param options - the complete request.
   * @returns the chunk stream.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Exact route one review is billed to. */
export interface WardenModelRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Exact model id passed with the request. */
  readonly model: string
  /** Adapter-owned reasoning effort, when the route needs one. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** Bounds one review applies to itself. */
export interface ModelWardenLimits {
  /** Deadline of one review, in milliseconds. */
  readonly timeoutMs: number
  /** Output cap of one review. */
  readonly maxOutputTokens: number
  /** Largest packet, in UTF-8 bytes, the route may receive. */
  readonly maxPacketBytes: number
}

/** A warden that reviews through a model. */
export interface ModelReviewer {
  /**
   * Review one running task.
   * @param packet - the bounded state packet.
   * @returns the verdict and the tokens it cost.
   */
  review(packet: WardenPacket): Promise<WardenReview>
}

/**
 * Review running tasks through one exact model route.
 *
 * The instance is stateless across reviews: no transcript, no history and no
 * Session identity reach the provider, so two reviews of one task cannot leak
 * context into each other.
 */
export class ModelWarden implements ModelReviewer {
  private readonly port: WardenLlmPort
  private readonly route: WardenModelRoute
  private readonly limits: ModelWardenLimits
  private readonly now: () => number

  /**
   * @param port - the LLM stream face, typically `ctx.llm`.
   * @param route - provider and model every review is billed to.
   * @param limits - packet, output and time bounds.
   * @param now - clock used for the reported latency.
   */
  constructor(
    port: WardenLlmPort,
    route: WardenModelRoute,
    limits: ModelWardenLimits,
    now: () => number = () => Date.now(),
  ) {
    this.port = port
    this.route = route
    this.limits = limits
    this.now = now
  }

  /**
   * Ask the route for one verdict.
   * @param packet - the bounded state packet.
   * @returns the verdict, its route and its reported token cost.
   * @throws WardenReviewError with `packet-too-large`, `timeout`, `unavailable` or `invalid-output`.
   */
  async review(packet: WardenPacket): Promise<WardenReview> {
    const body = JSON.stringify(packet)
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > this.limits.maxPacketBytes) {
      throw new WardenReviewError(
        'packet-too-large',
        `the state packet is ${bytes} bytes, exceeding the ${this.limits.maxPacketBytes} byte review budget`,
      )
    }
    const startedAt = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.port.stream(this.request(body, controller.signal))) {
        assembler.push(chunk)
      }
    } catch (error) {
      throw controller.signal.aborted
        ? new WardenReviewError('timeout', `the review did not finish within ${this.limits.timeoutMs}ms`, { cause: error })
        : new WardenReviewError('unavailable', messageOf(error), { cause: error })
    } finally {
      clearTimeout(timer)
    }
    if (controller.signal.aborted) {
      throw new WardenReviewError('timeout', `the review did not finish within ${this.limits.timeoutMs}ms`)
    }
    const decision = decisionOf(assembler)
    const usage = assembler.usage
    return {
      decision,
      provider: this.route.provider,
      model: this.route.model,
      latencyMs: Math.max(0, this.now() - startedAt),
      ...(usage === undefined ? {} : { inputTokens: promptTokens(usage) }),
      ...(usage === undefined ? {} : { outputTokens: usage.outputTokens }),
    }
  }

  /**
   * Build the one stateless request of this review.
   * @param body - the serialized packet.
   * @param signal - deadline signal of the review.
   * @returns the full request.
   */
  private request(body: string, signal: AbortSignal): GenerateOptions {
    return {
      provider: this.route.provider,
      model: this.route.model,
      ...(this.route.reasoningEffort === undefined ? {} : { reasoningEffort: this.route.reasoningEffort }),
      system: WARDEN_REVIEW_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Review this state packet:\n${body}` }],
      }],
      maxTokens: this.limits.maxOutputTokens,
      signal,
    }
  }
}

/**
 * Resolve the mounted `llm` service into a warden.
 *
 * The service is read with `ctx.get` so mounting the runtime never waits on the
 * LLM service: rule mode does not need it at all, and model mode fails here with
 * an actionable message instead of hanging the plugin.
 * @param ctx - host context of the runtime plugin.
 * @param route - provider and model every review is billed to.
 * @param limits - packet, output and time bounds.
 * @param now - clock used for the reported latency.
 * @returns a model warden over the mounted LLM service.
 * @throws Error when the host mounted no LLM service.
 */
export function createModelWarden(
  ctx: Context,
  route: WardenModelRoute,
  limits: ModelWardenLimits,
  now?: () => number,
): ModelWarden {
  const llm = ctx.get('llm') as WardenLlmPort | undefined
  if (llm === undefined) {
    throw new Error('the model warden needs the llm service, which this host did not mount; set wardenMode to "rule" or mount an LLM adapter')
  }
  return new ModelWarden(llm, route, limits, now)
}

/**
 * Read the verdict out of one assembled answer.
 * @param assembler - the assembled stream.
 * @returns the validated decision.
 * @throws WardenReviewError with `invalid-output`.
 */
function decisionOf(assembler: BlockAssembler): WardenDecision {
  const finish = assembler.finish
  switch (finish.kind) {
    case 'stop':
      break
    case 'aborted':
      throw new WardenReviewError('timeout', finish.failure.message)
    case 'error':
      throw new WardenReviewError('unavailable', finish.failure.message)
    case 'max-tokens':
      throw new WardenReviewError('invalid-output', 'the review reached its output cap before the JSON object closed')
    case 'tool-calls':
      throw new WardenReviewError('invalid-output', 'the review requested a tool instead of answering')
    default:
      // The finish union is merge-extensible: an adapter-specific reason cannot
      // carry a review answer this contract knows how to read.
      throw new WardenReviewError('invalid-output', 'the review ended with an unsupported finish reason')
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type !== 'text')) {
    throw new WardenReviewError('invalid-output', 'the review must answer with text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const parsed = parseReviewJson(text)
  if (parsed === undefined) {
    throw new WardenReviewError('invalid-output', 'the review did not answer with one JSON object')
  }
  return { verdict: parsed.verdict as WardenVerdict, reason: parsed.reason }
}

/**
 * Parse the answer as the strict review object, tolerating one code fence.
 * @param text - the assembled answer text.
 * @returns the validated object, or `undefined` when it violates the contract.
 */
function parseReviewJson(text: string): z.infer<typeof wardenReviewSchema> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return undefined
  }
  const parsed = wardenReviewSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/**
 * Sum the disjoint prompt-token buckets one call reported.
 * @param usage - adapter usage of the review.
 * @returns cached plus uncached prompt tokens.
 */
function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Read an error's message.
 * @param error - the thrown value.
 * @returns a printable message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
