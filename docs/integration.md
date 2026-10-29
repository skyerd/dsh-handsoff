# 集成指南：把 HandsOff 挂载进 deepseek-harness

本插件以 deepseek-harness monorepo 的**内嵌包**形态存在。除两个插件包目录外，还需要对上游 4 个文件做少量注册改动。`patches/harness-0.2.0-rc.2-integration.patch` 已经包含全部改动，优先使用：

```bash
git apply /path/to/dsh-handsoff/patches/harness-0.2.0-rc.2-integration.patch
```

`git apply` 失败（版本漂移或换行符差异）时，按下文手动修改。

## 前置条件

- deepseek-harness **0.2.0-rc.2** 源码（更新版本请先核对差异）
- 启用 Corepack 的 pnpm（仓库固定 `pnpm@11.7.0`）

## 第 1 步：放入插件包

```
dsh-handsoff/packages/orchestrator/session-orchestrator
  → harness/packages/orchestrator/session-orchestrator

dsh-handsoff/packages/client/ui-settings-session-orchestrator
  → harness/packages/client/ui-settings-session-orchestrator
```

保持目录结构一致即可，无需改包名。

## 第 2 步：注册 Remote 命名空间

### 2.1 `packages/api/remotes/package.json`

在 `dependencies` 中按字母序加入：

```jsonc
"@deepseek-ai/dsh-session-orchestrator": "workspace:*",
```

（位于 `@deepseek-ai/dsh-scope` 之后、`@deepseek-ai/dsh-session-reference` 之前。）

### 2.2 `packages/api/remotes/src/client/index.ts`

三处改动：

```ts
// 1. import 区，紧挨 sessionRemote：
import sessionOrchestratorRemote from '@deepseek-ai/dsh-session-orchestrator/remote'

// 2. type 导出区，紧挨 session-controller 那行：
export type {} from '@deepseek-ai/dsh-session-orchestrator/remote'

// 3. mount 数组，在 sessionRemote 之后追加：
permissionPresetsRemote, subagentsRemote, sessionRemote, sessionOrchestratorRemote, jobRemote,
```

## 第 3 步：注册 web-app 组合

### 3.1 `packages/bundle/web-app/cordis.patch.yml`

两处插入：

```yaml
# A. host 模块区，在 `- id: session-controller` 条目之后：
    - id: session-orchestrator
      name: '@deepseek-ai/dsh-session-orchestrator'
    - id: session-orchestrator-controller
      name: '@deepseek-ai/dsh-session-orchestrator/host'

# B. UI 插件区，在 `- id: ui-settings-session-log` 条目之后：
    - id: ui-settings-session-orchestrator
      name: '@deepseek-ai/dsh-client-ui-settings-session-orchestrator'
      disabled: !!js "ctx.get('sessionOrchestratorController') === undefined"
```

> `disabled` 闸门的含义：若组合里没有挂载宿主控制器，设置页对应条目置灰，而不是留下一个永远 pending 的插件行。

### 3.2 `packages/bundle/web-app/package.json`

在 `devDependencies` 中加入：

```jsonc
"@deepseek-ai/dsh-session-orchestrator": "workspace:*",
"@deepseek-ai/dsh-client-ui-settings-session-orchestrator": "workspace:*"
```

## 第 4 步：构建与验证

```bash
corepack enable
pnpm install          # 新增 workspace 包后必须重跑
pnpm run typecheck    # Host lib（含 Typert 产物）+ Client 检查
pnpm run build:web    # 或 pnpm run dev:web
```

验证要点：

1. 设置页出现 **HandsOff** 分区，四个标签页：创建任务队列 / 正在执行中的任务 / 自动处理 / 运行平台。
2. 新建流水线 → 开始执行 → 看板出现「运行中」任务行。
3. 故意停掉会话观察「自动处理」规则记录（如 20 分钟无响应追问）。

## 常见问题

| 现象 | 处理 |
|---|---|
| `git apply` 报冲突 | 按本文手动改 4 个文件；或对更新的上游版本重新生成补丁 |
| HandsOff 条目置灰 | `sessionOrchestratorController` 未挂载：检查 3.1 A 段两个 host 条目 |
| typecheck 找不到 `@deepseek-ai/dsh-session-orchestrator` | `pnpm install` 未重跑，或包目录层级放错 |
| 设置页 pending 不出现 | 确认 2.2 的 import 与 mount 数组都已修改 |
