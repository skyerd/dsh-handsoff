/** Dependency layers and queue order for the selected queue. */

import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildTaskGraph } from './model.ts'
import { SelectField } from './Fields.tsx'
import type { OrchestrationTabProps } from './TaskTab.tsx'
import css from './GraphTab.module.css'

/**
 * Render queue order, dependency layers, edges, and structural problems.
 * @param props - snapshots and section callbacks.
 * @returns the dependency graph tab.
 */
export function GraphTab({ t, live, drafts, actions }: OrchestrationTabProps) {
  const busy = drafts.busy !== undefined
  const queue = drafts.selectedQueueId === undefined
    ? undefined
    : live.queues.find(candidate => candidate.id === drafts.selectedQueueId)
  if (queue === undefined) {
    return (
      <div className={css.tab}>
        <SelectField
          label={t('queueSection')}
          value=""
          options={[{ value: '', label: t('noQueue') }, ...live.queues.map(item => ({ value: item.id, label: item.title }))]}
          disabled={busy}
          onChange={(value) => { if (value !== '') void actions.selectQueue(value) }}
        />
        <p className={css.empty}>{t('noQueue')}</p>
      </div>
    )
  }
  const graph = buildTaskGraph(queue, live.tasks)
  const titles = new Map(graph.nodes.map(node => [node.id, node.title]))

  return (
    <div className={css.tab}>
      <header className={css.head}>
        <SelectField
          label={t('queueSection')}
          value={queue.id}
          options={live.queues.map(item => ({ value: item.id, label: item.title }))}
          disabled={busy}
          onChange={(value) => { if (value !== queue.id) void actions.selectQueue(value) }}
        />
        <Tag tone="neutral">{t('graphSelectedQueue', { id: queue.id })}</Tag>
      </header>
      <section className={css.block} aria-label={t('graphOrder')}>
        <h3 className={css.title}>{t('graphOrder')}</h3>
        <ol className={css.order}>
          {graph.order.map((id) => (
            <li key={id}>
              <span className={css.nodeTitle}>{titles.get(id) ?? id}</span>
              <code className={css.id}>{id}</code>
            </li>
          ))}
        </ol>
      </section>
      <section className={css.block} aria-label={t('graphLayers')}>
        <h3 className={css.title}>{t('graphLayers')}</h3>
        <div className={css.layers}>
          {graph.layers.map((layer, index) => (
            <div key={String(index)} className={css.layer}>
              <span className={css.layerLabel}>
                {layer.length > 0 && graph.nodes.some(node => node.layer < 0 && layer.includes(node.id))
                  ? t('graphUnresolved')
                  : t('graphLayer', { index: index + 1 })}
              </span>
              <div className={css.layerNodes}>
                {layer.map((id) => {
                  const node = graph.nodes.find(candidate => candidate.id === id)
                  if (node === undefined) return null
                  return (
                    <div key={id} className={css.node} data-task-id={id}>
                      <StateDot state={node.enabled ? 'done' : 'idle'} />
                      <span className={css.nodeTitle}>{node.title}</span>
                      <code className={css.id}>{node.id}</code>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className={css.block} aria-label={t('graphEdges')}>
        <h3 className={css.title}>{t('graphEdges')}</h3>
        {graph.edges.length === 0
          ? <p className={css.empty}>{t('graphNoEdges')}</p>
          : (
            <ul className={css.edges}>
              {graph.edges.map(edge => (
                <li key={`${edge.from}->${edge.to}`}>
                  {t('graphEdge', {
                    from: titles.get(edge.from) ?? edge.from,
                    to: titles.get(edge.to) ?? edge.to,
                  })}
                </li>
              ))}
            </ul>
          )}
      </section>
      {graph.issues.length > 0 && (
        <section className={css.block} aria-label={t('errorsTitle')}>
          <h3 className={css.title}>{t('errorsTitle')}</h3>
          <ul className={css.issues}>
            {graph.issues.map((issue, index) => (
              <li key={`${issue.kind}:${issue.taskId}:${String(index)}`}>
                {issue.kind === 'missing-dependency' && t('graphIssueMissing', {
                  task: issue.taskId, dependency: issue.dependencyId,
                })}
                {issue.kind === 'duplicate-dependency' && t('graphIssueDuplicate', {
                  task: issue.taskId, dependency: issue.dependencyId,
                })}
                {issue.kind === 'self-dependency' && t('graphIssueSelf', { task: issue.taskId })}
                {issue.kind === 'cycle' && t('graphIssueCycle', { task: issue.taskId })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
