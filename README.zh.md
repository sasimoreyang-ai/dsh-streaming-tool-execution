# 流式工具执行

> MindAgent 说明：本 bundle 随 MindAgent DSH 源镜像构建并默认启用，不要在插件市场中重复安装；
> 接线与验收见镜像构建目录的 `STREAMING-TOOL-EXECUTION.md`。

面向 **DSH 0.2.0-rc.2** 的 DeepSeek Harness 配置插件：并行安全的工具调用在模型流中的
`tool-call` 块一闭合就立即开始，而不是等待 assistant message 结算；工具执行体与剩余的
模型解码过程重叠。

本插件是 agent-loop 变更
`feat(agent-loop): execute parallel-safe tool calls while streaming`
（`Te-ddybear/deepseek-harness@de079108d2dcbef687ab6457b2bb7987fb67d292`）的插件化移植，面向
0.2.0-rc.2 运行时。

> 本地改动：本副本不 import 任何 host 包，因此可以从 profile 安装直接加载；与上游的差异见
> `NOTICE`。

## 兼容性

- **仅支持 DSH 0.2.0-rc.2。** 插件包装 0.2.0-rc.2 `dsh-agent-loop` 内部
  `TOOL_RUNTIME_SCHEDULER` 分阶段工具流水线的 `prepare` / `dispatch`。DSH 0.2.1 及之后把
  工具批次迁移到 `ToolExecutor` API，因此插件在这些版本上激活即报错；请勿把这些 profile 配进来。
- 无运行时依赖，也不 import 任何 host 包：调度器符号在 `tools` 服务上按描述
  `@deepseek-ai/dsh-tools.scheduler` 查找，因此装进 profile 的副本无需安装锚点即可加载。
  `peerDependencies` 已把 `@deepseek-ai/dsh` 钉在 `0.2.0-rc.2`，版本不符时 DSH 会拒绝安装，
  除非显式 `dsh plugin allow-version … --accept-risk` 放行。

## 行为

- 并行安全的调用（`isConcurrencySafe(args) === true`）在模型流仍打开时就开始，并发上限为
  profile 的 `maxParallelToolCalls`。
- 独占调用仍是排序屏障：它们等待更早的调用，后续调用等待它们。
- 结果仍然在 assistant message **之后**按模型顺序通过循环自身的 `finalize` / `finish`
  提交。因此持久 `tool/call` 事件仍写在 `assistant/message` 之后，与未启用插件时一致。核心
  Harness 变更会提前写 `tool/call` 并增加会话修复容错；本插件不提前写会话状态，因此两者都不需要。
- `tools/pre-execute` 策略、守卫与审批在推测调用开始时运行；`tools/post-execute` 与
  `tools/result` 仍在循环提交该调用时各运行一次。
- 以下情况会放弃推测且不提交结果：尝试失败或被放弃、步骤结束但未消费该调用（例如输出 token
  上限）、轮次取消、agent 进入 idle。放弃会中止执行体的 `exec.signal`。
- **推测性副作用无法撤销。** 如果执行体已经写了文件或发出了请求，尝试被放弃后这些副作用仍然
  存在。仅在对并行安全工具的提前副作用可接受时启用；优先使用只读或幂等工具，并在不能承担该
  风险的 profile 中保持 `streamingToolExecution` 关闭。

## 安装

本包是 DSH bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入一个 Host
插件行。

1. 将目录放到目标机器（复制，或使用 `npm pack` 打包）。
2. 装进 profile：`dsh plugin --profile <profile> add <tarball 或 bundle 目录绝对路径>`，
   或 Web UI 插件页的 `plugin_manager`（`action: install_bundle`）。安装器会把包复制进
   profile 并选中它的 bundle。
   手动等价做法：把包装进 profile，并把 `mindagent-dsh-streaming-tool-execution` 追加到
   profile `package.json` 的 `dsh.profile.bundles`。
3. 插入的行默认以 `streamingToolExecution: true` 启用；插件在 `tools` 与 `agentLoop`
   就绪后激活。

不需要再往 DSH 安装目录里装第二份。MindAgent 镜像仍会把它同时装进 DSH 安装作用域，那是构建期
的便利做法，不是加载前提。

## 配置

`cordis.patch.yml` 插入：

```yaml
- insert:
    - id: streaming-tool-execution
      name: 'mindagent-dsh-streaming-tool-execution'
      config:
        streamingToolExecution: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `streamingToolExecution` | `false` | 在模型流打开时启动并行安全调用。按普通布尔值读取：不经 schema 校验，切换后需重新加载 profile。 |

若要在不移除 bundle 的情况下关闭行为，在 profile 的 `cordis.patch.yml` 覆盖该行：

```yaml
- id: streaming-tool-execution
  name: 'mindagent-dsh-streaming-tool-execution'
  config:
    streamingToolExecution: false
```

## 验证

在隔离的 `@deepseek-ai/dsh@0.2.0-rc.2` 安装上，用脚本化 mock adapter 在 Cordis 层验证：

- 并行安全工具在流被 gate 住时、`assistant/message` 之前启动，且执行体只运行一次；
- 关闭插件时工具只在 message 结算后启动；
- 两个并行调用都重叠解码，并按模型顺序提交；
- 独占调用会把后续调用挡在屏障之后；
- `max-tokens` 会启动执行体，随后带中止信号放弃且不提交结果；
- 失败尝试会放弃其执行体，重试可正常完成；
- `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` 每次调用各运行一次；
- 卸载插件会恢复原始调度阶段；
- bundle 能通过 0.2.0-rc.2 Cordis loader 加载，组合后的 0.2.0-rc.2 profile 能显示插入的行。

另在 stock `@deepseek-ai/dsh@0.2.0-rc.2` 安装上实测：`dsh plugin --profile web add` 成功，
装进 profile 的副本在解不到任何 host 包的前提下 import 通过，脚本化调度器验证了推测启动、
认领不重跑、卸载还原三个阶段。

尚未在 0.2.0-rc.2 浏览器会话中对插件清单卡片做视觉验证；标题与描述均已提供。本包
不提供图标，插件清单界面预期使用其默认图标。

## 限制

- 插件修改 DSH 放在内部 `TOOL_RUNTIME_SCHEDULER` 符号下的调度对象，该符号按描述
  `@deepseek-ai/dsh-tools.scheduler` 发现。卸载时会恢复原始方法，但若重建改了符号名或该
  内部对象，激活时会直接报错（不再静默）。
- 并行安全分类来自每个工具的 `isConcurrencySafe`；没有按工具的白名单。
- 假设每个 agent 同时只有一个模型步骤（agent loop 对单个 agent 是串行的）。
- 放弃只能停止协作式工作，无法强制终止忽略 `exec.signal` 的执行体。

## 许可证

MIT。
