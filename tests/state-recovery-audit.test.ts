import "./test-env"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type CompressionBlock,
    type PersistedSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"

const logger = new Logger(false, "silent")

function user(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: "session",
            role: "user",
            agent: "code",
            time: { created: 1 },
            model: { providerID: "provider", modelID: "model" },
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: "session", messageID: id, text }],
    }
}

function assistant(id: string, text: string, summary = false): WithParts {
    return {
        info: {
            id,
            sessionID: "session",
            role: "assistant",
            agent: "code",
            time: { created: summary ? 20 : 2 },
            parentID: "parent",
            modelID: "model",
            providerID: "provider",
            mode: "code",
            path: { cwd: "/workspace", root: "/workspace" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            summary,
        } as WithParts["info"],
        parts: [{ type: "text", id: `${id}-part`, sessionID: "session", messageID: id, text }],
    }
}

function block(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 2,
        durationMs: 0,
        topic: "parent work",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "parent-u",
        compressMessageId: "parent-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["parent-u", "parent-a"],
        directToolIds: [],
        effectiveMessageIds: ["parent-u", "parent-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "parent summary",
        survivedCount: 0,
        ...overrides,
    }
}

function config(storagePath: string): PluginConfig {
    return { storagePath } as PluginConfig
}

function noParentSessions() {
    return {
        get: async () => ({ id: "session", parentID: null }),
        messages: async () => [],
        parentMessages: async () => [],
    }
}

test("restart after a newer compaction resets transient state but preserves blocks and stats", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-compaction-restart-"))
    const sessionID = "compaction-restart"
    try {
        const persisted = createSessionState()
        persisted.sessionId = sessionID
        persisted.storageDir = storage
        persisted.lastCompaction = 10
        persisted.nudges.lastPerMessageNudgeTokens = 42
        persisted.nudges.contextLimitAnchors.add("old-anchor")
        persisted.toolParameters.set("old-call", {
            tool: "read",
            parameters: { path: "old.ts" },
            turn: 1,
        })
        persisted.messageIds.byRawId.set("old-message", "m00001")
        persisted.messageIds.byRef.set("m00001", "old-message")
        persisted.messageIds.nextRef = 2
        persisted.stats = { pruneTokenCounter: 11, totalPruneTokens: 99 }
        persisted.prune.messages.blocksById.set(1, block())
        persisted.prune.messages.activeBlockIds.add(1)
        persisted.prune.messages.activeByAnchorMessageId.set("parent-u", 1)
        await saveSessionState(persisted, logger)

        const restored = createSessionState()
        await ensureSessionInitialized(
            noParentSessions(),
            restored,
            sessionID,
            logger,
            [assistant("completed-compaction", "checkpoint", true), user("after", "continue")],
            config(storage),
            "/workspace",
        )

        assert.equal(restored.lastCompaction, 20)
        assert.equal(restored.nudges.lastPerMessageNudgeTokens, undefined)
        assert.equal(restored.nudges.contextLimitAnchors.size, 0)
        assert.equal(restored.toolParameters.size, 0)
        assert.equal(restored.toolIdList.length, 0)
        assert.equal(restored.messageIds.byRawId.size, 0)
        assert.equal(restored.prune.messages.activeBlockIds.has(1), true)
        assert.deepEqual(restored.stats, { pruneTokenCounter: 11, totalPruneTokens: 99 })

        const persistedAfter = JSON.parse(
            readFileSync(join(storage, `${sessionID}.json`), "utf8"),
        ) as PersistedSessionState
        assert.equal(persistedAfter.lastCompaction, 20)
        assert.deepEqual(persistedAfter.messageIds?.byRawId, {})
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("fork recovery reads the active custom storage and normalizes legacy parent refs", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-fork-custom-storage-"))
    const parentID = "legacy-parent"
    const childID = "custom-child"
    const parentMessages = [
        user("parent-u", "same request"),
        assistant("parent-a", "same response"),
        assistant("parent-compress", "compression call"),
    ]
    const childMessages = [
        user("child-u", "same request"),
        assistant("child-a", "same response"),
        assistant("child-compress", "compression call"),
    ]
    const parentBlock = block()
    const parentState: PersistedSessionState = {
        prune: {
            messages: {
                byMessageId: {
                    "parent-u": { tokenCount: 5, allBlockIds: [1], activeBlockIds: [1] },
                    "parent-a": { tokenCount: 5, allBlockIds: [1], activeBlockIds: [1] },
                },
                blocksById: { "1": parentBlock },
                activeBlockIds: [1],
                activeByAnchorMessageId: { "parent-u": 1 },
                nextBlockId: 2,
                nextRunId: 2,
            },
        },
        nudges: { contextLimitAnchors: [] },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: {
            byRawId: {
                "parent-u": "m0001",
                "parent-a": "m0002",
                "parent-compress": "m0003",
            },
            byRef: {
                m0001: "parent-u",
                m0002: "parent-a",
                m0003: "parent-compress",
            },
            nextRef: 4,
        },
        lastCompaction: 0,
        lastUpdated: new Date(0).toISOString(),
    }
    writeFileSync(join(storage, `${parentID}.json`), JSON.stringify(parentState), "utf8")

    try {
        const childState: SessionState = createSessionState()
        const sessions = {
            get: async (sessionID: string) =>
                sessionID === childID
                    ? { id: childID, parentID }
                    : { id: parentID, parentID: null },
            messages: async () => childMessages,
            parentMessages: async () => parentMessages,
        }
        await ensureSessionInitialized(
            sessions,
            childState,
            childID,
            logger,
            childMessages,
            config(storage),
            "/workspace",
        )

        assert.equal(childState.prune.messages.blocksById.get(1)?.anchorMessageId, "child-u")
        assert.equal(childState.prune.messages.activeBlockIds.has(1), true)
        assert.equal(childState.prune.messages.byMessageId.get("child-a")?.activeBlockIds[0], 1)
        assert.equal(parentState.messageIds?.byRef.m0001, "parent-u")
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("persisted ACP notice refs are removed without consuming the next alias", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-notice-ref-cleanup-"))
    const sessionID = "notice-ref-cleanup"
    try {
        const persisted = createSessionState()
        persisted.sessionId = sessionID
        persisted.storageDir = storage
        persisted.messageIds.byRawId.set("normal-message", "m00001")
        persisted.messageIds.byRawId.set("msg_acp_notice_deadbeef", "m00002")
        persisted.messageIds.byRef.set("m00001", "normal-message")
        persisted.messageIds.byRef.set("m00002", "msg_acp_notice_deadbeef")
        persisted.messageIds.nextRef = 3
        await saveSessionState(persisted, logger)

        const restored = createSessionState()
        await ensureSessionInitialized(
            noParentSessions(),
            restored,
            sessionID,
            logger,
            [user("normal-message", "continue")],
            config(storage),
            "/workspace",
        )
        assert.deepEqual([...restored.messageIds.byRawId], [["normal-message", "m00001"]])
        assert.deepEqual([...restored.messageIds.byRef], [["m00001", "normal-message"]])
        assert.equal(restored.messageIds.nextRef, 2)
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})
