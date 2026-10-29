import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  CreateAgentOptions,
  Inbox,
  InboxTarget,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, Session } from '@deepseek-ai/dsh-session'
import { Session as SessionClass, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { OperationId, RunId } from '../src/brand.ts'
// Value-free import: joins the orchestrator MessageSourceMap augmentation for
// the fake prompts these tests build.
import type {} from '../src/message-source.ts'
import type { SessionDurability, SupervisorAgents } from '../src/supervisor.ts'

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * Deterministic Agent test double.
 *
 * `whenIdle()` never resolves on its own: each call parks until the test calls
 * {@link releaseIdle}. This keeps the sequence "wait → observe → probe"
 * explicit instead of depending on timers.
 */
export class FakeAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context
  readonly options: AgentOptions = {}
  readonly followups: UserMessage[] = []
  readonly cancels: Array<{ cause: AgentCancelCause; options?: CancelOptions }> = []
  readonly inbox: Inbox

  private state: AgentStatus = 'idle'
  private idleWaiters: Array<() => void> = []
  private idleWatchers: Array<() => void> = []
  private followupWatchers: Array<() => void> = []
  private maintenanceStarted = false
  private maintenanceStartedWatchers: Array<() => void> = []
  private maintenanceGate: Promise<void> | undefined
  private readonly turnQueue: UserMessage[] = []
  private readonly stepQueue: UserMessage[] = []

  constructor(sessionId: SessionId, ctx: Context) {
    this.id = sessionId
    this.session = SessionClass.create(sessionId)
    this.ctx = ctx
    const target = (name: InboxTarget): UserMessage[] => (name === 'next-turn' ? this.turnQueue : this.stepQueue)
    const turnQueue = this.turnQueue
    const stepQueue = this.stepQueue
    this.inbox = {
      get nextTurn() {
        return turnQueue
      },
      get nextStep() {
        return stepQueue
      },
      clear: () => {
        this.turnQueue.length = 0
        this.stepQueue.length = 0
      },
      append: (name, message) => {
        target(name).push(message)
      },
      prepend: (name, message) => {
        target(name).unshift(message)
      },
      replace: (messageId, newMessage) => {
        for (const list of [this.turnQueue, this.stepQueue]) {
          const index = list.findIndex((message) => message.id === messageId)
          if (index >= 0) {
            list[index] = newMessage
            return true
          }
        }
        return false
      },
      remove: (messageId) => {
        for (const list of [this.turnQueue, this.stepQueue]) {
          const index = list.findIndex((message) => message.id === messageId)
          if (index >= 0) {
            list.splice(index, 1)
            return true
          }
        }
        return false
      },
      splice: (name, start, deleteCount, inserted) => {
        return target(name).splice(start, deleteCount, ...inserted)
      },
    }
  }

  get status(): AgentStatus {
    return this.state
  }

  followup(message: UserMessage): void {
    this.followups.push(message)
    for (const wake of this.followupWatchers.splice(0)) wake()
  }

  send(message: UserMessage): void {
    this.inbox.append('next-turn', message)
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message)
  }

  inject(message: UserMessage): void {
    this.inbox.append('next-step', message)
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.cancels.push({ cause, ...(options === undefined ? {} : { options }) })
    this.state = 'idle'
    this.releaseIdle()
  }

  whenIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
      for (const wake of this.idleWatchers.splice(0)) wake()
    })
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.maintenanceStarted = true
    for (const wake of this.maintenanceStartedWatchers.splice(0)) wake()
    if (this.maintenanceGate !== undefined) await this.maintenanceGate
    return await task(new AbortController().signal)
  }

  /** Queue an inbox message as if another actor appended it. */
  enqueue(message: UserMessage, target: InboxTarget = 'next-turn'): void {
    if (target === 'next-turn') this.turnQueue.push(message)
    else this.stepQueue.push(message)
  }

  /** Wait until `start()` has reached the fake agent's first idle wait. */
  async waitForIdleWait(): Promise<void> {
    if (this.idleWaiters.length > 0) return
    await new Promise<void>((resolve) => this.idleWatchers.push(resolve))
  }

  /** Resolve the current `whenIdle()` call. */
  releaseIdle(): void {
    for (const wake of this.idleWaiters.splice(0)) wake()
  }

  /** Wait until `followup()` accepted at least one message. */
  async waitForFollowup(): Promise<UserMessage> {
    while (this.followups.length === 0) {
      await new Promise<void>((resolve) => this.followupWatchers.push(resolve))
    }
    return this.followups[0]!
  }

  /** Hold the next maintenance callback until the returned function is called. */
  holdMaintenance(): () => void {
    const gate = deferred()
    this.maintenanceStarted = false
    this.maintenanceGate = gate.promise
    return gate.resolve
  }

  async waitForMaintenanceStart(): Promise<void> {
    if (this.maintenanceStarted) return
    await new Promise<void>((resolve) => this.maintenanceStartedWatchers.push(resolve))
  }

  emit(event: SessionEvent): void {
    this.ctx.emit('session/event', this.session, event)
  }
}

/** Agent factory double with observable create/dispose ordering. */
export class FakeAgents implements SupervisorAgents {
  readonly created: FakeAgent[] = []
  readonly createOptions: CreateAgentOptions[] = []
  readonly resumed: FakeAgent[] = []
  readonly resumeOptions: ResumeAgentOptions[] = []
  createError: Error | undefined
  resumeError: Error | undefined
  disposeMode: 'ok' | 'fail' | 'gate' = 'ok'
  disposeError: Error = new Error('dispose failed')
  disposeCalls = 0
  private disposeGate: Promise<void> | undefined
  private disposeStarted = false
  private disposeStartedWatchers: Array<() => void> = []
  private createWatchers: Array<() => void> = []
  private resumeWatchers: Array<() => void> = []

  constructor(private readonly ctx: Context) {}

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.createError !== undefined) throw this.createError
    const agent = new FakeAgent(options.sessionId, this.ctx)
    this.created.push(agent)
    this.createOptions.push(options)
    for (const wake of this.createWatchers.splice(0)) wake()
    return {
      agent,
      dispose: async (): Promise<void> => {
        this.disposeCalls += 1
        this.disposeStarted = true
        for (const wake of this.disposeStartedWatchers.splice(0)) wake()
        if (this.disposeGate !== undefined) await this.disposeGate
        if (this.disposeMode === 'fail') throw this.disposeError
      },
    }
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    if (this.resumeError !== undefined) throw this.resumeError
    const agent = new FakeAgent(options.resumeSessionId, this.ctx)
    this.resumed.push(agent)
    this.resumeOptions.push(options)
    for (const wake of this.resumeWatchers.splice(0)) wake()
    return {
      agent,
      dispose: async (): Promise<void> => {
        this.disposeCalls += 1
        this.disposeStarted = true
        for (const wake of this.disposeStartedWatchers.splice(0)) wake()
        if (this.disposeGate !== undefined) await this.disposeGate
        if (this.disposeMode === 'fail') throw this.disposeError
      },
    }
  }

  async waitForResume(): Promise<FakeAgent> {
    while (this.resumed.length === 0) {
      await new Promise<void>((resolve) => this.resumeWatchers.push(resolve))
    }
    return this.resumed[0]!
  }

  async waitForCreate(): Promise<FakeAgent> {
    while (this.created.length === 0) {
      await new Promise<void>((resolve) => this.createWatchers.push(resolve))
    }
    return this.created[0]!
  }

  holdDispose(): () => void {
    const gate = deferred()
    this.disposeStarted = false
    this.disposeGate = gate.promise
    this.disposeMode = 'gate'
    return gate.resolve
  }

  async waitForDisposeStart(): Promise<void> {
    if (this.disposeStarted) return
    await new Promise<void>((resolve) => this.disposeStartedWatchers.push(resolve))
  }
}

/** Controllable durability checkpoint double. */
export class FakeDurability implements SessionDurability {
  readonly sessions: Session[] = []
  calls = 0
  failure: Error | undefined
  private gate: Promise<void> | undefined
  private started = false
  private startedWatchers: Array<() => void> = []

  hold(): () => void {
    const gate = deferred()
    this.started = false
    this.gate = gate.promise
    return gate.resolve
  }

  async flush(session: Session): Promise<boolean> {
    this.calls += 1
    this.sessions.push(session)
    this.started = true
    for (const wake of this.startedWatchers.splice(0)) wake()
    if (this.gate !== undefined) await this.gate
    if (this.failure !== undefined) throw this.failure
    return true
  }

  async waitForFlush(): Promise<void> {
    if (this.started) return
    await new Promise<void>((resolve) => this.startedWatchers.push(resolve))
  }
}

/** Build a well-formed session event for fake/session-log tests. */
export function event<T extends SessionEventType>(
  type: T,
  seq: number,
  data: SessionEventMap[T],
): SessionEvent<T> {
  const base = { type, seq: SessionSeq(seq), time: 1_000 + seq, data }
  const value = type === 'user/message' ? { ...base, surfaceOp: 'append' as const } : base
  return value as SessionEvent<T>
}

/** Create a user message attributed to another orchestration operation. */
export function otherOperationMessage(operationId: string, content: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: {
      kind: 'session-orchestrator',
      operationId: OperationId(operationId),
      runId: RunId('run-other'),
      generation: 0,
      attempt: 0,
    },
  })
}

/** Create a user message that was typed by a human, not by orchestration. */
export function humanMessage(content: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
}
