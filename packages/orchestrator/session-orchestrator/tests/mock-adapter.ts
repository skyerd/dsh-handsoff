import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  SystemPromptUpdate,
  ToolUpdate,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Scripted plain-text response chunks. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Deterministic adapter: each model call consumes the next scripted response. */
export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  systemPromptUpdate?: SystemPromptUpdate
  toolUpdate?: ToolUpdate

  constructor(
    private readonly script: StreamChunk[][],
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly defaultMaxTokens?: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
      ...(this.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.defaultMaxTokens }),
      ...(this.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: this.systemPromptUpdate }),
      ...(this.toolUpdate === undefined ? {} : { toolUpdate: this.toolUpdate }),
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('MockAdapter: script exhausted')
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
