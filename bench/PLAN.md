# 收益评测测试方案（v2，严谨版）

本方案是 `bench/` 目录的执行依据。v1 的教训：只测了"单工具尾部"与"等长顺序流"两种形态，
恰好都是收益下限为零的形态，导致结论（"收益≈0"）与 long-short 实测（+13.5%）矛盾。
v2 以**形态矩阵**覆盖全部关键路径形状，并以解析解对账。

## 1. 被测对象与固定条件

| 项 | 值 |
|---|---|
| 宿主 | `@deepseek-ai/dsh@0.2.2-rc.1`（进程内 harness：真 agent-loop + 真 NativeToolExecutor + testkit） |
| 插件 | `mindagent-dsh-streaming-tool-execution@0.2.2-rc.1`（main 分支） |
| 模型 | 进程内脚本化 adapter，**逐 delta 时延可控** |
| 工具 | sleep 探针（`isConcurrencySafe` 可控、耗时可控），执行计数器内置 |
| 并发上限 | `maxParallelToolCalls = 10` |
| 隔离 | 每 case 独立 Context；`finally` 中 dispose；无网络 |

## 2. 流式形态矩阵（自变量）

Δ_first = 首个 tool-call 块闭合 → 消息落库的间隔；Δ_tail = **最后一个**块闭合 → 消息落库。

| 编号 | 形态 | 构造 | 关键路径形状 | 预期收益（解析解） |
|---|---|---|---|---|
| F1 | 单工具·尾部 | 1 个调用后直接 finish | 尾部无流 | ≈0（Δ_tail≈finish 开销） |
| F2 | 等长顺序流 | 3 个等耗时调用逐个闭合 | 最后一个调用卡尾 | ≈0 |
| F3 | **长短混合** | 长调用(1500ms)先闭合，短调用(50ms)随后 | **长调用是关键路径且提前闭合** | ≈ 长调用块闭合→批量的间隔 |
| F4 | 文本后置 | 1 个调用后继续流 400ms 文本 | 尾部有长流 | ≈ min(T, Δ_first) |
| F5 | 并发会话 | F3 形态 × 1/4/8 会话同 Context | 同 F3 | 验证不串扰、不衰减 |

F1/F2 是收益下限哨兵，F4 是机制上界，**F3 是现实主场景**（编码 agent 常见）。

## 3. 观测指标与打点

| 指标 | 打点位置 |
|---|---|
| `ttft` | 首个 `agent/assistant-stream` chunk 帧 |
| `b_i` | 第 i 个 `block-end(tool-call)` 帧 |
| `toolStart_i` / `toolEnd_i` | 工具体 execute 入口 / finally |
| `messageCommit` | `session/event` type=`assistant/message` |
| `tool/call`、`tool/result` | `session/event` |
| `turnEnd` | `agent/status=idle` |
| 执行次数 | 工具体内置计数器（必须 == 调用数） |

派生量：`Δ_first = toolStart_base(first) − b_first(first 块闭合后)`、
`Δ_tail = 基线批量启动 − 最后一个块闭合`、
`gain = turnEnd_base − turnEnd_on`、
理论收益 per 形态见 §2。

## 4. 判据（通过/失败定义）

**语义安全（全部形态必须满足，否则 FAIL）**
- S1 每个调用的工具体执行次数 == 1；
- S2 `messageCommit ≤ tool/call ≤ tool/result`（逐样本）；
- S3 两臂 `ttft` 差值 < 2ms 且不系统性偏向插件；
- S4 卸载后 `tools.resolve/execute` descriptor 与挂载前相等；
- S5 控制组（纯文本、独占工具）`turnEnd` 偏差 < 1%。

**收益（按形态分别判定）**
- B1 F3/F4：插件臂 `toolStart`（关键路径工具）显著早于基线（>90% Δ_first）；
- B2 `gain` 与解析解 `min(T_关键, Δ_对应)` 的吻合度在 85%–115% 区间（超出即查因）；
- B3 F1/F2：|gain| < 5ms（确认下限为零，插件不虚构收益）；
- B4 F5：会话数增加时 per-session `turnEnd` 不劣化超过噪声，执行次数仍 == 调用数。

## 5. 噪声控制

1. 进程级 warmup 两轮弃置；
2. 每个重复内 A/B **交错**执行；
3. 每格 5 次重复，报告 p50 与 max；
4. A/B 分臂先后不固定（奇偶轮交换顺序）；
5. 禁止同一 Context 复用于不同 case；
6. 机器后台负载不控（家用机），因此以 p50 与解析解对账，不采用绝对单次值。

## 6. 产物

- `bench/out/samples-v2.jsonl`（逐样本）
- `bench/out/plan-v2.json`（形态×判据×结果的机器可读汇总）
- 本文件作为方案存档，随报告引用。

## 7. 与 v1 报告的差异声明

v1 报告的"延迟矩阵"（Δ 60–400ms 人为供给）保留为**机制上界**；v2 新增 F3/F5 作为**现实主场景**，
并在最终报告中以 F3 的实测收益作为生产预期，F1/F2 作为下限哨兵。
