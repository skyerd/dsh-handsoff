/**
 * The one-click pipeline template: an ordered architecture → breakdown →
 * implement → test chain.
 *
 * The template is pure data. It creates no queue, calls no model and starts no
 * run; the controller writes these records under the caller's revision, and the
 * user still has to press "Start pipeline". Every stage owns a complete prompt
 * built from the original requirement, so the created pipeline is executable
 * rather than four empty rows.
 *
 * @module @deepseek-ai/dsh-session-orchestrator/pipeline
 */

import { TaskId } from './brand.ts'
import type { HandoffPolicy, ModelPolicy } from './types.ts'

/** Fixed stage order of the one-click pipeline template. */
export const PIPELINE_STAGES = [
  {
    stage: 'architecture',
    title: '架构设计',
    summary: '读原始需求与工作区，产出架构方案和分块草案。',
  },
  {
    stage: 'breakdown',
    title: '任务分块',
    summary: '把架构方案拆成按顺序可独立实现与验收的分块清单。',
  },
  {
    stage: 'implement',
    title: '分块实现',
    summary: '按分块清单逐块实现、验证并记录进度。',
  },
  {
    stage: 'test',
    title: '测试验收',
    summary: '对照原始需求运行构建与测试，输出验收报告。',
  },
] as const

/** One fixed stage of the template. */
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

/** Stage identity carried by `TaskSpec.stage`. */
export type PipelineStageName = PipelineStage['stage']

/** Directory where each stage leaves the artifact the next stage reads. */
export const PIPELINE_ARTIFACT_DIR = 'docs/pipeline'

/** Hand-off policy shared by every template stage. */
export const PIPELINE_DEFAULT_HANDOFF: HandoffPolicy = {
  enabled: true,
  ratio: 0.6,
  mode: 'structured-brief',
  boundary: 'completed-turn',
  maxGenerations: 4,
  maxHandoffTokens: 8_000,
}

/**
 * Stable task identity of one template stage.
 *
 * Derived from the queue id so a retried create names the same four tasks and
 * can never append a second set after a lost response.
 * @param queueId - queue that will own the task.
 * @param stage - template stage.
 * @returns the task identity.
 */
export function pipelineTaskId(queueId: string, stage: PipelineStageName): TaskId {
  return TaskId(`${queueId}-${stage}`)
}

/**
 * Every template task identity in stage order.
 * @param queueId - queue that will own the tasks.
 * @returns four task identities, architecture first.
 */
export function pipelineTaskIds(queueId: string): readonly TaskId[] {
  return PIPELINE_STAGES.map(stage => pipelineTaskId(queueId, stage.stage))
}

/**
 * Default queue title for a requirement.
 *
 * The first line is used so a multi-line brief cannot produce a title with a
 * newline; the title is only a label and stays editable after creation.
 * @param brief - original requirement.
 * @returns a non-empty, single-line title.
 */
export function pipelineQueueTitle(brief: string): string {
  const line = brief.split(/\r?\n/u, 1)[0]?.trim() ?? ''
  const snippet = line === '' ? '未命名需求' : line.slice(0, 40)
  return `流水线：${snippet}`
}

/**
 * Complete prompt of one template stage.
 *
 * Each prompt carries the original requirement and points at the artifact the
 * previous stage wrote. A task starts a fresh Session with no chat history, so
 * the filesystem is the only durable channel between stages.
 * @param stage - template stage.
 * @param brief - original requirement, verbatim.
 * @returns the first user message of that stage's Session.
 */
export function pipelineStagePrompt(stage: PipelineStageName, brief: string): string {
  switch (stage) {
    case 'architecture':
      return [
        '[阶段 1/4 · 架构设计]',
        '',
        '原始需求：',
        '"""',
        brief,
        '"""',
        '',
        '目标：把上面的需求收敛成可执行的架构方案，并留下后续阶段能读取的文档。',
        '',
        '执行步骤：',
        '1. 先读工作区现状：目录结构、构建与测试命令、关键入口，以及与需求相关的既有代码。',
        '2. 给出架构设计：目标与范围、模块/目录划分、关键接口与数据流、外部依赖、失败与回滚策略。',
        '3. 把需求拆成可独立交付的分块草案（每块写清目标、涉及文件、验收标准、前置依赖），但本阶段不写业务实现。',
        `4. 把架构与分块草案写入 \`${PIPELINE_ARTIFACT_DIR}/architecture.md\`（目录不存在就创建）。`,
        '5. 在回答末尾用一句话总结：架构要点、分块数量、主要风险。',
        '',
        '约束：不修改业务代码，不改动与需求无关的文件；结论必须来自工作区证据。',
      ].join('\n')
    case 'breakdown':
      return [
        '[阶段 2/4 · 任务分块]',
        '',
        '原始需求：',
        '"""',
        brief,
        '"""',
        '',
        `先读取上一阶段的 \`${PIPELINE_ARTIFACT_DIR}/architecture.md\`，核对它是否完整覆盖原始需求。`,
        '',
        '目标：把架构方案拆成按顺序可独立实现、可独立验收的分块清单。',
        '',
        '执行步骤：',
        '1. 对照原始需求与架构文档，补齐遗漏或纠正偏差；不要重新设计整个系统。',
        '2. 每个分块给出：ID、标题、目标、涉及文件、实现要点、验收标准、验证命令、前置分块。',
        `3. 把完整清单写入 \`${PIPELINE_ARTIFACT_DIR}/tasks.md\`，顺序即实现阶段的执行顺序。`,
        '4. 单块必须能在一次会话内完成；预计过长的块继续细分，直到每块都有明确完成条件。',
        '5. 在回答末尾汇总：分块总数、执行顺序、需要人工确认的事项。',
        '',
        '约束：不写业务实现；不改动与需求无关的文件；验收标准必须可执行、可观察。',
      ].join('\n')
    case 'implement':
      return [
        '[阶段 3/4 · 分块实现]',
        '',
        '原始需求：',
        '"""',
        brief,
        '"""',
        '',
        `先读取 \`${PIPELINE_ARTIFACT_DIR}/architecture.md\` 与 \`${PIPELINE_ARTIFACT_DIR}/tasks.md\`，再读取 \`${PIPELINE_ARTIFACT_DIR}/progress.md\`（若存在）确认已完成分块。`,
        '',
        '目标：按清单顺序实现所有未完成分块，并用清单里的验证命令逐块验收。',
        '',
        '执行步骤：',
        '1. 选择一个未完成且前置分块已完成的块，先读相关代码再改。',
        '2. 遵循工作区现有风格与结构；只改与本块相关的文件。',
        '3. 运行该块的验收命令；失败就修复并重跑，不得跳过。',
        `4. 每完成一块，更新 \`${PIPELINE_ARTIFACT_DIR}/progress.md\`：块 ID、变更文件、验证命令与结果。`,
        '5. 全部完成后，在回答中列出：已完成块、验证命令与结果、未完成块与原因。',
        '',
        '约束：不修改与分块无关的文件；如果剩余工作过多或上下文接近切换点，先把进度写入 progress.md，系统会在切换点把剩余工作拆成子任务接管。',
      ].join('\n')
    case 'test':
      return [
        '[阶段 4/4 · 测试验收]',
        '',
        '原始需求：',
        '"""',
        brief,
        '"""',
        '',
        `先读取 \`${PIPELINE_ARTIFACT_DIR}/architecture.md\`、\`${PIPELINE_ARTIFACT_DIR}/tasks.md\` 与 \`${PIPELINE_ARTIFACT_DIR}/progress.md\`。`,
        '',
        '目标：独立验收需求，不默认相信实现阶段的自述。',
        '',
        '执行步骤：',
        '1. 依据原始需求与各块验收标准，补全或修正测试（按仓库现有能力选择单元/集成/端到端）。',
        '2. 运行仓库的完整构建与测试命令，记录实际输出摘要。',
        '3. 逐条对照原始需求与 tasks.md 的验收标准，给出证据：命令、结果、失败原因。',
        `4. 把验收报告写入 \`${PIPELINE_ARTIFACT_DIR}/acceptance.md\`：结论（通过/部分通过/不通过）、逐条证据、遗留问题与建议。`,
        '5. 可安全修复的失败先修复并重跑；不能修复的明确列为遗留问题。',
        '',
        '约束：不得把未执行或失败的测试写成通过；不得改动与验收无关的实现。',
      ].join('\n')
  }
}

/**
 * Model policy a template stage starts with.
 * @param model - caller override; absent means every stage inherits the host.
 * @returns the policy stored on each stage task.
 */
export function pipelineStageModel(model: ModelPolicy | undefined): ModelPolicy {
  return model ?? { kind: 'inherit' }
}
