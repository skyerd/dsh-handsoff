---
description: "DeepSeek Harness 的持久会话编排：任务队列、运行状态、operation 对账与交接记录，位于 ctx.sessionOrchestrator。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-orchestrator

[English](README.md) | 中文

## 摘要

使用此包为按计划运行大量 Agent 会话的宿主保存持久编排状态：队列、任务定义、运行记录、operation 对账与交接世系。记录位于 `session_orchestrator` 存储域，因此可跨重启保留，并在打开时按 zod schema 校验。此包不注册模型工具、不追加 Session 事件；其 scheduler、supervisor 与 handoff manager 都不调用模型。唯一的可选例外是模型监工：只有显式配置 provider 与 model 后才会巡检运行中的任务，默认的规则监工仍然零消耗。

## 目录

- [使用此包](#use-this-package)
- [部署与运维](#deployment-and-operations)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

此包是 Service Definition 加持久 store、纯 planner、通过注入 launcher 启动运行的 scheduler、消费一个真实 Agent Session 日志的单运行 supervisor、测量上下文压力并为交接正文定价的 pressure monitor、创建一个全新后继 Session 并投递一条召回消息的 handoff manager、恢复对账器，以及 `sessionOrchestrator` Remote controller。`LocalSessionOrchestrator` 为一个宿主组合调度组件；宿主在出现待处理压力决策后调用 `HandoffManager`。Remote controller 通过带 revision 的 DTO 读取与变更同一批记录，并发布整快照；它从不调用模型，也不追加 Session 事件。

### 公开类型

| 类型 | 作用 |
|---|---|
| `QueueId`、`TaskId`、`RunId`、`OperationId` | 持久记录的不透明 branded 标识 |
| `ModelPolicy`、`SkillsPolicy`、`PresetPolicy` | 由 supervisor 而非本包解析的任务级继承规则 |
| `HandoffPolicy` | 单个任务的结构化简报阈值与代数上限 |
| `TaskSpec` | 可编辑任务定义；每次编辑都携带 `revision` |
| `QueueRecord`、`GlobalSettings` | 队列顺序与宿主级编排设置 |
| `RunState`、`RunRecord` | 单次尝试的状态机及其 Session 世系 |
| `OperationRecord` | 以 `operationId` 为键的创建/提交对账单元 |
| `HandoffRecord` | 带切点、正文 hash 与配置快照的父子 Session 世系 |
| `SkipRecord` | 以 run 为键、绑定所观察 run revision 的审计式人工跳过 |
| `PlannerInput`、`PlannerOutput`、`PlannerReady`、`PlannerBlocked` | 纯 ready 集合计划：有序启动、带类型原因的 blocked 任务、active 与 skipped 任务 |
| `PlannerBlocker` | 任务未就绪的全部原因组成的封闭联合；`describeBlocker` 渲染其一 |
| `HumanSkip` | 经审计的人工跳过决策；只有 `isAuditedSkip` 条目可解锁依赖 |
| `SchedulerOptions`、`SchedulerStore`、`RunLauncher` | scheduler 的注入端口：记录、启动调用、时钟 |
| `SchedulerTickResult`、`SchedulerSkip`、`SchedulerSnapshot` | 单次 tick 启动与跳过内容，以及当前持有的锁 |
| `WorkspaceKeyResolver`、`WorkspaceKeyResolution` | 规范 `workspaceKey` 推导，或带类型的拒绝 |
| `RunSupervisor`、`RunSupervisorOptions`、`RunStartRequest` | 单运行观察/驱动单元及其注入端口 |
| `RunLaunchStart`、`RunResumeStart` | Session 创建或恢复 resume 时返回的 Handle 所有权 |
| `SupervisorLauncher`、`LaunchSupervisor` | scheduler 到 supervisor 的适配器；Session 存在后立即返回 |
| `LocalSessionOrchestrator`、`LocalSessionOrchestratorOptions` | 宿主本地 store/scheduler/supervisor/recovery 组合 |
| `RecoveryManager`、`RecoveryManagerOptions`、`RecoveryReport` | 对账门、决策与卸载报告 |
| `RunHandle`、`RunHandleTable`、`RunOwnership` | 内存中的自有 Handle 表；从不存入 Domain |
| `RunSettlement`、`RunSettlementState`、`RunSettlementReason`、`RunProbe` | 终态结果与静止状态探测 |
| `SessionDurability`、`SupervisorAgents`、`SupervisorLiveSessions`、`SupervisorStore` | 窄端口：flush 一个 Session、创建一个 Agent、查找 live Session、读写记录 |
| `PressureMonitor`、`PressureMonitorOptions`、`PressureObservation`、`PressureObservationResult` | 10.1–10.3 测量/决策单元：live Session、门禁事实、已渲染正文、持久快照 |
| `PressureTokenMeter`、`PressureMeasurement`、`PressureMeasurementBaseline` | 窄 TokenMeter 端口：`measure(session)` 与 `estimateMessage(message)` |
| `PressureStore` | 窄 store 端口：task/run/settings 读取与一次 revision-CAS run 写入 |
| `PressureHandoffBodies`、`PressureBudget`、`PressureModeBudget`、`PressureBodyFallback` | 独立定价的 structured-brief 与 last-complete-turn 正文，含带类型的逐字降级 |
| `PressureRoute`、`pressureRouteFingerprint` | 使旧 ratio、容量、reserve 与待处理决策失效的路由标识 |
| `HandoffManager`、`HandoffManagerOptions`、`HandoffExecutionRequest` | 安全 Turn 事务：claim、freeze、create、submit、flush 与 commit |
| `HandoffStore`、`HandoffAgents`、`HandoffDurability`、`HandoffRuntimeModel` | 窄 handoff 端口：CAS 记录、新建 Session `create`、flush、最后兜底路由 |
| `HandoffResult`、`HandoffStatus`、`HandoffBlockReason`、`HandoffFailureReason` | 带类型结果与明确的 blocked/needs-attention 原因 |
| `HandoffConfigInheritance`、`HandoffPresetInheritance`、`HandoffConfigDegradation` | 冻结路由/preset，以及诚实的权限/skills 与降级标记 |
| `HandoffSessionFacts`、`HandoffCompleteTurn`、`HandoffToolFact`、`HandoffToolStatus` | 完整 Turn 边界投影，工具只允许 `settled`、`running-known` 或 `unknown` |
| `StructuredBriefInput`、`LastCompleteTurnBodyInput` | 确定性正文渲染器；二者都不调用模型 |
| `SessionOrchestratorController`、`SessionOrchestratorControllerInternals` | `sessionOrchestrator` 命名空间的 Host Remote owner 及其测试接缝 |
| `QueueDto`、`TaskDto`、`RunDto`、`HandoffDto`、`SettingsDto` | 脱敏的线上投影；不含 Handle、Context、lease、宿主标识或交接正文 |
| `InterventionDto`、`WardenAuditDto` | 审计式流水线决策与巡检；每条都写明判决者，模型巡检还写明付费路由 |
| `RuleWarden`、`Warden`、`WardenPacket`、`WardenDecision` | 纯规则判决器、其有界状态包，以及两类判决器共用的判决词汇 |
| `ModelWarden`、`ModelReviewer`、`WardenReview`、`WardenReviewError` | 可选模型巡检：每次一次严格 JSON 调用，带状态包、输出与截止时间上限 |
| `WARDEN_REVIEW_SCHEMA`、`WARDEN_REVIEW_SYSTEM_PROMPT`、`wardenReviewSchema` | 严格的巡检合约，分别以文本与 zod 校验固定 |
| `QueueDraft`、`TaskDraft`、`SettingsDraft` | 可编辑草稿值；标识、revision 与宿主 claim 字段归 controller 所有 |
| `OrchestratorAccess`、`OrchestratorAccessRequest`、`OrchestratorAction`、`OrchestratorRole`、`OrchestratorResource` | 按集合与按记录求值的 owner/observer/none 策略 |
| `OrchestratorRunControl` | 匹配 `RunSupervisor.cancel(runId)` 的可选 live 取消接缝；缺席时只取消状态 |
| `OrchestratorSnapshotFrame`、`SessionOrchestratorRemoteErrorCode` | 整快照变更流与稳定失败词汇 |

### 监工模式与成本

runtime 每个 tick 巡检每个运行中的任务。`wardenMode` 选择判决者，默认 `rule`：`RuleWarden` 只读状态包做判决，不调用模型、不写巡检记录，因此默认部署在巡检上恰好零额外 Token。

`wardenMode: model` 需要同时配置 `wardenProvider` 与 `wardenModel`；缺任一项或宿主未挂载 `llm` 服务时，runtime 在加载期直接失败。一次巡检就是一次无状态请求：有界状态包（队列需求首段、任务提示词首段、带配置阈值的健康信号、最多五条最近事件、最多八个子任务状态）、固定系统提示词，以及由 `wardenReviewSchema` 校验的严格 JSON 回答（未知字段被拒绝）。请求受 `wardenMaxPacketBytes`（UTF-8 字节）、`wardenMaxOutputTokens` 与 `wardenTimeoutMs` 约束。

成本受三重约束：`wardenCooldownMs` 是同一 run 两次巡检的最小间隔；`wardenMaxReviewsPerRun` 限制一个代数可消耗的巡检次数，额度用尽只记录一次 `budget-exhausted`；巡检以脱离方式运行，慢调用绝不阻塞派发与健康采样。

本地规则始终是底线。规则判决为 `decompose`（上下文切换点）或 `abort-all`（缓存命中中断线）时立即执行、不做巡检，且不会被模型判决降级（`protectHardGate`）。其余采样要么启动一次巡检，要么在巡检未到期时回退规则。

超时、输出不合规、Provider 拒绝或状态包超过预算的巡检会回退本地规则判决，并记录一条写明稳定码的 `rule-fallback`。成功的巡检记录一条 `model`，含 provider、model、耗时与上报的输入/输出 Token。巡检台账按 run 保留（`wardenAuditLimit`，默认 20 条）并进入快照，设置页因此能把每次巡检归到付费路由。

拆解刻意不是第二次模型调用：固定指令进入运行中的对话、回答本地解析，因此这一 Turn 由任务自己的对话路由付费。干预记录同时携带 `warden`（谁判决）与 `paidBy`（谁的对话为指令付费），设置页两者都展示。

### 规划与调度

`planReadyTasks` 是纯函数：它读取 tasks、queues、runs 与 skips 的快照，返回稳定的 ready 顺序、带类型原因的 blocked 列表、当前 active 任务以及已应用的 skips。它不执行 IO，也不读取时钟。排序为优先级降序、队列顺序、队列标识、任务标识。`LocalSessionOrchestrator` 默认提供 store 的 skip ledger，并只保留 run 为该任务最新 attempt 的 skip，因此新 attempt 绝不会被旧审计记录挡住；显式 `humanSkips` 选项会覆盖该读取器。

`Scheduler.tick()` 先规划，然后对每个 ready 条目检查卸载门、解析规范 `workspaceKey`、检查容量并派发。派发在调用 launcher 前用 revision CAS 将 run 置为 `starting`，因此第二次 tick 绝不会重复派发同一 run。锁在 `finally` 中释放，可重试的启动失败回滚到 `ready`，否则记录 `needs-attention`。

### Workspace key 与锁

`workspaceKey` 是 DSH workspace 标识与规范化 cwd 的连接：折叠点段、去掉尾分隔符、在 Windows 上折叠大小写。两个拼写不同但解析到同一目录的任务因此共享一把锁。相对 cwd 会被拒绝，而不是在其上加锁；任务绝不会声称只读来绕过串行化。

### 监督与完成判定

`RunSupervisor.start()` 驱动一个已经处于 `starting` 的 run。它通过注入的 `SupervisorAgents` 端口创建 Agent，持久记录 `session-created` 与已提交消息标识，然后把编排器 `MessageSource` 附加到唯一一条 follow-up prompt 上。`RunSupervisor.launch()` 执行同样的创建，但在 Session 存在后立即返回，使 `Scheduler` 能在 agent 继续运行时提交 `starting → running`；创建后、提交前的失败会结算为 `needs-attention: restart-uncertain`，绝不会把该 attempt 退回 `ready`。`SupervisorLauncher` 是薄 `RunLauncher` 适配器。完成判定绝不依赖一次 idle 回调：

1. 等待 `whenIdle()`；
2. 从 `runMaintenance()` 探测打开 Turn、run 自有的排队输入、人工输入与打开的审批；
3. 只接受本 operation 消息源认领 Turn 的 `turn/end` 事件；
4. 在不再有打开 Turn 或 run 自有输入时重新收敛；
5. 记录 `claimed`，等待 `SessionDurability.flush(session)`，然后以 revision CAS 提交 `succeeded`。

人工输入产生 `needs-attention: external-input`，打开的审批产生 `awaiting-approval`，flush 失败产生 `flush-failed`，持久状态为 `submitted`/`claimed`/`uncertain` 的 operation 产生 `restart-uncertain` 且不重放。Turn 失败映射到 `failed`（`turn-error`、`turn-aborted`、`turn-blocked` 等）。`acceptedTurnEndSeq` 是最后一个被接受的持久 `turn/end` 序号；重复事件会被计数，绝不重复接受。

Handle 只存在于 `RunHandleTable`，以 run id 为键并由本进程拥有。Domain 不存 Handle。成功、失败与取消的 run 在 flush/commit 边界后 dispose；`needs-attention` run 保留 live Handle 直到 `close()`，以免丢弃待处理人工输入或审批。Disposal 只触碰已 take（owned）的条目，因此被观察的 run 绝不会被拆除。`close()` 停止新启动，等待在途结算，然后 dispose 剩余 Handle。

### 压力测量与决策

`PressureMonitor.observe()` 读取 run 的持久 `HandoffPolicy`，通过注入的 TokenMeter 测量 live Session，并从 `Session.requestContext()` 取得最新 `contextWindow`。它按 run revision CAS 写入一份 `pressure` 快照并返回决策，不创建子 Session，也不追加任何 Session 事件。

10.2 门禁按序执行：交接已启用、代数上限、paused/cancelled/handing-off、推进代数但没有已接受 Turn、外部输入、打开的 Turn、已知正容量、ratio 达到或超过任务阈值、正文定价在 `maxHandoffTokens` 内、estimated 模式策略。默认 authored 阈值为 `0.88`；monitor 读取持久 ratio，而不是替换它。路由或容量变化会产生新 fingerprint，因此旧 ratio、reserve 与待处理决策被丢弃，Session 会重新测量。

正文独立定价。`structured-brief` 在 `estimateMessage()` 渲染简报的结果上加上自己的固定安全余量。`last-complete-turn` 精确测量投影消息并使用自己的 reserve（默认零）；当总量超过 `maxHandoffTokens` 时，结果选择 structured brief，并在带类型 fallback 中记录 `max-handoff-tokens`，而不是截断工具配对。两种模式绝不借用对方的 reserve。

重复观察在同一 Session 日志 revision 上复用一次测量。同路由上的待处理决策绝不会写入两次，包括后续流式事件之后，因此一次压力事件只产生一个触发。压缩后的更低读数会用 `below-threshold` 替换待处理快照。

### 安全 Turn 交接

`HandoffManager.handoff()` 仅在 run 为 `running` 且存在待处理压力决策（或已为 `handoff-pending`）时执行。它校验持久策略，读取父 Session 以确认最近 Turn 正常闭合、没有打开 Turn、其 `turn/end` 后没有中断尾部，解析持久路由，并以 revision CAS 将 run 认领为 `handing-off`，同时把确定性的后继 Session id 追加到 `sessionLineage`。随后由 operation 阶段负责重启安全：

1. 等待可选的父静止，flush 父 Session 并冻结 `sourceSeq`；
2. 渲染 structured brief 或精确 last-complete-Turn 投影，并用共享 pressure budget 为二者定价；
3. 规划一个确定性 handoff operation，用 `agents.create` 创建后继，并记录 `session-created` 与 `targetSessionId`；
4. 创建一条带 operation source 的召回 `UserMessage`，记录 `submitted`，恰好调用一次 `followup` 并 flush 子 Session；
5. 持久化 `HandoffRecord`（父子、source seq、body hash、mode、配置快照），并以子 Session 作为 `activeSessionId` 将 run CAS 到 `running`。

父 Session 绝不 resume，新 Session 只接收任务元数据（`cwd`、`parentSession`、可选 `agentPreset`）——不复制 seed、权限或 skills。缺失持久路由进入 `needs-attention: model-unavailable`；父或子 flush 失败进入 `flush-failed`；子 Session 已存在后的失败进入 `handoff-uncertain` 并保留 target，因此后续调用绝不可能创建第二个子 Session或首条消息。operation 阶段——而非时间戳或列表索引——是重复守卫。

结构化简报遵循文档中的固定模板。日志未记录的事实保持 `unknown`；未结算的工具调用绝不会报告为 settled，缺失结果也绝不会解释为“工具从未启动”。`last-complete-turn` 使用官方事件投影的表面顺序，并保留每一组 user/assistant/tool 配对；当超过 `maxHandoffTokens` 时，manager 投递 structured brief 并记录 pressure fallback。被压缩或不完整的投影也会降级，而不是删除工具结果。

### Remote controller

`SessionOrchestratorController` 扩展 `TypertRemoteService`，把 Cordis 键 `sessionOrchestratorController` 绑定到 `sessionOrchestrator` Remote 命名空间。它注入 `sessionOrchestrator` 与 `typert`；可选 Web Session owner 通过 `ctx.get('sessionController')` 读取，并且只向 Session 引用添加 `linkable`，因此编排命名空间在没有 Web profile 时也能工作。

方法包括 `listQueues`、`getQueue`、`createQueue`、`updateQueue`、`deleteDraftQueue`、`upsertTask`、`reorderTasks`、`setTaskEnabled`、`skipTask`、`listRuns`、`getRun`、`pause`、`resume`、`cancel`、`retry`、`listHandoffs`、`getHandoff`、`getSettings`、`updateSettings` 以及 `changed` 快照流。每次 mutation 都携带 `expectedRevision`：create 要求 `0`，update 比较所观察记录 revision，`skipTask` 比较它审计的 run revision，`retry` 在创建 scheduler 的确定性 `run-<task>-<attempt>` 后继前比较已结算 attempt。`pause` 与 `resume` 更新宿主级 scheduler 暂停；它们不冻结 live Agent。

访问策略接收 action、resource kind、可选记录 id 以及调用 Connection 的 `peerId`，并回答 `owner`、`observer` 或 `none`。集合级 `none` 拒绝 list；记录级 `none` 将其从列表与快照过滤，并在 `get*` 中读作 `not-found`；只有 owner 可 mutation。默认策略向每个已准入调用者授予 owner，因为 Connection 已完成传输准入。具有不同 principal 的宿主在直接构造 controller 时通过 `SessionOrchestratorControllerInternals` 传入自己的策略；loader 创建的 controller 使用 owner 默认值。

每种失败都使用 `sessionOrchestrator/` 下的一个稳定码：`forbidden`、`not-found`、`revision-conflict`、`conflict`、`invalid-transition`、`invalid-request`、`queue-not-empty`、`unavailable` 或 `cancelled`。请求在线上边界用 store 相同的 zod schema 校验，取消的 carrier signal 在任何持久写入前被观察。`cancel` 通过 revision CAS 提交持久取消，然后才调用可选 `OrchestratorRunControl`；它拒绝 `handing-off`，以免交接事务被孤立，因此过期调用者绝不会停掉另一个调用者已结算的 run。

所有结果都是显式 DTO。`getQueue` 返回 task prompt，因为那是编辑器输入；快照只携带 task summary。run 暴露 id、state、lineage、operation phase、冻结 route/preset、pressure facts、稳定错误码与 retryability，但绝不暴露 lease、submitted message identity、request hash 或诊断消息。Settings 省略 `hostInstanceId`，handoff 携带父子 id、cut point、mode、body hash 与 token count，但绝不包含已渲染正文。干预记录暴露 `warden` 判决与 `paidBy` 对话路由，快照携带受保留上限约束的 `wardenAudits` 台账，因此审阅者能把每个决策与每次巡检归到付费账户。

`changed` 先立即产出一份整快照，然后每个合并持久变更产出一份快照。每帧携带单调宿主 generation；重连 client 从最新 generation 开始，并丢弃它保留的更旧 baseline。流在 carrier signal abort 时结束，并在 `finally` 中移除 `domain/changed` 订阅。

### 宿主会话适配器

`HostSessionAdapter` 是一套统一的能力契约：`listWorkspaces`、`createSession`、`sendPrompt`、`openSession`、`subscribeEvents`、`getUsage` 与 `selectModel`。每个方法返回一个值或一个明确失败；被禁用的能力会说明宿主缺少哪一层界面，并返回 `unsupported` 且不产生副作用。`HostSessionRegistry` 保留一个主执行宿主，并把所有已知宿主报告给设置页。

| 适配器 | 真实能力 | 禁用能力 |
|---|---|---|
| `DshHostSessionAdapter` | 全部七项，依赖 Workspace 注册表、`ctx.agents`、Session 事件、实时 Session、token meter 与 `/session/<id>` | 上述服务挂载时没有禁用项；缺少某个可选服务只会禁用对应行 |
| `WorkBuddyHostSessionAdapter` | 通过已安装的 `codebuddy --print` CLI 创建、发送、订阅、读取用量并选择模型（`--session-id`、`--resume`、`--output-format stream-json`、`--model`） | 列出 Workspace（CLI 没有列表；桌面 REST 列表需要宿主签发的密码）与打开 GUI 对话（CLI 只恢复终端） |
| `TraeHostSessionAdapter` | 无 | 全部对话能力：Trae 只暴露 IDE 启动器与私有 `ai-agent` socket，没有公开的对话/工作区/提示词协议 |

队列的执行路径仍只有一条：`SessionOrchestratorRuntime` 会预检 DSH 适配器，create/send/subscribe 三项不可用就在加载期失败。WorkBuddy 与 Trae 适配器只是经过验证的能力报告；它们不会新增第二套调度器、恢复管理器、健康门或模板构建器。当逐用户发现逻辑看不到非默认安装位置时，`hostWorkBuddyCli` 与 `hostTraeCli` 运行配置字段可显式指定路径。

### 宿主组合与恢复

`LocalSessionOrchestrator` 接收 store、一个 `RunSupervisor`、`ctx.sessionPersistence`、`ctx.sessions` 与稳定 `hostInstanceId`，然后在同一批接缝上构造 `SupervisorLauncher`、`Scheduler` 与 `RecoveryManager`。它不新增 context key，也不注册 Cordis effect。`tick()` 委托给对账器，并在 `reconcile()` 打开门前返回 `ran: false`。`close()` 使用恢复卸载顺序：pause CAS、scheduler close、supervisor close、storage-domain close。

### Storage domain

`session_orchestrator` 版本 `1`，表为 `queues`、`tasks`、`runs`、`operations`、`handoffs`、`skips`、`interventions`、`warden_audits` 与一个 `global` 单例。权威数据使用拒绝式默认：存储记录未通过其 schema 会以 `invalid-record` 拒绝整个打开，并指名表与键。Domain 绝不启用 backup-and-skip。

### 写入、revision 与关闭

每次 mutation 都在 store 的单 FIFO 链上运行，因此两个并发调用者无法跨表交错 read-modify-write。每个迁移比较调用者的 `revision`，并在写入前以 `revision-conflict` 拒绝过期值。`close()` 立即拒绝新写入，排空已排队写入，然后释放 domain；重复调用共享同一次 teardown。

### Operation 标识

`OperationRecord` 以 `operationId` 标识。相同 `operationId` 与相同 `requestHash` 的记录是已识别重复，返回现有记录；相同 `operationId` 但 `requestHash` 不同会以 `operation-hash-conflict` 拒绝。标识绝不来自 `Date.now()` 或列表索引。

-----

<a id="deployment-and-operations"></a>
## 部署与运维

### 安装与 profile 组合

此包是私有 workspace 包；请从本仓库以 `workspace:*` 安装，而不是从独立 registry release 安装。其 Node 面导出 `SessionOrchestrator` store service（Loader 行名 `@deepseek-ai/dsh-session-orchestrator`，`inject: ['storageDomain']`）以及构造器 `SessionOrchestratorController`、`LocalSessionOrchestrator`、`RunSupervisor` 与 `HandoffManager`。

组合 profile 必须提供 storage domain backend（例如 JSON backend）与 controller 使用的 Typert registry。此包随附两个 Host 行：`@deepseek-ai/dsh-session-orchestrator` 挂载 store，`@deepseek-ai/dsh-session-orchestrator/host` 以默认 owner 访问策略挂载 `SessionOrchestratorController`。`web-app` bundle 同时挂载两行，浏览器侧装配生成的 `sessionOrchestrator` Remote 命名空间，因此 Web 设置页读取同一批持久记录。

live 执行仍需宿主接线：Agent factory、持久 Session persistence、live Session directory 与 TokenMeter 由 profile 自有插件传给 `RunSupervisor`、`HandoffManager` 与 `LocalSessionOrchestrator`，并使用该宿主的 `OrchestratorAccess` 与可选 `OrchestratorRunControl`。controller 行不启动 scheduler、不创建 Agent、不调用模型。可选 `runtime` 行（`@deepseek-ai/dsh-session-orchestrator/runtime`）就是那个驱动：它 tick scheduler、采样健康度并执行干预；除非 `wardenMode: model` 同时指定 provider 与 model，它绝不触碰 LLM 服务。Web 设置页是独立的 `@deepseek-ai/dsh-client-ui-settings-session-orchestrator` 行；`web-app` bundle 在 `ctx.get('sessionOrchestratorController')` 缺席时禁用该行。

live profile 提供的 service 端口是：

- `storageDomain` —— 权威记录，store 所需；
- `typert` —— Remote 命名空间注册，controller 所需；
- `agents` —— Agent 创建与恢复 resume，传给 supervisor 与 handoff manager；
- `sessionPersistence` 与 `sessions` —— 监督与恢复所需的 flush 与 live-session 查找；
- 一个 TokenMeter 与每个 live Session —— 压力测量，由宿主传入；
- `llm` —— 仅在 `wardenMode: model` 时通过 `ctx.get('llm')` 读取；服务缺席会在加载期拒绝该插件。

### 数据迁移

`session_orchestrator` 是 domain 版本 `1`。表为 `queues`、`tasks`、`runs`、`operations`、`handoffs`、`skips`、`interventions`、`warden_audits` 与 `global` 单例。`skips`、`interventions` 与 `warden_audits` 都在版本 1 内加入，因为它们只引入新表而没改变既有记录 schema；不含某表的版本 1 medium 打开时该表为空。之后任何记录 schema 变化都需要新 domain 版本与手写迁移。Domain 使用拒绝式默认：不支持的版本在打开时以 `version-mismatch` 失败，损坏记录以 `invalid-record` 失败，而不是被跳过。此包绝不以覆盖、移动或删除已提交代际的方式回填，也不支持降级。

### 恢复限制

启动对账先认领宿主 lease，检查 active run 及其持久 operation source，然后才在通过后打开 scheduler。当 operation source 无法与 run、generation 和 attempt 绑定，prompt 绝不重放。恢复目标是“不盲目重复并让边界可审计”，而不是跨 domain 与 Session 日志的 exactly-once。`session-created` 前的崩溃会让 run 停在 `handing-off`；没有 Remote mutation 创建子 Session，`uncertain` 状态变为 `needs-attention` 而不是重放。`needs-attention` 没有进程内 resume API；`retry` 创建全新 attempt。成功 resume 恢复监督与结算，但不推进过期 operation phase。压力决策后的 handoff 与所有自动重试都是宿主接线，不属于此包。卸载顺序是 pause CAS、scheduler close、supervisor close，然后 domain close。

### 并行安全

Scheduler 启动规范 `workspaceKey` 不同的任务，并串行化共享同一 key 的每个任务；没有只读绕过。`concurrencyGroup`、provider 配额与全局上限是额外的独立限制。锁与槽位在 `finally` 释放，失败的启动回滚或记录 `needs-attention`，关闭 scheduler 后不再启动新工作，同时等待在途启动结算。规范化是词法的：折叠 `.`/`..` 段与尾分隔符、Windows 上折叠大小写、拒绝相对 cwd；不解析符号链接别名。共享外部数据库、服务或上游目录的任务即使 workspace key 不同，也需要相同 `concurrencyGroup`。设计面向单 Host 进程；持久 lease 拒绝第二个写者，但没有分布式锁或跨机器调度。

### 测试证据

`tests/zero-llm.spec.ts` 是静态与运行时门禁。它扫描 Host 与 Client 源码中的禁止 import 与服务名，并要求 `llm` 服务只被 `src/model-warden.ts` 一个模块命名；然后针对已安装的 spy `llm`、`tools`、`agents`、`compaction` 与 `sessionTitle` service 驱动 store、scheduler、恢复对账器、pressure monitor、handoff manager、supervisor 与 Remote controller，并要求每个 journal 保持为空；默认规则模式下的一次运行健康巡检同样保持 LLM journal 为空且不写巡检记录。`tests/model-warden.spec.ts` 证明巡检合约（严格 JSON、围栏、拒绝、Provider 失败、截止时间、状态包上限）、runtime 台账（路由与 Token、冷却、预算、不阻塞 tick、回退记录、硬门优先）以及回退后的实际动作。`tests/integration.spec.ts` 还证明任务 Agent 的一次正常 `prepareCall` 存在，同时没有原始 `ctx.llm.stream` 调用，也没有辅助 `purpose`。锁定快照的准确命令与真实结果记录在工作区根目录的 Block 9 实施记录中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

- **记录是权威，不是缓存。** Domain 以拒绝式 schema 策略打开，因此损坏或不支持的记录会停止宿主，而不是静默丢弃编排状态。
- **每个 store 一条 FIFO 链。** Domain 串行化单记录写入；store 自己的链把该保证扩展到创建 run 与其首个 operation 等多记录迁移。
- **Store 处 revision CAS，Domain 处原子 RMW。** 迁移读取当前记录、比较 `revision`，然后通过 `table.update()` 写入，其 transform 在其链槽运行——比较与写入无法交错。
- **提交点之后发事件。** 每次持久写入都发出 `domain/changed`；失败的 listener 会被容纳，而不是拒绝已持久写入。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：导出 service、domain、planner、scheduler、Remote controller 与 id |
| [`src/brand.ts`](src/brand.ts) | Branded 标识及其构造器 |
| [`src/schema.ts`](src/schema.ts) | Zod schema；每个存储记录类型由它们推断 |
| [`src/types.ts`](src/types.ts) | schema 推断记录与策略类型的 type-only 再导出 |
| [`src/storage.ts`](src/storage.ts) | `session_orchestrator` domain 声明及其初始 global |
| [`src/store.ts`](src/store.ts) | `SessionOrchestrator` service：FIFO 链、revision CAS、close |
| [`src/planner.ts`](src/planner.ts) | 纯 ready 集合 planner：DAG 顺序、blockers、skips |
| [`src/task-order.ts`](src/task-order.ts) | 纯有序列表推导与旧数据依赖审计 |
| [`src/workspace-key.ts`](src/workspace-key.ts) | 规范 `workspaceKey` 推导及其拒绝 |
| [`src/scheduler.ts`](src/scheduler.ts) | `Scheduler`：容量检查、锁获取、派发、回滚 |
| [`src/launcher.ts`](src/launcher.ts) | `SupervisorLauncher`：由 supervisor 支撑的 scheduler 启动端口 |
| [`src/local.ts`](src/local.ts) | `LocalSessionOrchestrator`：宿主组合与 recovery-gated tick/unload |
| [`src/supervisor.ts`](src/supervisor.ts) | `RunSupervisor`：create/launch/follow-up、事件归属、收敛、flush、结算、dispose |
| [`src/pressure.ts`](src/pressure.ts) | `PressureMonitor`：TokenMeter 测量、10.2 门禁、路由失效、独立正文定价与 CAS 快照 |
| [`src/handoff.ts`](src/handoff.ts) | `HandoffManager`：claim/freeze/create/submit/flush/commit、确定性简报、Turn 投影与配置继承 |
| [`src/remote.ts`](src/remote.ts) | `SessionOrchestratorController`：命名空间、访问过滤、revision 绑定 mutation、脱敏 DTO 与快照流 |
| [`src/warden.ts`](src/warden.ts) | `RuleWarden`：零 Token 门禁、有界状态包词汇、硬门地板与拆解解析器 |
| [`src/model-warden.ts`](src/model-warden.ts) | `ModelWarden`：可选严格 JSON 巡检、状态包/输出/截止时间上限及稳定失败码 |
| [`src/runtime.ts`](src/runtime.ts) | 宿主驱动：tick、健康采样、巡检冷却与预算、干预事务与巡检台账 |
| [`src/recovery.ts`](src/recovery.ts) | `RecoveryManager`：启动对账、lease 门、决策、resume 与卸载 |
| [`src/errors.ts`](src/errors.ts) | `OrchestratorError` 及其稳定码 |
| [`src/message-source.ts`](src/message-source.ts) | `'session-orchestrator'` `MessageSourceMap` 贡献 |
| [`src/host-session.ts`](src/host-session.ts) | 统一 `HostSessionAdapter` 能力契约、结果与路由辅助 |
| [`src/host-dsh.ts`](src/host-dsh.ts) | 基于 Workspace、Agent、Session、meter 与路由接缝的真实 DSH 适配器 |
| [`src/host-workbuddy.ts`](src/host-workbuddy.ts) | 无头 WorkBuddy CLI 适配器与 NDJSON 事件映射 |
| [`src/host-trae.ts`](src/host-trae.ts) | 显式禁用的 Trae 能力报告 |
| [`src/host-registry.ts`](src/host-registry.ts) | 主宿主选择、能力报告与可运行预检 |
| [`tests/host-session.spec.ts`](tests/host-session.spec.ts) | 真实 DSH/WorkBuddy 行为、显式 Trae 拒绝与注册表预检 |
| [`tests/harness.ts`](tests/harness.ts) | 每个 spec 复用的内存 domain fixture |
| [`tests/fake-launcher.ts`](tests/fake-launcher.ts) | 带手动 accept/reject 日志的确定性 `RunLauncher` |
| [`tests/store.spec.ts`](tests/store.spec.ts) | schema、CAS、FIFO、operation 标识、重启与关闭用例 |
| [`tests/planner.spec.ts`](tests/planner.spec.ts) | DAG、菱形、失败、skip 审计与优先级稳定用例 |
| [`tests/task-order.spec.ts`](tests/task-order.spec.ts) | 串行链、并行组与旧数据悬空/重复/自依赖/循环用例 |
| [`tests/workspace-key.spec.ts`](tests/workspace-key.spec.ts) | 路径规范化、等价与拒绝用例 |
| [`tests/scheduler.spec.ts`](tests/scheduler.spec.ts) | 槽位、锁、组、配额、pause、卸载、回滚与重复用例 |
| [`tests/fake-agent.ts`](tests/fake-agent.ts) | 确定性 Agent、factory、durability 端口与 Session 事件构造器 |
| [`tests/supervisor.spec.ts`](tests/supervisor.spec.ts) | 归属、单 idle 拒绝、再收敛、失败边界、flush/dispose、重启与 scheduler-launch 用例 |
| [`tests/local.spec.ts`](tests/local.spec.ts) | 启动适配器、recovery-gated tick、单 Session 派发与卸载顺序 |
| [`tests/pressure.spec.ts`](tests/pressure.spec.ts) | 阈值边界、estimated/usage、模型切换、压缩下降、未知容量、流式去重、代数/pause 与正文预算 |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | 单子并发、打开 Turn、中断尾部、配对、长 Turn 降级、模型/flush 失败、创建后崩溃、代数上限与 preset 降级 |
| [`tests/remote.spec.ts`](tests/remote.spec.ts) | 命名空间标记、owner/observer/none 访问、记录过滤、revision 冲突、cancel/retry 竞态、无效输入、脱敏扫描、重连快照与可选 Session 链接 |
| [`tests/fake-token-meter.ts`](tests/fake-token-meter.ts) | 可控 TokenMeter：固定读数、baseline kind 与逐消息估算器 |
| [`tests/recovery.spec.ts`](tests/recovery.spec.ts) | lease、对账决策、resume、容纳与卸载矩阵 |
| [`tests/integration.spec.ts`](tests/integration.spec.ts) | 一个真实 agent-loop + MockAdapter 运行驱动到已提交成功，并带正常调用 spy |
| [`tests/zero-llm.spec.ts`](tests/zero-llm.spec.ts) | 静态禁止 import 扫描，以及 LLM、tools、agents、compaction 与标题的运行时 spy journal |
| [`tests/model-warden.spec.ts`](tests/model-warden.spec.ts) | 严格巡检合约、巡检台账、冷却与预算、不阻塞 tick 与规则回退 |
| [`tests/mock-adapter.ts`](tests/mock-adapter.ts) | 集成用例的脚本化本地 LLM 适配器 |

### 测试命令

```sh
# Type-check this package against the workspace-installed 0.2.0-rc.2 declarations
node node_modules/typescript/bin/tsc -p verify/tsconfig.orchestrator.json

# Run one suite (the forks pool is unavailable in this environment)
node node_modules/vitest/vitest.mjs run --pool=threads \
  "tmp-src/deepseek-harness-639ed015397290b3745d163aafe02ffee4aa3f84/packages/orchestrator/session-orchestrator/tests/store.spec.ts"
```

套件是 `store`、`planner`、`workspace-key`、`scheduler`、`supervisor`、`recovery`、`recovery-matrix`、`fault-injection`、`local`、`integration`、`pressure`、`handoff`、`remote`、`zero-llm` 与 `model-warden`；把一个 `vitest run` 传多个路径可一起执行。devroot `vitest.config.mts` 提供带 decorator 的 `remote.ts` 所需的标准 decorator 转换；没有它，默认转换会拒绝该源码。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Storage 子系统](../../../docs/subsystems/storage.zh.md) —— domain 契约、backend 路由、变更事件。
- [Storage 包地图](../../storage/README.zh.md) —— 此包构建所依赖的同级 domain 与 backend 包。

-----

<a id="model-experience"></a>
## 模型体验

### 持久编排状态

#### 模型看到什么

默认什么都没有。此包不注册工具，也不向 Session 注入 prompt 文本；任务 Agent 只看到宿主本来就会发送的任务提示词。它模型相邻的贡献是交接召回消息或干预指令上的 `'session-orchestrator'` message source，用于让 Session 日志读者识别产生该 user message 的 operation。

在可选模型模式下，监工每次巡检发送一次独立请求：固定系统提示词加有界状态包，不带 Session 标识、不带对话记录、不带历史。巡检回答绝不会成为 Session 事件。

#### Token 影响

默认零：`wardenMode: rule` 不调用模型，规则判决是状态包的纯函数。`wardenMode: model` 下每次巡检向配置路由计费一次，并受冷却、单 run 预算、输出上限与状态包字节上限约束；回退的巡检会花掉 Provider 已经收取的那次尝试，台账如实记录。拆解始终是任务自己对话内的一次调用，绝不是第二次模型调用。

#### KV Cache 影响

独立：此处不触碰任务的请求前缀。监工巡检没有 Session 标识也没有共享前缀，因此既不预热也不失效任何对话的缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **快速结算可能跑在 scheduler 提交之前。** `launch()` 在 Session 存在后返回；若 run 在 `Scheduler.markRunning` 前结算并赢得终态 CAS，scheduler 会把过期提交记录为失败，终态 run state 仍是权威，恢复会对账。不会重放 prompt。
- **恢复成功不推进 operation phase。** `resume()` 恢复监督与结算，但停在 `session-created` 的 operation 会保持到 supervisor 自己的提交路径或后续块推进它。
- **`needs-attention` 没有进程内 resume API。** live handle 保留到 `close()`；Remote `retry` 创建新 attempt 而不是 resume 旧 Agent，宿主必须在卸载前解决人工边界。
- **Retry 是显式而非自动。** Remote controller 能创建下一个确定性 attempt，但 `LocalSessionOrchestrator` 不自动重试；pressure 仍产生持久 `handoff-pending` 决策，宿主必须交给 `HandoffManager`。
- **Pressure 未自动接到 supervisor。** 调用方提供 live Session、`turnClosed`、`externalInput` 与预渲染正文。渲染简报或投影最后 Turn 是 `HandoffManager` 的工作，不属于此 monitor。
- **Handoff preset 降级缺少 schema 字段。** `EffectiveConfigSnapshot.preset` 没有 `source`；当没有可读的 session、task 或 prior preset 时，manager 记录保留的 `host-default` id，省略 `meta.agentPreset`，并在 `HandoffConfigInheritance` 中暴露降级，而不是发明完整 preset 副本。
- **`session-created` 前的硬崩溃不会在此自动对账。** 进程重启看到 `handing-off` 并拒绝创建另一个子 Session；`getRun`/`listRuns` 暴露状态与 operation phase，但没有 Remote mutation 重放或对账 uncertain handoff。
- **`observe-only` 复用既有原因。** schema 没有 estimated-mode 原因，因此被 `estimatedMode: 'observe-only'` 抑制的 estimated 读数会记录为 `handoff-disabled`，并在结果中带 `observeOnly: true`。
- **没有基于时间的冷却。** 冷却是持久规则：推进代数必须有已接受 Turn（`empty-generation`）；不发明墙钟时长。
- **没有模型侧压力输入。** 文档中的 `contextPressure().pressureTokens` 在锁定 commit 不是 TokenMeter API；monitor 使用 `measure(session).totalTokens` 与 `Session.requestContext().contextWindow`。
- **Session flush 是端口。** supervisor 等待一次 flush，但不配置 durability listener；宿主必须组合 checkpoint 策略，`flushParticipated` 才会为 true。
- **自定义 `humanSkips` 读取器必须保留 latest-attempt 过滤。** `skipTask` 针对所观察 `needs-attention` revision 写入审计 `SkipRecord`；`LocalSessionOrchestrator` 默认读取 `store.listSkips()`，只保留 run 为该任务最新 attempt 的 skip，因此后续 `retry` 不会被挡住，审计记录仍在。提供 `humanSkips` 会替换该读取器；返回旧 skip 会重新应用它们。
- **Remote pause 是宿主级，cancel 是状态优先。** `pause`/`resume` 改变全局 scheduler 暂停，`cancel` 在调用注入的 `OrchestratorRunControl` 前提交持久取消。`cancel` 拒绝 `handing-off` run，以免中途交接事务被孤立；让它结算或恢复。没有 run-control 接缝时 Agent 会继续跑到自身边界；controller 从不拥有或暴露 Handle。
- **默认 Remote 访问是 owner。** Connection 已认证每个准入调用者，因此默认策略授予 owner。具有 observer 或按记录 principal 的宿主必须注入 `OrchestratorAccess`；controller 强制执行该策略返回的结果。
- **Session 链接仅表示存在。** 可选 `ctx.get('sessionController')` 查找只报告 `linkable`；它不调用 Web controller，因此此处不发明 URL 或 Session 内容投影。
- **Typert 产物是 build 输出。** 包导出 `./typert` 供 Host manifest 使用，导出 `./remote` 供浏览器装配使用；两者都解析到 workspace bundle 生成的 `lib/typert.*`。未 build 的源码检出无法挂载 Remote 命名空间，浏览器装配也必须包含此包的 `./remote` 贡献。
- **模型监工可选且默认关闭。** `wardenMode` 默认 `rule`，也是唯一能证明零额外 Token 的模式。启用 `model` 需要 `wardenProvider` 与 `wardenModel` 以及已挂载的 `llm` 服务；缺少路由或服务会在插件加载期失败，而不是拖到第一个 tick。
- **模型判决不能降级本地安全门。** `protectHardGate` 让规则判决 `decompose`（上下文切换点）与 `abort-all`（缓存命中中断线）保持权威，且这两道门不做巡检直接执行。模型只能在规则看不到地板的地方追加判断——提前拆解、判定卡死、精化。其余规则建议（`refine`、`stop-and-notify`）会等到下一个巡检槽位，最长一个冷却周期。
- **巡检失败是回退，不是队列失败。** 超时、输出不合规、Provider 失败或状态包超预算都会立即使用本地判决，写一条带稳定码的 `rule-fallback`，并让队列继续运行。Provider 仍可能为失败的尝试计费；台账会记录但无法退款。
- **巡检预算是按 run 代数，不是按宿主。** `wardenMaxReviewsPerRun` 统计一个 `(runId, generation)` 的已记录巡检，因此重试会重新获得额度。保留策略只保留每个 run 的 `wardenAuditLimit` 条，审阅者无法翻阅无界历史。
- **监工模式是部署配置，不是页面开关。** `wardenMode`、其路由与各项上限都是组合 profile 读取的插件 `Config` 字段；设置页展示由此产生的巡检台账，但不能切换判决者。因此改变模式需要重启或重载 runtime 行。
- **没有跨表事务。** 多记录迁移对其他 store 调用者原子，但两次持久写入之间的崩溃仍可能留下可对账中间状态；恢复是对账，不是 exactly-once。
- **WorkBuddy 的 Workspace 列表与 GUI 打开被禁用。** 无头 CLI 没有 Workspace 列表或 GUI 对话；桌面 REST 列表需要宿主签发的密码。
- **WorkBuddy 适配器不是第二套队列后端。** 它只是经过验证的能力报告，不新增 scheduler、recovery manager、健康门或模板构建器。
- **Trae 不暴露对话 API。** IDE 启动器只打开文件夹/文件/扩展，私有 `ai-agent` socket 没有公开的对话、工作区或提示词协议。
- **逐用户安装可能位于发现根之外。** `hostWorkBuddyCli` 与 `hostTraeCli` 可显式指定非默认安装路径。
- **不解析符号链接。** `workspaceKey` 规范化是词法的，使规划保持纯函数且无 IO；同一目录的 symlink 别名在 launcher 报告真实路径前不会折叠。
- **没有数据迁移。** 改变记录 schema 需要新 domain 版本与手写迁移；旧 medium 在打开时以 `version-mismatch` 拒绝。在版本 1 内新增表不会改写既有记录。
- **只预组合了 controller。** 随附 Host 行挂载 store 与 Remote controller，不构造 supervisor、recovery manager、handoff manager 或 `LocalSessionOrchestrator`。因此 live 调度仍是宿主接线，设置页可以在不启动 run 的情况下管理记录。
- **不发布 runtime invariant companion，因为 store 的 revision CAS、恢复对账器与 DTO 投影本身就是独立校验的关系；第二个观察者只会重复这些检查，而不会暴露新的自有发散。**

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作上下文——点击展开</summary>

此包针对锁定 `dsh-v0.2.0-rc.2` 源码开发；它消费的每个 API 在使用前都从该树读取。块范围由设计文档的 chunk 列表固定，每块报告真实测试输出而不是意图断言。

</details>
