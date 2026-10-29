/**
 * Pure projections over the orchestration snapshot.
 *
 * Everything here is a deterministic fold over DTOs: no Remote call, no clock
 * read, and no React. The page keeps the live snapshot and its local drafts in
 * separate sources and uses these helpers only to render the live side.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-session-orchestrator/client/model
 */

import type {
  HandoffDto, QueueDto, RunDto, TaskDto, TaskSummaryDto,
} from './contract.ts'

/** One queue's task graph as the page draws it. */
export interface TaskGraph {
  /** Known task ids in queue order, then any remaining ids. */
  readonly order: readonly string[]
  /** Every resolvable task node. */
  readonly nodes: readonly GraphNode[]
  /** Dependency edges from prerequisite to dependent. */
  readonly edges: readonly GraphEdge[]
  /** Nodes grouped by dependency depth; unresolved nodes share the last layer. */
  readonly layers: readonly (readonly string[])[]
  /** Structural problems the task definitions carry. */
  readonly issues: readonly GraphIssue[]
}

/** One task node in the graph. */
export interface GraphNode {
  readonly id: string
  readonly title: string
  readonly dependsOn: readonly string[]
  readonly enabled: boolean
  readonly priority: number
  /** Zero-based dependency depth; `-1` marks a node left unresolved by a cycle. */
  readonly layer: number
}

/** One dependency edge. */
export interface GraphEdge {
  readonly from: string
  readonly to: string
}

/** One structural problem in a queue's task graph. */
export interface GraphIssue {
  readonly kind: 'missing-dependency' | 'duplicate-dependency' | 'self-dependency' | 'cycle'
  readonly taskId: string
  readonly dependencyId?: string
}

/** Run columns the parallel board shows. */
export type BoardColumn = 'running' | 'attention' | 'waiting' | 'paused' | 'settled'

/** Task groups the parallel board shows, in render order. */
export const BOARD_COLUMN_ORDER: readonly BoardColumn[] = ['running', 'attention', 'waiting', 'paused', 'settled']

/** One task row inside a board group, with its latest attempt when one exists. */
export interface BoardRow {
  readonly task: TaskSummaryDto
  readonly run?: RunDto
  readonly column: BoardColumn
}

/** The whole board projection. */
export interface BoardView {
  readonly columns: Readonly<Record<BoardColumn, readonly BoardRow[]>>
  readonly counts: Readonly<Record<BoardColumn, number>>
  /** Task rows whose latest attempt is live or dispatched. */
  readonly active: number
}

/** One handoff edge inside a run chain. */
export interface HandoffLink {
  readonly handoff: HandoffDto
  readonly parentSession: string
  readonly childSession: string
}

/** One run's generation chain. */
export interface HandoffChain {
  readonly runId: string
  readonly taskId: string
  readonly attempt: number
  readonly generation: number
  readonly sessions: readonly string[]
  readonly links: readonly HandoffLink[]
}

/** Fields shared by every observable audit fact. */
interface AuditEventBase {
  readonly id: string
  readonly at: number
  readonly runId: string
  readonly taskId: string
}

/** One observable audit fact, projected from run and handoff timestamps. */
export type AuditEvent =
  | (AuditEventBase & { readonly kind: 'run-created' | 'run-updated' | 'human-skip' })
  | (AuditEventBase & { readonly kind: 'run-error'; readonly code: string })
  | (AuditEventBase & {
    readonly kind: 'operation-phase'
    readonly code: NonNullable<RunDto['operation']>['phase']
  })
  | (AuditEventBase & {
    readonly kind: 'pressure'
    readonly code: NonNullable<RunDto['pressure']>['baselineKind']
  })
  | (AuditEventBase & { readonly kind: 'handoff'; readonly code: HandoffDto['mode'] })

/**
 * Bucket that carries a run's state.
 * @param state - run state from the live snapshot.
 * @returns the parallel-board column.
 */
export function boardColumnOf(state: RunDto['state']): BoardColumn {
  switch (state) {
    case 'ready':
      return 'waiting'
    case 'starting':
    case 'running':
    case 'handoff-pending':
    case 'handing-off':
      return 'running'
    case 'needs-attention':
      return 'attention'
    case 'paused':
      return 'paused'
    case 'succeeded':
    case 'deferred':
    case 'failed':
    case 'cancelled':
      return 'settled'
  }
}

/**
 * State-dot appearance for one run state.
 * @param state - run state from the live snapshot.
 * @returns the presentation tone key.
 */
export function runStateTone(state: RunDto['state']): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  switch (state) {
    case 'succeeded':
      return 'done'
    case 'needs-attention':
      return 'warning'
    case 'starting':
    case 'running':
    case 'handoff-pending':
    case 'handing-off':
      return 'ongoing'
    case 'failed':
      return 'error'
    case 'ready':
    case 'paused':
    case 'deferred':
    case 'cancelled':
      return 'idle'
  }
}

/**
 * Whether the controller accepts a human cancel for this state.
 * @param state - run state from the live snapshot.
 * @returns whether the cancel control is available.
 */
export function canCancelRun(state: RunDto['state']): boolean {
  return state === 'ready'
    || state === 'starting'
    || state === 'running'
    || state === 'handoff-pending'
    || state === 'needs-attention'
    || state === 'paused'
}

/**
 * Whether the controller accepts a fresh attempt for this state.
 *
 * A recorded skip belongs to the old attempt only: it stays as audit history
 * and does not block a successor attempt.
 * @param run - run projection from the live snapshot.
 * @returns whether the retry control is available.
 */
export function canRetryRun(run: RunDto): boolean {
  return run.state === 'needs-attention'
    || run.state === 'failed'
    || run.state === 'cancelled'
    || run.state === 'paused'
}

/**
 * Whether the controller accepts an audited human skip for this run.
 * @param run - run projection from the live snapshot.
 * @returns whether the skip control is available.
 */
export function canSkipRun(run: RunDto): boolean {
  return run.state === 'needs-attention' && run.skipped !== true
}

/**
 * Project one queue's tasks into dependency layers and ordered edges.
 * @param queue - selected queue, or `undefined` for every visible task.
 * @param tasks - live task summaries.
 * @returns ordered nodes, edges, layers and structural issues.
 */
export function buildTaskGraph(
  queue: QueueDto | undefined,
  tasks: readonly TaskSummaryDto[],
): TaskGraph {
  const queueTasks = queue === undefined
    ? [...tasks]
    : tasks.filter(task => task.queueId === queue.id)
  const index = new Map(queueTasks.map(task => [task.id, task]))
  const queueOrder = queue?.taskOrder ?? []
  const orderIndex = new Map(queueOrder.map((id, index) => [id, index]))
  const order = [
    ...queueOrder.filter(id => index.has(id)),
    ...queueTasks.map(task => task.id)
      .filter(id => !queueOrder.includes(id))
      .sort((left, right) => left.localeCompare(right)),
  ]
  const issues: GraphIssue[] = []
  const edges: GraphEdge[] = []
  const indegree = new Map(queueTasks.map(task => [task.id, 0]))
  const dependents = new Map<string, string[]>()

  for (const task of queueTasks) {
    const seen = new Set<string>()
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        issues.push({ kind: 'self-dependency', taskId: task.id, dependencyId })
        continue
      }
      if (seen.has(dependencyId)) {
        issues.push({ kind: 'duplicate-dependency', taskId: task.id, dependencyId })
        continue
      }
      seen.add(dependencyId)
      if (!index.has(dependencyId)) {
        issues.push({ kind: 'missing-dependency', taskId: task.id, dependencyId })
        continue
      }
      edges.push({ from: dependencyId, to: task.id })
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
      const list = dependents.get(dependencyId) ?? []
      list.push(task.id)
      dependents.set(dependencyId, list)
    }
  }

  const layerOf = new Map<string, number>()
  const ready = [...queueTasks]
    .filter(task => (indegree.get(task.id) ?? 0) === 0)
    .map(task => task.id)
  const byOrder = (left: string, right: string): number => {
    const leftOrder = orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.localeCompare(right)
  }
  ready.sort(byOrder)
  for (const id of ready) layerOf.set(id, 0)
  const work = [...ready]
  while (work.length > 0) {
    const id = work.shift()
    if (id === undefined) break
    const layer = layerOf.get(id) ?? 0
    for (const dependent of dependents.get(id) ?? []) {
      const next = Math.max(layerOf.get(dependent) ?? 0, layer + 1)
      layerOf.set(dependent, next)
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) work.push(dependent)
    }
  }

  const unresolved = order.filter(id => !layerOf.has(id))
  for (const id of unresolved) {
    issues.push({ kind: 'cycle', taskId: id })
    layerOf.set(id, -1)
  }
  for (const id of order) layerOf.set(id, layerOf.get(id) ?? 0)

  const nodes: GraphNode[] = order.map((id) => {
    const task = index.get(id)
    if (task === undefined) throw new Error(`task graph lists an unknown node ${id}`)
    return {
      id: task.id,
      title: task.title,
      dependsOn: [...task.dependsOn],
      enabled: task.enabled,
      priority: task.priority,
      layer: layerOf.get(task.id) ?? 0,
    }
  })
  edges.sort((left, right) => byOrder(left.from, right.from) || byOrder(left.to, right.to))

  const layers: string[][] = []
  for (const node of nodes) {
    if (node.layer < 0) {
      const unresolvedLayer = layers.length === 0 ? 0 : layers.length
      while (layers.length <= unresolvedLayer) layers.push([])
      layers[unresolvedLayer]?.push(node.id)
      continue
    }
    while (layers.length <= node.layer) layers.push([])
    layers[node.layer]?.push(node.id)
  }
  return { order, nodes, edges, layers: layers.map(layer => [...layer].sort(byOrder)), issues }
}

/**
 * Find one task's newest attempt.
 *
 * `attempt` is the scheduler's own sequence; timestamps and ids only break a
 * tie, so a late event cannot make an older attempt look newer.
 * @param runs - live run projections.
 * @param taskId - task whose attempt is read.
 * @returns the newest attempt, or `undefined` before the first dispatch.
 */
export function latestRunOf(
  runs: readonly RunDto[],
  taskId: string,
): RunDto | undefined {
  let latest: RunDto | undefined
  for (const run of runs) {
    if (run.taskId !== taskId) continue
    if (latest === undefined
      || run.attempt > latest.attempt
      || (run.attempt === latest.attempt
        && (run.createdAt > latest.createdAt
          || (run.createdAt === latest.createdAt && run.id.localeCompare(latest.id) > 0)))) {
      latest = run
    }
  }
  return latest
}

/**
 * Group every visible task into the parallel board by its latest attempt.
 *
 * A task with no attempt is a waiting row, not an absent one: creating a task
 * is what makes it visible, and the first run only changes its status.
 * @param tasks - live task summaries.
 * @param runs - live run projections.
 * @returns columns, counts and the number of dispatched task rows.
 */
export function buildBoard(
  tasks: readonly TaskSummaryDto[],
  runs: readonly RunDto[],
): BoardView {
  const columns: Record<BoardColumn, BoardRow[]> = {
    running: [], attention: [], waiting: [], paused: [], settled: [],
  }
  for (const task of tasks) {
    const run = latestRunOf(runs, task.id)
    const column = run === undefined ? 'waiting' : boardColumnOf(run.state)
    columns[column].push(run === undefined ? { task, column } : { task, run, column })
  }
  for (const list of Object.values(columns)) {
    list.sort((left, right) => {
      const activity = (right.run?.updatedAt ?? -1) - (left.run?.updatedAt ?? -1)
      if (activity !== 0) return activity
      if (left.task.priority !== right.task.priority) return right.task.priority - left.task.priority
      return left.task.title.localeCompare(right.task.title) || left.task.id.localeCompare(right.task.id)
    })
  }
  return {
    columns,
    counts: {
      running: columns.running.length,
      attention: columns.attention.length,
      waiting: columns.waiting.length,
      paused: columns.paused.length,
      settled: columns.settled.length,
    },
    active: [...columns.running, ...columns.waiting]
      .filter(row => row.run !== undefined)
      .length,
  }
}

/**
 * Join every run's session lineage with the handoffs it produced.
 * @param runs - live run projections.
 * @param handoffs - completed handoff projections.
 * @returns one chain per run, oldest run first.
 */
export function buildHandoffChains(
  runs: readonly RunDto[],
  handoffs: readonly HandoffDto[],
): readonly HandoffChain[] {
  const byRun = new Map<string, HandoffDto[]>()
  for (const handoff of handoffs) {
    const list = byRun.get(handoff.runId) ?? []
    list.push(handoff)
    byRun.set(handoff.runId, list)
  }
  return [...runs]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((run) => {
      const records = [...(byRun.get(run.id) ?? [])]
        .sort((left, right) => left.generation - right.generation)
      const sessions: string[] = [...run.sessionLineage.map(link => link.sessionId)]
      if (run.activeSession !== undefined && !sessions.includes(run.activeSession.sessionId)) {
        sessions.push(run.activeSession.sessionId)
      }
      for (const record of records) {
        if (!sessions.includes(record.parentSession.sessionId)) sessions.push(record.parentSession.sessionId)
        if (!sessions.includes(record.childSession.sessionId)) sessions.push(record.childSession.sessionId)
      }
      return {
        runId: run.id,
        taskId: run.taskId,
        attempt: run.attempt,
        generation: run.generation,
        sessions,
        links: records.map(record => ({
          handoff: record,
          parentSession: record.parentSession.sessionId,
          childSession: record.childSession.sessionId,
        })),
      }
    })
}

/**
 * Project the observable audit trail carried by snapshot records.
 *
 * The Remote contract returns projections, not an audit log: actor and reason
 * of a human skip never leave the Host. This helper therefore lists only facts
 * the snapshot actually carries (run timestamps, last error, operation phase,
 * pressure reading, handoff generation, skipped bit) and never fabricates an
 * actor, a reason, or a transition history.
 * @param runs - visible run projections.
 * @param handoffs - visible handoff projections.
 * @returns newest-first observable facts.
 */
export function deriveAuditEvents(
  runs: readonly RunDto[],
  handoffs: readonly HandoffDto[],
): readonly AuditEvent[] {
  const events: AuditEvent[] = []
  for (const run of runs) {
    const base = { runId: run.id, taskId: run.taskId }
    events.push({ ...base, id: `${run.id}:created`, at: run.createdAt, kind: 'run-created' })
    events.push({ ...base, id: `${run.id}:updated`, at: run.updatedAt, kind: 'run-updated' })
    if (run.lastError !== undefined) {
      events.push({
        ...base,
        id: `${run.id}:error`,
        at: run.updatedAt,
        kind: 'run-error',
        code: run.lastError.code,
      })
    }
    if (run.operation !== undefined) {
      events.push({
        ...base,
        id: `${run.id}:operation`,
        at: run.updatedAt,
        kind: 'operation-phase',
        code: run.operation.phase,
      })
    }
    if (run.pressure !== undefined) {
      events.push({
        ...base,
        id: `${run.id}:pressure`,
        at: run.pressure.measuredAt,
        kind: 'pressure',
        code: run.pressure.baselineKind,
      })
    }
    for (const handoff of handoffs) {
      if (handoff.runId !== run.id) continue
      events.push({
        ...base,
        id: `${run.id}:handoff:${handoff.generation}`,
        at: handoff.createdAt,
        kind: 'handoff',
        code: handoff.mode,
      })
    }
    if (run.skipped) {
      events.push({
        ...base,
        id: `${run.id}:skip`,
        at: run.updatedAt,
        kind: 'human-skip',
      })
    }
  }
  return events
    .sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
}

/** One run's token reading with its baseline provenance. */
export interface PressureReading {
  readonly tokens: number
  readonly estimated: boolean
  readonly baselineKind: NonNullable<RunDto['pressure']>['baselineKind']
  readonly ratio?: number
  readonly contextWindow?: number
  readonly threshold: number
  readonly decision: NonNullable<RunDto['pressure']>['decision']
  readonly blockedBy?: NonNullable<RunDto['pressure']>['blockedBy']
}

/**
 * Read a run's pressure reading and whether its token count is an estimate.
 * @param run - run projection carrying an optional pressure reading.
 * @returns the reading, or undefined when none was measured.
 */
export function pressureReading(run: RunDto): PressureReading | undefined {
  const pressure = run.pressure
  if (pressure === undefined) return undefined
  return {
    tokens: pressure.totalTokens,
    estimated: pressure.baselineKind === 'estimated',
    baselineKind: pressure.baselineKind,
    ...(pressure.ratio === undefined ? {} : { ratio: pressure.ratio }),
    ...(pressure.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow }),
    threshold: pressure.threshold,
    decision: pressure.decision,
    ...(pressure.blockedBy === undefined ? {} : { blockedBy: pressure.blockedBy }),
  }
}

/**
 * Provider quota entries in stable provider-name order.
 * @param quotas - provider-to-limit record.
 * @returns ordered entries.
 */
export function quotaEntries(quotas: Readonly<Record<string, number>>): readonly [string, number][] {
  return Object.entries(quotas).sort(([left], [right]) => left.localeCompare(right))
}

/**
 * Count tasks in a queue that the snapshot exposes.
 * @param queue - queue projection.
 * @param tasks - live task summaries.
 * @returns the visible task count.
 */
export function queueTaskCount(queue: QueueDto, tasks: readonly TaskSummaryDto[]): number {
  return tasks.filter(task => task.queueId === queue.id).length
}

/**
 * Resolve a task title without inventing a fallback title.
 * @param tasks - live task summaries.
 * @param taskId - task identity.
 * @returns the title, or `undefined` when the task is not visible.
 */
export function taskTitleOf(tasks: readonly TaskSummaryDto[], taskId: string): string | undefined {
  return tasks.find(task => task.id === taskId)?.title
}

/**
 * Resolve a full task detail from a loaded queue.
 * @param tasks - loaded task details.
 * @param taskId - task identity.
 * @returns the detail, or `undefined` when loading has not produced it.
 */
export function detailOf(tasks: readonly TaskDto[], taskId: string): TaskDto | undefined {
  return tasks.find(task => task.id === taskId)
}

/**
 * Pick the route a task should pin when the user asks for a fixed model.
 *
 * The deployment default is the only route the Host would have used on its own,
 * so it is the honest pin: an arbitrary catalog row moves the task onto a
 * provider the deployment may hold no credential for, and a pinned route
 * outranks both the pipeline and the host default.
 * @param choices - advertised routes in catalog order.
 * @returns the default route, else the first advertised route.
 */
export function pinnedRouteOf<T extends { readonly isDefault?: boolean }>(
  choices: readonly T[],
): T | undefined {
  return choices.find(choice => choice.isDefault === true) ?? choices[0]
}
