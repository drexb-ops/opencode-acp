import "./test-env"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createAcpContextRecapToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    type ToolFactoryContext,
    type ToolStateRegistry,
} from "../lib/compress"
import { type HostPermissionSnapshot } from "../lib/host-permissions"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { PromptStore } from "../lib/prompts/store"
import {
    createSessionState,
    saveSessionState,
    SessionStateRegistry,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"
import type { V2HostAdapter } from "../lib/v2/host"
import { V2OperationTracker } from "../lib/v2/lifecycle"
import { createV2Tool } from "../lib/v2/tools"

const SESSION_ID = "v2-tool-hydration"
const permissions: HostPermissionSnapshot = { global: undefined, agents: {}, v2Agents: {} }

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        storagePath: "relative-acp-state",
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

function userMessage(id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            sessionID: SESSION_ID,
            role: "user",
            agent: "code",
            time: { created },
            model: { providerID: "provider", modelID: "model" },
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: SESSION_ID, messageID: id, text }],
    }
}

function assistantMessage(id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            sessionID: SESSION_ID,
            role: "assistant",
            agent: "code",
            parentID: "parent",
            providerID: "provider",
            modelID: "model",
            mode: "code",
            path: { cwd: "/workspace", root: "/workspace" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created },
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: SESSION_ID, messageID: id, text }],
    }
}

function history(): WithParts[] {
    return [
        userMessage("old-user", "old request ".repeat(80), 1),
        assistantMessage("old-assistant", "old response ".repeat(80), 2),
        userMessage("current-user", "current request", 3),
        assistantMessage("current-assistant", "current response", 4),
    ]
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
        anchorMessageId: "old-user",
        compressMessageId: "old-assistant",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["old-user", "old-assistant"],
        directToolIds: [],
        effectiveMessageIds: ["old-user", "old-assistant"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "seed summary",
        survivedCount: 0,
    }
    state.prune.messages.blocksById.set(block.blockId, block)
    state.prune.messages.activeBlockIds.add(block.blockId)
    state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
    for (const messageId of block.effectiveMessageIds) {
        state.prune.messages.byMessageId.set(messageId, {
            tokenCount: 5,
            allBlockIds: [block.blockId],
            activeBlockIds: [block.blockId],
        })
    }
}

function makeHost(
    directory: string,
    messages: () => Promise<WithParts[]>,
    notices: string[] = [],
    notifications: string[] = [],
): V2HostAdapter {
    return {
        directory,
        sessions: {
            get: async () => ({ id: SESSION_ID, parentID: null }),
            messages,
            parentMessages: async () => [],
        },
        models: {
            list: async () => [{ providerId: "provider", modelId: "model", contextLimit: 128_000 }],
        },
        notices: { send: async (input) => notices.push(input.text) },
        notifications: { notify: (input) => notifications.push(input.message) },
        projectedContext: async () => [],
    }
}

function factory(
    registry: ToolStateRegistry,
    host: V2HostAdapter,
    config: PluginConfig,
    logger: Logger,
): ToolFactoryContext {
    return {
        host,
        registry,
        logger,
        config,
        prompts: new PromptStore(logger, host.directory, false, false),
    }
}

function v2Context(id = "tool-call") {
    return {
        sessionID: SESSION_ID,
        messageID: "tool-message",
        id,
        agent: "code",
        progress: async () => {},
    }
}

function compressTool(
    factoryCtx: ToolFactoryContext,
    host: V2HostAdapter,
    tracker?: V2OperationTracker,
) {
    return createV2Tool(
        createCompressRangeToolDefinition(factoryCtx),
        factoryCtx,
        host,
        permissions,
        () => true,
        tracker,
    )
}

test("V2 direct compression atomically hydrates persisted state and saves an accepted result", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const messages = history()
    let historyReads = 0
    const host = makeHost(projectDir, async () => {
        historyReads++
        return messages
    })

    try {
        const seededRegistry = new SessionStateRegistry(logger, projectDir)
        const seeded = await seededRegistry.getOrCreate(host.sessions, SESSION_ID, messages, config)
        assignMessageRefs(seeded, messages)
        seeded.prune.messages.nextBlockId = 41
        await saveSessionState(seeded, logger)

        const registry = new SessionStateRegistry(logger, projectDir)
        const factoryCtx = factory(registry, host, config, logger)
        const result = await compressTool(factoryCtx, host).execute(
            {
                topic: "cold persisted history",
                content: [{ startId: "m00001", endId: "m00002", summary: "cold history summary" }],
            },
            v2Context(),
        )

        assert.match(String(result.content), /Compressed 2 messages/i)
        assert.equal(historyReads, 1)
        const hydrated = registry.get(SESSION_ID)
        assert.ok(hydrated)
        assert.equal(hydrated.storageDir, join(projectDir, "relative-acp-state"))
        assert.ok(hydrated.prune.messages.blocksById.has(41))
        assert.equal(hydrated.prune.messages.nextBlockId, 42)

        const persisted = JSON.parse(
            await readFile(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`), "utf8"),
        )
        assert.equal(persisted.prune.messages.nextBlockId, 42)
        assert.match(persisted.prune.messages.blocksById["41"].summary, /cold history summary/)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 direct compression keeps a reserved history snapshot when the host drifts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-drift-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const snapshot = history()
    const drifted = [
        userMessage("drift-user", "drifted request ".repeat(80), 10),
        assistantMessage("drift-assistant", "drifted response ".repeat(80), 11),
        userMessage("drift-current-user", "drifted current request", 12),
        assistantMessage("drift-current-assistant", "drifted current response", 13),
    ]
    let historyReads = 0
    const host = makeHost(projectDir, async () => {
        historyReads++
        return historyReads === 1 ? snapshot : drifted
    })
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)

    try {
        const result = await compressTool(factoryCtx, host).execute(
            {
                topic: "reserved snapshot",
                content: [{ startId: "m00001", endId: "m00002", summary: "snapshot summary" }],
            },
            v2Context(),
        )

        assert.match(String(result.content), /Compressed 2 messages/i)
        assert.equal(historyReads, 1)
        assert.deepEqual(
            registry.get(SESSION_ID)?.prune.messages.blocksById.get(1)?.directMessageIds,
            ["old-user", "old-assistant"],
        )
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 direct tools do not fabricate a fresh state when history hydration fails", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-failure-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const notices: string[] = []
    const notifications: string[] = []
    let reads = 0
    const host = makeHost(
        projectDir,
        async () => {
            reads++
            throw new Error("history unavailable")
        },
        notices,
        notifications,
    )
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)

    try {
        const result = await createV2Tool(
            createAcpContextRecapToolDefinition(factoryCtx),
            factoryCtx,
            host,
            permissions,
        ).execute({}, v2Context())

        assert.match(String(result.content), /history unavailable/i)
        assert.equal(reads, 1)
        assert.equal(registry.get(SESSION_ID), undefined)
        assert.equal(registry.size, 0)
        assert.equal(
            existsSync(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`)),
            false,
        )
        assert.deepEqual(notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 direct-tool operation failures discard hydrated state without persistence or notices", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-operation-error-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const notices: string[] = []
    const notifications: string[] = []
    const host = makeHost(projectDir, async () => history(), notices, notifications)
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)

    try {
        const result = await compressTool(factoryCtx, host).execute(
            {
                topic: "invalid hydrated operation",
                content: [{ startId: "b999", endId: "b999", summary: "must not persist" }],
            },
            v2Context(),
        )

        assert.match(String(result.content), /ACP compress failed/i)
        assert.equal(registry.get(SESSION_ID), undefined)
        assert.equal(registry.size, 0)
        assert.equal(
            existsSync(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`)),
            false,
        )
        assert.deepEqual(notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 lifecycle cancellation discards a cold hydration before tool execution", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-cancel-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const notices: string[] = []
    const notifications: string[] = []
    let started!: () => void
    const hydrationStarted = new Promise<void>((resolve) => {
        started = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    const host = makeHost(
        projectDir,
        async () => {
            started()
            await blocked
            return history()
        },
        notices,
        notifications,
    )
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)
    const tracker = new V2OperationTracker()

    try {
        const pending = compressTool(factoryCtx, host, tracker).execute(
            {
                topic: "cancelled cold history",
                content: [{ startId: "m00001", endId: "m00002", summary: "must not persist" }],
            },
            v2Context(),
        )
        await hydrationStarted
        assert.equal(registry.get(SESSION_ID), undefined)

        tracker.deactivate()
        release()
        const result = await pending

        assert.match(String(result.content), /shutting down/i)
        assert.equal(registry.get(SESSION_ID), undefined)
        assert.equal(registry.size, 0)
        assert.equal(
            existsSync(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`)),
            false,
        )
        assert.deepEqual(notices, [])
        assert.deepEqual(notifications, [])
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 direct tools serialize concurrent cold hydration for one session", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-concurrent-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    let reads = 0
    let started!: () => void
    const firstReadStarted = new Promise<void>((resolve) => {
        started = resolve
    })
    let release!: () => void
    const firstRead = new Promise<void>((resolve) => {
        release = resolve
    })
    const host = makeHost(projectDir, async () => {
        reads++
        if (reads === 1) {
            started()
            await firstRead
        }
        return history()
    })
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)
    const tool = createV2Tool(
        createAcpContextRecapToolDefinition(factoryCtx),
        factoryCtx,
        host,
        permissions,
    )

    try {
        const first = tool.execute({}, v2Context("first"))
        await firstReadStarted
        const second = tool.execute({}, v2Context("second"))
        await Promise.resolve()
        assert.equal(reads, 1)
        assert.equal(registry.get(SESSION_ID), undefined)

        release()
        const [firstResult, secondResult] = await Promise.all([first, second])
        assert.equal(firstResult.content, "No active compression blocks.")
        assert.equal(secondResult.content, "No active compression blocks.")
        assert.equal(reads, 2)
        assert.equal(registry.get(SESSION_ID)?.sessionId, SESSION_ID)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 quality rejection keeps only its retry marker after atomic rollback", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-quality-"))
    const logger = new Logger(false, "silent")
    const config: PluginConfig = {
        ...buildConfig(),
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
    const messages = history()
    const host = makeHost(projectDir, async () => messages)
    const registry = new SessionStateRegistry(logger, projectDir)
    const state = await registry.getOrCreate(host.sessions, SESSION_ID, messages, config)
    assignMessageRefs(state, messages)
    await saveSessionState(state, logger)
    const persistedBefore = await readFile(
        join(projectDir, "relative-acp-state", `${SESSION_ID}.json`),
        "utf8",
    )
    const factoryCtx = factory(registry, host, config, logger)
    const tool = compressTool(factoryCtx, host)

    try {
        const rejected = await tool.execute(
            {
                topic: "quality failure",
                content: [{ startId: "m00001", endId: "m00002", summary: "too short" }],
            },
            v2Context("quality-rejected"),
        )

        assert.match(String(rejected.content), /QUALITY GATE FAILURE/i)
        assert.equal(state.qualityGateRetryPending, true)
        assert.equal(state.prune.messages.blocksById.size, 0)
        assert.equal(
            await readFile(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`), "utf8"),
            persistedBefore,
        )

        const accepted = await tool.execute(
            {
                topic: "quality retry",
                content: [{ startId: "m00001", endId: "m00002", summary: "still short" }],
                acknowledgeRisk: true,
            },
            v2Context("quality-accepted"),
        )
        assert.match(String(accepted.content), /Compressed 2 messages/i)
        assert.equal(state.qualityGateRetryPending, false)
        assert.equal(state.prune.messages.blocksById.size, 1)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 cold quality rejection retains a retry marker without committing failed state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-cold-quality-"))
    const logger = new Logger(false, "silent")
    const config: PluginConfig = {
        ...buildConfig(),
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
    const notices: string[] = []
    const notifications: string[] = []
    const host = makeHost(projectDir, async () => history(), notices, notifications)
    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)
    const tool = compressTool(factoryCtx, host)

    try {
        const rejected = await tool.execute(
            {
                topic: "cold quality failure",
                content: [{ startId: "m00001", endId: "m00002", summary: "too short" }],
            },
            v2Context("cold-quality-rejected"),
        )

        assert.match(String(rejected.content), /QUALITY GATE FAILURE/i)
        assert.equal(registry.get(SESSION_ID), undefined)
        assert.equal(registry.size, 0)
        assert.equal(
            existsSync(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`)),
            false,
        )
        assert.deepEqual(notices, [])
        assert.deepEqual(notifications, [])

        const accepted = await tool.execute(
            {
                topic: "cold quality retry",
                content: [{ startId: "m00001", endId: "m00002", summary: "still short" }],
                acknowledgeRisk: true,
            },
            v2Context("cold-quality-accepted"),
        )

        assert.match(String(accepted.content), /Compressed 2 messages/i)
        assert.equal(registry.get(SESSION_ID)?.qualityGateRetryPending, false)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V2 post-commit flush failures keep an accepted hydrated state visible", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-flush-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const messages = history()
    const host = makeHost(projectDir, async () => messages)
    const seededRegistry = new SessionStateRegistry(logger, projectDir)
    const seeded = await seededRegistry.getOrCreate(host.sessions, SESSION_ID, messages, config)
    assignMessageRefs(seeded, messages)
    seedBlock(seeded)
    await saveSessionState(seeded, logger)

    const registry = new SessionStateRegistry(logger, projectDir)
    const factoryCtx = factory(registry, host, config, logger)
    const tool = createV2Tool(
        createDecompressToolDefinition(factoryCtx),
        factoryCtx,
        host,
        permissions,
    )

    try {
        const result = await tool.execute(
            { blockId: "b1", toFile: "/var/tmp/acp-v2-hydration-forbidden.txt" },
            v2Context(),
        )

        assert.match(String(result.content), /ACP decompress failed/i)
        const accepted = registry.get(SESSION_ID)
        assert.ok(accepted)
        assert.equal(accepted.sessionId, SESSION_ID)
        assert.ok(accepted.prune.messages.blocksById.get(1)?.active)
        assert.equal(existsSync(join(projectDir, "relative-acp-state", `${SESSION_ID}.json`)), true)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})

test("V1 tools retain their live-state mutation path", async () => {
    const state = createSessionState()
    state.sessionId = SESSION_ID
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const host = makeHost("/tmp/acp-v1-tool-hydration", async () => history())
    let mutations = 0
    let atomicMutations = 0
    const registry: ToolStateRegistry = {
        get: () => state,
        withSessionMutation: async (_sessionID, operation) => {
            mutations++
            return operation(state)
        },
        async withSessionMutationAndInitialize<T>(): Promise<T | undefined> {
            atomicMutations++
            return undefined
        },
    }
    const factoryCtx = factory(registry, host, config, logger)

    const result = await createAcpContextRecapToolDefinition(factoryCtx).execute(
        {},
        {
            sessionID: SESSION_ID,
            ask: async () => {},
            metadata: () => {},
        },
    )

    assert.equal(result, "No active compression blocks.")
    assert.equal(mutations, 1)
    assert.equal(atomicMutations, 0)
})

test("throwing rollback observers preserve the operation failure and release fresh state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "acp-v2-tool-hydration-observer-"))
    const logger = new Logger(false, "silent")
    const config = buildConfig()
    const messages = history()
    const host = makeHost(projectDir, async () => messages)
    const registry = new SessionStateRegistry(logger, projectDir)
    const operationFailure = new Error("operation failure")
    let observerRan = false

    try {
        await assert.rejects(
            () =>
                registry.withSessionMutationAndInitialize(
                    host.sessions,
                    SESSION_ID,
                    () => messages,
                    (loaded) => loaded,
                    config,
                    () => {
                        throw operationFailure
                    },
                    {
                        onError: () => {
                            observerRan = true
                            throw new Error("rollback observer failure")
                        },
                    },
                ),
            (error: unknown) => error === operationFailure,
        )

        assert.equal(observerRan, true)
        assert.equal(registry.get(SESSION_ID), undefined)
        assert.equal(registry.size, 0)
        const recovered = await registry.getOrCreate(host.sessions, SESSION_ID, messages, config)
        assert.equal(recovered.sessionId, SESSION_ID)
    } finally {
        await rm(projectDir, { recursive: true, force: true })
    }
})
