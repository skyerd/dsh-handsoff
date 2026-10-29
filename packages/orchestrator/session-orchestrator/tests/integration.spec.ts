/** One real agent-loop turn driven end-to-end by the RunSupervisor. */
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { OperationId, QueueId, RunId, TaskId } from '../src/brand.ts'
import { RunSupervisor } from '../src/supervisor.ts'
import type { OperationRecord, RunRecord, TaskSpec } from '../src/types.ts'
import { harness } from './harness.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

function integrationTask(): TaskSpec {
  return {
    id: TaskId('task-int'),
    queueId: QueueId('queue-int'),
    title: 'Integration task',
    prompt: 'Say done',
    workspaceId: 'workspace-int',
    cwd: '/work/integration',
    preset: { kind: 'inherit' },
    model: { kind: 'fixed', provider: 'mock', model: 'mock-model' },
    skills: { kind: 'inherit-preset' },
    dependsOn: [],
    priority: 0,
    handoff: {
      enabled: false,
      ratio: 0.88,
      mode: 'structured-brief',
      boundary: 'completed-turn',
      maxGenerations: 20,
      maxHandoffTokens: 4096,
    },
    enabled: true,
    revision: 0,
  }
}

describe('RunSupervisor + real AgentLoop', () => {
  it('creates a real session, follows up once, accepts the committed turn and settles succeeded', async () => {
    const h = await harness()
    const ctx = h.ctx
    try {
      const adapter = new MockAdapter([textResponse('done')])
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.llm.registerAdapter(['mock'], adapter)

      const spec = integrationTask()
      await h.store.createTask(spec)
      const base: RunRecord = {
        id: RunId('run-int'),
        taskId: spec.id,
        attempt: 1,
        state: 'ready',
        sessionLineage: [],
        generation: 0,
        workspaceKey: 'workspace-int:/work/integration',
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      }
      await h.store.createRun(base)
      const operation: OperationRecord = {
        id: OperationId('operation-int'),
        runId: base.id,
        generation: 0,
        attempt: 1,
        kind: 'initial-prompt',
        phase: 'planned',
        requestHash: 'hash-int',
        createdAt: 1_000,
        updatedAt: 1_000,
      }
      await h.store.planOperation(operation)
      const run = await h.store.updateRun(base.id, 0, {
        ...base,
        state: 'starting',
        operationId: operation.id,
        revision: 1,
        updatedAt: 1_001,
      })

      const prepareCall = vi.spyOn(ctx.llm, 'prepareCall')
      const rawStream = vi.spyOn(ctx.llm, 'stream')

      const userMessages: string[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type !== 'user/message') return
        const source = event.data.source
        if (source.kind === 'session-orchestrator') {
          userMessages.push(String(source.operationId))
        }
      })

      const supervisor = new RunSupervisor({
        ctx,
        store: h.store,
        sessions: ctx.sessions,
        liveSessions: ctx.sessions,
        agents: ctx.agents,
        now: () => 2_000,
      })
      try {
        const settlement = await supervisor.start({ run, task: spec, operationId: operation.id })
        expect(settlement).toMatchObject({
          state: 'succeeded',
          reason: 'completed',
          committed: true,
          turns: 1,
          duplicates: 0,
          disposeError: undefined,
        })
        expect(settlement.sessionId).toBeDefined()
        expect(settlement.acceptedTurnEndSeq).toBeGreaterThan(0)
        expect(adapter.requests).toHaveLength(1)
        expect(adapter.requests[0]?.purpose).toBeUndefined()
        expect(prepareCall).toHaveBeenCalledTimes(1)
        expect(rawStream).not.toHaveBeenCalled()
        expect(userMessages).toEqual([String(operation.id)])
        expect(h.store.getOperation(operation.id)).toMatchObject({
          phase: 'claimed',
          targetSessionId: settlement.sessionId,
        })
        expect(h.store.getRun(run.id)).toMatchObject({
          state: 'succeeded',
          claimedTurn: 1,
          acceptedTurnEndSeq: settlement.acceptedTurnEndSeq,
        })
        expect(supervisor.ownershipOf(run.id)).toBe('observed')
      } finally {
        await supervisor.close()
      }
    } finally {
      await h.close()
    }
  })
})
