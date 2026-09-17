import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import { z } from "zod"
import type { PluginConfig } from "../lib/config"
import type { SharedToolDefinition, ToolFactoryContext, ToolStateRegistry } from "../lib/compress"
import type { HostPermissionSnapshot } from "../lib/host-permissions"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { messageHasCompress, messageHasCompressAttempt } from "../lib/messages/query"
import { PromptStore, type RuntimePrompts } from "../lib/prompts/store"
import { rebuildCompressionState } from "../lib/state/rebuild"
import { createSessionState } from "../lib/state"
import { applyV2ContextPatch, normalizeV2ProjectedHistory } from "../lib/v2/projection"
import type { V2HostAdapter } from "../lib/v2/host"
import { createV2Tool, V2_ACP_TOOL_NAMES } from "../lib/v2/tools"

const SESSION_ID = "v2-tool-result-status"
const MODEL = { id: "test-model", providerID: "test-provider" }
const PROMPTS: RuntimePrompts = {
    system: "",
    compressRange: "",
    contextLimitNudge: "",
    turnNudge: "",
    iterationNudge: "",
    subagentExtension: "",
    decompressExtension: "",
}

function config(
    permission: "allow" | "ask" | "deny" = "allow",
    allowSubAgents = true,
): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents,
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
            maxContextLimit: 128000,
            minContextLimit: 64000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
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
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
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

function adapter(parentID: string | null = null): V2HostAdapter {
    return {
        directory: "/tmp/v2-tool-result-status",
        sessions: {
            get: async () => ({ id: SESSION_ID, parentID }),
            messages: async () => [],
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async () => {} },
        notifications: { notify: () => {} },
        projectedContext: async () => [],
        agentPermissions: async () => [],
    }
}

function factory(
    toolConfig = config(),
    host = adapter(),
): { context: ToolFactoryContext; host: V2HostAdapter; permissions: HostPermissionSnapshot } {
    const logger = new Logger(false, "silent")
    const state = createSessionState()
    state.sessionId = SESSION_ID
    const registry: ToolStateRegistry = {
        get: () => state,
        withSessionMutation: async (_sessionID, operation) => operation(state),
    }
    return {
        context: {
            host,
            registry,
            logger,
            config: toolConfig,
            prompts: new PromptStore(logger, host.directory, false, false),
        },
        host,
        permissions: { global: undefined, agents: {} },
    }
}

function context() {
    return {
        sessionID: SESSION_ID,
        messageID: "assistant-tool-message",
        id: "compress-call",
        agent: "code",
        progress: async () => {},
    }
}

function definition(
    name: string,
    execute: SharedToolDefinition["execute"],
): SharedToolDefinition<typeof z.object> {
    const schema = z.object({})
    return { name, description: name, schema, inputSchema: schema, execute }
}

function normalizeCompressResult(output: string, metadata?: Record<string, unknown>) {
    const input = {
        topic: "compress old context",
        content: [{ startId: "m00001", endId: "m00001", summary: "summary" }],
    }
    const projected = [
        { type: "user", id: "prior-user", time: { created: 0 }, text: "earlier context" },
        {
            type: "assistant",
            id: "assistant-tool-message",
            time: { created: 1, completed: 2 },
            model: MODEL,
            content: [
                {
                    type: "tool",
                    id: "compress-call",
                    name: "compress",
                    executed: false,
                    state: {
                        status: "completed",
                        input,
                        content: [{ type: "text", text: output }],
                        ...(metadata ? { metadata } : {}),
                    },
                },
            ],
        },
    ]
    const outgoing = [
        Message.make({ id: "prior-user", role: "user", content: "earlier context" }),
        Message.make({
            id: "assistant-tool-message",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "compress-call",
                    name: "compress",
                    input,
                    providerExecuted: false,
                },
            ],
        }),
        Message.tool({
            type: "tool-result" as const,
            id: "compress-call",
            name: "compress",
            result: { type: "text" as const, value: output },
            providerExecuted: false,
        }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: SESSION_ID,
        currentModel: MODEL,
    })
    assert.equal(projection.valid, true, projection.rejection?.message)
    const message = projection.messages.find(
        (candidate) => candidate.info.id === "assistant-tool-message",
    )!
    const part = message.parts.find((candidate) => candidate.type === "tool")
    assert.ok(part)
    if (!part || part.type !== "tool") throw new Error("Expected normalized compress tool")
    return { input, message, outgoing, part, projection }
}

test("marks resolved error results from every V2 ACP tool with nonempty acpError metadata", async () => {
    for (const name of V2_ACP_TOOL_NAMES) {
        const run = factory()
        const result = await createV2Tool(
            definition(name, async () => "unexpected"),
            run.context,
            run.host,
            run.permissions,
            () => false,
        ).execute({}, context())

        assert.equal(typeof result.metadata?.acpError, "string", name)
        assert.ok(String(result.metadata?.acpError).trim(), name)
    }
})

test("marks denied, ask, and execution failures as explicit V2 tool errors", async () => {
    const variants = [
        {
            name: "deny",
            run: () => factory(config("deny")),
            execute: async () => "unexpected",
        },
        {
            name: "ask",
            run: () => factory(config("ask")),
            execute: async () => "unexpected",
        },
        {
            name: "execution",
            run: () => factory(),
            execute: async () => {
                throw new Error("expected execution failure")
            },
        },
        {
            name: "subagent",
            run: () => factory(config("allow", false), adapter("parent-session")),
            execute: async () => "unexpected",
        },
    ]
    for (const variant of variants) {
        const run = variant.run()
        const result = await createV2Tool(
            definition("compress", variant.execute),
            run.context,
            run.host,
            run.permissions,
        ).execute({}, context())

        assert.equal(typeof result.metadata?.acpError, "string", variant.name)
        assert.ok(String(result.metadata?.acpError).trim(), variant.name)
    }
})

test("normalizes resolved V2 compress failures as attempts without rebuilding state", async () => {
    const run = factory()
    const result = await createV2Tool(
        definition("compress", async () => {
            throw new Error("range validation failed")
        }),
        run.context,
        run.host,
        run.permissions,
    ).execute({}, context())
    assert.match(String(result.content), /ACP compress failed/i)
    assert.equal(typeof result.metadata?.acpError, "string")

    const normalized = normalizeCompressResult(String(result.content), result.metadata)
    assert.equal(normalized.part.state?.status, "error")
    assert.equal(messageHasCompress(normalized.message), false)
    assert.equal(messageHasCompressAttempt(normalized.message), true)

    const state = createSessionState()
    const rebuilt = rebuildCompressionState(
        state,
        [normalized.message],
        config(),
        new Logger(false, "silent"),
    )
    assert.equal(rebuilt, 0)
    assert.equal(state.prune.messages.blocksById.size, 0)

    state.nudges.lastNudgeShownTokens = 100
    state.nudges.lastPerMessageNudgeTokens = 100
    injectCompressNudges(
        state,
        config(),
        new Logger(false, "silent"),
        structuredClone(normalized.projection.messages),
        PROMPTS,
        undefined,
        undefined,
        300,
        undefined,
        undefined,
        200,
    )
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100)
    assert.equal(state.nudges.compressBaselineSet, false)

    const patched = applyV2ContextPatch(
        normalized.projection,
        structuredClone(normalized.projection.messages),
    )
    assert.equal(patched.accepted, true)
    if (!patched.accepted) return
    assert.strictEqual(patched.messages[2]?.content[0], normalized.outgoing[2]?.content[0])
})

test("keeps real V2 compress successes completed and recognizes historical failure text", async () => {
    const run = factory()
    const result = await createV2Tool(
        definition("compress", async () => "Compressed 1 messages into 1 block."),
        run.context,
        run.host,
        run.permissions,
    ).execute({}, context())
    assert.equal(result.metadata?.acpError, undefined)

    const success = normalizeCompressResult(String(result.content), result.metadata)
    assert.equal(success.part.state?.status, "completed")
    assert.equal(messageHasCompress(success.message), true)
    assert.equal(messageHasCompressAttempt(success.message), true)

    const historical = normalizeCompressResult("ACP compress failed: old stored failure")
    assert.equal(historical.part.state?.status, "error")
    assert.equal(messageHasCompress(historical.message), false)
    assert.equal(messageHasCompressAttempt(historical.message), true)
})
