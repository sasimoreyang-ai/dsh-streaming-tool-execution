# 流式工具执行

本分支适配 DSH 0.2.2-rc.1。使用 MindAgent 镜像时，请先核对镜像中的 DSH 版本。

面向 **DSH 0.2.2-rc.1** 的 DeepSeek Harness 配置插件：并行安全的工具调用在模型流中的
`tool-call` 块一闭合就立即开始，而不是等待 assistant message 结算；工具执行体与剩余的
模型解码过程重叠。

本插件是 agent-loop 变更
`feat(agent-loop): execute parallel-safe tool calls while streaming`
（`Te-ddybear/deepseek-harness@de079108d2dcbef687ab6457b2bb7987fb67d292`）的插件化移植，面向
0.2.2-rc.1 运行时。

> 本地改动：本副本不 import 任何 host 包，因此可以从 profile 安装直接加载；与上游的差异见
> `NOTICE`。

## 兼容性

- 支持 **DSH 0.2.2-rc.1** 和 Node.js 22+。插件保留该步骤已解析的工具准入集合，
  包装所选 NativeToolExecutor 的工具执行管线。
- 版本相关接入点为 ToolsService.resolve、execute、selectExecutor，以及
  NativeToolExecutor.pipeline。复用 prepare 和 dispatch 的结果，由原生 complete
  和 executeToolBatch 完成按序提交。
- 其他执行器继续使用其正常批处理行为，并输出跳过流式加速的诊断。
- 运行模块保持零 host import、零运行时依赖，DSH peer 和 engines 均锁定 0.2.2-rc.1。

## 行为

- 并行安全的调用（`isConcurrencySafe(args) === true`）在模型流仍打开时就开始，并发上限为
  profile 的 `maxParallelToolCalls`。
- 独占调用以及其后的调用等待模型消息结算，再进入原生批处理。提前启动限于并行安全调用。
- 结果在 assistant message 之后，经过原生执行器的 complete 和 executeToolBatch 按模型
  顺序提交，保留 tool/call 和 tool/result 的原有日志顺序。
- 条件工具继承该步骤一次性解析的 toolSet，提前执行也遵守相同的准入结果。
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

在真实的 0.2.2-rc.1 AgentLoop 上使用脚本化模型适配器运行测试。

```sh
npm ci --ignore-scripts
npm run check
```

测试覆盖提前执行、关闭插件、单次执行、策略和结果按序提交、独占屏障、并发上限、
条件工具准入、守卫与审批拒绝、token 上限、取消清理、复用调用 ID 的失败重试，
以及流式阶段和原生批处理期间卸载。

安装检查会打包插件，在独立临时 Web profile 中安装、核对配置合成，并导入脱离 host
依赖目录的模块副本。传入本机已安装的 DSH CLI 入口路径即可运行。

```sh
npm run check:install -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

真实模型的性能收益和浏览器插件清单卡片仍需现场验证。本包提供本地化标题与描述。

## 限制

- 本版依赖上述内部执行器查找和管线字段，启动时检查方法形状，并锁定支持的 DSH 版本。
  升级 host 时需要重新运行兼容性测试。
- 并行安全分类来自工具的 isConcurrencySafe 声明。
- 按原生循环约定，每个 Agent 同时运行一个模型步骤。
- 取消与卸载会等待协作式任务清理，忽略 abort signal 的工具可能延迟退出。
  已发生的推测性副作用仍然保留。
- npm audit 在锁定的 DSH 开发依赖链中报告 Zod 告警。插件发布包为零运行时依赖，
  host 依赖修复需结合部署所选的 DSH 版本处理。

## 许可证

MIT。
