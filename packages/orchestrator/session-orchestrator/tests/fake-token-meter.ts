/** Controllable TokenMeter double for pressure boundaries and deduplication. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  PressureMeasurement,
  PressureMeasurementBaseline,
  PressureTokenMeter,
} from '../src/pressure.ts'

/** A fake whose reading and per-message estimator are changed by the test. */
export class FakeTokenMeter implements PressureTokenMeter {
  /** Sessions measured in order; repeated identical revisions must not append. */
  readonly measureCalls: Session[] = []
  /** Every message priced in order. */
  readonly estimateCalls: Message[] = []
  private totalTokens = 0
  private baselineKind: PressureMeasurementBaseline['kind'] = 'estimated'
  private estimator: (message: Message) => number = message => {
    const block = message.content[0]
    return block !== undefined && block.type === 'text' ? block.text.length : 1
  }

  /** Set the next measured total and baseline source. */
  setReading(totalTokens: number, kind: PressureMeasurementBaseline['kind'] = 'estimated'): void {
    this.totalTokens = totalTokens
    this.baselineKind = kind
  }

  /** Replace how one rendered message is priced. */
  setEstimator(estimator: (message: Message) => number): void {
    this.estimator = estimator
  }

  measure(session: Session): PressureMeasurement {
    this.measureCalls.push(session)
    return {
      logRevision: session.seq,
      baseline: { kind: this.baselineKind, tokens: this.totalTokens },
      totalTokens: this.totalTokens,
    }
  }

  estimateMessage(message: Message): number {
    this.estimateCalls.push(message)
    return this.estimator(message)
  }
}
