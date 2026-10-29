/**
 * Offline evidence for the pipeline gates and the decomposition parser.
 *
 * These tests touch no Session, no model and no store: they pin the three
 * decisions a host makes before it spends a token — when to hand over, when to
 * refine, when to stop a queue — and the exact text a produced answer must have
 * to become child tasks.
 *
 * @module tests/warden.spec
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DECOMPOSE_LIMITS,
  FIXED_DECOMPOSE_PROMPT,
  RuleWarden,
  interventionId,
  kindOfVerdict,
  parseDecomposition,
  type WardenPacket,
} from '../src/warden.ts'
import type { WardenThresholds } from '../src/warden.ts'

const thresholds: WardenThresholds = {
  contextCeiling: 0.6,
  idleMs: 20 * 60 * 1000,
  hitRateWarn: 0.9,
  hitRateAbort: 0.5,
  minRateSamples: 3,
}

/** Build one packet with every health field overridable. */
function packet(health: Partial<WardenPacket['health']>): WardenPacket {
  return {
    queue: { brief: '把需求拆成可执行的块', state: 'running' },
    task: { title: '实现登录', prompt: '实现登录表单', generation: 0 },
    health: {
      idleMs: 1000,
      elapsedMs: 60_000,
      turnOpen: true,
      ...health,
    },
    recent: [],
    children: [],
  }
}

describe('rule warden', () => {
  it('continues while every signal is healthy', () => {
    const decision = new RuleWarden(thresholds).review(packet({
      contextRatio: 0.42,
      cacheHitRate: 0.95,
      idleMs: 5_000,
    }))
    expect(decision.verdict).toBe('continue')
  })

  it('hands over at the context switch point', () => {
    const decision = new RuleWarden(thresholds).review(packet({ contextRatio: 0.6 }))
    expect(decision.verdict).toBe('decompose')
    expect(decision.reason).toContain('60%')
  })

  it('refines in place below the warn line without pausing', () => {
    const decision = new RuleWarden(thresholds).review(packet({ cacheHitRate: 0.72 }))
    expect(decision.verdict).toBe('refine')
  })

  it('aborts every queue below the abort line, even when context is fine', () => {
    const decision = new RuleWarden(thresholds).review(packet({ contextRatio: 0.1, cacheHitRate: 0.2 }))
    expect(decision.verdict).toBe('abort-all')
  })

  it('escalates silence to a stop request', () => {
    const decision = new RuleWarden(thresholds).review(packet({ idleMs: 21 * 60 * 1000 }))
    expect(decision.verdict).toBe('stop-and-notify')
  })

  it('ignores an unknown context window and an unmeasured hit rate', () => {
    const decision = new RuleWarden(thresholds).review(packet({}))
    expect(decision.verdict).toBe('continue')
  })

  it('never treats a cold start or a missing sample as a health failure', () => {
    const decision = new RuleWarden(thresholds).review(packet({
      contextRatio: 0.41,
      idleMs: 5_000,
    }))
    expect(decision.verdict).toBe('continue')
  })

  it('aborts every queue on the first valid reading below 50%, without another sample', () => {
    const decision = new RuleWarden(thresholds).review(packet({
      contextRatio: 0.2,
      cacheHitRate: 0.49,
    }))
    expect(decision.verdict).toBe('abort-all')
    expect(decision.reason).toContain('49%')
  })
})

describe('intervention identity', () => {
  it('is stable per run, generation and kind', () => {
    expect(interventionId('run-1', 2, 'pause-context'))
      .toBe(interventionId('run-1', 2, 'pause-context'))
    expect(interventionId('run-1', 2, 'pause-context'))
      .not.toBe(interventionId('run-1', 3, 'pause-context'))
  })

  it('maps every verdict to a durable kind except continue', () => {
    expect(kindOfVerdict('continue')).toBeUndefined()
    expect(kindOfVerdict('decompose')).toBe('pause-context')
    expect(kindOfVerdict('refine')).toBe('refine')
    expect(kindOfVerdict('stop-and-notify')).toBe('pause-idle')
    expect(kindOfVerdict('abort-all')).toBe('abort-all')
  })
})

describe('decomposition parser', () => {
  it('reads a numbered list into one child per item', () => {
    const tasks = parseDecomposition([
      '1. 实现登录接口：在 src/auth.ts 增加 login()，返回 token。',
      '2. 实现登录页面：新增 LoginForm，提交调用接口。',
      '3. 补测试：覆盖成功、密码错误两条路径。',
    ].join('\n'))
    expect(tasks).toHaveLength(3)
    expect(tasks[0]?.title).toBe('实现登录接口')
    expect(tasks[0]?.prompt).toContain('src/auth.ts')
    expect(tasks[2]?.title).toBe('补测试')
  })

  it('accepts bullets and CJK markers, and unwraps a fence', () => {
    const body = ['```markdown', '- 迁移表结构：新增 users 表', '、 回填数据：把旧表写入 users', '```'].join('\n')
    const tasks = parseDecomposition(body)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('迁移表结构')
  })

  it('falls back to one child when the answer has no list marker', () => {
    const tasks = parseDecomposition('剩下的工作是把登录页接上真实接口，并补一条端到端测试。')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.prompt).toContain('登录页')
  })

  it('returns nothing for a blank or too-short answer', () => {
    expect(parseDecomposition('   ')).toHaveLength(0)
    expect(parseDecomposition('好的')).toHaveLength(0)
  })

  it('caps the number of children and the prompt length', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index + 1}. 任务${index + 1}：${'x'.repeat(50)}`)
    const tasks = parseDecomposition(lines.join('\n'), { maxTasks: 4, maxPromptChars: 30, maxProducedChars: 8000 })
    expect(tasks).toHaveLength(4)
    expect(tasks[0]?.prompt.length).toBeLessThanOrEqual(30)
    expect(DEFAULT_DECOMPOSE_LIMITS.maxTasks).toBeGreaterThanOrEqual(4)
  })
})

describe('fixed instruction', () => {
  it('is the sentence the host sends, with a parseable output contract', () => {
    expect(FIXED_DECOMPOSE_PROMPT).toContain('请为我生成将剩余任务分块分步骤完成的提示词')
    expect(FIXED_DECOMPOSE_PROMPT).toContain('格式')
  })
})
