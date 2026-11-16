/**
 * Streaming tool execution for the DeepSeek Harness 0.2.0-rc.2.
 *
 * Port of the agent-loop change "execute parallel-safe tool calls while
 * streaming" as a profile plugin: a parallel-safe model tool call starts as
 * soon as its `tool-call` block closes in the assistant stream, instead of
 * waiting for the assistant message to settle.
 *
 * The 0.2.0-rc.2 agent loop drives its staged tool pipeline through
 * `TOOL_RUNTIME_SCHEDULER`. This plugin wraps the `prepare` and `dispatch`
 * stages of that scheduler object: blocks observed on `agent/assistant-stream`
 * are prepared and dispatched speculatively, and when the loop later prepares
 * and dispatches the same call id it reuses the already-started execution.
 * Results still commit in model order after the assistant message, through the
 * loop's own `finalize`/`finish` stages, so the durable session ordering does
 * not change and nothing is persisted before the message settles.
 *
 * Speculation is abandoned without committing a result when the attempt fails,
 * the step ends without consuming the call (for example at the output-token
 * ceiling), the turn is cancelled, or the agent becomes idle. A body that
 * already produced side effects cannot be undone: enable this only for tools
 * whose early side effects are acceptable.
 *
 * @module mindagent-dsh-streaming-tool-execution
 */
// Local modification (not upstream): this module imports nothing from the host,
// so a profile-installed copy never has to resolve `@deepseek-ai/dsh-tools` or
// `@deepseek-ai/schemastery`. Importing a second copy of `dsh-tools` would also
// create a different Symbol and never match the host's scheduler.
const SCHEDULER_SYMBOL_DESCRIPTION = '@deepseek-ai/dsh-tools.scheduler'

/** Loader row name. */
export const name = 'streaming-tool-execution'

/** Services this plugin needs before it can activate. */
export const inject = ['tools', 'agentLoop']

const ABANDON_ERROR = 'tool call abandoned with its model attempt'

/** Model arguments: invalid JSON stays text; empty input is an empty object. */
function parseArguments(raw) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * Activate the plugin.
 * @param ctx - host context owning the tool runtime and agent loop.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const schedulerSymbol = Object.getOwnPropertySymbols(ctx.tools)
    .find(symbol => symbol.description === SCHEDULER_SYMBOL_DESCRIPTION)
  const scheduler = schedulerSymbol === undefined ? undefined : ctx.tools[schedulerSymbol]
  if (scheduler === undefined
    || typeof scheduler.prepare !== 'function' || typeof scheduler.dispatch !== 'function') {
    throw new Error(`streaming-tool-execution requires the DSH 0.2.0-rc.2 tool pipeline (`
      + `symbol ${SCHEDULER_SYMBOL_DESCRIPTION}); this host does not expose it`)
  }

  const logger = ctx.logger('streaming-tool-execution')
  const originalPrepare = scheduler.prepare
  const originalDispatch = scheduler.dispatch

  /** Speculative executions by step, keyed by agent id. */
  const steps = new Map()
  /** Unclaimed speculative executions by `agentId + callId`. */
  const pending = new Map()
  /** Speculative execution awaiting the loop's dispatch, keyed by its prepared exec. */
  const preparedExecs = new WeakMap()
  let disposed = false

  const enabled = () => {
    const field = config?.streamingToolExecution
    return typeof field?.get === 'function' ? field.get() === true : field === true
  }
  const keyOf = (agentId, callId) => `${agentId ?? ''}\u0000${callId}`

  /** Create one model step's speculative scheduler state. */
  const createStep = (agent, turn, step, signal) => {
    const controller = new AbortController()
    return {
      agent,
      turn,
      step,
      signal,
      controller,
      attemptId: undefined,
      execSignal: AbortSignal.any([signal, controller.signal]),
      calls: [],
      byId: new Map(),
      inFlight: new Set(),
      nextToStart: 0,
      exclusive: false,
      abandoned: false,
    }
  }

  /** Cancel every outstanding speculative call in a step without committing results. */
  const abandon = state => {
    if (state.abandoned) return
    state.abandoned = true
    state.controller.abort(new Error(ABANDON_ERROR))
    for (const entry of state.calls) {
      if (!entry.served) pending.delete(keyOf(state.agent.id, entry.block.id))
    }
  }

  /** Abandon and forget one agent's current step state. */
  const retire = agentId => {
    const state = steps.get(agentId)
    if (state === undefined) return
    abandon(state)
    steps.delete(agentId)
  }

  /** Record one speculative execution's prepared/outcome promises. Idempotent. */
  const startCall = (state, entry, exclusive) => {
    if (entry.started) return
    entry.started = true
    let prepared
    try {
      prepared = Promise.resolve(originalPrepare(entry.input))
    } catch (error) {
      prepared = Promise.reject(error)
    }
    entry.prepared = prepared
    const outcome = prepared.then(preparation => {
      if (preparation?.kind !== 'dispatch') return preparation
      return originalDispatch(preparation.exec)
    })
    // The loop only awaits this promise when it claims the call; keep an
    // abandoned or failed speculation from surfacing as an unhandled rejection.
    void outcome.catch(() => {})
    entry.outcome = outcome
    const tracked = outcome.then(
      () => {},
      error => { logger.warn(`streaming tool execution: speculative call failed: ${error}`) },
    ).finally(() => {
      state.inFlight.delete(entry)
      if (exclusive) state.exclusive = false
      pump(state)
    })
    state.inFlight.add(entry)
    void tracked
  }

  /** Classify one offered call: only an exact `parallel` mode may overlap. */
  const classify = entry => {
    try {
      return ctx.tools.executionMode(entry.input).kind !== 'parallel'
    } catch (error) {
      logger.warn(`streaming tool execution: executionMode failed for "${entry.block.name}": ${error}`)
      return true
    }
  }

  /** Start every offered call the current concurrency mode and pool permit. */
  const pump = state => {
    if (disposed || state.abandoned) return
    while (state.nextToStart < state.calls.length) {
      if (state.exclusive) return
      const maxParallel = ctx.agentLoop.config.maxParallelToolCalls.get()
      if (state.inFlight.size >= maxParallel) return
      const entry = state.calls[state.nextToStart]
      if (entry.started) {
        // The loop claimed this call before the pool reached it.
        state.nextToStart++
        continue
      }
      const exclusive = classify(entry)
      // An exclusive call waits for every earlier call, then runs alone.
      if (exclusive && state.inFlight.size > 0) return
      state.nextToStart++
      startCall(state, entry, exclusive)
      if (exclusive) {
        state.exclusive = true
        return
      }
    }
  }

  /** Offer one closed `tool-call` block from the live assistant stream. */
  const offer = (state, block) => {
    if (state.abandoned || state.byId.has(block.id) || state.signal.aborted) return
    const entry = {
      state,
      block,
      input: {
        callId: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        agent: state.agent,
        signal: state.execSignal,
      },
      prepared: undefined,
      outcome: undefined,
      started: false,
      served: false,
    }
    state.calls.push(entry)
    state.byId.set(block.id, entry)
    pending.set(keyOf(state.agent.id, block.id), entry)
    pump(state)
  }

  /** The loop asks for the call: hand back its already-prepared execution. */
  const prepare = input => {
    const key = keyOf(input.agent?.id, input.callId)
    const entry = pending.get(key)
    if (entry === undefined || entry.served || entry.state.abandoned) return originalPrepare(input)
    entry.served = true
    pending.delete(key)
    if (!entry.started) {
      // The loop reached a call the pool had not started yet: the previous
      // call kept the slot busy while the message settled. Start it now; the
      // loop is already waiting for this prepare.
      startCall(entry.state, entry, classify(entry))
    }
    return entry.prepared.then(preparation => {
      if (preparation?.kind === 'dispatch') preparedExecs.set(preparation.exec, entry)
      return preparation
    })
  }

  /** The loop dispatches the call: return the outcome the speculative body produced. */
  const dispatch = exec => {
    const entry = preparedExecs.get(exec)
    if (entry === undefined) return originalDispatch(exec)
    preparedExecs.delete(exec)
    return entry.outcome
  }

  const onRequest = (payload, next) => {
    try {
      const { agent, turn, step, signal } = payload
      if (agent !== undefined) {
        // A new step, or a retry of the same step after a failed attempt:
        // earlier speculation can no longer commit.
        retire(agent.id)
        steps.set(agent.id, createStep(agent, turn, step, signal))
      }
    } catch (error) {
      logger.warn(`streaming tool execution: step bookkeeping failed: ${error}`)
    }
    return next()
  }

  const onFrame = payload => {
    if (!enabled() || disposed) return
    try {
      const { agent, frame } = payload
      if (agent === undefined) return
      const state = steps.get(agent.id)
      if (state === undefined) return
      if (frame?.type === 'start') {
        // Chunk frames carry no turn/step; the attempt start binds them.
        state.attemptId = frame.attemptId
        return
      }
      if (frame?.type === 'end') {
        // An abandoned attempt committed no message, so its speculation can
        // never be claimed; the loop retries or closes the step.
        if (frame.outcome?.kind === 'abandoned') abandon(state)
        return
      }
      if (frame?.type !== 'chunk') return
      if (state.attemptId !== undefined && state.attemptId !== frame.attemptId) return
      const chunk = frame.chunk
      if (chunk?.type !== 'block-end' || chunk.block?.type !== 'tool-call') return
      offer(state, chunk.block)
    } catch (error) {
      logger.warn(`streaming tool execution: speculative start failed: ${error}`)
    }
  }

  const onStatus = payload => {
    if (payload?.status === 'idle' && payload.agent !== undefined) retire(payload.agent.id)
  }

  const onDisposed = payload => {
    if (payload?.agent !== undefined) retire(payload.agent.id)
  }

  scheduler.prepare = prepare
  scheduler.dispatch = dispatch
  ctx.on('agent/request', onRequest)
  ctx.on('agent/assistant-stream', onFrame)
  ctx.on('agent/status', onStatus)
  ctx.on('agent/disposed', onDisposed)

  ctx.effect(() => () => {
    disposed = true
    for (const agentId of [...steps.keys()]) retire(agentId)
    if (scheduler.prepare === prepare) scheduler.prepare = originalPrepare
    if (scheduler.dispatch === dispatch) scheduler.dispatch = originalDispatch
  })
}
