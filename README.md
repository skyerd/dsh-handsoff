<div align="center">

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/handsoff-avatar.png" width="140" alt="HandsOff — dsh 会话编排插件头像"/>

# dsh-handsoff

**简体中文** | [English](https://github.com/skyerd/dsh-handsoff/blob/main/README.en.md)

![license](https://img.shields.io/badge/license-MIT-2631463) ![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-2f6f4f) ![status](https://img.shields.io/badge/status-%E5%AE%9E%E9%AA%8C%E9%98%B6%E6%AE%B5-f0a441) ![i18n](https://img.shields.io/badge/i18n-%E4%B8%AD%E6%96%87%20%C2%B7%20English-4b6fff)

> 把要做的活提前写成一条任务流水线，交给 AI 自己排队执行、自己盯进度、自己纠偏。
> 你只需要在最后，体验和感受结果。

*Write the work up front as a task pipeline, hand it to AI: it queues, runs, watches and corrects itself — you just experience the result.*

</div>

---

## 这是什么

**dsh-handsoff（插件名 HandsOff）** 是一个 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的会话编排插件。它把「盯着 AI 干活」这件事也交给了 AI：

- 你提前约定好**框架和任务细节**，把它们写成一条任务队列；
- AI 自行**统筹规划项目的进度**，逐个任务排队执行、跨任务交接产物；
- 内置的本地规则**自动监工**：上下文过高、长时间无响应、缓存命中率异常，都会被自动拆分、追问或中断；
- 人只做一件事——**对项目进行体验与感受**。

插件由两个包组成：

| 包 | 位置 | 职责 |
|---|---|---|
| `@deepseek-ai/dsh-session-orchestrator` | `packages/orchestrator/session-orchestrator` | 宿主侧：持久化任务队列、运行状态机、操作与交接记录、调度与监工 |
| `@deepseek-ai/dsh-client-ui-settings-session-orchestrator` | `packages/client/ui-settings-session-orchestrator` | 界面侧：设置页「HandsOff」，队列、看板、自动处理、运行平台 |

## 设计初衷

我们想**解放普通程序员的双手**。

真实的项目里，人最累的部分往往不是写代码，而是当监工：盯着 AI 有没有跑偏、上下文快满了自己会不会忘事、一个任务卡住了要不要重试。这些事机械、重复、熬人，而且挤占了人真正该做的事——**想清楚要什么，然后感受做出来的东西**。

于是我们把「监工」做成了一款插件：不再需要一直盯着项目的进度，可以提前约定好框架和任务细节，由 AI 自行统筹规划项目的进度，人只需要对项目进行体验与感受。

## 它能做什么

- **任务队列**：新建流水线时填一个名称、选一个文件夹、逐条写下任务提示词；任务自上而下执行，也支持「与上一项并行」。
- **四阶段模板**：在「更多选项」里勾选，一键生成 架构 → 拆解 → 实现 → 测试验收 四个任务，每个阶段的提示词自动携带你的需求简报并读取上一阶段留在 `docs/pipeline` 的产物。
- **并行看板**：所有任务按 运行中 / 待人工 / 待启动 / 已暂停 / 已结束 五种状态排布，一键打开任意任务对应的会话。
- **自动处理（本地规则，0 Token）**：上下文达到 60% 自动整理并续排、连续 20 分钟无响应自动追问再暂停、缓存命中率低于 90% 拆分剩余工作、低于 50% 立即中断、有效样本命中率过低时全局停止全部队列。
- **监工**：默认规则监工不产生额外 Token；可选模型监工，费用记在指定路由，每次巡检留有记录。
- **修订护栏**：每一次写入都携带加载时的修订号（`expectedRevision`），发生冲突时如实上报，绝不静默覆盖你的草稿。
- **运行平台**：DSH / WorkBuddy / Trae 的能力矩阵如实呈现，缺什么就显示什么，不装成功。

## 界面预览

**创建任务队列**——写好提示词，点「开始执行」：

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/queue-create.png" width="820" alt="HandsOff 创建任务队列界面"/>

**自动处理**——四条本地规则盯着每一次运行：

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/auto-handling.png" width="820" alt="HandsOff 自动处理规则界面"/>

## 安装

插件针对 **deepseek-harness 0.2.0-rc.2** 开发（上游迭代很快，更高版本请先核对补丁是否仍适用）。

### 方式 A：npm 一键安装（推荐）

安装者只下载运行时产物（`lib/`、`client.js` 与插件清单），不含源码和构建脚本：

```bash
dsh plugin --profile web add dsh-handsoff
```

安装完成后重启一次 dsh web。`--profile` 填你实际使用的 profile 名称。

> 也可以先本地试用：`dsh plugin --profile <name> add <包路径>`。
> 兼容范围：dsh 0.2.x（按 0.2.0-rc.2 开发）。

### 方式 B：源码挂载（贡献者 / 本地调试）

只有要改插件源码时才需要 clone 仓库，并把两个包挂进 harness 源码构建：

```bash
# 1. 获取与插件匹配的上游源码
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout <0.2.0-rc.2 对应的 tag 或提交>

# 2. 放入两个插件包（保持 monorepo 目录结构）
cp -r /path/to/dsh-handsoff/packages/orchestrator/session-orchestrator packages/orchestrator/
cp -r /path/to/dsh-handsoff/packages/client/ui-settings-session-orchestrator packages/client/

# 3. 应用集成补丁（注册 sessionOrchestrator Remote 命名空间与 web-app 组合）
git apply /path/to/dsh-handsoff/patches/harness-0.2.0-rc.2-integration.patch

# 4. 构建
corepack enable
pnpm install
pnpm run build:web      # 或 pnpm run dev:web 一边改一边看
```

> Windows 用户：第 2 步直接用资源管理器复制两个文件夹即可；第 3 步若 `git apply` 失败，可按 [docs/integration.md](https://github.com/skyerd/dsh-handsoff/blob/main/docs/integration.md) 手动修改 4 个上游文件，改动都很小。
> clone 与安装互不影响：最终用户走 npm 安装，源码路线只用于开发和贡献。

本仓库已按 [DSH Plugin Hub](https://dsh-plugin.org) 的收录要求发布：公开仓库、`dsh-plugin` topic、可复制的安装命令、标准 `apply(ctx)` 插件形态。

## 使用方法

1. 启动你的 dsh（本地构建的 web 端或桌面端），进入 **设置 → HandsOff**。
2. 在 **创建任务队列** 标签页点「新建流水线」：填队列名称、选工作区文件夹、逐条写任务提示词。模型策略默认「继承系统默认」，技能「沿用当前预设」；需要时也可以为单个任务固定模型。
3. 点 **开始执行**。任务按顺序进入各自的会话，AI 开始工作。
4. 切到 **正在执行中的任务** 看板：五种状态一目了然，随时「打开对话」查看某个任务的会话。
5. 在 **自动处理** 标签页查看规则触发的记录与监工费用；也可以暂停 / 恢复自动处理。
6. **运行平台** 标签页展示当前运行时的能力矩阵（模型目录、技能、权限预设、上下文压缩等）。

> 队列、任务与监工记录保存在本地 `session_orchestrator` 存储域，可随会话数据一起备份。

##  实验测试阶段

本项目目前仍处于**实验测试阶段**，请带着预期使用：

- 自动处理的规则判断**不一定有那么强的准确性**：可能误拆、误停，也可能漏判。
- 四阶段模板生成的是「可运行的起点」，不是「免验收的成品」——关键节点的产出请保持人工确认的习惯。
- 建议先在低风险的工作区试用，重要项目保留手动暂停与重试的余地。
- 上游 harness 迭代很快，版本越新，补丁冲突的可能性越大。

## 展望

- [ ] **完全交给 AI**：项目从头到尾由 AI 统筹交付，不再需要在基础的代码编写和流水线监工上消耗自己的精力。
- [ ] **规范与 skills**：沉淀一套更详细的、专属于 AI 项目制作的规范与技能包，让编程小白也能安全地把想法变成项目。
- [x] **独立插件打包**：仓库根即装即用，`dsh plugin add` 一键安装。
- [ ] **插件市场上架**：已按 DSH Plugin Hub 收录要求发布，推进 verified 认证。
- [ ] **更多运行平台**：完善 WorkBuddy、Trae 等宿主的适配与能力呈现。
- [ ] **监工规则开放配置**：把内置阈值（60% / 20 分钟 / 90% / 50%）开放为可调参数。

## 项目结构

```
dsh-handsoff/
├── package.json / cordis.patch.yml / client.js / lib/   # 仓库根即插件包：npm 只发运行时（files 白名单），git 安装零构建
├── packages/
│   ├── orchestrator/session-orchestrator/          # 宿主侧：队列、调度、监工、交接
│   │   ├── src/                                    #   34 个源文件（pipeline/scheduler/pressure/warden…）
│   │   └── tests/                                  #   33 个测试文件（含故障注入与集成测试）
│   └── client/ui-settings-session-orchestrator/    # 界面侧：设置页「HandsOff」
│       ├── src/client/                             #   四个标签页、六个区块组件、中英文案
│       └── tests/client/                           #   组件与服务测试
├── scripts/                                        # standalone 构建 + 结构校验脚本
├── patches/
│   └── harness-0.2.0-rc.2-integration.patch        # 源码挂载路线：对上游 4 个文件的集成改动
└── docs/
    ├── images/                                     # 头像与界面截图
    └── integration.md                              # 手动集成说明
```

测试随 harness 工作区运行：挂载后执行 `pnpm run typecheck`，再按上游 vitest 配置运行两个包的测试。

### 维护者：重建仓库根构建产物

根目录的 `lib/` 与 `client.js` 随仓库提交，安装时零构建；只有改动两个包的源码后才需要重建：

```bash
npm install                 # 构建依赖：esbuild、zod
npm run build:standalone    # 重新生成 lib/index.js、lib/host.js、client.js
npm run check:standalone    # 校验 bundle 结构与 Remote 方法覆盖
```

`standalone/vendor/typert.remote-client.js` 由 harness 的 typert generator 生成，不纳入版本控制。脚本在文件缺失时，会从 `packages/orchestrator/session-orchestrator/lib/`（就地构建产物）或 `DSH_HARNESS_ROOT` 指向的 harness 工作区复制。

### 维护者：发布到 npm

`package.json` 的 `files` 白名单只放行运行时：`lib/`、`client.js`、`cordis.patch.yml`、两份 README 与 `LICENSE`；源码、测试、`scripts/`、`docs/` 都不会进入 tarball。

```bash
npm pack --dry-run    # 检查 tarball，应只包含白名单文件
npm version patch     # 或 minor / major
npm publish           # prepublishOnly 会先重建产物并跑结构校验
```

发布后安装者执行 `dsh plugin --profile web add dsh-handsoff`，无需 clone 仓库。

## 参与贡献

欢迎 Issue 与 PR：规则调优、平台适配、文档翻译都是好起点。提交前请跑一遍 `pnpm run typecheck` 与相关测试。

## 许可证

[MIT](LICENSE) © skyerd and dsh-handsoff contributors

上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 同为 MIT 许可，Copyright (c) 2026 DeepSeek。头像为项目自有的插件形象素材（经裁切处理），仅用作项目标识。
