/**
 * Pure template data: stage order, stable identities, the requirement embedded
 * in every prompt, and the artifact each stage leaves for the next one.
 */
import { describe, expect, it } from 'vitest'
import {
  PIPELINE_ARTIFACT_DIR,
  PIPELINE_STAGES,
  pipelineQueueTitle,
  pipelineStageModel,
  pipelineStagePrompt,
  pipelineTaskId,
  pipelineTaskIds,
} from '../src/pipeline.ts'

describe('pipeline template', () => {
  it('orders architecture, breakdown, implement and test', () => {
    expect(PIPELINE_STAGES.map(stage => stage.stage)).toEqual([
      'architecture',
      'breakdown',
      'implement',
      'test',
    ])
    expect(PIPELINE_STAGES.map(stage => stage.title)).toEqual([
      '架构设计',
      '任务分块',
      '分块实现',
      '测试验收',
    ])
  })

  it('derives four stable, distinct task identities from one queue id', () => {
    const ids = pipelineTaskIds('pipeline-1')
    expect(ids).toEqual([
      'pipeline-1-architecture',
      'pipeline-1-breakdown',
      'pipeline-1-implement',
      'pipeline-1-test',
    ])
    expect(new Set(ids).size).toBe(4)
    expect(pipelineTaskId('pipeline-1', 'implement')).toBe('pipeline-1-implement')
  })

  it('embeds the original requirement in every prompt and hands off through files', () => {
    const brief = 'Ship a multi-tenant upload flow without breaking existing jobs.'
    for (const stage of PIPELINE_STAGES) {
      const prompt = pipelineStagePrompt(stage.stage, brief)
      expect(prompt).toContain(brief)
      expect(prompt).toContain(`[阶段 ${PIPELINE_STAGES.indexOf(stage) + 1}/4`)
      expect(prompt).toContain(PIPELINE_ARTIFACT_DIR)
    }
    expect(pipelineStagePrompt('architecture', brief)).toContain('architecture.md')
    expect(pipelineStagePrompt('breakdown', brief)).toContain('tasks.md')
    expect(pipelineStagePrompt('implement', brief)).toContain('progress.md')
    expect(pipelineStagePrompt('test', brief)).toContain('acceptance.md')
  })

  it('derives a non-empty single-line title from the requirement', () => {
    expect(pipelineQueueTitle('First line\nsecond line')).toBe('流水线：First line')
    expect(pipelineQueueTitle('   ')).toBe('流水线：未命名需求')
    expect(pipelineQueueTitle('x'.repeat(80))).toHaveLength('流水线：'.length + 40)
  })

  it('inherits the host model unless the caller overrides it', () => {
    expect(pipelineStageModel(undefined)).toEqual({ kind: 'inherit' })
    expect(pipelineStageModel({ kind: 'fixed', provider: 'p', model: 'm' })).toEqual({
      kind: 'fixed',
      provider: 'p',
      model: 'm',
    })
  })
})
