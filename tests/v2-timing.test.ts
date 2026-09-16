import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"
import { createV2CompressionTimingHandlers } from "../lib/v2/timing"
import { SessionStateRegistry, type CompressionBlock } from "../lib/state"

function block(messageId: string, callId: string): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 2,
        durationMs: 0,
        mode: "range",
        tier: 1,
        topic: "timing",
        startId: messageId,
        endId: messageId,
        anchorMessageId: messageId,
        compressMessageId: messageId,
        compressCallId: callId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [messageId],
        directToolIds: [],
        effectiveMessageIds: [messageId],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "timing",
        survivedCount: 0,
    }
}

test("V2 timing records success duration and persists the matching block", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-timing-"))
    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/v2-timing")
    const sessions = {
        get: async () => ({ id: "session" }),
        messages: async () => [],
        parentMessages: async () => [],
    }
    const state = await registry.getOrCreate(sessions, "session", [])
    state.storageDir = storage
    state.prune.messages.blocksById.set(1, block("message", "call"))
    const handlers = createV2CompressionTimingHandlers(registry, logger)
    const originalNow = Date.now
    try {
        Date.now = () => 100
        handlers.before({
            tool: "compress",
            sessionID: "session",
            messageID: "message",
            id: "call",
        })
        Date.now = () => 145
        await handlers.after({
            tool: "compress",
            sessionID: "session",
            messageID: "message",
            id: "call",
            status: "completed",
            result: {},
        })
        assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 45)
        assert.equal(registry.compressionTiming.startsByCallId.size, 0)
        assert.equal(registry.compressionTiming.pendingByCallId.size, 0)
        assert.strictEqual(state.compressionTiming, registry.compressionTiming)
    } finally {
        Date.now = originalNow
        rmSync(storage, { recursive: true, force: true })
    }
})

test("V2 timing clears starts on tool errors without mutating state", async () => {
    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/v2-timing")
    const sessions = {
        get: async () => ({ id: "session" }),
        messages: async () => [],
        parentMessages: async () => [],
    }
    const state = await registry.getOrCreate(sessions, "session", [])
    const handlers = createV2CompressionTimingHandlers(registry, logger)
    handlers.before({ tool: "compress", sessionID: "session", messageID: "message", id: "call" })
    await handlers.after({
        tool: "compress",
        sessionID: "session",
        messageID: "message",
        id: "call",
        status: "error",
        error: { message: "failed" },
    })
    assert.equal(registry.compressionTiming.startsByCallId.size, 0)
    assert.equal(registry.compressionTiming.pendingByCallId.size, 0)
    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("V2 timing keeps same message/call IDs independent across sessions", async () => {
    const storageOne = mkdtempSync(join(tmpdir(), "acp-v2-timing-one-"))
    const storageTwo = mkdtempSync(join(tmpdir(), "acp-v2-timing-two-"))
    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/v2-timing")
    const sessions = {
        get: async () => ({ id: "session" }),
        messages: async () => [],
        parentMessages: async () => [],
    }
    const first = await registry.getOrCreate(sessions, "session-one", [])
    const second = await registry.getOrCreate(sessions, "session-two", [])
    first.storageDir = storageOne
    second.storageDir = storageTwo
    first.prune.messages.blocksById.set(1, block("message", "call"))
    second.prune.messages.blocksById.set(1, block("message", "call"))
    const handlers = createV2CompressionTimingHandlers(registry, logger)
    const originalNow = Date.now
    try {
        Date.now = () => 100
        handlers.before({
            tool: "compress",
            sessionID: "session-one",
            messageID: "message",
            id: "call",
        })
        Date.now = () => 200
        handlers.before({
            tool: "compress",
            sessionID: "session-two",
            messageID: "message",
            id: "call",
        })

        Date.now = () => 150
        await handlers.after({
            tool: "compress",
            sessionID: "session-one",
            messageID: "message",
            id: "call",
            status: "completed",
            result: {},
        })
        assert.equal(first.prune.messages.blocksById.get(1)?.durationMs, 50)
        assert.equal(second.prune.messages.blocksById.get(1)?.durationMs, 0)
        assert.equal(registry.compressionTiming.startsByCallId.size, 1)
        assert.equal(registry.compressionTiming.pendingByCallId.size, 0)

        Date.now = () => 275
        await handlers.after({
            tool: "compress",
            sessionID: "session-two",
            messageID: "message",
            id: "call",
            status: "completed",
            result: {},
        })
        assert.equal(second.prune.messages.blocksById.get(1)?.durationMs, 75)
        assert.equal(registry.compressionTiming.startsByCallId.size, 0)
        assert.equal(registry.compressionTiming.pendingByCallId.size, 0)
        assert.strictEqual(first.compressionTiming, second.compressionTiming)
        assert.strictEqual(first.compressionTiming, registry.compressionTiming)
    } finally {
        Date.now = originalNow
        rmSync(storageOne, { recursive: true, force: true })
        rmSync(storageTwo, { recursive: true, force: true })
    }
})
