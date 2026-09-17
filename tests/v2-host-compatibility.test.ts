import "./test-env"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Message } from "@opencode/ai"
import { createCompressRangeToolDefinition } from "../lib/compress/range"
import { getConfig } from "../lib/config"
import { isAcpNonRemovableMessage } from "../lib/messages/opaque"
import { PromptStore } from "../lib/prompts/store"
import { SessionStateRegistry, createSessionState } from "../lib/state"
import { findLastCompactionTimestamp } from "../lib/state/utils"
import { assignMessageRefs } from "../lib/message-ids"
import { detectV2CatalogCapabilities } from "../lib/v2/capabilities"
import { assessV2HistoryCompatibility, attachV2CompactionTimestamp } from "../lib/v2/history"
import { createV2Host, type V2Context } from "../lib/v2/host"
import { Logger } from "../lib/logger"
import { applyV2ContextPatch, normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { createV2Tool } from "../lib/v2/tools"
import {
    catalogHasV2BiliProxy,
    initializeV2ProxyState,
    startV2ProxyMonitor,
    type V2ProxyState,
} from "../lib/v2/proxy"

function v2Context(value: unknown): V2Context {
    return value as V2Context
}

function nextTick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

function eventQueue() {
    const queued: unknown[] = []
    let wake: (() => void) | undefined
    let closed = false
    const source = {
        async next(): Promise<IteratorResult<unknown>> {
            while (!closed && queued.length === 0) {
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
            return closed
                ? { done: true, value: undefined }
                : { done: false, value: queued.shift() }
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
        push(value: unknown) {
            if (closed) return
            queued.push(value)
            wake?.()
            wake = undefined
        },
    }
}

test("V2 host adapts the pinned catalog envelope and newer top-level direct list contracts", async () => {
    const pinned = {
        location: { directory: "/workspace/pinned" },
        catalog: {
            provider: { list: async () => ({ data: [] }) },
            model: {
                list: async () => ({
                    data: [
                        {
                            id: "pinned-model",
                            providerID: "pinned-provider",
                            limit: { context: 128_000 },
                        },
                    ],
                }),
            },
        },
    }
    const latest = {
        location: { directory: "/workspace/latest" },
        provider: { list: async () => [] },
        model: {
            list: async () => [
                {
                    id: "latest-model",
                    providerID: "latest-provider",
                    limit: { context: 256_000 },
                },
            ],
        },
    }

    assert.equal(detectV2CatalogCapabilities(pinned).family, "catalog")
    assert.equal(detectV2CatalogCapabilities(latest).family, "top-level")
    assert.deepEqual(await createV2Host(v2Context(pinned)).models.list(), [
        { providerId: "pinned-provider", modelId: "pinned-model", contextLimit: 128_000 },
    ])
    assert.deepEqual(await createV2Host(v2Context(latest)).models.list(), [
        { providerId: "latest-provider", modelId: "latest-model", contextLimit: 256_000 },
    ])
})

test("V2 catalog adaptation fails closed for unavailable capabilities and malformed list responses", async () => {
    const incomplete = { catalog: {} }
    assert.throws(
        () => detectV2CatalogCapabilities(incomplete),
        /provider\/model catalog capability is unavailable/,
    )

    const malformed = {
        location: { directory: "/workspace/malformed" },
        provider: { list: async () => [] },
        model: { list: async () => ({ data: {} }) },
    }
    await assert.rejects(
        createV2Host(v2Context(malformed)).models.list(),
        /model\.list returned an invalid response/,
    )
})

test("V2 catalog adaptation does not combine partial catalog and top-level domains", async () => {
    const mixed = {
        location: { directory: "/workspace/mixed" },
        catalog: {
            model: {
                list: async () => [
                    {
                        id: "catalog-model",
                        providerID: "catalog-provider",
                        limit: { context: 64_000 },
                    },
                ],
            },
        },
        provider: { list: async () => [{ id: "top-level-provider", settings: {} }] },
        model: {
            list: async () => [
                {
                    id: "top-level-model",
                    providerID: "top-level-provider",
                    limit: { context: 128_000 },
                },
            ],
        },
    }
    const context = v2Context(mixed)
    assert.equal(detectV2CatalogCapabilities(mixed).family, "catalog")
    assert.deepEqual(await createV2Host(context).models.list(), [
        { providerId: "catalog-provider", modelId: "catalog-model", contextLimit: 64_000 },
    ])
    await assert.rejects(
        catalogHasV2BiliProxy(context),
        /catalog provider\.list capability is unavailable/,
    )
})

test("V2 proxy monitor uses newer provider/model events without duplicate reloads", async () => {
    let providerBaseURL = "https://direct.example/v1"
    let modelBaseURL = "https://direct.example/v1"
    let providerFailures = false
    let reloads = 0
    const queue = eventQueue()
    const context = v2Context({
        provider: {
            list: async () => {
                if (providerFailures) throw new Error("provider unavailable")
                return [{ id: "provider", settings: { baseURL: providerBaseURL } }]
            },
        },
        model: {
            list: async () => [
                { id: "model", providerID: "provider", settings: { baseURL: modelBaseURL } },
            ],
        },
        event: {
            subscribe: () => queue.source,
        },
    })
    const state: V2ProxyState = { disabled: false }
    const logger = new Logger(false, "silent")
    await initializeV2ProxyState(context, state, logger)
    const monitor = startV2ProxyMonitor(context, state, logger, () => {
        reloads++
    })

    try {
        queue.push({ type: "catalog.updated" })
        await nextTick()
        assert.equal(reloads, 0)

        providerBaseURL = "https://proxy.example/bili/upstream"
        queue.push({ type: "provider.updated" })
        await nextTick()
        assert.equal(state.disabled, true)
        assert.equal(reloads, 1)

        queue.push({ type: "model.updated" })
        await nextTick()
        assert.equal(reloads, 1)

        providerFailures = true
        modelBaseURL = "https://direct.example/v1"
        queue.push({ type: "provider.updated" })
        await nextTick()
        assert.equal(state.disabled, true)
        assert.equal(reloads, 1)
    } finally {
        await monitor.stop()
    }
})

test("V2 native checkpoints scope direct and context history to a removable correlated suffix", async () => {
    const checkpoint = {
        type: "compaction",
        id: "native-checkpoint",
        status: "completed",
        time: { created: 100 },
        providerContext: {
            provenance: {
                providerID: "old-provider",
                modelID: "old-model",
                route: "responses",
                protocol: "openai-responses",
                endpoint: "endpoint-hash",
            },
            messages: [],
        },
    }
    const projected = [checkpoint, { type: "user", id: "new-user", text: "continue" }]
    const outgoing = [
        Message.make({ id: "old-user", role: "user", content: "original request" }),
        Message.make({ id: "new-user", role: "user", content: "continue" }),
    ]
    const mismatch = assessV2HistoryCompatibility(
        projected,
        { providerID: "new-provider", id: "new-model" },
        outgoing,
    )
    assert.equal(mismatch.status, "degraded")
    assert.equal(mismatch.preserveOriginalRequest, false)
    assert.equal(mismatch.code, "provider-checkpoint-provenance-mismatch")
    assert.deepEqual(mismatch.projected, [projected[1]])
    assert.deepEqual(mismatch.independentlyCorrelatedSourceIds, ["new-user"])
    assert.deepEqual(mismatch.uncorrelatedOutgoingIds, ["old-user"])
    assert.equal(mismatch.nativeCompactionTimestamp, 100)

    const contextProjection = normalizeV2ProjectedHistory(mismatch.projected, outgoing, {
        sessionID: "history",
        currentModel: { providerID: "new-provider", id: "new-model" },
    })
    assert.equal(contextProjection.valid, true)
    attachV2CompactionTimestamp(contextProjection.messages, mismatch.nativeCompactionTimestamp)
    assert.equal(findLastCompactionTimestamp(contextProjection.messages), 100)
    const patch = applyV2ContextPatch(contextProjection, [], outgoing)
    assert.equal(patch.accepted, true)
    if (patch.accepted) {
        assert.deepEqual(patch.patch.removedMessageIds, ["new-user"])
        assert.equal(patch.messages.length, 1)
        assert.equal(patch.messages[0], outgoing[0])
    }

    const degraded = assessV2HistoryCompatibility(
        projected,
        { providerID: "old-provider", id: "old-model" },
        outgoing,
    )
    assert.equal(degraded.status, "degraded")
    assert.equal(degraded.preserveOriginalRequest, false)
    assert.equal(degraded.code, "provider-checkpoint-provenance-unavailable")

    const context = v2Context({
        location: { directory: "/workspace/history" },
        session: { context: async () => projected },
    })
    const messages = await createV2Host(context).sessions.messages("session")
    assert.deepEqual(
        messages.map((message) => message.info.id),
        ["new-user"],
    )
    assert.equal(messages[0]?.parts[0]?.type, "text")
    assert.equal(findLastCompactionTimestamp(messages), 100)
})

test("V2 native checkpoint without a correlated suffix preserves the original request", () => {
    const projected = [
        {
            type: "compaction",
            id: "native-checkpoint",
            status: "completed",
            time: { created: 100 },
            providerContext: {
                provenance: { providerID: "old-provider", modelID: "old-model" },
            },
        },
        { type: "user", id: "not-on-wire", text: "unmatched suffix" },
    ]
    const compatibility = assessV2HistoryCompatibility(
        projected,
        { providerID: "new-provider", id: "new-model" },
        [Message.make({ id: "old-user", role: "user", content: "re-expanded prefix" })],
    )
    assert.equal(compatibility.status, "unsupported")
    assert.equal(compatibility.preserveOriginalRequest, true)
    assert.equal(compatibility.code, "provider-checkpoint-no-correlated-suffix")
    assert.deepEqual(compatibility.projected, [projected[1]])
    assert.deepEqual(compatibility.uncorrelatedScopedSourceIds, ["not-on-wire"])
})

test("V2 scoped normalization rejects an uncorrelated suffix source instead of guessing", () => {
    const checkpoint = {
        type: "compaction",
        id: "native-checkpoint",
        status: "completed",
        providerContext: {
            provenance: { providerID: "old-provider", modelID: "old-model" },
        },
    }
    const projected = [
        checkpoint,
        { type: "user", id: "safe", text: "safe suffix" },
        { type: "user", id: "missing", text: "missing suffix" },
    ]
    const outgoing = [
        Message.make({ id: "prefix", role: "user", content: "re-expanded prefix" }),
        Message.make({ id: "safe", role: "user", content: "safe suffix" }),
    ]
    const compatibility = assessV2HistoryCompatibility(
        projected,
        { providerID: "new-provider", id: "new-model" },
        outgoing,
    )
    assert.equal(compatibility.preserveOriginalRequest, false)
    const projection = normalizeV2ProjectedHistory(compatibility.projected, outgoing, {
        sessionID: "history",
        currentModel: { providerID: "new-provider", id: "new-model" },
    })
    assert.equal(projection.valid, false)
    assert.match(projection.rejection?.message ?? "", /has no exact lowered outgoing match/)
})

test("V2 cold direct native suffixes require an accepted context authorization before compression", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-v2-native-suffix-"))
    const sessionID = "native-suffix"
    const model = { providerID: "provider", id: "model" }
    const checkpoint = {
        type: "compaction",
        id: "native-checkpoint",
        status: "completed",
        time: { created: 100 },
        providerContext: {
            provenance: {
                providerID: "old-provider",
                modelID: "old-model",
                route: "responses",
                protocol: "openai-responses",
                endpoint: "endpoint-hash",
            },
        },
    }
    let projected: unknown[] = [
        checkpoint,
        {
            type: "assistant",
            id: "verified-suffix",
            model,
            time: { created: 101, completed: 102 },
            content: [{ type: "text", text: "verified suffix detail ".repeat(100) }],
        },
        { type: "user", id: "latest", time: { created: 103 }, text: "continue" },
    ]
    const outgoing = [
        Message.make({ id: "re-expanded-prefix", role: "user", content: "original prefix" }),
        Message.make({
            id: "verified-suffix",
            role: "assistant",
            content: "verified suffix detail ".repeat(100),
        }),
        Message.make({ id: "latest", role: "user", content: "continue" }),
    ]
    let currentModel = model
    const apiContext = v2Context({
        location: { directory },
        session: {
            context: async () => projected,
            get: async () => ({ id: sessionID, model: currentModel }),
        },
        agent: { get: async () => ({ data: { permissions: [] } }) },
    })
    const host = createV2Host(apiContext)
    const config = getConfig({ directory, notifications: { notify() {} } })
    config.storagePath = directory
    config.autoUpdate = false
    config.pruneNotification = "off"
    config.compress.minCompressRange = 0
    config.compress.preserveRecentMessages = 0
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = false
    const logger = new Logger(false, "silent")
    let ordinaryStorage: string | undefined
    const execute = (registry: SessionStateRegistry, startId: string) => {
        const factory = {
            host,
            registry,
            logger,
            config,
            prompts: new PromptStore(logger, directory),
        }
        return createV2Tool(createCompressRangeToolDefinition(factory), factory, host, {
            agents: {},
        }).execute(
            {
                topic: "native suffix",
                content: [{ startId, endId: startId, summary: "suffix summary" }],
            },
            {
                sessionID,
                messageID: "compress-message",
                id: "compress-call",
                agent: "build",
                progress: async () => {},
            },
        )
    }

    try {
        const unverified = await host.sessions.messages(sessionID)
        assert.equal(findLastCompactionTimestamp(unverified), 100)
        assert.equal(isAcpNonRemovableMessage(unverified[0]), true)
        const refs = createSessionState()
        assignMessageRefs(refs, unverified)
        const suffixRef = refs.messageIds.byRawId.get("verified-suffix")
        assert.ok(suffixRef)

        const coldRegistry = new SessionStateRegistry(logger, directory)
        const cold = await execute(coldRegistry, suffixRef)
        assert.match(String(cold.content), /non-removable|provider-owned/i)
        assert.equal(coldRegistry.get(sessionID)?.prune.messages.blocksById.size ?? 0, 0)

        const history = assessV2HistoryCompatibility(projected, model, outgoing)
        const projection = normalizeV2ProjectedHistory(history.projected, outgoing, {
            sessionID,
            currentModel: model,
        })
        const accepted = applyV2ContextPatch(projection, projection.messages, outgoing)
        assert.equal(accepted.accepted, true)
        assert.equal(history.preserveOriginalRequest, false)
        host.recordAcceptedNativeSuffix?.({
            sessionID,
            checkpointIds: history.checkpointIds,
            nativeCompactionTimestamp: history.nativeCompactionTimestamp,
            model,
            sourceIds: history.independentlyCorrelatedSourceIds,
        })

        const authorized = await host.sessions.messages(sessionID)
        assert.equal(isAcpNonRemovableMessage(authorized[0]), false)
        const reloadedHost = createV2Host(apiContext)
        assert.equal(
            isAcpNonRemovableMessage((await reloadedHost.sessions.messages(sessionID))[0]),
            true,
            "a new host cannot inherit authorization",
        )
        currentModel = { ...model, id: "different-model" }
        assert.equal(
            isAcpNonRemovableMessage((await host.sessions.messages(sessionID))[0]),
            true,
            "model changes revoke authorization",
        )
        currentModel = model
        assert.equal(
            isAcpNonRemovableMessage((await host.sessions.messages(sessionID))[0]),
            true,
            "switching back cannot revive revoked evidence",
        )
        host.recordAcceptedNativeSuffix?.({
            sessionID,
            checkpointIds: history.checkpointIds,
            nativeCompactionTimestamp: history.nativeCompactionTimestamp,
            model,
            sourceIds: history.independentlyCorrelatedSourceIds,
        })
        const authorizedRegistry = new SessionStateRegistry(logger, directory)
        const result = await execute(authorizedRegistry, suffixRef)
        assert.match(String(result.content), /^Compressed 1 messages/)
        assert.equal(authorizedRegistry.get(sessionID)?.prune.messages.blocksById.size, 1)

        projected = [
            ...projected,
            {
                type: "assistant",
                id: "new-unverified-suffix",
                model,
                time: { created: 104, completed: 105 },
                content: [{ type: "text", text: "new suffix" }],
            },
        ]
        const appended = await host.sessions.messages(sessionID)
        assert.equal(
            isAcpNonRemovableMessage(
                appended.find((message) => message.info.id === "new-unverified-suffix"),
            ),
            true,
        )

        projected = [
            { ...checkpoint, id: "new-native-checkpoint", time: { created: 200 } },
            ...projected.slice(1),
        ]
        const stale = await host.sessions.messages(sessionID)
        assert.equal(isAcpNonRemovableMessage(stale[0]), true)
        const staleRegistry = new SessionStateRegistry(logger, directory)
        const staleResult = await execute(staleRegistry, suffixRef)
        assert.match(String(staleResult.content), /non-removable|provider-owned/i)
        assert.equal(staleRegistry.get(sessionID)?.prune.messages.blocksById.size ?? 0, 0)

        projected = [
            {
                type: "assistant",
                id: "ordinary-history",
                model,
                time: { created: 300, completed: 301 },
                content: [{ type: "text", text: "ordinary history ".repeat(100) }],
            },
            { type: "user", id: "ordinary-latest", time: { created: 302 }, text: "continue" },
        ]
        ordinaryStorage = mkdtempSync(join(tmpdir(), "acp-v2-ordinary-history-"))
        config.storagePath = ordinaryStorage
        const ordinary = await host.sessions.messages(sessionID)
        assert.equal(isAcpNonRemovableMessage(ordinary[0]), false)
        const ordinaryRefs = createSessionState()
        assignMessageRefs(ordinaryRefs, ordinary)
        const ordinaryRef = ordinaryRefs.messageIds.byRawId.get("ordinary-history")
        assert.ok(ordinaryRef)
        const ordinaryRegistry = new SessionStateRegistry(logger, directory)
        const ordinaryResult = await execute(ordinaryRegistry, ordinaryRef)
        assert.match(String(ordinaryResult.content), /^Compressed 1 messages/)
    } finally {
        rmSync(directory, { recursive: true, force: true })
        if (ordinaryStorage) rmSync(ordinaryStorage, { recursive: true, force: true })
    }
})

test("V2 history without a native checkpoint remains supported", () => {
    const result = assessV2HistoryCompatibility(
        [{ type: "user", id: "request", text: "hello" }],
        { providerID: "provider", id: "model" },
        [Message.make({ id: "request", role: "user", content: "hello" })],
    )
    assert.equal(result.status, "supported")
    assert.equal(result.preserveOriginalRequest, false)
})
