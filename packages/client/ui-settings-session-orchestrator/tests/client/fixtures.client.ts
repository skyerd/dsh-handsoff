/** DTO fixtures for the orchestration settings client tests. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol/types'
import type {
  HandoffDto, HostCapabilityDto, InterventionDto, OrchestratorSnapshotFrame, QueueDetailValue, QueueDto, RunDto, SessionLinkDto,
  SettingsDto, TaskDto, TaskSummaryDto, WardenAuditDto,
} from '../../src/client/contract.ts'

/** Wrap one successful business result. */
export function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One stable revision-conflict result. */
export function revisionConflict<T>(details: {
  readonly resource: 'queue' | 'task' | 'run' | 'settings' | 'handoff' | 'stream'
  readonly id?: string
  readonly expectedRevision?: number
}): RemoteResult<T> {
  return {
    ok: false,
    error: new RemoteError(
      'sessionOrchestrator/revision-conflict',
      'the request observed a stale orchestration revision',
      details,
    ),
  }
}

/** One queue projection. */
export function queue(overrides: Partial<QueueDto> = {}): QueueDto {
  return {
    id: 'q1',
    title: 'Queue one',
    taskOrder: ['t1', 't2'],
    paused: false,
    state: 'idle',
    revision: 1,
    ...overrides,
  }
}

/** One task summary. */
export function taskSummary(overrides: Partial<TaskSummaryDto> = {}): TaskSummaryDto {
  return {
    id: 't1',
    queueId: 'q1',
    title: 'Task one',
    workspaceId: 'w1',
    priority: 10,
    enabled: true,
    model: { kind: 'inherit' },
    dependsOn: [],
    revision: 1,
    ...overrides,
  }
}

/** One full task projection. */
export function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't1',
    queueId: 'q1',
    title: 'Task one',
    prompt: 'Do the thing.',
    workspaceId: 'w1',
    cwd: '/workspace',
    preset: { kind: 'inherit' },
    model: { kind: 'inherit' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 10,
    handoff: {
      enabled: true,
      ratio: 0.88,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 4,
      maxHandoffTokens: 8_000,
    },
    enabled: true,
    revision: 1,
    ...overrides,
  }
}

/** One queue detail value. */
export function queueDetail(overrides: {
  readonly queue?: QueueDto
  readonly tasks?: readonly TaskDto[]
} = {}): QueueDetailValue {
  return { queue: overrides.queue ?? queue(), tasks: overrides.tasks ?? [task()] }
}

/** One host settings projection. */
export function settings(overrides: Partial<SettingsDto> = {}): SettingsDto {
  return {
    revision: 4,
    paused: false,
    maxConcurrentRuns: 2,
    providerQuotas: { deepseek: 3 },
    updatedAt: 1_000,
    ...overrides,
  }
}

/** One run projection. */
export function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: 'run-t1-1',
    taskId: 't1',
    attempt: 1,
    state: 'needs-attention',
    generation: 0,
    revision: 3,
    sessionLineage: [],
    workspaceKey: 'w1',
    skipped: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

/** One host-projected Session link. */
export function sessionLink(overrides: Partial<SessionLinkDto> = {}): SessionLinkDto {
  return {
    sessionId: 'session-1',
    linkable: true,
    openState: 'ready',
    workspaceId: 'w1',
    route: '/session/session-1',
    ...overrides,
  }
}

/** One completed handoff projection. */
export function handoff(overrides: Partial<HandoffDto> = {}): HandoffDto {
  return {
    operationId: 'op-1',
    runId: 'run-t1-1',
    generation: 1,
    parentSession: { sessionId: 's1', linkable: true, openState: 'ready', route: '/session/s1' },
    childSession: { sessionId: 's2', linkable: false, openState: 'unsupported' },
    sourceSeq: 10,
    bodyHash: 'abcdef1234567890',
    mode: 'structured-brief',
    bodyTokens: 1_200,
    configSnapshot: {
      routeSource: 'fixed-policy',
      provider: 'deepseek',
      model: 'deepseek-chat',
      preset: { id: 'default' },
      capturedAt: 1_500,
    },
    createdAt: 3_000,
    ...overrides,
  }
}

/** One audited intervention with a recorded judge and payer. */
export function intervention(overrides: Partial<InterventionDto> = {}): InterventionDto {
  return {
    id: 'iv-run-t1-1-g0-pause-context',
    runId: 'run-t1-1',
    taskId: 't1',
    generation: 0,
    kind: 'pause-context',
    phase: 'settled',
    reason: 'context occupancy reached the switch point 60%',
    warden: { mode: 'rule', verdict: 'decompose' },
    paidBy: { provider: 'deepseek', model: 'deepseek-chat' },
    trigger: { contextRatio: 0.61 },
    childTaskIds: [],
    createdAt: 4_000,
    updatedAt: 4_100,
    ...overrides,
  }
}

/** One warden review row naming the route that paid for it. */
export function wardenReview(overrides: Partial<WardenAuditDto> = {}): WardenAuditDto {
  return {
    id: 'wa-run-t1-1-g0-4000',
    runId: 'run-t1-1',
    taskId: 't1',
    generation: 0,
    mode: 'model',
    verdict: 'decompose',
    reason: 'the remaining work is too broad for one task',
    provider: 'deepseek',
    model: 'deepseek-chat',
    latencyMs: 320,
    inputTokens: 1_200,
    outputTokens: 18,
    createdAt: 4_000,
    ...overrides,
  }
}

/** One host capability matrix with one disabled and one supported capability. */
export function hostCapability(overrides: Partial<HostCapabilityDto> = {}): HostCapabilityDto {
  return {
    host: 'trae',
    displayName: 'Trae',
    available: true,
    runnable: false,
    queueBackend: false,
    capabilities: [
      { capability: 'listWorkspaces', status: 'unsupported', reason: 'the IDE exposes no workspace listing' },
      { capability: 'createSession', status: 'unsupported', reason: 'no public conversation API' },
      { capability: 'sendPrompt', status: 'unsupported', reason: 'no public prompt API' },
      { capability: 'openSession', status: 'unsupported', reason: 'no stable conversation route' },
      { capability: 'subscribeEvents', status: 'unsupported', reason: 'no public event stream' },
      { capability: 'getUsage', status: 'unsupported', reason: 'no public usage endpoint' },
      { capability: 'selectModel', status: 'unsupported', reason: 'no per-conversation model API' },
      { capability: 'listModels', status: 'unsupported', reason: 'no model catalog' },
      { capability: 'skills', status: 'unsupported', reason: 'no preset composition' },
      { capability: 'permissions', status: 'unsupported', reason: 'no permission policy' },
      { capability: 'compaction', status: 'unsupported', reason: 'no compaction surface' },
    ],
    ...overrides,
  }
}

/** One whole snapshot frame. */
export function frame(overrides: Partial<OrchestratorSnapshotFrame> = {}): OrchestratorSnapshotFrame {
  return {
    type: 'snapshot',
    revision: 1,
    generatedAt: 5_000,
    settings: settings(),
    queues: [queue()],
    tasks: [taskSummary()],
    runs: [],
    handoffs: [],
    interventions: [],
    wardenAudits: [],
    hosts: [],
    ...overrides,
  }
}
