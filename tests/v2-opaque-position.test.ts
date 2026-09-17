import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Message } from "@opencode/ai"
import type { PluginConfig } from "../lib/config"
import { createV2ContextHandler } from "../lib/v2/context"
import type { V2HostAdapter } from "../lib/v2/host"
import { applyV2ContextPatch, normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import type { WithParts } from "../lib/state"
import { SessionStateRegistry } from "../lib/state"
// Real OpenCode v2.0.3 host lowering, vendored verbatim into this fixture so
// the regression exercises the exact provider message shapes the host emits.
import { toLLMMessages } from "./fixtures/opencode-core-2.0.3/session/runner/to-llm-message.js"

const modelA = { id: "model-a", providerID: "provider-a" }
type OutgoingMessage = ReturnType<typeof Message.make>

function config(storagePath: string): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        storagePath,
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 90_000,
            minContextLimit: 80_000,
            contextLimitFallback: 128_000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 50_000,
            toolOutputNudgeThreshold: 5_000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20_000,
            minCompressRange: 5_000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5_000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32_768,
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
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.2,
                },
            },
        },
        messageFilters: {
            enabled: false,
            filters: {
                "omo-system-reminder": { enabled: true },
                "omo-todo-continuation": { enabled: true },
                "omo-context": { enabled: true },
                "omo-task-directive": { enabled: true },
                "omo-mode-injection": { enabled: true },
            },
        },
    }
}

function host(
    projectedBySession: Map<string, readonly unknown[]>,
    models: readonly { providerId: string; modelId: string; contextLimit?: number }[],
): V2HostAdapter {
    const projectedContext = async (sessionID: string) => projectedBySession.get(sessionID) ?? []
    const sessions = {
        get: async (sessionID: string) => ({ id: sessionID, parentID: undefined }),
        messages: async (): Promise<WithParts[]> => [],
        parentMessages: async (): Promise<WithParts[]> => [],
    }
    return {
        sessions,
        models: { list: async () => models },
        notices: { send: async () => {} },
        notifications: { notify: () => {} },
        projectedContext,
        directory: "/tmp/opencode-v2-opaque-position",
    }
}

function runHandler(projected: readonly unknown[], outgoing: OutgoingMessage[]) {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-opaque-position-"))
    const logger = new Logger(false, "silent")
    const cfg = config(storage)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-opaque-position")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-opaque-position")
    const adapter = host(new Map([["session", projected]]), [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
    ])
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    return {
        storage,
        registry,
        logger,
        event: {
            sessionID: "session",
            agent: "code",
            model: modelA,
            system: [] as never[],
            messages: outgoing,
        },
        handler,
    }
}

function userRecord(id: string, text: string) {
    return { type: "user", id, time: { created: 1 }, text, metadata: {} }
}

function assistantToolRecord(tool: Record<string, unknown>) {
    return {
        type: "assistant",
        id: "assist-tool",
        time: { created: 2 },
        agent: "code",
        model: modelA,
        metadata: {},
        content: [tool],
    }
}

/** Completed shell tool whose result carries two text items ([stdout, notice]). */
function multipartShellTool() {
    return {
        type: "tool",
        id: "call-shell-1",
        name: "shell",
        executed: true,
        state: {
            status: "completed",
            input: { command: "ls" },
            time: { start: 2, end: 3 },
            content: [
                { type: "text", text: "file-a\nfile-b" },
                { type: "text", text: "exit status 0" },
            ],
        },
    }
}

/** Failed shell tool; error results are always opaque. */
function errorShellTool() {
    return {
        type: "tool",
        id: "call-shell-fail",
        name: "shell",
        executed: true,
        state: {
            status: "error",
            input: { command: "definitely-missing" },
            time: { start: 2, end: 3 },
            error: { message: "exit status 127" },
        },
    }
}

/** Single-text completed tool result; representable and editable by ACP. */
function singleTextShellTool() {
    return {
        type: "tool",
        id: "call-shell-single",
        name: "shell",
        executed: true,
        state: {
            status: "completed",
            input: { command: "true" },
            time: { start: 2, end: 3 },
            content: [{ type: "text", text: "ok" }],
        },
    }
}

type LoweredAssistant = {
    content: [
        Extract<OutgoingMessage["content"][number], { type: "tool-call" }>,
        Extract<OutgoingMessage["content"][number], { type: "tool-result" }>,
    ]
}

function buildMultipartFixture() {
    const projected = [userRecord("u-1", "run ls"), assistantToolRecord(multipartShellTool())]
    const outgoing = toLLMMessages(projected, modelA) as unknown as OutgoingMessage[]
    const assistant = outgoing.find((message) => message.id === "assist-tool") as
        LoweredAssistant | undefined
    assert.ok(assistant, "real lowering must emit one assistant message for the tool record")
    assert.equal(assistant.content.length, 2)
    assert.equal(assistant.content[0].type, "tool-call")
    assert.equal(assistant.content[1].type, "tool-result")
    // Two-item results lower to a non-text content result, which ACP must treat
    // as provider-owned opaque content.
    assert.notEqual((assistant.content[1] as { result?: { type?: string } }).result?.type, "text")
    return { projected, outgoing, assistant }
}

function buildErrorFixture() {
    const projected = [userRecord("u-1", "run missing"), assistantToolRecord(errorShellTool())]
    const outgoing = toLLMMessages(projected, modelA) as unknown as OutgoingMessage[]
    const assistant = outgoing.find((message) => message.id === "assist-tool") as
        LoweredAssistant | undefined
    assert.ok(assistant, "real lowering must emit one assistant message for the error tool")
    assert.equal(assistant.content.length, 2)
    assert.equal(assistant.content[0].type, "tool-call")
    assert.equal(assistant.content[1].type, "tool-result")
    assert.equal((assistant.content[1] as { result?: { type?: string } }).result?.type, "error")
    return { projected, outgoing, assistant }
}

function buildSingleTextFixture() {
    const projected = [userRecord("u-1", "run true"), assistantToolRecord(singleTextShellTool())]
    const outgoing = toLLMMessages(projected, modelA) as unknown as OutgoingMessage[]
    const assistant = outgoing.find((message) => message.id === "assist-tool") as
        LoweredAssistant | undefined
    assert.ok(assistant, "real lowering must emit one assistant message for the tool record")
    assert.equal(assistant.content.length, 2)
    assert.equal((assistant.content[1] as { result?: { type?: string } }).result?.type, "text")
    return { projected, outgoing, assistant }
}

function acpIdPart(messageID: string, text: string) {
    return {
        id: "prt_dcp_text_opaquepositiontest",
        sessionID: "s",
        messageID,
        type: "text" as const,
        text,
    }
}

function normalizeFor(projected: readonly unknown[], outgoing: OutgoingMessage[]) {
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "s",
        agent: "code",
        currentModel: modelA,
    })
    assert.equal(projection.valid, true)
    return projection
}

/** Simulates injectMessageIds splicing its ID part before the first tool part. */
function transformWithIdInsertion(projection: ReturnType<typeof normalizeFor>) {
    const transformed = structuredClone(projection.messages)
    const assistant = transformed.find((message) => message.info.id === "assist-tool")!
    const toolIndex = assistant.parts.findIndex((part) => part.type === "tool")
    assert.ok(toolIndex >= 0, "normalized assistant must retain the tool part")
    assistant.parts.splice(toolIndex, 0, acpIdPart(assistant.info.id, "m00002 tag"))
    return transformed
}

test("accepts ACP ID insertion before a multipart tool call while preserving opaque parts by identity", () => {
    const { projected, outgoing, assistant } = buildMultipartFixture()
    const projection = normalizeFor(projected, outgoing)
    const result = applyV2ContextPatch(projection, transformWithIdInsertion(projection))

    assert.equal(result.accepted, true, JSON.stringify(result.rejection ?? null))
    if (!result.accepted) return
    const finalAssistant = result.messages.find((message) => message.id === "assist-tool")!
    assert.equal(finalAssistant.content.length, 3)
    assert.equal(finalAssistant.content[0]?.type, "text")
    assert.match(String(finalAssistant.content[0]?.text), /m00002/)
    assert.strictEqual(finalAssistant.content[1], assistant.content[0])
    assert.strictEqual(finalAssistant.content[2], assistant.content[1])
})

test("accepts ACP ID insertion before an error tool result while preserving opaque parts by identity", () => {
    const { projected, outgoing, assistant } = buildErrorFixture()
    const projection = normalizeFor(projected, outgoing)
    const result = applyV2ContextPatch(projection, transformWithIdInsertion(projection))

    assert.equal(result.accepted, true, JSON.stringify(result.rejection ?? null))
    if (!result.accepted) return
    const finalAssistant = result.messages.find((message) => message.id === "assist-tool")!
    assert.equal(finalAssistant.content.length, 3)
    assert.equal(finalAssistant.content[0]?.type, "text")
    assert.strictEqual(finalAssistant.content[1], assistant.content[0])
    assert.strictEqual(finalAssistant.content[2], assistant.content[1])
})

test("repeated patching over settled multipart output stays idempotent", () => {
    const { projected, outgoing } = buildMultipartFixture()
    const projection = normalizeFor(projected, outgoing)
    const transformed = transformWithIdInsertion(projection)
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true, JSON.stringify(first.rejection ?? null))
    if (!first.accepted) return

    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true, JSON.stringify(second.rejection ?? null))
    if (!second.accepted) return
    assert.deepEqual(second.messages, first.messages)
})

test("rejects a repeated patch after an opaque tool part is reordered within its message", () => {
    const { projected, outgoing } = buildMultipartFixture()
    const projection = normalizeFor(projected, outgoing)
    const transformed = transformWithIdInsertion(projection)
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true, JSON.stringify(first.rejection ?? null))
    if (!first.accepted) return

    const finalAssistant = first.messages.find((message) => message.id === "assist-tool")!
    ;[finalAssistant.content[1], finalAssistant.content[2]] = [
        finalAssistant.content[2],
        finalAssistant.content[1],
    ]
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(repeated.accepted, false)
    if (!repeated.accepted) {
        // Defense in depth: the baseline fingerprint gate detects this first;
        // the opaque-origin gate is the backstop when baseline matching applies.
        assert.ok(
            repeated.rejection.code === "fingerprint-mismatch" ||
                repeated.rejection.code === "opaque-origin",
            `unexpected rejection code: ${repeated.rejection.code}`,
        )
    }
})

test("rejects a repeated patch after an opaque tool part object is replaced", () => {
    const { projected, outgoing } = buildMultipartFixture()
    const projection = normalizeFor(projected, outgoing)
    const transformed = transformWithIdInsertion(projection)
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true, JSON.stringify(first.rejection ?? null))
    if (!first.accepted) return

    const finalAssistant = first.messages.find((message) => message.id === "assist-tool")!
    finalAssistant.content[2] = structuredClone(finalAssistant.content[2])
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(repeated.accepted, false)
    if (!repeated.accepted) {
        // Same layered defense as the reorder case above.
        assert.ok(
            repeated.rejection.code === "fingerprint-mismatch" ||
                repeated.rejection.code === "opaque-origin",
            `unexpected rejection code: ${repeated.rejection.code}`,
        )
    }
})

test("full V2 handler accepts real multipart shell lowering with injected message IDs", async () => {
    const { projected, outgoing, assistant } = buildMultipartFixture()
    const run = runHandler(projected, outgoing)
    try {
        await run.handler(run.event)

        assert.ok(run.registry.get("session"), "transaction must commit instead of rolling back")
        const finalAssistant = run.event.messages.find((message) => message.id === "assist-tool")!
        assert.equal(finalAssistant.content.length, 3)
        assert.equal(finalAssistant.content[0]?.type, "text")
        assert.match(String(finalAssistant.content[0]?.text), /m00002/)
        assert.strictEqual(finalAssistant.content[1], assistant.content[0])
        assert.strictEqual(finalAssistant.content[2], assistant.content[1])
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("full V2 handler accepts real error tool lowering without shifting content-less tool messages", async () => {
    const { projected, outgoing, assistant } = buildErrorFixture()
    const run = runHandler(projected, outgoing)
    try {
        await run.handler(run.event)

        assert.ok(run.registry.get("session"), "transaction must commit instead of rolling back")
        const finalAssistant = run.event.messages.find((message) => message.id === "assist-tool")!
        // An errored tool has no completed string output, so the ID injector
        // (hasContent gate in lib/messages/utils.ts) leaves the message
        // untouched; no insertion means no index shift to validate.
        assert.equal(finalAssistant.content.length, 2)
        assert.strictEqual(finalAssistant.content[0], assistant.content[0])
        assert.strictEqual(finalAssistant.content[1], assistant.content[1])
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("full V2 handler keeps accepting freshly re-lowered history across consecutive turns", async () => {
    const { projected } = buildMultipartFixture()
    const firstOutgoing = toLLMMessages(projected, modelA) as unknown as OutgoingMessage[]
    const firstAssistant = firstOutgoing.find((message) => message.id === "assist-tool")!
    const run = runHandler(projected, firstOutgoing)
    try {
        await run.handler(run.event)
        assert.ok(run.registry.get("session"))

        // Next turn: the host re-lowers the same history into fresh objects.
        const secondOutgoing = toLLMMessages(projected, modelA) as unknown as OutgoingMessage[]
        const secondAssistant = secondOutgoing.find((message) => message.id === "assist-tool")!
        assert.notStrictEqual(secondAssistant.content[0], firstAssistant.content[0])
        run.event.messages = secondOutgoing
        await run.handler(run.event)

        const finalAssistant = run.event.messages.find((message) => message.id === "assist-tool")!
        assert.equal(finalAssistant.content.length, 3)
        assert.match(String(finalAssistant.content[0]?.text), /m00002/)
        assert.strictEqual(finalAssistant.content[1], secondAssistant.content[0])
        assert.strictEqual(finalAssistant.content[2], secondAssistant.content[1])
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("full V2 handler still edits representable single-text tool results in place", async () => {
    const { projected, outgoing, assistant } = buildSingleTextFixture()
    const run = runHandler(projected, outgoing)
    try {
        await run.handler(run.event)

        assert.ok(run.registry.get("session"))
        const finalAssistant = run.event.messages.find((message) => message.id === "assist-tool")!
        assert.equal(finalAssistant.content.length, 2)
        assert.strictEqual(finalAssistant.content[0], assistant.content[0])
        const result = finalAssistant.content[1] as { result?: { value?: unknown } }
        assert.notStrictEqual(finalAssistant.content[1], assistant.content[1])
        assert.match(String(result.result?.value), /m00002/)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})
