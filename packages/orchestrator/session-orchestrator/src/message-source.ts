/**
 * The orchestrator's `MessageSourceMap` contribution.
 *
 * A prompt the orchestrator delivers carries this source, so a reader of the
 * session log can relate one user message back to the operation, run and
 * generation that produced it. This is the authoritative restart link: the
 * record is persisted with `user/message`, and a UI that does not recognize the
 * kind presents it as an opaque source without affecting execution.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/message-source
 */

import type { OperationId, RunId } from './brand.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-orchestrator': {
      readonly kind: 'session-orchestrator'
      /** Operation that created and delivered this message. */
      readonly operationId: OperationId
      /** Run the operation belongs to. */
      readonly runId: RunId
      /** Handoff generation the message belongs to. */
      readonly generation: number
      /** Attempt the operation belongs to. */
      readonly attempt: number
      /** Set when the message carries handed-off material from another session. */
      readonly form?: 'recall'
      /**
       * Set when the message is a pipeline intervention rather than the run's
       * own prompt: the identity of the `InterventionRecord` that sent it.
       * A reader can then tell the task's work apart from the host's request to
       * hand its remainder over.
       */
      readonly intervention?: string
    }
  }
}

/** One delivered orchestrator prompt, in the vocabulary the session log stores. */
export type SessionOrchestratorMessageSource =
  import('@deepseek-ai/dsh-llm').MessageSourceMap['session-orchestrator']
