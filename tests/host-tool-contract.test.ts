import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import type { PluginInput } from "@opencode-ai/plugin"
import {
    acpContextRecapInputSchema,
    acpStatusInputSchema,
    compressRangeInputSchema,
    createAcpContextRecapToolDefinition,
    createAcpStatusToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    createSearchContextToolDefinition,
    decompressInputSchema,
    searchContextInputSchema,
} from "../lib/compress"
import type { HostServices, NoticeInput, NotificationInput } from "../lib/host"
import { createModelLimitCatalog } from "../lib/state/model-limits"
import { createSessionState, type WithParts } from "../lib/state"
import { createV1Host } from "../lib/v1/host"
import { createV1Tool } from "../lib/v1/tools"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import type { ToolStateRegistry } from "../lib/compress"

const SESSION_ID = "host-tool-contract-session"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: true,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
            toolOutputNudgeThreshold: 5000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: { enabled: false, filters: {} },
    }
}

function makeHost(
    notifications: NotificationInput[] = [],
    notices: NoticeInput[] = [],
): HostServices {
    return {
        sessions: {
            async get() {
                return { parentID: null }
            },
            async messages() {
                return [] as WithParts[]
            },
            async parentMessages() {
                return [] as WithParts[]
            },
        },
        models: {
            async list() {
                return [{ providerId: "provider", modelId: "model", contextLimit: 128000 }]
            },
        },
        notices: {
            async send(input) {
                notices.push(input)
            },
        },
        notifications: {
            notify(input) {
                notifications.push(input)
            },
        },
    }
}

function makeFactoryContext(host: HostServices) {
    const state = createSessionState()
    state.sessionId = SESSION_ID
    return {
        host,
        registry: { get: () => state } satisfies ToolStateRegistry,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: new PromptStore(new Logger(false), "/tmp", false, false),
    }
}

test("shared ACP definitions expose complete root-Zod contracts", () => {
    const host = makeHost()
    const context = makeFactoryContext(host)
    const definitions = [
        createCompressRangeToolDefinition(context),
        createDecompressToolDefinition(context),
        createSearchContextToolDefinition(context),
        createAcpStatusToolDefinition(context),
        createAcpContextRecapToolDefinition(context),
    ]

    assert.deepEqual(
        definitions.map((definition) => definition.name),
        ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
    )
    for (const definition of definitions) {
        assert.equal(typeof definition.description, "string")
        assert.ok(definition.description.length > 0)
        assert.equal(definition.inputSchema, definition.schema)
        assert.equal(typeof definition.schema.safeParse, "function")
    }

    assert.equal(compressRangeInputSchema.safeParse({}).success, false)
    assert.equal(decompressInputSchema.safeParse({}).success, true)
    assert.equal(searchContextInputSchema.safeParse({ query: "context" }).success, true)
    assert.equal(acpStatusInputSchema.safeParse({}).success, true)
    assert.equal(acpContextRecapInputSchema.safeParse({ blockId: 1 }).success, true)
})

test("shared execution and V1 adapter preserve IDs, ask, and metadata", async () => {
    const calls: string[] = []
    const host = makeHost()
    const context = makeFactoryContext(host)
    const definition = createDecompressToolDefinition(context)
    const runContext = {
        sessionID: SESSION_ID,
        messageID: "message-1",
        callID: "call-1",
        agent: "assistant",
        ask: async () => calls.push("ask"),
        metadata: ({ title }: { title?: string }) => calls.push(`metadata:${title}`),
    }

    const sharedResult = await definition.execute({ blockId: "b1" }, runContext)
    assert.match(String(sharedResult), /Block 1 does not exist/)
    assert.deepEqual(calls, ["ask", "metadata:Decompress"])

    calls.length = 0
    const v1Tool = createV1Tool(definition)
    const v1Result = await v1Tool.execute(
        { blockId: "b1" },
        {
            sessionID: SESSION_ID,
            messageID: "message-1",
            agent: "assistant",
            directory: "/tmp",
            worktree: "/tmp",
            abort: new AbortController().signal,
            ask: async () => calls.push("ask"),
            metadata: ({ title }: { title?: string }) => calls.push(`metadata:${title}`),
        },
    )
    assert.match(String(v1Result), /Block 1 does not exist/)
    assert.deepEqual(calls, ["ask", "metadata:Decompress"])
})

test("model catalog consumes host inventory and V1 host translates client data", async () => {
    const catalog = createModelLimitCatalog()
    assert.equal(
        await catalog.hydrate({
            list: async () => [
                { providerId: "p", modelId: "small", contextLimit: 64000 },
                { providerId: "p", modelId: "unknown" },
            ],
        }),
        1,
    )
    assert.equal(catalog.resolve("p", "small"), 64000)
    assert.equal(catalog.resolve("p", "unknown"), undefined)

    const toasts: unknown[] = []
    const prompts: unknown[] = []
    const client = {
        config: {
            providers: async () => ({
                data: {
                    providers: [{ id: "p", models: { large: { limit: { context: 256000 } } } }],
                },
            }),
        },
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: [] }),
            prompt: async (input: unknown) => {
                prompts.push(input)
                return {}
            },
        },
        tui: {
            showToast: async (input: unknown) => {
                toasts.push(input)
            },
        },
    }
    const host = createV1Host({ client } as unknown as Pick<PluginInput, "client">)
    assert.deepEqual(await host.models.list(), [
        { providerId: "p", modelId: "large", contextLimit: 256000 },
    ])

    await host.notifications.notify({
        title: "ACP",
        message: "context updated",
        variant: "info",
        duration: 5000,
    })
    assert.deepEqual(toasts, [
        { body: { title: "ACP", message: "context updated", variant: "info", duration: 5000 } },
    ])

    await host.notices.send({
        sessionID: SESSION_ID,
        text: "command output",
        metadata: { providerId: "p", modelId: "large", agent: "assistant", variant: "default" },
    })
    assert.deepEqual(prompts, [
        {
            path: { id: SESSION_ID },
            body: {
                noReply: true,
                agent: "assistant",
                model: { providerID: "p", modelID: "large" },
                variant: "default",
                parts: [{ type: "text", text: "command output", ignored: true }],
            },
        },
    ])
})
