import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { findV2BiliProxyProviders } from "../lib/bili-proxy"
import { Logger } from "../lib/logger"
import {
    initializeV2ProxyState,
    startV2ProxyMonitor,
    type V2Context,
    type V2ProxyState,
} from "../lib/v2/proxy"

test("V2 proxy extractor reads ProviderInfo and ModelInfo settings.baseURL only", () => {
    const matches = findV2BiliProxyProviders(
        {
            data: [
                { id: "provider-route", settings: { baseURL: "http://proxy/bili/upstream" } },
                { id: "provider-direct", settings: { baseURL: "https://direct.example/v1" } },
                { id: "top-level-only", baseURL: "http://proxy/bili/ignored" },
            ],
        },
        {
            data: [
                {
                    id: "model-route",
                    providerID: "provider-model",
                    settings: { baseURL: "http://proxy/bili/model" },
                },
            ],
        },
    )
    assert.deepEqual(matches, [
        { provider: "provider-route", baseURL: "http://proxy/bili/upstream" },
        { provider: "provider-model", model: "model-route", baseURL: "http://proxy/bili/model" },
    ])
})

function eventQueue() {
    const queued: unknown[] = []
    let wake: (() => void) | undefined
    let closed = false
    let abortSeen = false
    const push = (value: unknown) => {
        if (closed) return
        queued.push(value)
        wake?.()
        wake = undefined
    }
    const source = {
        async next(): Promise<IteratorResult<unknown>> {
            while (!closed && queued.length === 0) {
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
            if (closed) return { done: true, value: undefined }
            return { done: false, value: queued.shift() }
        },
        async return(): Promise<IteratorResult<unknown>> {
            closed = true
            wake?.()
            wake = undefined
            return { done: true, value: undefined }
        },
        [Symbol.asyncIterator]() {
            return this
        },
    }
    return {
        source,
        push,
        close() {
            closed = true
            wake?.()
            wake = undefined
        },
        get closed() {
            return closed
        },
        get abortSeen() {
            return abortSeen
        },
        markAbort() {
            abortSeen = true
            closed = true
            wake?.()
            wake = undefined
        },
    }
}

test("V2 proxy monitor disables/re-enables on catalog changes without duplicate transforms", async () => {
    let providerBaseURL = "http://proxy/bili/upstream"
    let modelBaseURL = "https://direct.example/v1"
    let providerFailures = false
    let subscriptions = 0
    const queue = eventQueue()
    const context = {
        catalog: {
            provider: {
                list: async () => {
                    if (providerFailures) throw new Error("catalog unavailable")
                    return { data: [{ id: "provider", settings: { baseURL: providerBaseURL } }] }
                },
            },
            model: {
                list: async () => ({
                    data: [
                        {
                            id: "model",
                            providerID: "provider",
                            settings: { baseURL: modelBaseURL },
                        },
                    ],
                }),
            },
        },
        event: {
            subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
                subscriptions += 1
                signal?.addEventListener("abort", queue.markAbort, { once: true })
                return queue.source
            },
        },
    }
    const state: V2ProxyState = { disabled: false }
    const logger = new Logger(false, "silent")
    await initializeV2ProxyState(context as unknown as V2Context, state, logger)
    assert.equal(state.disabled, true)

    let reloads = 0
    const monitor = startV2ProxyMonitor(context as unknown as V2Context, state, logger, () => {
        reloads += 1
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(subscriptions, 1)

    queue.push({ type: "catalog.updated", data: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reloads, 0)

    providerBaseURL = "https://direct.example/v1"
    queue.push({ type: "catalog.updated", data: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.disabled, false)
    assert.equal(reloads, 1)

    providerFailures = true
    queue.push({ type: "catalog.updated", data: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.disabled, false)
    assert.equal(reloads, 1)

    providerFailures = false
    modelBaseURL = "http://proxy/bili/model"
    queue.push({ type: "catalog.updated", data: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.disabled, true)
    assert.equal(reloads, 2)

    await monitor.stop()
    await monitor.stop()
    assert.equal(queue.abortSeen, true)
    assert.equal(queue.closed, true)
    assert.equal(subscriptions, 1)
})

test("V2 proxy monitor rolls back failed reloads so the same catalog event retries", async () => {
    let providerBaseURL = "https://direct.example/v1"
    const queue = eventQueue()
    const context = {
        catalog: {
            provider: {
                list: async () => ({
                    data: [{ id: "provider", settings: { baseURL: providerBaseURL } }],
                }),
            },
            model: {
                list: async () => ({ data: [] }),
            },
        },
        event: {
            subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
                signal?.addEventListener("abort", queue.markAbort, { once: true })
                return queue.source
            },
        },
    }
    const state: V2ProxyState = { disabled: true }
    const logger = new Logger(false, "silent")
    let failures = 1
    let reloads = 0
    const monitor = startV2ProxyMonitor(context as unknown as V2Context, state, logger, () => {
        reloads++
        if (failures > 0) {
            failures--
            throw new Error("reload failed")
        }
    })

    try {
        queue.push({ type: "catalog.updated", data: {} })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(state.disabled, true)
        assert.equal(reloads, 1)

        queue.push({ type: "catalog.updated", data: {} })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(state.disabled, false)
        assert.equal(reloads, 2)
    } finally {
        providerBaseURL = "https://direct.example/v1"
        await monitor.stop()
    }
})
