import "./test-env"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { z } from "zod"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { PluginConfig } from "../lib/config"
import type { ToolFactoryContext, ToolStateRegistry } from "../lib/compress"
import { createCompressRangeToolDefinition, createDecompressToolDefinition } from "../lib/compress"
import type { SharedToolDefinition } from "../lib/compress"
import { withToolSessionMutation } from "../lib/compress/types"
import { Logger } from "../lib/logger"
import type { V2HostAdapter } from "../lib/v2/host"
import { createV2CommandTransform } from "../lib/v2/commands"
import { createV2Tool } from "../lib/v2/tools"
import { V2OperationTracker } from "../lib/v2/lifecycle"
import {
    cloneSessionState,
    createSessionState,
    saveSessionState,
    SessionStateRegistry,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"
import { PromptStore } from "../lib/prompts/store"
import type { HostPermissionSnapshot } from "../lib/host-permissions"

const SESSION_ID = "v2-runtime-lifecycle"

function buildConfig(storagePath: string): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        storagePath,
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150_000,
            minContextLimit: 50_000,
            contextLimitFallback: 128_000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5_000,
            toolOutputNudgeThreshold: 5_000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20_000,
            minCompressRange: 0,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            reasoning: { drop: true, threshold: 2_048 },
            completionReserveTokens: 32_768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3_000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function userMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SESSION_ID,
            role: "user",
            agent: "code",
            time: { created: 1 },
            model: { providerID: "provider", modelID: "model" },
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: SESSION_ID, messageID: id, text }],
    }
}

function assistantMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SESSION_ID,
            role: "assistant",
            agent: "code",
            parentID: "parent",
            modelID: "model",
            providerID: "provider",
            mode: "code",
            path: { cwd: "/workspace", root: "/workspace" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2 },
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: SESSION_ID, messageID: id, text }],
    }
}

function history(): WithParts[] {
    return [
        userMessage("history-user", "earlier request"),
        assistantMessage("history-assistant", "earlier response"),
    ]
}

function historyWithCompletedCompression(): WithParts[] {
    const compressed = assistantMessage("history-compress", "")
    compressed.parts = [
        {
            type: "tool",
            tool: "compress",
            callID: "history-compress-call",
            state: {
                status: "completed",
                input: {
                    topic: "history",
                    content: [
                        {
                            startId: "m00001",
                            endId: "m00002",
                            summary: "history summary",
                        },
                    ],
                },
                output: "Compressed history",
            },
        } as WithParts["parts"][number],
    ]
    return [...history(), compressed]
}

function seedBlock(state: SessionState): void {
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 2,
        durationMs: 0,
        mode: "range",
        tier: 1,
        topic: "seed",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "history-user",
        compressMessageId: "history-assistant",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["history-user", "history-assistant"],
        directToolIds: [],
        effectiveMessageIds: ["history-user", "history-assistant"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "seed summary",
        survivedCount: 0,
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("history-user", 1)
    state.prune.messages.byMessageId.set("history-user", {
        tokenCount: 5,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("history-assistant", {
        tokenCount: 5,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
}

interface BlockedHistory {
    readonly started: Promise<void>
    readonly release: () => void
}

function blockedSessionService(messages: WithParts[]): {
    service: V2HostAdapter["sessions"]
    block(): BlockedHistory
    notices: string[]
} {
    let blocked = false
    let gate: Promise<void> = Promise.resolve()
    let releaseGate = () => {}
    let started: Promise<void> = Promise.resolve()
    let signalStarted = () => {}
    const notices: string[] = []

    const service = {
        get: async () => ({ id: SESSION_ID, parentID: null }),
        messages: async () => {
            if (blocked) {
                signalStarted()
                await gate
            }
            return messages
        },
        parentMessages: async () => messages,
    }

    return {
        service,
        notices,
        block() {
            blocked = true
            gate = new Promise<void>((resolve) => {
                releaseGate = () => {
                    blocked = false
                    resolve()
                }
            })
            started = new Promise<void>((resolve) => {
                signalStarted = resolve
            })
            return { started, release: () => releaseGate() }
        },
    }
}

function makeHost(
    sessions: V2HostAdapter["sessions"],
    notices: string[],
    storagePath: string,
    notifications: string[] = [],
): V2HostAdapter {
    return {
        sessions,
        models: {
            list: async () => [{ providerId: "provider", modelId: "model", contextLimit: 128_000 }],
        },
        notices: {
            async send(input) {
                notices.push(input.text)
            },
        },
        notifications: { notify: (input) => notifications.push(input.message) },
        projectedContext: async () => [],
        directory: storagePath,
    }
}

function factoryContext(
    state: SessionState,
    host: V2HostAdapter,
    config: PluginConfig,
    logger: Logger,
): ToolFactoryContext {
    const registry: ToolStateRegistry = {
        get: () => state,
        withSessionMutation: async (_sessionID, operation) => operation(state),
    }
    return {
        host,
        registry,
        logger,
        config,
        prompts: new PromptStore(logger, host.directory, false, false),
    }
}

function v2ToolContext() {
    return {
        sessionID: SESSION_ID,
        messageID: "message-1",
        callID: "call-1",
        agent: "code",
        progress: async () => {},
    }
}

const permissions: HostPermissionSnapshot = { global: undefined, agents: {}, v2Agents: {} }

test("blocked V2 compress discards staged state, persistence, and notification on cleanup", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-tool-compress-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    const records = blockedSessionService(history())
    const host = makeHost(records.service, records.notices, storage)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const before = cloneSessionState(state)
    const tracker = new V2OperationTracker()
    const context = factoryContext(state, host, config, logger)
    const tool = createV2Tool(
        createCompressRangeToolDefinition(context),
        context,
        host,
        permissions,
        () => true,
        tracker,
    )
    const blocked = records.block()

    try {
        const pending = tool.execute(
            {
                topic: "blocked",
                content: [{ startId: "m00001", endId: "m00002", summary: "summary" }],
                dangerous: true,
            },
            v2ToolContext(),
        )
        await blocked.started
        tracker.deactivate()
        blocked.release()
        const result = await pending

        assert.match(String(result.content), /shutting down/i)
        assert.deepEqual(cloneSessionState(state), before)
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("blocked V2 decompress discards staged state, persistence, and notification on cleanup", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-tool-decompress-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    seedBlock(state)
    const records = blockedSessionService(history())
    const host = makeHost(records.service, records.notices, storage)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const before = cloneSessionState(state)
    const tracker = new V2OperationTracker()
    const context = factoryContext(state, host, config, logger)
    const tool = createV2Tool(
        createDecompressToolDefinition(context),
        context,
        host,
        permissions,
        () => true,
        tracker,
    )
    const blocked = records.block()

    try {
        const pending = tool.execute({ blockId: "b1" }, v2ToolContext())
        await blocked.started
        tracker.deactivate()
        blocked.release()
        const result = await pending

        assert.match(String(result.content), /shutting down/i)
        assert.deepEqual(cloneSessionState(state), before)
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("V2 quality rejection arms only the retry flag and acknowledgeRisk consumes it", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-quality-retry-"))
    const logger = new Logger(false, "silent")
    const qualityConfig: PluginConfig = {
        ...buildConfig(storage),
        qualityGate: {
            enabled: true,
            algorithm: "rouge-recall-v1",
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.2,
                },
            },
        },
    }
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    const existingPending = {
        messageId: "existing-message",
        callId: "existing-call",
        durationMs: 19,
    }
    state.compressionTiming.startsByCallId.set("existing-start", 11)
    state.compressionTiming.pendingByCallId.set("existing-pending", existingPending)
    const records = blockedSessionService(history())
    const notifications: string[] = []
    const host = makeHost(records.service, records.notices, storage, notifications)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const context = factoryContext(state, host, qualityConfig, logger)
    const tracker = new V2OperationTracker()
    const tool = createV2Tool(
        createCompressRangeToolDefinition(context),
        context,
        host,
        permissions,
        () => true,
        tracker,
    )
    const before = cloneSessionState(state)
    const timing = state.compressionTiming
    const starts = timing.startsByCallId
    const pendingTiming = timing.pendingByCallId
    const startsBefore = [...starts.entries()]
    const pendingBefore = [...pendingTiming.entries()].map(
        ([key, value]) => [key, { ...value }] as const,
    )

    try {
        const rejected = await tool.execute(
            {
                topic: "quality",
                content: [{ startId: "m00001", endId: "m00002", summary: "too short" }],
            },
            v2ToolContext(),
        )
        assert.match(String(rejected.content), /QUALITY GATE FAILURE/i)
        assert.equal(state.qualityGateRetryPending, true)
        const comparableAfterRejection = cloneSessionState(state)
        comparableAfterRejection.qualityGateRetryPending = false
        const comparableBefore = cloneSessionState(before)
        comparableBefore.qualityGateRetryPending = false
        assert.deepEqual(comparableAfterRejection, comparableBefore)
        assert.strictEqual(state.compressionTiming, timing)
        assert.strictEqual(state.compressionTiming.startsByCallId, starts)
        assert.strictEqual(state.compressionTiming.pendingByCallId, pendingTiming)
        assert.deepEqual([...starts.entries()], startsBefore)
        assert.deepEqual(
            [...pendingTiming.entries()].map(([key, value]) => [key, { ...value }] as const),
            pendingBefore,
        )
        assert.strictEqual(pendingTiming.get("existing-pending"), existingPending)
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
        assert.deepEqual(notifications, [])

        const accepted = await tool.execute(
            {
                topic: "quality",
                content: [{ startId: "m00001", endId: "m00002", summary: "still short" }],
                acknowledgeRisk: true,
            },
            v2ToolContext(),
        )
        assert.match(String(accepted.content), /Compressed 2 messages/i)
        assert.equal(state.qualityGateRetryPending, false)
        assert.equal(state.prune.messages.blocksById.size, 1)
        assert.deepEqual([...state.prune.messages.activeBlockIds], [1])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("V2 ordinary range errors do not arm quality retry or commit speculative state", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-quality-error-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    config.qualityGate = {
        enabled: true,
        algorithm: "rouge-recall-v1",
        algorithms: {
            "rouge-recall-v1": { layer1MinChars: 200, layer1MinRetentionPct: 5 },
        },
    }
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    const records = blockedSessionService(history())
    const notifications: string[] = []
    const host = makeHost(records.service, records.notices, storage, notifications)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const context = factoryContext(state, host, config, logger)
    const tracker = new V2OperationTracker()
    const tool = createV2Tool(
        createCompressRangeToolDefinition(context),
        context,
        host,
        permissions,
        () => true,
        tracker,
    )
    const before = cloneSessionState(state)
    const timing = state.compressionTiming
    const starts = timing.startsByCallId
    const pendingTiming = timing.pendingByCallId
    const startsBefore = [...starts.entries()]
    const pendingBefore = [...pendingTiming.entries()].map(
        ([key, value]) => [key, { ...value }] as const,
    )

    try {
        const result = await tool.execute(
            {
                topic: "ordinary error",
                summaryMaxChars: 1,
                content: [{ startId: "m00001", endId: "m00002", summary: "x".repeat(2) }],
            },
            v2ToolContext(),
        )
        assert.match(String(result.content), /ACP compress failed/i)
        assert.equal(state.qualityGateRetryPending, false)
        assert.deepEqual(cloneSessionState(state), before)
        assert.strictEqual(state.compressionTiming, timing)
        assert.strictEqual(state.compressionTiming.startsByCallId, starts)
        assert.strictEqual(state.compressionTiming.pendingByCallId, pendingTiming)
        assert.deepEqual([...starts.entries()], startsBefore)
        assert.deepEqual(
            [...pendingTiming.entries()].map(([key, value]) => [key, { ...value }] as const),
            pendingBefore,
        )
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("V2 deactivation before quality rejection does not arm retry or commit state", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-quality-deactivate-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    config.qualityGate = {
        enabled: true,
        algorithm: "rouge-recall-v1",
        algorithms: {
            "rouge-recall-v1": { layer1MinChars: 200, layer1MinRetentionPct: 5 },
        },
    }
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    const records = blockedSessionService(history())
    const notifications: string[] = []
    const host = makeHost(records.service, records.notices, storage, notifications)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const context = factoryContext(state, host, config, logger)
    const tracker = new V2OperationTracker()
    const tool = createV2Tool(
        createCompressRangeToolDefinition(context),
        context,
        host,
        permissions,
        () => true,
        tracker,
    )
    const before = cloneSessionState(state)
    const timing = state.compressionTiming
    const starts = timing.startsByCallId
    const pendingTiming = timing.pendingByCallId
    const startsBefore = [...starts.entries()]
    const pendingBefore = [...pendingTiming.entries()].map(
        ([key, value]) => [key, { ...value }] as const,
    )
    const blocked = records.block()

    try {
        const pending = tool.execute(
            {
                topic: "deactivated",
                content: [{ startId: "m00001", endId: "m00002", summary: "too short" }],
            },
            v2ToolContext(),
        )
        await blocked.started
        tracker.deactivate()
        blocked.release()
        const result = await pending

        assert.match(String(result.content), /shutting down/i)
        assert.equal(state.qualityGateRetryPending, false)
        assert.deepEqual(cloneSessionState(state), before)
        assert.strictEqual(state.compressionTiming, timing)
        assert.strictEqual(state.compressionTiming.startsByCallId, starts)
        assert.strictEqual(state.compressionTiming.pendingByCallId, pendingTiming)
        assert.deepEqual([...starts.entries()], startsBefore)
        assert.deepEqual(
            [...pendingTiming.entries()].map(([key, value]) => [key, { ...value }] as const),
            pendingBefore,
        )
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("blocked V2 command dispatch emits no synthetic notice after cleanup", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-command-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    const source = history()
    const records = blockedSessionService(source)
    const host = makeHost(records.service, records.notices, storage)
    const registry = new SessionStateRegistry(logger, storage)
    await registry.getOrCreate(host.sessions, SESSION_ID, source, config)
    const state = registry.get(SESSION_ID)
    assert.ok(state)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const before = cloneSessionState(state)
    const tracker = new V2OperationTracker()
    const added: CommandDefinition[] = []
    const editor = {
        add(definition: CommandDefinition) {
            added.push(definition)
        },
    }
    createV2CommandTransform(
        host,
        registry,
        logger,
        config,
        permissions,
        storage,
        () => true,
        tracker,
    )(editor)
    const command = added.find((definition) => definition.name === "acp")
    assert.ok(command)
    const blocked = records.block()

    try {
        const pending = command.execute({
            sessionID: SESSION_ID,
            messageID: "message-1",
            prompt: { text: "/acp help" },
            delivery: "queue",
        })
        await blocked.started
        tracker.deactivate()
        blocked.release()
        await pending

        assert.deepEqual(cloneSessionState(state), before)
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("V2 pre-commit lifecycle fence discards speculative state, timing, persistence, and effects", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-precommit-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    const state = createSessionState()
    state.sessionId = SESSION_ID
    state.storageDir = storage
    const records = blockedSessionService(history())
    const notifications: string[] = []
    const host = makeHost(records.service, records.notices, storage, notifications)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(join(storage, `${SESSION_ID}.json`), "utf8")
    const before = cloneSessionState(state)
    const context = factoryContext(state, host, config, logger)
    const tracker = new V2OperationTracker()
    const schema = z.object({})
    let signalStarted = () => {}
    let releaseBarrier = () => {}
    const speculativeStarted = new Promise<void>((resolve) => {
        signalStarted = resolve
    })
    const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve
    })
    const definition: SharedToolDefinition<typeof schema> = {
        name: "precommit-test",
        description: "precommit-test",
        schema,
        inputSchema: schema,
        execute: (_input, toolContext) =>
            withToolSessionMutation(context, toolContext, async (toolCtx) => {
                toolCtx.state.currentTurn = 99
                toolCtx.state.stats.totalPruneTokens = 123
                toolCtx.state.toolParameters.set("speculative-call", {
                    tool: "read",
                    parameters: { path: "speculative.ts" },
                    turn: 99,
                })
                toolCtx.state.compressionTiming.startsByCallId.set("speculative-start", 77)
                toolCtx.state.compressionTiming.pendingByCallId.set("speculative-pending", {
                    messageId: "speculative-message",
                    callId: "speculative-call",
                    durationMs: 88,
                })
                toolCtx.effects?.requestPersistence()
                toolCtx.effects?.defer(() =>
                    toolCtx.notifications.notify({
                        title: "speculative",
                        message: "speculative effect",
                        variant: "info",
                    }),
                )
                signalStarted()
                await barrier
                return "completed"
            }),
    }
    const tool = createV2Tool(definition, context, host, permissions, () => true, tracker)

    try {
        const pending = tool.execute({}, v2ToolContext())
        await speculativeStarted
        tracker.deactivate()
        releaseBarrier()
        const result = await pending

        assert.match(String(result.content), /shutting down/i)
        assert.deepEqual(cloneSessionState(state), before)
        assert.equal(await readFile(join(storage, `${SESSION_ID}.json`), "utf8"), persistedBefore)
        assert.deepEqual(records.notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})

test("active V2 command persists initialization state requested by recovery", async () => {
    const storage = await mkdtemp(join(tmpdir(), "acp-v2-command-persist-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig(storage)
    const source = historyWithCompletedCompression()
    const records = blockedSessionService(source)
    const host = makeHost(records.service, records.notices, storage)
    const registry = new SessionStateRegistry(logger, storage)
    const tracker = new V2OperationTracker()
    const added: CommandDefinition[] = []

    try {
        createV2CommandTransform(
            host,
            registry,
            logger,
            config,
            permissions,
            storage,
            () => true,
            tracker,
        )({ add: (definition) => added.push(definition) })
        const command = added.find((definition) => definition.name === "acp")
        assert.ok(command)

        await command.execute({
            sessionID: SESSION_ID,
            prompt: { text: "/acp help" },
            delivery: "queue",
        })

        const persisted = JSON.parse(
            await readFile(join(storage, `${SESSION_ID}.json`), "utf8"),
        ) as {
            prune: { messages: { blocksById: Record<string, unknown> } }
            messageIds: { byRef: Record<string, string> }
        }
        assert.ok(persisted.prune.messages.blocksById["1"])
        assert.equal(persisted.messageIds.byRef.m00001, "history-user")
        assert.equal(persisted.messageIds.byRef.m00002, "history-assistant")
        assert.equal(records.notices.length, 1)
    } finally {
        await rm(storage, { recursive: true, force: true })
    }
})
