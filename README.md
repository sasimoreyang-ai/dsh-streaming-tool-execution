# Streaming tool execution

This branch targets DSH 0.2.2-rc.1. Check the runtime version in any packaged
MindAgent image before selecting this bundle.

A DeepSeek Harness profile plugin for **DSH 0.2.2-rc.1** that starts
parallel-safe tool calls as soon as their `tool-call` block closes in the
assistant stream, instead of waiting for the assistant message to settle. The
tool body then overlaps the rest of the model decode.

This is a plugin port of the agent-loop change
`feat(agent-loop): execute parallel-safe tool calls while streaming`
(`Te-ddybear/deepseek-harness@de079108d2dcbef687ab6457b2bb7987fb67d292`), built for the
0.2.2-rc.1 runtime without patching the shipped packages.

> Local modification: this copy imports no host package, so it loads from a
> profile installation. See `NOTICE` for the exact difference from upstream.

## Compatibility

- **DSH 0.2.2-rc.1**, Node.js 22 or newer. The plugin observes the step's
  resolved tool admission and wraps the selected NativeToolExecutor pipeline.
- The version-specific hooks are ToolsService.resolve / execute / selectExecutor
  and NativeToolExecutor.pipeline. Native prepare and dispatch are reused, and
  complete plus executeToolBatch remain responsible for ordered settlement.
- Other executors retain their normal batch behavior and produce a diagnostic
  when streaming acceleration is skipped.
- The runtime module has no host imports or runtime dependencies. The optional
  DSH peer and engines field pin the supported host to 0.2.2-rc.1.

## Behavior

- A parallel-safe call (`isConcurrencySafe(args) === true`) starts while the
  model stream is still open, up to the profile's `maxParallelToolCalls`.
- Exclusive calls and every following call wait for the normal batch after the
  assistant message settles. Only parallel-safe calls start speculatively.
- Results commit in model order after the assistant message, through the
  Native executor's complete stage and executeToolBatch. Durable tool/call
  and tool/result events keep their original ordering.
- Conditional tools retain the exact toolSet resolved once for that step.

- `tools/pre-execute` policy, guards, and approval run when the speculative call
  starts; `tools/post-execute` and `tools/result` still run exactly once when
  the loop commits the call.
- Speculation is abandoned without committing a result when the attempt fails
  or is abandoned, when the step ends without consuming the call (for example
  at the output-token ceiling), when the turn is cancelled, or when the agent
  becomes idle. Abandoning aborts the body's `exec.signal`.
- **Speculative side effects cannot be undone.** A body that already wrote a
  file or sent a request stays written when the attempt is abandoned. Enable
  the plugin only where early side effects from parallel-safe tools are
  acceptable; prefer read-only or idempotent tools, and keep
  `streamingToolExecution` off for profiles that must not take that risk.

## Install

The package is a DSH bundle: `package.json` declares `dsh.bundle.patch`, and
`cordis.patch.yml` inserts one Host plugin row.

1. Make the directory available to the target machine (copy it, or pack it with
   `npm pack`).
2. Install it into the profile: `dsh plugin --profile <profile> add <tarball or
   absolute bundle directory>`, or `plugin_manager` with
   `action: install_bundle` from the Web UI's Plugins page. The installer copies
   the package into the profile and selects its bundle.
   Manual equivalent: install the package into the profile and append
   `mindagent-dsh-streaming-tool-execution` to `dsh.profile.bundles` in the
   profile's `package.json`.
3. The inserted row is enabled with `streamingToolExecution: true`; the plugin
   activates after `tools`, `agentLoop` and `llm` are available.

No second installation into the DSH package is required. The MindAgent image
additionally installs the package inside its DSH installation; that is a build
convenience, not a load requirement.

## Configuration

`cordis.patch.yml` inserts:

```yaml
- insert:
    - id: streaming-tool-execution
      name: 'mindagent-dsh-streaming-tool-execution'
      config:
        streamingToolExecution: true
```

| Field | Default | Meaning |
|---|---|---|
| `streamingToolExecution` | `false` | Start parallel-safe calls while the model stream is open. Read as a plain boolean: not schema-validated, and toggling it needs a profile reload. |

To disable the behavior without removing the bundle, override the row in the
profile's `cordis.patch.yml`:

```yaml
- id: streaming-tool-execution
  name: 'mindagent-dsh-streaming-tool-execution'
  config:
    streamingToolExecution: false
```

## Verification

Run the real 0.2.2-rc.1 AgentLoop tests with scripted adapters locally.

```sh
npm ci --ignore-scripts
npm run check
```

The tests cover streaming overlap, disabled behavior, single execution, ordered
policy and result stages, exclusive barriers, concurrency limits, conditional
tool admission, guard/approval denial, token ceilings, cancellation, retry with
reused call IDs, and unloading during both streaming and native batch execution.

An isolated CLI installation check packs the bundle, installs it into a temporary
Web profile, verifies composition, and imports a detached copy of the module.

```sh
npm run check:install -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

Real-provider performance and the browser inventory card still need deployment
validation. The package supplies localized titles and descriptions.

## Limits

- This version relies on the internal native executor lookup and pipeline fields
  listed above. Method shapes are checked and supported versions are pinned.
  Re-run compatibility tests when upgrading the host.
- Safety classification comes from each tool's isConcurrencySafe declaration.
- One model step per Agent is assumed, as in the stock loop.
- Cancellation and unloading join cooperative work. A tool that ignores its
  abort signal can delay teardown. Speculative side effects remain observable.
- npm audit reports a Zod advisory through the exact pinned DSH development
  dependency graph. This plugin ships zero runtime dependencies. Host dependency
  remediation belongs to the DSH deployment's version selection.

## License

MIT.
