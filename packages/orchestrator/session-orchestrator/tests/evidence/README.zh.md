# 恢复证据索引（Block 4）

[English](README.md) | 中文

基线 commit：`639ed015397290b3745d163aafe02ffee4aa3f84`（解包快照；
该目录没有 `.git`）。所有 API 都已对照此树核对。

此处的每个产物都由下列 spec 生成；没有手写通过/失败数据。从工作区根重新运行：

```powershell
node verify/run-recovery-evidence.mjs
```

或直接运行：

```powershell
npx vitest run <session-orchestrator>/tests/recovery.spec.ts <session-orchestrator>/tests/recovery-matrix.spec.ts <session-orchestrator>/tests/fault-injection.spec.ts
```

## 产物

| 文件 | 生成者 | 内容 |
| --- | --- | --- |
| `recovery-matrix.json` | `recovery-matrix.spec.ts` | 28 个 F1–F10 用例，含崩溃前后 run、operation 与 Session 快照、决策及每次 resume 请求 |
| `snapshot-diff.md` | `recovery-matrix.spec.ts` | 每个矩阵用例的紧凑 run/operation 前后差异 |
| `fault-injection.json` | `fault-injection.spec.ts` | 7 个崩溃用例，含崩溃前、崩溃后与重启后的状态 |
| `zero-llm.json` | `zero-llm.spec.ts` | 静态禁止 import 扫描与六个运行时 service journal，全部为零 |
| 本文件 | 人工索引 | C-001–C-008 与 F1–F10 → 测试与产物映射 |

## C-001–C-008

| 用例 | Spec | 证据 |
| --- | --- | --- |
| C-001 对账矩阵 | `recovery-matrix.spec.ts`（28 tests） | `recovery-matrix.json`、`snapshot-diff.md` |
| C-002 operation source 而非 MessageId | `recovery.spec.ts` — `C-002 operation source...` | 重复消息标识只计一次；被另一 operation 复用的 id 绝不结算 |
| C-003 source 标识字段 | `recovery.spec.ts` — `C-003 durable message source...` | 仅人工日志 → `submission-unverified`；runId/generation 不匹配 → `message-source-mismatch` |
| C-004 operation 标识/hash | `recovery.spec.ts` — `C-004 durable operation identity...` | 规范值接受；hash/id/run-link 不匹配 → `needs-attention`，不 resume |
| C-005 scheduler 门 | `recovery.spec.ts` — `C-005 the scheduler stays closed...` | 持久读取挂起时拒绝 tick；对账后打开 |
| C-006 uncertain | `recovery.spec.ts` — `C-006 uncertain state...` | 打开 Turn 或未知 owner → `needs-attention`；只有已证明完成的 run 自有 Turn 才结算；不创建第二个 Session |
| C-007 lease/host | `recovery.spec.ts` — `C-007 leases and host ownership...` | 外部/时钟异常 lease 阻止且不写入；过期 lease 恢复；第二 domain 写者被拒绝 |
| C-008 持久失败 | `recovery.spec.ts` — `C-008 durable failures...` | 格式/损坏/缺失/writer-held → 可操作的 `needs-attention`；无效 domain 记录拒绝打开 |

## F1–F10 → 产物用例

| 故障点 | 用例 |
| --- | --- |
| F1 starting CAS | `F1-before-write`、`F1-after-write`、`F1-response-lost` |
| F2 Session 创建 | `F2-before-write`、`F2-after-write`、`F2-response-lost` |
| F3 operation target / run 采用 | `F3-before-write`、`F3-after-write`、`F3-conflict` |
| F4 prompt 投递 | `F4-before-write`、`F4-after-write`、`F4-response-lost` |
| F5 submitted 记录 | `F5-before-write`、`F5-after-write`、`F5-record-lost` |
| F6 claimed Turn 映射 | `F6-claimed`、`F6-unrelated`、`F6-open-turn` |
| F7 flush 边界 | `F7-before-flush`、`F7-flushed-crash`、`F7-response-lost` |
| F8 成功提交 / disposal | `F8-settled`、`F8-response-lost` |
| F9 handoff 子创建 | `F9-child-created`、`F9-child-missing`、`F9-response-lost` |
| F10 切换前 handoff 投递 | `F10-delivered`、`F10-response-lost` |

## 崩溃注入（持久写入）

| 用例 | 注入 | 重启预期 |
| --- | --- | --- |
| `IP-01-host-claim-after` | `updateSettings` 已写，响应丢失 | claim 复用；不产生第二个 claim |
| `IP-02-host-claim-before` | `updateSettings` 未落地 | claim 只写一次 |
| `IP-03-success-after` | 成功 `updateRun` 已写，响应丢失 | 观察到已结算 run；不重复提交或重放 |
| `IP-04-success-before` | 成功 `updateRun` 未落地 | 重启时提交成功 |
| `IP-05-target-after` | operation target 已写，响应丢失 | target 被采用；恰好一次 resume、一个 Session |
| `IP-06-target-before` | operation target 未落地 | 写入 target，然后一次 resume |
| `IP-07-delivery-record-lost` | prompt + `turn/end` 已持久，submitted 记录缺失 | 不重新提交即结算 |

## 零 LLM 证据

`zero-llm.spec.ts` 在其四项断言后写入 `zero-llm.json`。产物记录 Host 与 Client 源文件的静态扫描（无禁止模块 import、`ctx.llm`/`ctx.tools` 访问、辅助 purpose 字面量或 `SessionEventMap` 贡献）以及六个运行时场景的七项 service journal：store 加 Remote 快照、scheduler 派发、恢复对账、压力测量与定价、handoff 正文渲染与投递、运行监督。每个 journal 值必须为 `0`；非零值会使 spec 失败。

## 矩阵断言的不变量

- 对账使用 operation source（`operationId` + `runId` +
  `generation` + `attempt`），绝不使用裸 `MessageId`。
- `uncertain` 与不可验证用例变为 `needs-attention`；不重放，
  也不创建第二个 Session。
- 每次持久状态迁移都是 revision/phase CAS；崩溃写入通过重读持久状态
  检测，而不是重放副作用。
- Scheduler 只在成功完成一轮对账后打开。
