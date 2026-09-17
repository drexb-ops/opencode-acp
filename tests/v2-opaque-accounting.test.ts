import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Message } from "@opencode/ai"
import type { PluginConfig } from "../lib/config"
import { createCompressRangeToolDefinition } from "../lib/compress"
import { filterNonRemovableSources } from "../lib/compress/range-utils"
import type { SelectionResolution } from "../lib/compress/types"
import { createV2ContextHandler } from "../lib/v2/context"
import { createV2Host, type V2Context } from "../lib/v2/host"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { SessionStateRegistry, type SessionState } from "../lib/state"

/**
 * [Issue #420] V2 compress reported savings for non-removable opaque sources
 * (e.g. completed native compactions) that restoreMissingV2OpaqueSources puts
 * back byte-for-byte on every request. These tests pin the fix:
 * - the host exposes nonRemovableSourceIds derived from projection provenance
 * - planning excludes those IDs from selections and token accounting
 * - an opaque-only selection is rejected instead of reporting false savings
 * - a mixed selection counts only removable content, and the NEXT REQUEST'S
 *   wire bytes are verified (patch accepted, original checkpoint unchanged)
 */

const model = { id: "model-a", providerID: "provider-a" }

function longText(tag: string): string {
    return `${tag} ${"x".repeat(900)}`
}

function buildHistory() {
    const setup = longText("setup")
    const workOne = longText("work one")
    const workTwo = longText("work two")
    const workThree = longText("work three")
    const projected = [
        { type: "user", id: "user-0", time: { created: 0 }, text: setup },
        {
            type: "compaction",
            id: "long-compaction",
            time: { created: 1 },
            status: "completed",
            summary: `summary ${"y".repeat(900)}`,
            recent: `recent ${"z".repeat(900)}`,
            providerState: { responseID: "native-summary", sequence: 7 },
        },
        { type: "user", id: "user-1", time: { created: 2 }, text: workOne },
        { type: "user", id: "user-2", time: { created: 3 }, text: workTwo },
        { type: "user", id: "user-3", time: { created: 4 }, text: workThree },
    ]
    const outgoing = [
        Message.make({ id: "user-0", role: "user", content: setup }),
        Message.make({ id: "long-compaction", role: "user", content: "native checkpoint payload" }),
        Message.make({ id: "user-1", role: "user", content: workOne }),
        Message.make({ id: "user-2", role: "user", content: workTwo }),
        Message.make({ id: "user-3", role: "user", content: workThree }),
    ]
    return { projected, outgoing }
}

function config(): PluginConfig {
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
            minCompressRange: 1_000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
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
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function fakeV2Context(projected: readonly unknown[], sessionID: string): V2Context {
    return {
        session: {
            get: async () => ({ data: { id: sessionID } }),
            context: async () => projected,
        },
        location: { directory: "/tmp/acp-v2-opaque-accounting" },
        catalog: { model: { list: async () => ({ data: [] }) } },
    } as unknown as V2Context
}

function harness(projected: readonly unknown[], sessionID: string) {
    // Unique per-harness storage dir AND unique session IDs keep each test's
    // persisted state isolated (persistence keys by {storageDir}/{sessionID}).
    const storagePath = mkdtempSync(join(tmpdir(), "acp-v2-opaque-accounting-"))
    const logger = new Logger(false, "silent")
    const cfg = config()
    cfg.storagePath = storagePath
    const registry = new SessionStateRegistry(logger, storagePath)
    const prompts = new PromptStore(logger, storagePath)
    const host = createV2Host(fakeV2Context(projected, sessionID))
    const definition = createCompressRangeToolDefinition({
        host,
        registry,
        logger,
        config: cfg,
        prompts,
    })
    const handler = createV2ContextHandler(host, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    return { logger, cfg, registry, prompts, host, definition, handler }
}

function eventOf(messages: ReturnType<typeof Message.make>[], sessionID: string) {
    return { sessionID, agent: "code", model, system: [], messages }
}

function toolCtx(callID: string, sessionID: string) {
    return {
        sessionID,
        messageID: "message-tool",
        callID,
        ask: async () => {},
        metadata: () => {},
        permission: "allow" as const,
    }
}

function refForRawId(state: SessionState, rawId: string): string {
    for (const [ref, raw] of state.messageIds.byRef) {
        if (raw === rawId) return ref
    }
    assert.fail(`no ref assigned for ${rawId}`)
}

test("#420 filterNonRemovableSources drops IDs and token entries, preserves the rest", () => {
    const selection: SelectionResolution = {
        startReference: { kind: "message", rawIndex: 0, messageId: "a" },
        endReference: { kind: "message", rawIndex: 2, messageId: "c" },
        messageIds: ["a", "b", "c"],
        messageTokenById: new Map([
            ["a", 10],
            ["b", 20],
            ["c", 30],
        ]),
        toolIds: [],
        requiredBlockIds: [],
    }
    assert.strictEqual(filterNonRemovableSources(selection, new Set()), selection)
    const filtered = filterNonRemovableSources(selection, new Set(["b"]))
    assert.notStrictEqual(filtered, selection)
    assert.deepEqual(filtered.messageIds, ["a", "c"])
    assert.deepEqual(
        [...filtered.messageTokenById.entries()],
        [
            ["a", 10],
            ["c", 30],
        ],
    )
    assert.deepEqual(filtered.toolIds, [])
    assert.deepEqual(filtered.requiredBlockIds, [])
    assert.strictEqual(filtered.startReference, selection.startReference)
    assert.strictEqual(filtered.endReference, selection.endReference)
})

test("#420 V2 host derives non-removable source IDs from projection provenance", async () => {
    const projected = [
        { type: "user", id: "user-1", time: { created: 0 }, text: "removable user message" },
        {
            type: "compaction",
            id: "local-compaction",
            time: { created: 1 },
            status: "completed",
            summary: "local summary",
            recent: "local recent",
            providerState: { responseID: "native-summary", sequence: 7 },
        },
        {
            type: "compaction",
            id: "provider-checkpoint",
            time: { created: 2 },
            status: "completed",
            summary: "checkpoint summary",
            recent: "checkpoint recent",
            providerContext: { encrypted: true },
        },
        { type: "system", id: "sys-1", time: { created: 3 }, text: "expected system" },
        {
            type: "synthetic",
            id: "foreign-synthetic",
            time: { created: 4 },
            text: "foreign synthetic",
        },
        {
            type: "synthetic",
            id: "msg_acp_notice_aaaaaaaaaaaaaaaa",
            time: { created: 5 },
            text: "acp notice",
        },
        { type: "compaction", id: "running-compaction", time: { created: 6 }, status: "running" },
    ]
    const sessionID = "v2-opaque-t2-host"
    const host = createV2Host(fakeV2Context(projected, sessionID))
    const ids = await host.nonRemovableSourceIds!(sessionID)
    assert.ok(ids.has("local-compaction"), "completed local compaction is non-removable")
    assert.ok(ids.has("provider-checkpoint"), "provider checkpoint compaction is non-removable")
    assert.ok(ids.has("sys-1"), "system messages are non-removable")
    assert.ok(ids.has("foreign-synthetic"), "foreign synthetics are non-removable")
    assert.ok(!ids.has("user-1"), "user messages are removable")
    assert.ok(!ids.has("msg_acp_notice_aaaaaaaaaaaaaaaa"), "ACP-owned notices are excluded")
    assert.ok(!ids.has("running-compaction"), "incomplete compactions have no message yet")
})

test("#420 V2 host resolver propagates host failures so planning can fail closed", async () => {
    const sessionID = "v2-opaque-t3-failure"
    const failingContext = {
        session: {
            get: async () => ({ data: { id: sessionID } }),
            context: async () => {
                throw new Error("context unavailable")
            },
        },
        location: { directory: "/tmp/acp-v2-opaque-accounting" },
    } as unknown as V2Context
    const host = createV2Host(failingContext)
    await assert.rejects(host.nonRemovableSourceIds!(sessionID), /context unavailable/)
})

test("#420 opaque-only selection is rejected with an actionable error and stores nothing", async () => {
    const { projected, outgoing } = buildHistory()
    const sessionID = "v2-opaque-t4-opaque-only"
    const run = harness(projected, sessionID)
    await run.handler(eventOf(structuredClone(outgoing), sessionID))
    const compactionRef = refForRawId(run.registry.get(sessionID)!, "long-compaction")

    await assert.rejects(
        run.definition.execute(
            {
                topic: "opaque only",
                content: [
                    { startId: compactionRef, endId: compactionRef, summary: "never stored" },
                ],
            },
            toolCtx("call-opaque", sessionID),
        ),
        (error: Error) => {
            assert.match(error.message, /provider-owned sources/)
            assert.match(error.message, /save nothing/)
            return true
        },
    )
    assert.equal(run.registry.get(sessionID)!.prune.messages.blocksById.size, 0)
})

test("#420 mixed selection counts only removable content and keeps the checkpoint on the wire", async () => {
    const { projected, outgoing } = buildHistory()
    const sessionID = "v2-opaque-t5-mixed"
    const run = harness(projected, sessionID)
    await run.handler(eventOf(structuredClone(outgoing), sessionID))
    const state = run.registry.get(sessionID)!
    const compactionRef = refForRawId(state, "long-compaction")
    const lastUserRef = refForRawId(state, "user-3")

    const output = String(
        await run.definition.execute(
            {
                topic: "mixed range",
                content: [
                    {
                        startId: compactionRef,
                        endId: lastUserRef,
                        summary: "mixed summary covering three work messages",
                    },
                ],
            },
            toolCtx("call-mixed", sessionID),
        ),
    )
    assert.match(output, /Compressed 3 messages/)
    assert.match(output, /1 provider-owned message\(s\) were excluded from compression/)
    assert.match(output, /NO savings were counted/)

    const block = [...run.registry.get(sessionID)!.prune.messages.blocksById.values()][0]!
    assert.deepEqual([...block.directMessageIds].sort(), ["user-1", "user-2", "user-3"])
    assert.ok(!block.effectiveMessageIds.includes("long-compaction"))

    // Acceptance criterion 3: validate the next request's actual bytes/content,
    // not just the block count. The summary reaches the model through the
    // compress tool call's `summary` parameter (which opencode persists in
    // history); ACP owns the wire outcome here: removable messages gone,
    // opaque source byte-identical, real byte savings as a result.
    const bytesOf = (messages: ReturnType<typeof Message.make>[]) =>
        messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
    const bytesBefore = bytesOf(outgoing)
    const removedBytes = [outgoing[2], outgoing[3], outgoing[4]].reduce(
        (n, m) => n + JSON.stringify(m).length,
        0,
    )
    const nextRequest = eventOf(structuredClone(outgoing), sessionID)
    await run.handler(nextRequest)
    const checkpointAfter = nextRequest.messages.find((message) => message.id === "long-compaction")
    assert.ok(checkpointAfter, "provider checkpoint must remain on the wire")
    assert.equal(JSON.stringify(checkpointAfter), JSON.stringify(outgoing[1]))
    for (const id of ["user-1", "user-2", "user-3"]) {
        assert.ok(!nextRequest.messages.some((message) => message.id === id), `${id} must be gone`)
    }
    assert.ok(
        bytesOf(nextRequest.messages) < bytesBefore - removedBytes / 2,
        "wire must show real savings beyond the removed messages' own size",
    )
})

test("#420 refuses to plan when removability cannot be verified (fail closed)", async () => {
    const { projected, outgoing } = buildHistory()
    const sessionID = "v2-opaque-t6-fail-closed"
    const base = harness(projected, sessionID)
    const failingHost = {
        ...base.host,
        nonRemovableSourceIds: async (): Promise<ReadonlySet<string>> => {
            throw new Error("host provenance unavailable")
        },
    }
    const definition = createCompressRangeToolDefinition({
        host: failingHost,
        registry: base.registry,
        logger: base.logger,
        config: base.cfg,
        prompts: base.prompts,
    })
    await base.handler(eventOf(structuredClone(outgoing), sessionID))
    const compactionRef = refForRawId(base.registry.get(sessionID)!, "long-compaction")

    await assert.rejects(
        definition.execute(
            {
                topic: "t",
                content: [{ startId: compactionRef, endId: compactionRef, summary: "x" }],
            },
            toolCtx("call-failclosed", sessionID),
        ),
        (error: Error) => {
            assert.match(error.message, /Cannot verify which session sources are removable/)
            assert.match(error.message, /host provenance unavailable/)
            return true
        },
    )
    assert.equal(base.registry.get(sessionID)!.prune.messages.blocksById.size, 0)
})

test("#420 hosts without the capability keep the legacy behavior", async () => {
    const { projected, outgoing } = buildHistory()
    const sessionID = "v2-opaque-t7-legacy"
    const base = harness(projected, sessionID)
    const normalized = await base.host.sessions.messages(sessionID)
    const legacyHost = {
        sessions: {
            get: async () => ({ id: sessionID, parentID: null }),
            messages: async () => normalized,
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async () => {} },
        notifications: { notify: () => {} },
    }
    const definition = createCompressRangeToolDefinition({
        host: legacyHost,
        registry: base.registry,
        logger: base.logger,
        config: base.cfg,
        prompts: base.prompts,
    })
    await base.handler(eventOf(structuredClone(outgoing), sessionID))
    const compactionRef = refForRawId(base.registry.get(sessionID)!, "long-compaction")

    const output = String(
        await definition.execute(
            {
                topic: "legacy",
                content: [
                    { startId: compactionRef, endId: compactionRef, summary: "legacy opaque" },
                ],
            },
            toolCtx("call-legacy", sessionID),
        ),
    )
    assert.match(output, /Compressed 1 messages/)
    assert.ok(!output.includes("provider-owned"))
    assert.equal(base.registry.get(sessionID)!.prune.messages.blocksById.size, 1)
})
