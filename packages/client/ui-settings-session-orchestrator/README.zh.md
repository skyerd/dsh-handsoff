---
description: "会话编排设置页：队列与任务、依赖顺序、并行运行看板、压力与交接预算、交接链、可观测审计事实，以及带 revision 校验的人工控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-orchestrator

[English](README.md) | 中文

## 摘要

打开 **设置 → 会话编排**，在生成式 `sessionOrchestrator` Remote 命名空间背后创建并跟踪流水线。**新建流水线** 只要求选择文件夹并填写提示词，然后创建第一个任务并启动；队列与任务 ID 由客户端生成。AI 四阶段模板收在 **更多选项** 中。页面有六个 Tab：**队列与任务**、**并行看板**、**阈值与预算**、**交接与审计**、**干预记录**、**宿主**。实时整快照通过 `changed` 到达；每个可编辑草稿都保存在本地，并携带其加载时的 revision。因此每次写入都发送 `expectedRevision`，冲突会被报告，且不会把草稿标记为已保存或覆盖草稿。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

**新建流水线** 收集文件夹、可修改的工作目录、提示词与可选名称。名称留空时用提示词第一行自动生成；创建成功前，表单输入会保存在本机。**创建并启动** 复用现有的 `startQueue` 控制。队列编辑不再暴露 ID、生命周期或运行上限；这些字段仍保留在存储中，以保持兼容。

**队列与任务** 选择流水线、编辑名称、文件夹与目标，并把任务展示为带编号的有序列表。拖动行、使用箭头按钮，或点 **在下方插入** 放置新任务；**复制** 在源任务下方克隆，**删除** 需先确认。任务默认从上到下串行；唯一的并行选项是 **与上一项同时执行**，它会加入上一行所在分组，两者等待同一个前序分组。任务编辑器暂存 prompt、工作区、工作目录、优先级、preset/模型/skills 策略与交接阈值；任务 ID 与依赖 ID 从不由用户填写。宿主按列表顺序推导全部依赖，并在一次提交中同时处理排序、插入、复制和删除，因此移动或删除不会留下指向不存在 ID 的依赖。非法历史依赖会阻止 **开始流水线**，在列表内写明具体任务与依赖；**按列表顺序修复** 会重写已存依赖且不删除任何任务。

**并行看板** 以任务为主体，把每个任务放进运行中、待响应、待启动、已暂停、已结束五个固定状态的全宽行。最新一次运行提供该行的状态、模型、最近活动与会话链接；尚未启动、还没有运行的任务也会立即出现在 **待启动**。打开对话复用稳定的 `/session/<sessionId>` 路由；运行、会话、操作、尝试、代数、压力读数与错误等内部信息默认收在 **详情** 中。

**阈值与预算** 编辑宿主调度器的暂停标记、全局运行上限与 provider 配额，展示当前暂停/恢复控制，并在每次运行的压力读数旁列出任务级交接阈值与预算。基线为 `estimated` 的读数会明确标记为 **估算 Token 基线**；交接正文 Token 字段标记为上限，而不是估算。

**交接与审计** 绘制 Session 世系与已完成的交接代数，不展示正文，并仅根据 Remote DTO 实际暴露的字段投影审计事实。每个运行旁提供取消、重试与带审计的人工跳过；Host controller 会在交接事务中途拒绝取消，跳过必须同时提供操作者与原因。所有危险路径都经过确认复选框；失败会留在页面的保留错误列表中，直到用户逐条关闭。

-----

<a id="understand-the-implementation"></a>
## 理解实现

Host 半部分是空 `apply`，只为让包拥有一个 Loader 行，其浏览器半部分从 `./client` 提供。浏览器半部分注入 `slots`、`locale` 与生成的 `remote.sessionOrchestrator` 命名空间，然后注册一个 `settings.section` 条目，id 为 `session-orchestrator`。

`OrchestratorClient` 使用 `@deepseek-ai/dsh-client-store` 拥有两个独立快照源：`live` 只接受整帧 `changed`，忽略更低 revision；`drafts` 保存队列/任务/设置编辑、已加载队列详情、进行中的操作与保留错误。实时帧从不写入草稿字段。每次变更都用草稿或实时记录携带的 revision 调用 Remote，并只合并权威结果；流仍是重连权威。

所有文案位于类型化 locale 命名空间 `settings.sessionOrchestrator`。页面使用共享 `Button`、`Input`、`Switch`、`Checkbox`、`Tag`、`StateDot`、`SegmentedTabs` 与 `RiskConfirmation` 原语、基于 `--dsw-*` 语义别名的 CSS Modules，不引入新的 UI 库。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-settings](../ui-settings/README.zh.md) — `settings.section` 插槽与设置外壳。
- [ui-settings-general](../ui-settings-general/README.zh.md) — 页面出现的设置导航。
- [ui-primitives](../ui-primitives/README.zh.md) — 此处使用的控件与风险确认。

-----

<a id="model-experience"></a>
## 模型体验

无；此包是浏览器侧设置界面，不注册任何模型表面。

#### KV Cache 影响

无；此包不组装也不发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **“当前工作区”默认是近似的。** 设置页只收到工作区列表，没有“当前工作区”标记；因此 **新建流水线** 用列表中第一个可见工作区的文件夹与工作目录作为默认值，用户可以在创建前修改。
- **手动创建不是一次宿主事务。** 客户端组合现有的 `createQueue` → `upsertTask` → `startQueue` 调用：任务写入失败时会删除刚建的空队列；启动失败时会留下一条未开始的流水线，用户可从顶部按钮手动启动。
- **需要生成的 Remote 产物。** 页面注入 `remote.sessionOrchestrator`，其 Host 与 Client 生成贡献是 `session-orchestrator` 的构建产物。没有生成命名空间及其 controller 的 profile 会让插件保持 pending；web-app 行在缺少 `sessionOrchestratorController` 时禁用。
- **Session 导航只靠路由。** DTO 携带稳定 Session 标识、同源 `/session/<id>` 路由与 `openState`；浏览器通过 `uiWorkspace.openSession` 选中对话。未挂载 Web Session controller 的宿主报告 `unsupported`，页面不会发明按标题匹配的兜底。
- **宿主行只是只读报告。** 宿主 Tab 渲染运行期提供的能力矩阵，不能启用适配器声明为禁用的能力；WorkBuddy/Trae 行不会新增第二套队列执行路径。
- **审计是投影。** 人工跳过的操作者与原因不会离开 Host。审计表只派生运行时间戳、操作阶段、最后稳定错误、压力读数、交接代数与跳过标记；它不是状态迁移日志。
- **不发布 runtime invariant companion，因为页面没有可独立发散的拥有关系：Host 校验每次写入，实时快照是每次读取的权威。**
- **未接入完整 `apps/web` scaffold E2E。** Host controller 的生产组合与生成的 Remote 产物不在本块范围内。devroot 浏览器 harness 已通过真实 Cordis、React 与 Chromium 验证页面、控制与卸载行为。
