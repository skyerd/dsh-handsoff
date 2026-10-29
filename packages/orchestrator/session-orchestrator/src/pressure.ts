/**
 * Context-pressure measurement and the handoff decision it produces.
 *
 * This module owns sections 10.1–10.3 only. It measures the live Session with
 * the injected TokenMeter, prices one of the two handoff bodies with separate
 * reserves, and records the resulting decision on the run under revision CAS.
 * It never calls a model, never creates a child Session and never appends a
 * Session event.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/pressure
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { RunId } from './brand.ts'
import { OrchestratorError } from './errors.ts'
import type {
  GlobalSettings,
  HandoffMode,
  PressureBlockReason,
  PressureDecision,
  PressureSnapshot,
  RunRecord,
  TaskSpec,
} from './types.ts'

/**
 * Default trigger ratio used when a task policy is authored. Persisted tasks
 * always carry their own ratio, so the monitor reads the record rather than
 * silently substituting this value.
 */
export const DEFAULT_HANDOFF_RATIO = 0.88

/**
 * Fixed safety margin added to a rendered structured brief. It is deliberately
 * separate from the last-complete-turn reserve.
 */
export const DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS = 64

/**
 * Last-complete-turn uses the measured projection itself; its reserve defaults
 * to zero and is configured independently of the structured brief.
 */
export const DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS = 0

/** Baseline source recorded with one pressure reading. */
export interface PressureMeasurementBaseline {
  /** `none` when the meter has no estimate or usage yet. */
  readonly kind: 'none' | 'estimated' | 'usage'
  /** Total tokens the baseline reported. */
  readonly tokens: number
}

/**
 * The subset of the TokenMeter measurement this block consumes.
 *
 * The real `TokenMeter.measure(session)` result structurally satisfies this
 * port; tests substitute a controllable fake.
 */
export interface PressureMeasurement {
  /** Last Session log offset consumed by the measurement. */
  readonly logRevision: SessionLogOffset
  /** Which token count the measurement is based on. */
  readonly baseline: PressureMeasurementBaseline
  /** Total tokens attributed to the measured request. */
  readonly totalTokens: number
}

/** Narrow TokenMeter port: measure one Session, price one handoff message. */
export interface PressureTokenMeter {
  /** Measure the latest request over the Session's durable log. */
  measure(session: Session): PressureMeasurement
  /** Estimate the tokens in one rendered handoff message. */
  estimateMessage(message: Message): number
}

/** Narrow store port for reading policy/run/settings and CAS-writing pressure. */
export interface PressureStore {
  /** Read a run, or `undefined` when it does not exist. */
  getRun(id: RunId): RunRecord | undefined
  /** Read a task, or `undefined` when it does not exist. */
  getTask(id: TaskSpec['id']): TaskSpec | undefined
  /** Read the host-wide pause flag and other global settings. */
  getSettings(): GlobalSettings
  /** Compare-and-swap a replacement run record. */
  updateRun(id: RunId, expectedRevision: number, next: RunRecord): Promise<RunRecord>
}

/** The route facts that invalidate an older pressure reading. */
export interface PressureRoute {
  /** Registered provider id. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
  /** Reasoning effort when the latest request header named one. */
  readonly reasoningEffort?: string
  /** Advertised capacity of the latest request context, when known. */
  readonly contextWindow?: number
}

/**
 * Canonical route identity. A model, provider, reasoning effort or capacity
 * change yields a new fingerprint, which invalidates the previous pending
 * decision and forces fresh pricing.
 * @param route - provider, model and optional reasoning/capacity facts.
 * @returns the canonical fingerprint string.
 */
export function pressureRouteFingerprint(route: PressureRoute): string {
  return JSON.stringify([
    route.provider,
    route.model,
    route.reasoningEffort ?? null,
    route.contextWindow ?? null,
  ])
}

/** Messages that can be priced for either handoff body mode. */
export interface PressureHandoffBodies {
  /** Rendered complete structured brief. */
  readonly structuredBrief?: readonly Message[]
  /** Exact projection of the last complete turn, in event order. */
  readonly lastCompleteTurn?: readonly Message[]
}

/** Price of one handoff body, including its own reserve. */
export interface PressureModeBudget {
  /** Body mode this price belongs to. */
  readonly mode: HandoffMode
  /** Sum of `estimateMessage` over the body actuals. */
  readonly bodyTokens: number
  /** Mode-specific safety reserve, never shared with the other mode. */
  readonly reserveTokens: number
  /** `bodyTokens + reserveTokens`. */
  readonly totalTokens: number
  /** Task cap used for the comparison. */
  readonly maxTokens: number
  /** Whether the total fits the task's `maxHandoffTokens`. */
  readonly withinMax: boolean
}

/** Why the last-complete-turn body could not be used verbatim. */
export interface PressureBodyFallback {
  /** Rejected body mode. */
  readonly from: 'last-complete-turn'
  /** Body mode selected instead. */
  readonly to: 'structured-brief'
  /** Stable reason recorded with the decision. */
  readonly reason: 'max-handoff-tokens'
}

/** Both computed prices plus the selected body. */
export interface PressureBudget {
  /** Body mode selected for the handoff. */
  readonly selected: PressureModeBudget
  /** Structured-brief price, when a rendered brief was supplied. */
  readonly structuredBrief?: PressureModeBudget
  /** Last-complete-turn price, when an exact projection was supplied. */
  readonly lastCompleteTurn?: PressureModeBudget
  /** Present when the verbatim last turn exceeded the cap. */
  readonly fallback?: PressureBodyFallback
}

/** Inputs for one pressure observation. */
export interface PressureObservation {
  /** Run whose task policy and pressure record are authoritative. */
  readonly runId: RunId
  /** Live Session measured over its durable log. */
  readonly session: Session
  /** Whether the current Turn has closed with no open tool settlement. */
  readonly turnClosed: boolean
  /** True when human input arrived outside the run's claimed turn. */
  readonly externalInput?: boolean
  /** Rendered bodies; without the selected body the decision is blocked. */
  readonly bodies?: PressureHandoffBodies
}

/** Result of one observation. */
export interface PressureObservationResult {
  /** Observations are run-scoped. */
  readonly runId: RunId
  /** The current durable reading, or `undefined` when no route is known. */
  readonly snapshot: PressureSnapshot | undefined
  /** `handoff-pending` only when every 10.2 gate passed. */
  readonly decision: PressureDecision
  /** Why the decision did not trigger, when it did not. */
  readonly blockedBy: PressureBlockReason | undefined
  /** Both mode prices and the selected body, when bodies were priced. */
  readonly budget: PressureBudget | undefined
  /** True when this call persisted a new snapshot. */
  readonly recorded: boolean
  /** Current measurement, recorded even when the snapshot was deduplicated. */
  readonly measurement: PressureMeasurement
  /** True when `estimatedMode: 'observe-only'` suppressed an estimated handoff. */
  readonly observeOnly: boolean
}

/** Constructor inputs for {@link PressureMonitor}. */
export interface PressureMonitorOptions {
  /** Authoritative records and revision CAS. */
  readonly store: PressureStore
  /** Token measurement and message pricing. */
  readonly tokenMeter: PressureTokenMeter
  /** Clock for `measuredAt`; defaults to `Date.now`. */
  readonly now?: () => number
  /** CAS retries on a concurrent run write; defaults to 3. */
  readonly writeAttempts?: number
  /** Structured-brief fixed safety margin. */
  readonly structuredBriefReserveTokens?: number
  /** Last-complete-turn reserve, configured independently. */
  readonly lastCompleteTurnReserveTokens?: number
  /**
   * Whether an `estimated` baseline may trigger. `handoff` (default) follows
   * the conservative policy; `observe-only` records the reading without one.
   */
  readonly estimatedMode?: 'handoff' | 'observe-only'
}

/**
 * Price both available handoff bodies without sharing a reserve.
 *
 * @param mode - Task-selected body mode.
 * @param bodies - Rendered brief and/or exact last-turn projection.
 * @param meter - Message pricer.
 * @param options - Independent reserves and the task token cap.
 * @returns Both prices, the selected body and any verbatim fallback; `undefined`
 *   when the selected mode's body was not supplied.
 */
export function estimatePressureBudget(
  mode: HandoffMode,
  bodies: PressureHandoffBodies,
  meter: Pick<PressureTokenMeter, 'estimateMessage'>,
  options: {
    readonly structuredBriefReserveTokens: number
    readonly lastCompleteTurnReserveTokens: number
    readonly maxTokens: number
  },
): PressureBudget | undefined {
  const structuredBrief = bodies.structuredBrief === undefined
    ? undefined
    : priceBody(
      'structured-brief',
      bodies.structuredBrief,
      meter,
      options.structuredBriefReserveTokens,
      options.maxTokens,
    )
  const lastCompleteTurn = bodies.lastCompleteTurn === undefined
    ? undefined
    : priceBody(
      'last-complete-turn',
      bodies.lastCompleteTurn,
      meter,
      options.lastCompleteTurnReserveTokens,
      options.maxTokens,
    )

  if (mode === 'structured-brief') {
    return structuredBrief === undefined ? undefined : { selected: structuredBrief, structuredBrief }
  }

  if (lastCompleteTurn === undefined) return undefined
  if (lastCompleteTurn.withinMax) {
    return { selected: lastCompleteTurn, ...(structuredBrief === undefined ? {} : { structuredBrief }), lastCompleteTurn }
  }
  if (structuredBrief !== undefined && structuredBrief.withinMax) {
    return {
      selected: structuredBrief,
      structuredBrief,
      lastCompleteTurn,
      fallback: {
        from: 'last-complete-turn',
        to: 'structured-brief',
        reason: 'max-handoff-tokens',
      },
    }
  }
  return {
    selected: lastCompleteTurn,
    ...(structuredBrief === undefined ? {} : { structuredBrief }),
    lastCompleteTurn,
  }
}

/**
 * Measure the live Session and persist the pressure decision under CAS.
 *
 * Repeated observations at the same log revision reuse one measurement. A
 * pending decision on the same route is never written twice, so streaming
 * updates cannot retrigger a handoff. A route change discards the old reading.
 */
export class PressureMonitor {
  private readonly store: PressureStore
  private readonly tokenMeter: PressureTokenMeter
  private readonly now: () => number
  private readonly writeAttempts: number
  private readonly structuredBriefReserveTokens: number
  private readonly lastCompleteTurnReserveTokens: number
  private readonly estimatedMode: 'handoff' | 'observe-only'
  private readonly measurements = new WeakMap<Session, PressureMeasurement>()

  /**
   * @param options - Injected ports and independent budget reserves.
   */
  constructor(options: PressureMonitorOptions) {
    if (!Number.isInteger(options.writeAttempts ?? 3) || (options.writeAttempts ?? 3) < 1) {
      throw new RangeError('writeAttempts must be a positive integer')
    }
    assertTokenCount(
      options.structuredBriefReserveTokens ?? DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS,
      'structuredBriefReserveTokens',
    )
    assertTokenCount(
      options.lastCompleteTurnReserveTokens ?? DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS,
      'lastCompleteTurnReserveTokens',
    )
    this.store = options.store
    this.tokenMeter = options.tokenMeter
    this.now = options.now ?? Date.now
    this.writeAttempts = options.writeAttempts ?? 3
    this.structuredBriefReserveTokens =
      options.structuredBriefReserveTokens ?? DEFAULT_STRUCTURED_BRIEF_RESERVE_TOKENS
    this.lastCompleteTurnReserveTokens =
      options.lastCompleteTurnReserveTokens ?? DEFAULT_LAST_COMPLETE_TURN_RESERVE_TOKENS
    this.estimatedMode = options.estimatedMode ?? 'handoff'
  }

  /**
   * Observe one run without creating a child Session.
   *
   * @param observation - Live Session, gate facts and rendered bodies.
   * @returns The decision, its durable snapshot and the selected body price.
   */
  async observe(observation: PressureObservation): Promise<PressureObservationResult> {
    const initialRun = this.store.getRun(observation.runId)
    if (initialRun === undefined) {
      throw new OrchestratorError('not-found', `run ${observation.runId} does not exist`)
    }

    const measurement = this.measure(observation.session)
    const context = observation.session.requestContext()
    const header = observation.session.requestHeader()
    const route = routeOf(context, header, initialRun)
    const contextWindow = normalizeContextWindow(context?.contextWindow)
    const totalTokens = normalizeTotal(measurement.totalTokens)
    const now = this.now()

    for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
      const run = this.store.getRun(observation.runId)
      if (run === undefined) {
        throw new OrchestratorError('not-found', `run ${observation.runId} does not exist`)
      }
      const task = this.store.getTask(run.taskId)
      if (task === undefined) {
        throw new OrchestratorError('not-found', `task ${run.taskId} does not exist`)
      }

      const routeWithCapacity = { ...route, ...(contextWindow === undefined ? {} : { contextWindow }) }
      const fingerprint = pressureRouteFingerprint(routeWithCapacity)
      const ratio = contextWindow === undefined ? undefined : totalTokens / contextWindow
      const budget = this.price(task, observation.bodies)
      const previous = run.pressure
      const gate = this.gate(run, task, observation, contextWindow, ratio, measurement, budget, previous)
      const snapshot = route.provider === '' || route.model === ''
        ? undefined
        : makeSnapshot({
          sessionId: observation.session.id,
          logRevision: measurement.logRevision,
          route,
          contextWindow,
          totalTokens,
          ratio,
          baselineKind: measurement.baseline.kind,
          threshold: task.handoff.ratio,
          fingerprint,
          measuredAt: now,
          decision: gate.blockedBy === undefined ? 'handoff-pending' : 'no-handoff',
          ...(gate.blockedBy === undefined ? {} : { blockedBy: gate.blockedBy }),
        })

      if (snapshot === undefined) {
        return {
          runId: observation.runId,
          snapshot: undefined,
          decision: 'no-handoff',
          blockedBy: 'context-window-unknown',
          budget,
          recorded: false,
          measurement,
          observeOnly: false,
        }
      }

      if (samePendingDecision(previous, snapshot)) {
        return {
          runId: observation.runId,
          snapshot: previous,
          decision: 'handoff-pending',
          blockedBy: undefined,
          budget,
          recorded: false,
          measurement,
          observeOnly: gate.observeOnly,
        }
      }
      if (sameReading(previous, snapshot)) {
        return {
          runId: observation.runId,
          snapshot: previous,
          decision: snapshot.decision,
          blockedBy: snapshot.blockedBy,
          budget,
          recorded: false,
          measurement,
          observeOnly: gate.observeOnly,
        }
      }

      const next: RunRecord = {
        ...run,
        pressure: snapshot,
        revision: run.revision + 1,
        updatedAt: now,
      }
      try {
        await this.store.updateRun(run.id, run.revision, next)
        return {
          runId: observation.runId,
          snapshot,
          decision: snapshot.decision,
          blockedBy: snapshot.blockedBy,
          budget,
          recorded: true,
          measurement,
          observeOnly: gate.observeOnly,
        }
      } catch (error) {
        if (error instanceof OrchestratorError && error.code === 'revision-conflict') continue
        throw error
      }
    }

    throw new OrchestratorError(
      'revision-conflict',
      `run ${observation.runId} changed during ${this.writeAttempts} pressure writes`,
    )
  }

  /** Measure once per Session log offset; streaming duplicates reuse the reading. */
  private measure(session: Session): PressureMeasurement {
    const cached = this.measurements.get(session)
    if (cached !== undefined && cached.logRevision === session.seq) return cached
    const measurement = this.tokenMeter.measure(session)
    this.measurements.set(session, measurement)
    return measurement
  }

  /** Price the selected body with that mode's own reserve. */
  private price(task: TaskSpec, bodies: PressureHandoffBodies | undefined): PressureBudget | undefined {
    if (bodies === undefined) return undefined
    return estimatePressureBudget(task.handoff.mode, bodies, this.tokenMeter, {
      structuredBriefReserveTokens: this.structuredBriefReserveTokens,
      lastCompleteTurnReserveTokens: this.lastCompleteTurnReserveTokens,
      maxTokens: task.handoff.maxHandoffTokens,
    })
  }

  /** Apply the ordered 10.2 gates; the first failing gate is recorded. */
  private gate(
    run: RunRecord,
    task: TaskSpec,
    observation: PressureObservation,
    contextWindow: number | undefined,
    ratio: number | undefined,
    measurement: PressureMeasurement,
    budget: PressureBudget | undefined,
    previous: PressureSnapshot | undefined,
  ): { readonly blockedBy: PressureBlockReason | undefined; readonly observeOnly: boolean } {
    if (!task.handoff.enabled) return { blockedBy: 'handoff-disabled', observeOnly: false }
    if (run.generation >= task.handoff.maxGenerations) {
      return { blockedBy: 'generation-exhausted', observeOnly: false }
    }
    if (this.store.getSettings().paused || run.state === 'paused') {
      return { blockedBy: 'paused', observeOnly: false }
    }
    if (run.state === 'cancelled') return { blockedBy: 'cancelled', observeOnly: false }
    if (run.state === 'handing-off') return { blockedBy: 'handoff-in-flight', observeOnly: false }
    if (run.state === 'handoff-pending' && previous?.decision !== 'handoff-pending') {
      return { blockedBy: 'handoff-in-flight', observeOnly: false }
    }
    if (observation.externalInput === true) return { blockedBy: 'external-input', observeOnly: false }
    if (!observation.turnClosed) return { blockedBy: 'turn-not-closed', observeOnly: false }
    if (contextWindow === undefined || ratio === undefined || !Number.isFinite(ratio)) {
      return { blockedBy: 'context-window-unknown', observeOnly: false }
    }
    if (run.generation > 0 && run.acceptedTurnEndSeq === undefined) {
      return { blockedBy: 'empty-generation', observeOnly: false }
    }
    if (ratio < task.handoff.ratio) return { blockedBy: 'below-threshold', observeOnly: false }
    if (budget === undefined || !budget.selected.withinMax) {
      return { blockedBy: 'budget-unavailable', observeOnly: false }
    }
    if (measurement.baseline.kind === 'estimated' && this.estimatedMode === 'observe-only') {
      return { blockedBy: 'handoff-disabled', observeOnly: true }
    }
    return { blockedBy: undefined, observeOnly: false }
  }
}

/** Price one message list; the body actual is never replaced by a fixed reserve. */
function priceBody(
  mode: HandoffMode,
  messages: readonly Message[],
  meter: Pick<PressureTokenMeter, 'estimateMessage'>,
  reserveTokens: number,
  maxTokens: number,
): PressureModeBudget {
  let bodyTokens = 0
  for (const message of messages) {
    const estimate = meter.estimateMessage(message)
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new RangeError('estimateMessage must return a non-negative finite token count')
    }
    bodyTokens += estimate
  }
  const totalTokens = bodyTokens + reserveTokens
  return {
    mode,
    bodyTokens,
    reserveTokens,
    totalTokens,
    maxTokens,
    withinMax: totalTokens <= maxTokens,
  }
}

/** Route from the latest request context, falling back to header/config labels. */
function routeOf(
  context: ReturnType<Session['requestContext']>,
  header: ReturnType<Session['requestHeader']>,
  run: RunRecord,
): PressureRoute {
  const provider = context?.provider ?? header?.config.provider ?? run.configSnapshot?.provider ?? ''
  const model = context?.model ?? header?.config.model ?? run.configSnapshot?.model ?? ''
  const reasoningEffort = header?.config.reasoningEffort ?? run.configSnapshot?.reasoningEffort
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** A non-finite or non-positive advertised window is unknown capacity. */
function normalizeContextWindow(value: number | undefined): number | undefined {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? undefined : value
}

/** Durable token counts must be non-negative integers. */
function normalizeTotal(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** Constructor validation for reserve options. */
function assertTokenCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

/** Build the schema-shaped snapshot with an optional ratio/reason. */
function makeSnapshot(input: {
  readonly sessionId: PressureSnapshot['sessionId']
  readonly logRevision: PressureSnapshot['logRevision']
  readonly route: PressureRoute
  readonly contextWindow: number | undefined
  readonly totalTokens: number
  readonly ratio: number | undefined
  readonly baselineKind: PressureMeasurement['baseline']['kind']
  readonly threshold: number
  readonly fingerprint: string
  readonly measuredAt: number
  readonly decision: PressureDecision
  readonly blockedBy?: PressureBlockReason
}): PressureSnapshot {
  return {
    sessionId: input.sessionId,
    logRevision: input.logRevision,
    provider: input.route.provider,
    model: input.route.model,
    totalTokens: input.totalTokens,
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.ratio === undefined ? {} : { ratio: input.ratio }),
    baselineKind: input.baselineKind,
    threshold: input.threshold,
    routeFingerprint: input.fingerprint,
    measuredAt: input.measuredAt,
    decision: input.decision,
    ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
  }
}

/** A same-route pending decision is durable and must not be rewritten. */
function samePendingDecision(previous: PressureSnapshot | undefined, next: PressureSnapshot): boolean {
  return previous !== undefined
    && previous.decision === 'handoff-pending'
    && next.decision === 'handoff-pending'
    && previous.routeFingerprint === next.routeFingerprint
    && previous.threshold === next.threshold
}

/** Same revision/route/measurement means a duplicate streaming observation. */
function sameReading(previous: PressureSnapshot | undefined, next: PressureSnapshot): boolean {
  if (previous === undefined) return false
  return previous.sessionId === next.sessionId
    && previous.logRevision === next.logRevision
    && previous.provider === next.provider
    && previous.model === next.model
    && previous.totalTokens === next.totalTokens
    && previous.contextWindow === next.contextWindow
    && previous.ratio === next.ratio
    && previous.baselineKind === next.baselineKind
    && previous.threshold === next.threshold
    && previous.routeFingerprint === next.routeFingerprint
    && previous.decision === next.decision
    && previous.blockedBy === next.blockedBy
}
