import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import {
    SessionStateRegistry,
    cloneSessionState,
    commitSessionState,
    createSessionState,
    cloneRuntimeValue,
    type WithParts,
} from "../lib/state"
import { Logger } from "../lib/logger"

const logger = new Logger(false)
const messages: WithParts[] = []

function sessions(get: () => Promise<{ parentID: null }>): any {
    return {
        get,
        messages: async () => messages,
        parentMessages: async () => messages,
    }
}

function noParentSessions(): any {
    return sessions(async () => ({ parentID: null }))
}

test("cloneSessionState clones every owned mutable field and preserves shared timing", () => {
    const state = createSessionState()
    state.sessionId = "session"
    state.isSubAgent = true
    state.compressPermission = "ask"
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 12,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        effectiveCompressedTokens: 12,
        summaryTokens: 4,
        durationMs: 8,
        mode: "range",
        tier: 1,
        topic: "topic",
        batchTopic: "batch",
        startId: "m1",
        endId: "m2",
        anchorMessageId: "m2",
        compressMessageId: "m3",
        compressCallId: "call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1"],
        directToolIds: ["tool"],
        effectiveMessageIds: ["m1"],
        effectiveToolIds: ["tool"],
        createdAt: 1,
        deactivatedAt: 9,
        deactivatedByBlockId: 3,
        summary: "summary",
        survivedCount: 1,
        generation: "young",
    })
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("m2", 1)
    state.prune.messages.markedForCleanup.add(1)
    state.prune.messages.membershipsVerified = true
    state.prune.messages.structureVersion = 3
    state.prune.messages.lastSyncedStructureVersion = 2
    state.prune.messages.hideConsumedIndex = {
        version: 3,
        allBlockCallIds: new Set(["call"]),
        liveRangeKeysByCallId: new Map([["call", new Set(["m1:m2"])]]),
        activeCallIds: new Set(["call"]),
    }
    Object.assign(state.nudges, {
        lastPerMessageNudgeTurn: 4,
        lastPerMessageNudgeTokens: 10,
        lastNudgeShownTokens: 11,
        lastToolOutputNudgeTokens: 12,
        lastTier2NudgeTokens: 13,
        lastTier3NudgeTokens: 14,
        shouldInjectThisTurn: true,
        compressBaselineSet: true,
        lastProcessedCompressMessageId: "m3",
    })
    state.nudges.contextLimitAnchors.add("m1")
    state.nudges.turnNudgeAnchors.add("m2")
    state.nudges.iterationNudgeAnchors.add("m3")
    state.stats.totalPruneTokens = 99
    state.toolParameters.set("call", {
        tool: "bash",
        parameters: { nested: new Map([["key", new Set(["value"])]]) },
        status: "completed",
        turn: 2,
    })
    state.toolIdList.push("call")
    state.messageIds.byRawId.set("m1", "m00001")
    state.messageIds.byRef.set("m00001", "m1")
    state.messageIds.nextRef = 2
    state.lastCompaction = 7
    state.currentTurn = 8
    state.modelContextLimit = 1000
    state.modelProviderID = "provider"
    state.modelID = "model"
    state.systemPromptTokens = 20
    state.storageDir = "/tmp/acp"
    state.qualityGateRetryPending = true
    state.noContextLimitWarned = true

    const clone = cloneSessionState(state)

    assert.notEqual(clone, state)
    assert.equal(clone.compressionTiming, state.compressionTiming)
    assert.notEqual(clone.prune, state.prune)
    assert.notEqual(clone.prune.messages.blocksById.get(1), state.prune.messages.blocksById.get(1))
    assert.equal(clone.prune.messages.blocksById.get(1)?.deactivatedAt, 9)
    assert.equal(clone.prune.messages.blocksById.get(1)?.deactivatedByBlockId, 3)
    assert.notEqual(clone.nudges.contextLimitAnchors, state.nudges.contextLimitAnchors)
    assert.notEqual(clone.toolParameters.get("call"), state.toolParameters.get("call"))
    assert.deepEqual(clone.messageIds, state.messageIds)
    assert.deepEqual(clone.prune.messages.hideConsumedIndex, state.prune.messages.hideConsumedIndex)

    clone.prune.messages.blocksById.get(1)!.summary = "changed"
    clone.nudges.contextLimitAnchors.add("clone-only")
    clone.toolParameters.get("call")!.parameters.nested.get("key").add("clone-only")
    clone.toolIdList.push("clone-only")
    assert.equal(state.prune.messages.blocksById.get(1)!.summary, "summary")
    assert.equal(state.nudges.contextLimitAnchors.has("clone-only"), false)
    assert.equal(
        state.toolParameters.get("call")!.parameters.nested.get("key").has("clone-only"),
        false,
    )
    assert.equal(state.toolIdList.includes("clone-only"), false)
})

test("commitSessionState copies all working fields without replacing shared timing", () => {
    const live = createSessionState()
    live.sessionId = "session"
    const timing = live.compressionTiming
    const working = cloneSessionState(live)
    working.isSubAgent = true
    working.compressPermission = "deny"
    working.stats.totalPruneTokens = 42
    working.toolIdList = ["tool"]
    working.messageIds.byRawId.set("raw", "m00001")
    working.nudges.contextLimitAnchors.add("anchor")
    working.modelContextLimit = 1234
    working.qualityGateRetryPending = true

    commitSessionState(live, working)

    assert.equal(live.compressionTiming, timing)
    assert.equal(live.isSubAgent, true)
    assert.equal(live.compressPermission, "deny")
    assert.equal(live.stats.totalPruneTokens, 42)
    assert.deepEqual(live.toolIdList, ["tool"])
    assert.equal(live.messageIds.byRawId.get("raw"), "m00001")
    assert.equal(live.nudges.contextLimitAnchors.has("anchor"), true)
    assert.equal(live.modelContextLimit, 1234)
    assert.equal(live.qualityGateRetryPending, true)

    working.toolIdList.push("working-only")
    working.nudges.contextLimitAnchors.add("working-only")
    assert.deepEqual(live.toolIdList, ["tool"])
    assert.equal(live.nudges.contextLimitAnchors.has("working-only"), false)
})

test("runtime cloning isolates binary views and real Error values in tool parameters", () => {
    const buffer = new ArrayBuffer(8)
    const bytes = new Uint8Array(buffer)
    bytes.set([1, 2, 3, 4])
    const typed = new Uint16Array(buffer, 2, 2)
    const view = new DataView(buffer, 1, 4)
    const error = new Error("tool failed")
    ;(error as Error & { details?: { code: string } }).details = { code: "E_TOOL" }

    const value = cloneRuntimeValue({ buffer, bytes, typed, view, error })
    assert.notStrictEqual(value.buffer, buffer)
    assert.notStrictEqual(value.bytes, bytes)
    assert.notStrictEqual(value.typed, typed)
    assert.notStrictEqual(value.view, view)
    assert.notStrictEqual(value.error, error)
    assert.ok(value.error instanceof Error)
    assert.equal(value.error.message, "tool failed")
    assert.deepEqual(value.error.details, { code: "E_TOOL" })

    value.bytes[0] = 99
    value.typed[0] = 0xffff
    value.view.setUint8(0, 88)
    value.error.details.code = "CHANGED"
    assert.equal(bytes[0], 1)
    assert.equal(typed[0], 0x0403)
    assert.equal(view.getUint8(0), 2)
    assert.equal(error.details?.code, "E_TOOL")
})

test("concurrent getOrCreate callers await one complete initialization", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    const registry = new SessionStateRegistry(logger)
    const first = registry.getOrCreate(
        sessions(async () => {
            await blocked
            return { parentID: null }
        }),
        "blocked",
        messages,
    )

    await Promise.resolve()
    assert.equal(registry.get("blocked"), undefined)
    let secondSettled = false
    const second = registry.getOrCreate(noParentSessions(), "blocked", messages).then((state) => {
        secondSettled = true
        return state
    })
    await Promise.resolve()
    assert.equal(secondSettled, false)

    release()
    const [firstState, secondState] = await Promise.all([first, second])
    assert.equal(firstState, secondState)
    assert.equal(registry.get("blocked"), firstState)
    assert.equal(firstState.sessionId, "blocked")
})

test("same-session guarded mutations are ordered while different sessions proceed concurrently", async () => {
    const registry = new SessionStateRegistry(logger)
    await registry.getOrCreate(noParentSessions(), "same", messages)
    await registry.getOrCreate(noParentSessions(), "other", messages)

    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    const events: string[] = []
    const first = registry.withSessionMutation("same", async (state) => {
        events.push("same-start")
        state.currentTurn = 1
        await blocked
        events.push("same-end")
    })
    await Promise.resolve()
    const second = registry.withSessionMutation("same", async (state) => {
        events.push("same-second")
        state.currentTurn = 2
    })
    const other = registry.withSessionMutation("other", async () => {
        events.push("other-start")
    })
    await other
    assert.deepEqual(events, ["same-start", "other-start"])
    release()
    await Promise.all([first, second])
    assert.deepEqual(events, ["same-start", "other-start", "same-end", "same-second"])
    assert.equal(registry.get("same")!.currentTurn, 2)
})

test("soft-cap eviction skips initializing and executing sessions", async () => {
    const registry = new SessionStateRegistry(logger)
    let releaseInit!: () => void
    const blockedInit = new Promise<void>((resolve) => {
        releaseInit = resolve
    })
    const initPromise = registry.getOrCreate(
        sessions(async () => {
            await blockedInit
            return { parentID: null }
        }),
        "initializing",
        messages,
    )
    await Promise.resolve()

    for (let i = 0; i < 32; i++) {
        await registry.getOrCreate(noParentSessions(), `idle-${i}`, messages)
    }
    assert.equal(registry.get("initializing"), undefined)
    releaseInit()
    const initialized = await initPromise
    assert.equal(registry.get("initializing"), initialized)

    let releaseWork!: () => void
    const blockedWork = new Promise<void>((resolve) => {
        releaseWork = resolve
    })
    const guarded = registry.withSessionMutation("initializing", async () => blockedWork)
    await Promise.resolve()
    await registry.getOrCreate(noParentSessions(), "overflow", messages)
    assert.equal(registry.get("initializing"), initialized)
    releaseWork()
    await guarded
})

test("atomic session work serializes history loading before ordered commits", async () => {
    const registry = new SessionStateRegistry(logger)
    const events: string[] = []
    let releaseOld!: () => void
    const oldHistoryBlocked = new Promise<void>((resolve) => {
        releaseOld = resolve
    })

    const first = registry.withSessionMutationAndInitialize(
        noParentSessions(),
        "atomic-history",
        async () => {
            events.push("old-history-start")
            await oldHistoryBlocked
            events.push("old-history-end")
            return "old"
        },
        () => messages,
        undefined,
        async (state, history) => {
            events.push(`commit-${history}`)
            state.currentTurn = 1
        },
    )
    await Promise.resolve()

    const second = registry.withSessionMutationAndInitialize(
        noParentSessions(),
        "atomic-history",
        async () => {
            events.push("new-history")
            return "new"
        },
        () => messages,
        undefined,
        async (state, history) => {
            events.push(`commit-${history}`)
            state.currentTurn = 2
        },
    )
    await Promise.resolve()
    assert.deepEqual(events, ["old-history-start"])

    releaseOld()
    await Promise.all([first, second])
    assert.deepEqual(events, [
        "old-history-start",
        "old-history-end",
        "commit-old",
        "new-history",
        "commit-new",
    ])
    assert.equal(registry.get("atomic-history")?.currentTurn, 2)
})
