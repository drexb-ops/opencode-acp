import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import type { Message as AiMessage } from "@opencode/ai"
import type { PluginConfig } from "../lib/config"
import { injectMessageIds } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
import { applyV2ContextPatch, normalizeV2ProjectedHistory } from "../lib/v2/projection"

const MODEL = { id: "test-model", providerID: "test-provider" }
const SESSION_ID = "v2-projection-reliability"

const INJECT_CONFIG: PluginConfig = {
    enabled: true,
    autoUpdate: false,
    debug: false,
    logLevel: "error",
    allowSubAgents: false,
    pruneNotification: "off",
    pruneNotificationType: "toast",
    commands: { enabled: true, protectedTools: [] },
    experimental: { customPrompts: false },
    protectedFilePatterns: [],
    compress: {
        permission: "allow",
        showCompression: false,
        summaryBuffer: false,
        candidates: false,
        maxContextLimit: 128000,
        minContextLimit: 128000,
        contextLimitFallback: 128000,
        nudgeFrequency: 5,
        minNudgeContextPercent: 5,
        nudgeGrowthTokens: 50000,
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
        maxBlockAge: Number.MAX_SAFE_INTEGER,
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
    },
    qualityGate: {
        enabled: false,
        algorithm: "rouge-recall-v1",
        algorithms: {},
    },
    messageFilters: { enabled: false, filters: {} },
}

function normalize(projected: readonly unknown[], outgoing: readonly AiMessage[]) {
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: SESSION_ID,
        agent: "build",
        currentModel: MODEL,
    })
    assert.equal(projection.valid, true, projection.rejection?.message)
    return projection
}

function injectIdBeforeOpaqueTool(projection: ReturnType<typeof normalize>, assistantID: string) {
    const transformed = structuredClone(projection.messages)
    const state = createSessionState()
    state.messageIds.byRawId.set(assistantID, "m00001")
    injectMessageIds(state, INJECT_CONFIG, transformed)
    return transformed
}

function prependAcpText(transformed: WithParts[], assistantID: string): void {
    const assistant = transformed.find((message) => message.info.id === assistantID)
    assert.ok(assistant)
    assistant.parts.splice(0, 0, {
        id: "prt_dcp_text_reliability",
        sessionID: SESSION_ID,
        messageID: assistantID,
        type: "text" as const,
        text: "<dcp-message-id>m00001</dcp-message-id>",
    })
}

function multipartToolFixture() {
    const assistantID = "assistant-multipart"
    const callID = "shell-multipart"
    const projected = [
        {
            type: "assistant",
            id: assistantID,
            time: { created: 1, completed: 2 },
            agent: "build",
            model: MODEL,
            content: [
                {
                    type: "tool",
                    id: callID,
                    name: "shell",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { command: "true" },
                        content: [
                            { type: "text", text: "stdout" },
                            { type: "text", text: "Process exited with code 0" },
                        ],
                    },
                },
            ],
        },
    ]
    const outgoing = [
        Message.make({
            id: assistantID,
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: callID,
                    name: "shell",
                    input: { command: "true" },
                    providerExecuted: false,
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: callID,
                    name: "shell",
                    result: {
                        type: "content" as const,
                        value: [
                            { type: "text" as const, text: "stdout" },
                            { type: "text" as const, text: "Process exited with code 0" },
                        ],
                    },
                    providerExecuted: false,
                },
            ],
        }),
    ]
    return { assistantID, callID, outgoing, projection: normalize(projected, outgoing) }
}

function executedErrorToolFixture() {
    const assistantID = "assistant-error"
    const callID = "shell-error"
    const projected = [
        {
            type: "assistant",
            id: assistantID,
            time: { created: 1, completed: 2 },
            agent: "build",
            model: MODEL,
            content: [
                {
                    type: "tool",
                    id: callID,
                    name: "shell",
                    executed: true,
                    state: {
                        status: "error",
                        input: { command: "false" },
                        error: { type: "ToolError", message: "Process exited with code 1" },
                    },
                },
            ],
        },
    ]
    const outgoing = [
        Message.make({
            id: assistantID,
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: callID,
                    name: "shell",
                    input: { command: "false" },
                    providerExecuted: true,
                },
                {
                    type: "tool-result" as const,
                    id: callID,
                    name: "shell",
                    result: {
                        type: "error" as const,
                        value: {
                            error: { type: "ToolError", message: "Process exited with code 1" },
                            content: [],
                        },
                    },
                    providerExecuted: true,
                },
            ],
        }),
    ]
    return { assistantID, callID, outgoing, projection: normalize(projected, outgoing) }
}

test("preserves multipart shell output through real ID injection and a repeated patch", () => {
    const { assistantID, outgoing, projection } = multipartToolFixture()
    const transformed = injectIdBeforeOpaqueTool(projection, assistantID)
    const normalizedAssistant = transformed.find((message) => message.info.id === assistantID)
    assert.deepEqual(
        normalizedAssistant?.parts.map((part) => part.type),
        ["step-start", "text", "tool"],
    )

    const first = applyV2ContextPatch(projection, transformed, outgoing)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    assert.strictEqual(first.messages[0]?.content[1], outgoing[0]?.content[0])
    assert.strictEqual(first.messages[1]?.content[0], outgoing[1]?.content[0])

    const repeated = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(repeated.accepted, true)
    if (!repeated.accepted) return
    assert.deepEqual(repeated.messages, first.messages)
})

test("preserves provider-executed error call/result identities around ACP text", () => {
    const { assistantID, outgoing, projection } = executedErrorToolFixture()
    const transformed = structuredClone(projection.messages)
    prependAcpText(transformed, assistantID)

    const result = applyV2ContextPatch(projection, transformed, outgoing)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.strictEqual(result.messages[0]?.content[1], outgoing[0]?.content[0])
    assert.strictEqual(result.messages[0]?.content[2], outgoing[0]?.content[1])

    const repeated = applyV2ContextPatch(projection, transformed, result.messages)
    assert.equal(repeated.accepted, true)
})

test("patches mixed assistant text and opaque multipart output without replacing provider data", () => {
    const { assistantID, outgoing, projection } = multipartToolFixture()
    const projected = [
        {
            type: "assistant",
            id: assistantID,
            time: { created: 1, completed: 2 },
            agent: "build",
            model: MODEL,
            content: [
                { type: "text", text: "safe assistant text" },
                {
                    type: "tool",
                    id: "shell-multipart",
                    name: "shell",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { command: "true" },
                        content: [
                            { type: "text", text: "stdout" },
                            { type: "text", text: "Process exited with code 0" },
                        ],
                    },
                },
            ],
        },
    ]
    const mixedOutgoing = [
        Message.make({
            id: assistantID,
            role: "assistant",
            content: [
                { type: "text" as const, text: "safe assistant text" },
                outgoing[0]!.content[0]!,
            ],
        }),
        outgoing[1]!,
    ]
    const mixedProjection = normalize(projected, mixedOutgoing)
    const transformed = injectIdBeforeOpaqueTool(mixedProjection, assistantID)

    const result = applyV2ContextPatch(mixedProjection, transformed, mixedOutgoing)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.match(result.messages[0]?.content[0]?.text ?? "", /m00001/)
    assert.strictEqual(result.messages[0]?.content[1], mixedOutgoing[0]?.content[1])
    assert.strictEqual(result.messages[1]?.content[0], mixedOutgoing[1]?.content[0])
})

test("rejects replacement, deletion, and reordering of opaque provider content", () => {
    const cases = [
        {
            name: "replacement",
            content: (original: AiMessage) => [{ ...original.content[0] }, original.content[1]!],
        },
        {
            name: "deletion",
            content: (original: AiMessage) => [original.content[1]!],
        },
        {
            name: "reordering",
            content: (original: AiMessage) => [original.content[1]!, original.content[0]!],
        },
    ]
    for (const fixture of cases) {
        const { assistantID, outgoing, projection } = executedErrorToolFixture()
        const transformed = structuredClone(projection.messages)
        prependAcpText(transformed, assistantID)
        const changed = Message.make({
            id: assistantID,
            role: "assistant",
            content: fixture.content(outgoing[0]!),
        })

        const result = applyV2ContextPatch(projection, transformed, [changed])
        assert.equal(result.accepted, false, fixture.name)
        if (!result.accepted)
            assert.ok(
                ["opaque-origin", "fingerprint-mismatch"].includes(result.rejection.code),
                fixture.name,
            )
    }
})
