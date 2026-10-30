<div align="center">

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/handsoff-avatar.png" width="140" alt="HandsOff — dsh 会话编排插件头像"/>

# dsh-handsoff

**简体中文** | [English](https://github.com/skyerd/dsh-handsoff/blob/main/README.en.md)

![license](https://img.shields.io/badge/license-MIT%20%2B%20CC--BY--3.0-2631463) ![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-2f6f4f) ![status](https://img.shields.io/badge/status-%E5%AE%9E%E9%AA%8C%E9%98%B6%E6%AE%B5-f0a441) ![i18n](https://img.shields.io/badge/i18n-%E4%B8%AD%E6%96%87%20%C2%B7%20English-4b6fff)

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



### 自动处理：可配置、可明细、可自省

- **模型自选**：管理单条队列的模型、为队列拆分任务的模型，都可以由用户分别指定——不同队列，可以使用不同的管理模型。
- **阈值开放配置**：上下文占比、自动处理时限、缓存命中率的上下限，全部开放为可直接修改的数字，不再写死在代码里。
- **Token 用量上限**：为单个模型设定消耗额度，一经触及立即交接任务；额度多少，由用户决定。
- **处理明细**：自动处理页将完整记录每一次处理——动了哪条队列、处理了什么问题、原因是什么；一切正常时，也会明明白白写上一句「一切正常」。
- **异常自省**：同类问题反复出现（例如连续三次超时、某一类任务消耗过高）时，管理模型会在页面上主动询问：是否由它自动优化处理策略？如果问题出在管理模型自身，则换用更强的模型来打磨它的调度方式——全过程向用户公开，优化结果沉淀到技能管理页。

### Token 与时间的双重节省

- **少读无用文件**：AI 大量阅读无关文件、把单个文件写得过长，都会在读与改之间白白消耗 token。为此引入代码段落限制与更细分的文件制作工程要求，从源头约束。
- **负面反馈驱动改进**：读到大量无用文件、长时间运行命令却毫无结果时，自动记为负面反馈；管理模型据此改进当前任务的调度——对「该读什么」给出更准的指引，对「不该读什么」加上更严的限制。
- **跨项目沉淀**：两个以上项目的流水线遇到同类问题时，对应的改进会进入技能管理的「全局改进」，一次修正，处处生效。
- **上下文有效压缩**：只保留真正有价值的内容。我们的目标是社区里那种极致的 token 经济性——制作一小时的游戏实况视频、再看上两遍，也只花几毛钱的 token。

### 技能管理

顶部栏四个标签页之后，将新增**技能管理**入口：既可以自行添加技能，也可以直接使用我们预设的技能。页面分为三个分区：

- **全局技能**：独属于这位用户的技能——从其日常项目里最常出现的问题中沉淀出的专门改进；也收录专业程序员撰写的通用优化技能，比如「少读无用文件」「多向用户提问，准确理解项目」「单个文档不超过 500–700 行」。
- **专业任务技能**：我们预设的技能加上用户自建的技能，覆盖前端设计、后端设计、游戏设计、小说写作、文案写作等方向。分组之下还能再建分组，是完全属于用户的文件夹体系；每份技能文档都纳入 git 管理，即使被误改也能随时恢复。这些技能可以在流水线页面直接选用、注入对话，省下大量时间与 token。
- **流水线调度中的技能**：展示每条流水线当前引用了哪些技能——既有用户手动添加的，也有调度模型自动挂载的。支持实时增删：「−」只是解除这条对话对该技能的引用，技能本身不会被删除；「+」添加后，AI 在下一轮对话中即刻生效。每条流水线可以有多个任务，每个任务可挂载专属技能，流水线整体也可以挂全局技能——让每个任务都引用一次。

### 鱼的记忆

技能管理右侧的另一个新入口。点开它，你会得到一位**自学习、拥有独立人格的 AI 大管家**：

它不读大量文件，专注于项目的整体调度；它会与你对话、提醒你该留意的事；随着相处，它会慢慢养成自己的性格，懂得你平时在做什么，甚至有自己的情绪和小心思。

#### 大肥鱼桌宠

「鱼的记忆」页里的形象现在是一位 Q 版鲸鱼女仆「小鱼」：蓝色长发、鲸鳍耳、鱼尾，配深蓝/白色女仆装、围裙和鲸鱼徽章。内置立绘由 **Aeihu** 的 CC-BY 3.0 Q 版美人鱼改造而来（缩小、重绘女仆装、生成三个表情）；**代码仍是 MIT，内置立绘按 CC-BY 3.0 授权**，npm 包声明为 `MIT AND CC-BY-3.0`。

它会根据队列与最新运行状态切换 `idle / working / attention / done / error / sleeping` 六种姿态，并用对话条汇报「已完成 / 运行中 / 队列数量」。点击「把小鱼移到桌面」后，它会变成整个 Harness 桌面窗口上的可拖拽悬浮层，位置保存在浏览器本地，也能一键收回。

**自定义立绘**：点击「自定义立绘」可以导入本地 PNG/WebP 文件，文件名使用 `idle`、`joy`、`work`、`think`、`sleep`、`sad`、`wake` 等动作名。文件只写入当前浏览器的 IndexedDB，**不会上传、不会进入安装包、也不会随 npm 发布**。这样你可以把个人非商业的鲸鱼女仆立绘放在本机使用，而仓库本身不需要再分发这些素材。

> **关于 Live2D 皮肤**：「DeepSeek-chan / 大肥鱼」Live2D 模型（`.moc3` + `model3.json`）不能直接导入本插件。它的使用须知允许个人直播、视频与署名二创，但**禁止重新分发完整模型文件**，也不适合作为商业产品的一部分；并且运行时资源约 60MB（另有 125MB PSD），远超 10MB 的轻量目标。建议在 VTube Studio 里使用，或先在 VTube Studio / Cubism 中导出 PNG 帧，再用「自定义立绘」本地导入。若要把它内置为默认形象，需要先取得原画/建模作者的书面许可。

> **边界说明**：桌面模式是 Harness 桌面窗口内的置顶悬浮层，不是操作系统级窗口——浏览器端无法创建后者。若需要 OS 级透明置顶窗，可搭配原生桌宠项目；本仓库不启动、不打包任何第三方桌宠二进制。

> **素材声明**：内置立绘按 [CC-BY 3.0](ASSETS-LICENSE.md) 使用并署名 Aeihu；`dsh-whale-maid` / `deepseek-dafeiyu-pet` 的提取立绘本身禁止再分发，因此只支持本地导入，不随包分发。完整记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

而更远处，我们还希望：

- [ ] **完全交给 AI**：项目从头到尾由 AI 统筹交付，不再需要在基础的代码编写和流水线监工上消耗自己的精力——让编程小白也能安全地把想法变成项目。
- [x] **独立插件打包**：仓库根即装即用，`dsh plugin add` 一键安装。
- [ ] **插件市场上架**：已按 DSH Plugin Hub 收录要求发布，推进 verified 认证。
- [ ] **更多运行平台**：完善 WorkBuddy、Trae 等宿主的适配与能力呈现。

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

`package.json` 的 `files` 白名单只放行运行时：`lib/`、`client.js`、`cordis.patch.yml`、两份 README、`LICENSE`、`ASSETS-LICENSE.md` 与 `THIRD_PARTY_NOTICES.md`；源码、测试、`scripts/`、`docs/` 都不会进入 tarball。

```bash
npm pack --dry-run    # 检查 tarball，应只包含白名单文件
npm version patch     # 或 minor / major
npm publish           # prepublishOnly 会先重建产物并跑结构校验
```

发布后安装者执行 `dsh plugin --profile web add dsh-handsoff`，无需 clone 仓库。

## 参与贡献

欢迎 Issue 与 PR：规则调优、平台适配、文档翻译都是好起点。提交前请跑一遍 `pnpm run typecheck` 与相关测试。

## 许可证

**代码：[MIT](LICENSE) © skyerd and dsh-handsoff contributors。**

**内置桌宠立绘：[CC-BY 3.0](ASSETS-LICENSE.md)，基于 Aeihu 的 “Q-style cartoon mermaid” 改造，© Aeihu；改造部分 © skyerd and dsh-handsoff contributors。** 因此 npm 包声明为 `MIT AND CC-BY-3.0`。用户通过「自定义立绘」导入的文件不随包分发、不在此授权范围内，沿用其原授权。

上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 同为 MIT 许可，Copyright (c) 2026 DeepSeek。页面头像为项目自有素材。第三方项目、许可差异与本地导入说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
