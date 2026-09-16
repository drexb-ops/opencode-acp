import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import type { SharedToolDefinition, ToolFactoryContext, ToolStateRegistry } from "../lib/compress"
import {
    createAcpContextRecapToolDefinition,
    createAcpStatusToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    createSearchContextToolDefinition,
} from "../lib/compress"
import type { HostPermissionRule, HostPermissionSnapshot } from "../lib/host-permissions"
import type { V2HostAdapter } from "../lib/v2/host"
import { createV2Tool, createV2ToolTransform, type V2ToolEditor } from "../lib/v2/tools"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { createSessionState, type SessionState } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const sessionID = "v2-tools-session"

function config(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
            permission,
            showCompression: false,
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
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function host(rules: readonly HostPermissionRule[] = []): V2HostAdapter {
    return {
        sessions: {
            get: async () => ({ id: sessionID, parentID: null }),
            messages: async () => [],
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async () => {} },
        notifications: { notify: () => {} },
        projectedContext: async () => [],
        directory: "/tmp/v2-tools",
        agentPermissions: async () => rules,
    }
}

function factory(
    state: SessionState,
    rules: readonly HostPermissionRule[] = [],
    permission: "allow" | "ask" | "deny" = "allow",
) {
    const logger = new Logger(false, "silent")
    const adapter = host(rules)
    let guarded = 0
    const registry: ToolStateRegistry = {
        get: () => state,
        withSessionMutation: async (_id, operation) => {
            guarded += 1
            return operation(state)
        },
    }
    const context = {
        host: adapter,
        registry,
        logger,
        config: config(permission),
        prompts: new PromptStore(logger, "/tmp/v2-tools", false, false),
    } satisfies ToolFactoryContext
    return {
        adapter,
        context,
        hostPermissions: { global: undefined, agents: {} } satisfies HostPermissionSnapshot,
        guarded: () => guarded,
    }
}

function v2Context() {
    return {
        sessionID,
        agent: "code",
        messageID: "message-1",
        id: "call-1",
        progress: async () => {},
    }
}

test("V2 registers the five exact tools as direct tools with complete schemas", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const added: unknown[] = []
    const editor = { add: (tool: unknown) => added.push(tool) } as unknown as V2ToolEditor
    createV2ToolTransform(run.context, run.adapter, run.hostPermissions)(editor)

    assert.deepEqual(
        added.map((value) => (value as { name: string }).name),
        ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
    )
    for (const value of added) {
        const tool = value as { input: unknown; options?: Record<string, unknown> }
        assert.ok(tool.input)
        assert.deepEqual(tool.options, { codemode: false, permission: "compress" })
    }
})

test("V2 maps IDs, progress metadata, string/object output, and attachments", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const updates: unknown[] = []
    run.adapter.agentPermissions = async () => []
    const schema = z.object({ value: z.string() })
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute(_input, context) {
            context.metadata({ title: "running", metadata: { phase: "start" } })
            await context.progress?.({ title: "done", status: "completed" })
            return {
                output: "result",
                metadata: { preserved: true },
                attachments: [
                    {
                        type: "file",
                        mime: "text/plain",
                        url: "file:///tmp/result.txt",
                        filename: "result.txt",
                    },
                ],
            }
        },
    }
    const tool = createV2Tool(definition, run.context, run.adapter, run.hostPermissions)
    const result = await tool.execute(
        { value: "ok" },
        {
            ...v2Context(),
            progress: async (update) => {
                updates.push(update)
            },
        },
    )
    assert.deepEqual(result.content, [
        { type: "text", text: "result" },
        { type: "file", uri: "file:///tmp/result.txt", mime: "text/plain", name: "result.txt" },
    ])
    assert.deepEqual(result.metadata, { preserved: true })
    assert.deepEqual(updates, [
        { title: "running", phase: "start" },
        { title: "done", status: "completed" },
    ])
    assert.equal(run.guarded(), 0)
})

test("V2 deny and ask return safe results before state acquisition or mutation", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "unexpected"
        },
    }

    for (const [permission, rules, expected] of [
        ["deny", [], /disabled/i],
        ["allow", [{ action: "compress", resource: "*", effect: "deny" }], /disabled/i],
        ["ask", [], /allow.*deny/i],
    ] as const) {
        const run = factory(state, rules, permission)
        const result = await createV2Tool(
            definition,
            run.context,
            run.adapter,
            run.hostPermissions,
        ).execute({}, v2Context())
        assert.match(String(result.content), expected)
        assert.equal(run.guarded(), 0)
    }
    assert.equal(executed, 0)
})

test("V2 ordered agent rules let a later allow override only a matching deny", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "allowed"
        },
    }
    const run = factory(state, [
        { action: "*", resource: "*", effect: "deny" },
        { action: "compress", resource: "*", effect: "allow" },
    ])
    const result = await createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
    ).execute({}, v2Context())
    assert.equal(result.content, "allowed")
    assert.equal(executed, 1)
    assert.equal(run.guarded(), 0)
})

test("V2 agent allow overrides ACP ask, while ACP deny remains authoritative", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "allowed"
        },
    }

    const askRun = factory(state, [{ action: "compress", resource: "*", effect: "allow" }], "ask")
    const allowed = await createV2Tool(
        definition,
        askRun.context,
        askRun.adapter,
        askRun.hostPermissions,
    ).execute({}, v2Context())
    assert.equal(allowed.content, "allowed")

    const denyRun = factory(state, [{ action: "compress", resource: "*", effect: "allow" }], "deny")
    const denied = await createV2Tool(
        definition,
        denyRun.context,
        denyRun.adapter,
        denyRun.hostPermissions,
    ).execute({}, v2Context())
    assert.match(String(denied.content), /disabled/i)
    assert.equal(executed, 1)
})

test("actual ACP definitions retain their exact V2 names", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    assert.deepEqual(
        [
            createCompressRangeToolDefinition(run.context),
            createDecompressToolDefinition(run.context),
            createSearchContextToolDefinition(run.context),
            createAcpStatusToolDefinition(run.context),
            createAcpContextRecapToolDefinition(run.context),
        ].map((definition) => definition.name),
        ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
    )
})

test("V2 delegates actual ACP execution to the shared single session guard", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const tool = createV2Tool(
        createAcpContextRecapToolDefinition(run.context),
        run.context,
        run.adapter,
        run.hostPermissions,
    )
    const result = await tool.execute({}, v2Context())
    assert.match(String(result.content), /No active compression blocks/)
    assert.equal(run.guarded(), 1)
})
