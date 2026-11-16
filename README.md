# Streaming tool execution

> MindAgent note: MindAgent's DSH images already ship this bundle, so there you
> only need the image's `STREAMING-TOOL-EXECUTION.md` for wiring and
> verification. In any other DSH 0.2.0-rc.2 installation, install it with the
> steps under [Install](#install).

A DeepSeek Harness profile plugin for **DSH 0.2.0-rc.2** that starts
parallel-safe tool calls as soon as their `tool-call` block closes in the
assistant stream, instead of waiting for the assistant message to settle. The
tool body then overlaps the rest of the model decode.

This is a plugin port of the agent-loop change
`feat(agent-loop): execute parallel-safe tool calls while streaming`
(`Te-ddybear/deepseek-harness@de079108d2dcbef687ab6457b2bb7987fb67d292`), built for the
0.2.0-rc.2 runtime without patching the shipped packages.

> Local modification: this copy imports no host package, so it loads from a
> profile installation. See `NOTICE` for the exact difference from upstream.

## Compatibility

- **DSH 0.2.0-rc.2 only.** The plugin wraps the internal
  `TOOL_RUNTIME_SCHEDULER` staged tool pipeline (`prepare` / `dispatch`) of the
  0.2.0-rc.2 `dsh-agent-loop`. DSH 0.2.1 and later moved tool batches to the
  `ToolExecutor` API, where the pipeline this plugin wraps no longer exists, so
  activation fails there; keep it out of those profiles.
- No runtime dependencies and no host imports: the scheduler symbol is found by
  its description on the `tools` service instead of importing
  `@deepseek-ai/dsh-tools`, so a copy installed into a profile loads without a
  package anchor. `peerDependencies` pins `@deepseek-ai/dsh` to `0.2.0-rc.2`, so
  DSH refuses a mismatched installation unless an explicit
  `dsh plugin allow-version … --accept-risk` exemption is granted.

## Behavior

- A parallel-safe call (`isConcurrencySafe(args) === true`) starts while the
  model stream is still open, up to the profile's `maxParallelToolCalls`.
- Exclusive calls remain ordering barriers: they wait for earlier calls and
  later calls wait for them.
- Results still commit in model order **after** the assistant message, through
  the loop's own `finalize` / `finish` stages. The durable `tool/call` event is
  therefore written after `assistant/message`, exactly as without the plugin.
  The core Harness change logs `tool/call` early and adds a session-repair
  tolerance; this plugin avoids both by not writing session state early.
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
   activates after `tools` and `agentLoop` are available.

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

Verified against an isolated `@deepseek-ai/dsh@0.2.0-rc.2` installation with
scripted mock adapters at the Cordis level:

- a parallel-safe tool starts while the stream is gated, before
  `assistant/message`, and the body runs exactly once;
- with the plugin disabled the tool starts only after the message settles;
- two parallel calls both overlap decode and commit in model order;
- an exclusive call keeps a later call behind its barrier;
- `max-tokens` starts the body and then abandons it with an abort signal and no
  committed result;
- a failed attempt abandons its body and a retry succeeds cleanly;
- `tools/pre-execute`, `tools/execute`, `tools/post-execute`, and `tools/result`
  each run once per call;
- unloading the plugin restores the original scheduler stages;
- the bundle loads through the 0.2.0-rc.2 Cordis loader, and a composed
  0.2.0-rc.2 profile shows the inserted row.

Additionally verified against a stock `@deepseek-ai/dsh@0.2.0-rc.2` install:
`dsh plugin --profile web add` succeeds, the installed copy imports with no host
package resolvable, a scripted scheduler shows the speculative start, claiming
the call does not re-run its body, and unloading restores the stages.

The plugin row's rendered plugin-inventory card was not visually verified in a
0.2.0-rc.2 browser session; title and description are provided. This package
intentionally ships no icon, so the inventory UI should use its default icon.

## Limits

- The plugin patches the scheduler object DSH keeps under its internal
  `TOOL_RUNTIME_SCHEDULER` symbol, found by the symbol's description
  `@deepseek-ai/dsh-tools.scheduler`. It restores the original methods on
  unload, but a rebuild that renames the symbol or changes that internal object
  makes activation fail loudly.
- Parallel-safe classification comes from each tool's `isConcurrencySafe`;
  there is no per-tool allowlist.
- One model step per agent is assumed (the agent loop is serial per agent).
- Abandoning speculation stops cooperative work; it cannot hard-kill a body
  that ignores `exec.signal`.

## License

MIT. See `LICENSE` for the license text and `NOTICE` for provenance and the
local modifications relative to upstream.
