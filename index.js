/**
 * Streaming tool execution for DSH 0.2.2-rc.1.
 * NativeToolExecutor owns a ToolExecutionPipeline in this release. We reuse
 * its prepare/dispatch results and leave completion and durable batch logging
 * to that executor. Host packages are deliberately resolved by the host only.
 */
export const name = 'streaming-tool-execution'
export const inject = ['tools', 'agentLoop', 'llm']

const ABANDON_ERROR = 'tool call abandoned with its model attempt'
const OWNER = Symbol.for('mindagent.streaming-tool-execution.owner')

function parseArguments(raw) {
  try { return raw ? JSON.parse(raw) : {} }
  catch { return raw }
}

/** Install version-specific interception, owned and restored by this Cordis fiber. */
export function apply(ctx, config) {
  const tools = ctx.tools
  if (typeof tools.resolve !== 'function' || typeof tools.selectExecutor !== 'function') {
    throw new Error('streaming-tool-execution requires DSH 0.2.2-rc.1 ToolsService and NativeToolExecutor')
  }
  if (tools[OWNER]) throw new Error('streaming-tool-execution is already mounted on this tools service')
  const owner = {}
  tools[OWNER] = owner
  const logger = ctx.logger('streaming-tool-execution')
  const originalResolve = tools.resolve
  const originalExecute = tools.execute
  const resolveDescriptor = Object.getOwnPropertyDescriptor(tools, 'resolve')
  const executeDescriptor = Object.getOwnPropertyDescriptor(tools, 'execute')
  const admissions = new WeakMap()
  const steps = new Map()
  const draining = new Map()
  const pipelines = new Map()
  const batches = new Set()
  const warnedExecutors = new WeakSet()
  let disposed = false
  const enabled = () => {
    const field = config?.streamingToolExecution
    return typeof field?.get === 'function' ? field.get() === true : field === true
  }

  function abandon(state) {
    state.abandoned = true
    state.controller.abort(new Error(ABANDON_ERROR))
  }

  async function drain(state) {
    // The pump can still be waiting for an approval before publishing an outcome.
    await state.pumping
    await Promise.allSettled(state.calls.filter(entry => entry.started).map(entry => entry.outcome))
  }

  function retire(agent) {
    const state = steps.get(agent)
    if (!state) return draining.get(agent) ?? Promise.resolve()
    steps.delete(agent)
    state.signal.removeEventListener('abort', state.onAbort)
    abandon(state)
    const previous = draining.get(agent)
    const work = Promise.allSettled([previous, drain(state)]).then(() => {})
    draining.set(agent, work)
    void work.finally(() => { if (draining.get(agent) === work) draining.delete(agent) })
    return work
  }

  function attachPipeline(executor) {
    // Other executors own program bindings and restrictions. Leave their calls
    // entirely with their provider instead of treating them as native calls.
    if (executor.constructor?.name !== 'NativeToolExecutor') {
      if (!warnedExecutors.has(executor)) {
        warnedExecutors.add(executor)
        logger.warn('streaming-tool-execution: selected executor is not NativeToolExecutor; using normal batch execution')
      }
      return undefined
    }
    const pipeline = executor.pipeline
    if (!pipeline || !['executionMode', 'prepare', 'dispatch', 'complete'].every(key => typeof pipeline[key] === 'function')) {
      throw new Error('streaming-tool-execution: incompatible DSH 0.2.2-rc.1 NativeToolExecutor pipeline')
    }
    if (pipelines.has(pipeline)) return pipelines.get(pipeline)
    const originalPrepare = pipeline.prepare
    const originalDispatch = pipeline.dispatch
    const preparedExecs = new WeakMap()
    const record = { pipeline, originalPrepare, originalDispatch }
    const prepare = async input => {
      const state = steps.get(input.agent)
      const entry = state?.byId.get(input.callId)
      if (!state?.claiming || state.abandoned || state.record !== record || input.parent !== undefined
        || input.toolSet !== state.toolSet || !entry?.started || entry.served
        || entry.block.name !== input.name
        || JSON.stringify(entry.input.arguments) !== JSON.stringify(input.arguments)) {
        return originalPrepare.call(pipeline, input)
      }
      entry.served = true
      const prepared = await entry.prepared
      if (prepared.kind === 'dispatch') preparedExecs.set(prepared.exec, entry)
      return prepared
    }
    const dispatch = exec => {
      const entry = preparedExecs.get(exec)
      if (!entry) return originalDispatch.call(pipeline, exec)
      preparedExecs.delete(exec)
      return entry.outcome
    }
    Object.assign(record, { prepare, dispatch })
    pipeline.prepare = prepare
    pipeline.dispatch = dispatch
    pipelines.set(pipeline, record)
    return record
  }

  function pump(state) {
    if (state.pumping || state.blocked || state.abandoned || state.claiming || disposed || !enabled()) return
    state.pumping = (async () => {
      while (!state.abandoned && !state.claiming && !disposed && enabled() && state.next < state.calls.length) {
        const limit = ctx.agentLoop.config.maxParallelToolCalls.get()
        if (!Number.isInteger(limit) || limit < 1 || state.inFlight.size >= limit) return
        const entry = state.calls[state.next]
        // An exclusive or invalid call is a hard boundary for speculation.
        // It and every following call wait for the native model-ordered batch.
        if (state.record.pipeline.executionMode(entry.input).kind !== 'parallel') {
          state.blocked = true
          return
        }
        state.next++
        entry.started = true
        const { pipeline, originalPrepare, originalDispatch } = state.record
        entry.prepared = Promise.resolve().then(() => originalPrepare.call(pipeline, entry.input))
        entry.outcome = entry.prepared.then(prepared => prepared.kind === 'dispatch'
          ? originalDispatch.call(pipeline, prepared.exec) : prepared)
        state.inFlight.add(entry)
        void entry.outcome.catch(error => logger.warn(`streaming-tool-execution: speculative pipeline failed: ${error}`))
          .finally(() => { state.inFlight.delete(entry); pump(state) })
        // Policy gates remain ordered even while accepted bodies overlap.
        await entry.prepared
      }
    })().catch(error => {
      logger.warn(`streaming-tool-execution: speculative scheduling stopped: ${error}`)
      abandon(state)
    }).finally(() => {
      state.pumping = undefined
      // Settlements may have requested replenishment while the gate was awaited.
      const limit = ctx.agentLoop.config.maxParallelToolCalls.get()
      if (!state.blocked && !state.abandoned && !state.claiming && state.next < state.calls.length
        && Number.isInteger(limit) && limit > 0 && state.inFlight.size < limit) pump(state)
    })
  }

  const resolve = async function (context) {
    // Resolve remains the host's single evaluation of conditional activation.
    const toolSet = await originalResolve.call(this, context)
    if (context.agent && !disposed) admissions.set(context.agent, { toolSet, signal: context.signal })
    return toolSet
  }

  const execute = function (input) {
    const run = async () => {
      const state = steps.get(input.agent)
      if (!state) return originalExecute.call(this, input)
      // Service calls and nested work must not claim a model step's speculation.
      if (input.log?.turn !== state.turn || input.log?.step !== state.step) return originalExecute.call(this, input)
      const matches = input.toolSet === state.toolSet && tools.selectExecutor(input.agent) === state.executor
        && state.calls.every(entry => input.calls.some(block => block.id === entry.block.id
          && block.name === entry.block.name && block.arguments === entry.block.arguments))
        && new Set(input.calls.map(block => block.id)).size === input.calls.length
      if (!matches || state.abandoned) {
        await retire(input.agent)
        return originalExecute.call(this, input)
      }
      state.claiming = true
      const onAbort = () => abandon(state)
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) onAbort()
      try { return await originalExecute.call(this, { ...input,
        signal: AbortSignal.any([input.signal, state.controller.signal]) }) }
      finally {
        input.signal.removeEventListener('abort', onAbort)
        // Unclaimed calls (e.g. cancellation skips) must drain before batch return.
        await retire(input.agent)
      }
    }
    const work = run()
    batches.add(work)
    void work.then(() => batches.delete(work), () => batches.delete(work))
    return work
  }

  const onRequest = async (payload, next) => {
    const { agent, turn, step, signal } = payload
    if (!agent) return next()
    await retire(agent)
    if (!enabled() || disposed || signal.aborted) return next()
    const admission = admissions.get(agent)
    if (!admission || admission.signal !== signal) return next()
    const executor = tools.selectExecutor(agent)
    const record = attachPipeline(executor)
    if (!record) return next()
    const controller = new AbortController()
    const state = { agent, turn, step, signal, executor, record, controller, toolSet: admission.toolSet,
      execSignal: AbortSignal.any([signal, controller.signal]), calls: [], byId: new Map(),
      inFlight: new Set(), next: 0, claiming: false, abandoned: false, blocked: false, pumping: undefined }
    state.onAbort = () => abandon(state)
    signal.addEventListener('abort', state.onAbort, { once: true })
    steps.set(agent, state)
    try { return await next() }
    catch (error) { await retire(agent); throw error }
  }

  const onFrame = ({ agent, frame }) => {
    const state = steps.get(agent)
    if (!state || state.abandoned || disposed) return
    if (frame.type === 'start') {
      if (frame.turn === state.turn && frame.step === state.step) state.attemptId = frame.attemptId
      return
    }
    if (state.attemptId === undefined || frame.attemptId !== state.attemptId) return
    if (frame.type === 'end') {
      if (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt') void retire(agent)
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'finish' && ['max-tokens', 'error', 'aborted'].includes(chunk.reason?.kind)) {
      void retire(agent)
      return
    }
    if (!enabled() || state.claiming || chunk.type !== 'block-end' || chunk.block?.type !== 'tool-call') return
    const block = chunk.block
    if (state.byId.has(block.id)) return
    const entry = { block: structuredClone(block), started: false, served: false,
      input: { callId: block.id, name: block.name, arguments: parseArguments(block.arguments),
        agent, toolSet: state.toolSet, signal: state.execSignal } }
    state.calls.push(entry)
    state.byId.set(block.id, entry)
    pump(state)
  }

  tools.resolve = resolve
  tools.execute = execute
  ctx.on('llm/stream', async function* (options, next) {
    const state = [...steps.values()].find(value => value.agent.id === options.sessionId
      && value.signal === options.signal)
    let completed = false
    try {
      yield* next()
      completed = true
    } finally {
      // An aborted/error stream otherwise reaches the loop's idle notification
      // synchronously. Join cooperative tool cleanup at the stream boundary.
      if (state && (!completed || state.abandoned || state.signal.aborted)) {
        if (steps.get(state.agent) === state) await retire(state.agent)
        else await drain(state)
      }
    }
  })
  ctx.on('agent/request', onRequest)
  ctx.on('agent/assistant-stream', onFrame)
  ctx.on('agent/turn-stopping', ({ agent }) => retire(agent))
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') void retire(agent) })
  ctx.on('agent/disposed', ({ agent }) => { void retire(agent); admissions.delete(agent) })
  ctx.effect(() => async () => {
    disposed = true
    for (const agent of [...steps.keys()]) void retire(agent)
    await Promise.allSettled([...batches, ...draining.values()])
    // Cordis returns context-bound method proxies, so compare raw descriptors.
    for (const [key, wrapper, descriptor] of [
      ['resolve', resolve, resolveDescriptor], ['execute', execute, executeDescriptor],
    ]) {
      if (Object.getOwnPropertyDescriptor(tools, key)?.value !== wrapper) continue
      if (descriptor) Object.defineProperty(tools, key, descriptor)
      else delete tools[key]
    }
    for (const record of pipelines.values()) {
      if (record.pipeline.prepare === record.prepare) record.pipeline.prepare = record.originalPrepare
      if (record.pipeline.dispatch === record.dispatch) record.pipeline.dispatch = record.originalDispatch
    }
    if (tools[OWNER] === owner) delete tools[OWNER]
  })
}
