import "./test-env"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import {
    DeferredMutationEffects,
    SessionStateRegistry,
    cloneSessionState,
    commitSessionState,
    createSessionState,
    cloneRuntimeValue,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { Logger } from "../lib/logger"

const logger = new Logger(false)
const messages: WithParts[] = []

function sessions(get: () => Promise<{ parentID: null }>) {
    return {
        get,
        messages: async () => messages,
        parentMessages: async () => messages,
    }
}

function noParentSessions() {
    return sessions(async () => ({ parentID: null }))
}

function completeState(): ReturnType<typeof createSessionState> {
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
        deactivatedByUserDeep: true,
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
        includedBlockIds: [2],
        consumedBlockIds: [3],
        parentBlockIds: [4],
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
    state.stats.pruneTokenCounter = 17
    state.stats.totalPruneTokens = 99
    state.toolParameters.set("call", {
        tool: "bash",
        parameters: { nested: new Map([["key", new Set(["value"])]]) },
        status: "completed",
        error: "none",
        turn: 2,
        tokenCount: 14,
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
    state.compressionTiming.startsByCallId.set("session:call", 19)
    state.compressionTiming.pendingByCallId.set("session:call", {
        messageId: "m3",
        callId: "call",
        durationMs: 21,
    })

    return state
}

test("cloneSessionState clones every owned mutable field and preserves shared timing", () => {
    const state = completeState()

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
    assert.deepEqual(clone, state)

    clone.prune.messages.blocksById.get(1)!.summary = "changed"
    clone.prune.messages.blocksById.get(1)!.directMessageIds.push("clone-message")
    clone.nudges.contextLimitAnchors.add("clone-only")
    clone.toolParameters.get("call")!.parameters.nested.get("key").add("clone-only")
    clone.toolIdList.push("clone-only")
    clone.prune.messages.activeBlockIds.add(2)
    clone.prune.messages.activeByAnchorMessageId.set("clone-anchor", 2)
    clone.prune.messages.markedForCleanup.add(2)
    clone.prune.messages.hideConsumedIndex!.activeCallIds.add("clone-call")
    clone.messageIds.byRawId.set("clone-raw", "m00002")
    clone.stats.pruneTokenCounter = 100
    assert.equal(state.prune.messages.blocksById.get(1)!.summary, "summary")
    assert.equal(state.nudges.contextLimitAnchors.has("clone-only"), false)
    assert.equal(
        state.toolParameters.get("call")!.parameters.nested.get("key").has("clone-only"),
        false,
    )
    assert.equal(state.toolIdList.includes("clone-only"), false)
    assert.equal(
        state.prune.messages.blocksById.get(1)!.directMessageIds.includes("clone-message"),
        false,
    )
    assert.equal(state.prune.messages.activeBlockIds.has(2), false)
    assert.equal(state.prune.messages.activeByAnchorMessageId.has("clone-anchor"), false)
    assert.equal(state.prune.messages.markedForCleanup.has(2), false)
    assert.equal(state.prune.messages.hideConsumedIndex!.activeCallIds.has("clone-call"), false)
    assert.equal(state.messageIds.byRawId.has("clone-raw"), false)
    assert.equal(state.stats.pruneTokenCounter, 17)
})

test("commitSessionState copies all working fields without replacing shared timing", () => {
    const live = completeState()
    const timing = live.compressionTiming
    const working = cloneSessionState(live)
    working.sessionId = "committed-session"
    working.isSubAgent = false
    working.compressPermission = "deny"
    working.prune.messages.blocksById.get(1)!.summary = "committed summary"
    working.prune.messages.blocksById.get(1)!.directToolIds.push("committed-tool")
    working.prune.messages.activeBlockIds.delete(1)
    working.prune.messages.activeByAnchorMessageId.set("committed-anchor", 4)
    working.prune.messages.markedForCleanup.add(9)
    working.nudges.turnNudgeAnchors.add("committed-turn-anchor")
    working.stats.totalPruneTokens = 42
    working.stats.pruneTokenCounter = 43
    working.toolIdList = ["tool"]
    working.messageIds.byRawId.set("raw", "m00001")
    working.nudges.contextLimitAnchors.add("anchor")
    working.modelContextLimit = 1234
    working.qualityGateRetryPending = true
    working.noContextLimitWarned = true
    working.storageDir = "/tmp/committed"

    commitSessionState(live, working)

    assert.equal(live.compressionTiming, timing)
    assert.equal(live.sessionId, "committed-session")
    assert.equal(live.isSubAgent, false)
    assert.equal(live.compressPermission, "deny")
    assert.equal(live.prune.messages.blocksById.get(1)?.summary, "committed summary")
    assert.equal(live.prune.messages.blocksById.get(1)?.deactivatedByUserDeep, true)
    assert.equal(live.prune.messages.activeBlockIds.has(1), false)
    assert.equal(live.prune.messages.activeByAnchorMessageId.get("committed-anchor"), 4)
    assert.equal(live.prune.messages.markedForCleanup.has(9), true)
    assert.equal(live.nudges.turnNudgeAnchors.has("committed-turn-anchor"), true)
    assert.equal(live.stats.pruneTokenCounter, 43)
    assert.equal(live.stats.totalPruneTokens, 42)
    assert.deepEqual(live.toolIdList, ["tool"])
    assert.equal(live.messageIds.byRawId.get("raw"), "m00001")
    assert.equal(live.nudges.contextLimitAnchors.has("anchor"), true)
    assert.equal(live.modelContextLimit, 1234)
    assert.equal(live.qualityGateRetryPending, true)
    assert.equal(live.noContextLimitWarned, true)
    assert.equal(live.storageDir, "/tmp/committed")
    assert.deepEqual(live, working)

    working.prune.messages.blocksById.get(1)!.summary = "working-only summary"
    working.prune.messages.activeByAnchorMessageId.set("working-only", 8)
    working.toolIdList.push("working-only")
    working.nudges.contextLimitAnchors.add("working-only")
    assert.deepEqual(live.toolIdList, ["tool"])
    assert.equal(live.nudges.contextLimitAnchors.has("working-only"), false)
    assert.equal(live.prune.messages.blocksById.get(1)!.summary, "committed summary")
    assert.equal(live.prune.messages.activeByAnchorMessageId.has("working-only"), false)
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
    // The callback is still mutating the live state, so direct reads fail
    // closed until the reservation releases.
    assert.equal(registry.get("initializing"), undefined)
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

test("same-session work waits through synchronous commit and post-commit flush", async () => {
    const registry = new SessionStateRegistry(logger)
    const events: string[] = []
    let signalPostCommit!: () => void
    const postCommitStarted = new Promise<void>((resolve) => {
        signalPostCommit = resolve
    })
    let releasePostCommit!: () => void
    const postCommitBarrier = new Promise<void>((resolve) => {
        releasePostCommit = resolve
    })
    const effects = new DeferredMutationEffects()

    const first = registry.withSessionMutationAndInitialize(
        noParentSessions(),
        "post-commit-order",
        () => messages,
        (history) => history,
        undefined,
        async (state) => {
            events.push("first-operation")
            state.currentTurn = 1
            effects.defer(() => events.push("effect"))
            return true
        },
        {
            commitResult: (result) => result,
            commit: (state, result) => {
                assert.equal(result, true)
                events.push("synchronous-commit")
                state.currentTurn = 1
            },
            postCommit: async () => {
                events.push("post-commit-start")
                signalPostCommit()
                await postCommitBarrier
                await effects.run(() => true)
                events.push("post-commit-end")
            },
        },
    )
    await postCommitStarted

    const second = registry.withSessionMutation("post-commit-order", async (state) => {
        events.push("second-operation")
        state.currentTurn = 2
    })
    await Promise.resolve()
    assert.deepEqual(events, ["first-operation", "synchronous-commit", "post-commit-start"])
    assert.equal(registry.get("post-commit-order"), undefined)

    releasePostCommit()
    await Promise.all([first, second])
    assert.deepEqual(events, [
        "first-operation",
        "synchronous-commit",
        "post-commit-start",
        "effect",
        "post-commit-end",
        "second-operation",
    ])
    assert.equal(registry.get("post-commit-order")?.currentTurn, 2)
})

test("lifecycle deactivation after preparation suppresses commit for fresh and existing sessions", async () => {
    async function runCase(sessionID: string, existing: boolean): Promise<void> {
        const storage = mkdtempSync(join(tmpdir(), `acp-registry-race-${sessionID}-`))
        const registry = new SessionStateRegistry(logger)
        let liveState = registry.get(sessionID)
        if (existing) {
            liveState = await registry.getOrCreate(noParentSessions(), sessionID, messages)
            liveState.storageDir = storage
            await saveSessionState(liveState, logger)
        }
        const persistedPath = join(storage, `${sessionID}.json`)
        const persistedBefore = existing ? readFileSync(persistedPath, "utf8") : undefined
        const event = { messages: ["original-message"], system: ["original-system"] }
        const effects = new DeferredMutationEffects()
        let effectRuns = 0
        let commitRuns = 0
        let postCommitRuns = 0
        let active = true
        let signalPrepared!: () => void
        const prepared = new Promise<void>((resolve) => {
            signalPrepared = resolve
        })
        let releaseBarrier!: () => void
        const barrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve
        })

        const pending = registry.withSessionMutationAndInitialize(
            noParentSessions(),
            sessionID,
            async () => messages,
            (history) => history,
            undefined,
            async () => {
                const preparedResult = await Promise.resolve({ accepted: true as const })
                effects.defer(() => {
                    effectRuns++
                })
                signalPrepared()
                await barrier
                return preparedResult
            },
            {
                effects,
                isActive: () => active,
                commitResult: (result) => result.accepted,
                commit: (state) => {
                    commitRuns++
                    state.currentTurn = 99
                    event.messages = ["committed-message"]
                    event.system = ["committed-system"]
                },
                postCommit: async () => {
                    postCommitRuns++
                    await effects.run(() => true)
                },
            },
        )

        try {
            await prepared
            releaseBarrier()
            active = false
            await pending

            assert.equal(commitRuns, 0)
            assert.equal(postCommitRuns, 0)
            assert.equal(effectRuns, 0)
            assert.deepEqual(event, {
                messages: ["original-message"],
                system: ["original-system"],
            })
            if (existing) {
                assert.strictEqual(registry.get(sessionID), liveState)
                assert.equal(readFileSync(persistedPath, "utf8"), persistedBefore)
            } else {
                assert.equal(registry.get(sessionID), undefined)
                assert.equal(registry.size, 0)
                assert.equal(existsSync(persistedPath), false)
            }
        } finally {
            rmSync(storage, { recursive: true, force: true })
        }
    }

    await runCase("fresh-race", false)
    await runCase("existing-race", true)
})

test("synchronous commit failure restores existing state and shared timing", async () => {
    const registry = new SessionStateRegistry(logger)
    const state = await registry.getOrCreate(noParentSessions(), "commit-throw", messages)
    state.currentTurn = 4
    state.stats.totalPruneTokens = 12
    state.compressionTiming.startsByCallId.set("keep-start", 10)
    const pending = {
        messageId: "message",
        callId: "call",
        durationMs: 20,
    }
    state.compressionTiming.pendingByCallId.set("keep-pending", pending)
    const startsBefore = [...state.compressionTiming.startsByCallId.entries()]
    const pendingBefore = [...state.compressionTiming.pendingByCallId.entries()].map(
        ([key, value]) => [key, { ...value }] as const,
    )
    const currentTurnBefore = state.currentTurn
    const tokensBefore = state.stats.totalPruneTokens

    await assert.rejects(
        () =>
            registry.withSessionMutationAndInitialize(
                noParentSessions(),
                "commit-throw",
                () => messages,
                (history) => history,
                undefined,
                async (liveState) => {
                    liveState.currentTurn = 99
                    liveState.stats.totalPruneTokens = 999
                    liveState.compressionTiming.startsByCallId.set("speculative", 30)
                    liveState.compressionTiming.pendingByCallId.clear()
                    return true
                },
                {
                    commit: () => {
                        throw new Error("external commit failed")
                    },
                },
            ),
        /external commit failed/,
    )

    assert.equal(registry.get("commit-throw"), state)
    assert.equal(state.currentTurn, currentTurnBefore)
    assert.equal(state.stats.totalPruneTokens, tokensBefore)
    assert.deepEqual([...state.compressionTiming.startsByCallId.entries()], startsBefore)
    assert.deepEqual(
        [...state.compressionTiming.pendingByCallId.entries()].map(
            ([key, value]) => [key, { ...value }] as const,
        ),
        pendingBefore,
    )

    await registry.withSessionMutation("commit-throw", (liveState) => {
        liveState.currentTurn = 5
    })
    assert.equal(registry.get("commit-throw")?.currentTurn, 5)
})

test("synchronous commit failure removes a fresh placeholder without resolving it", async () => {
    const registry = new SessionStateRegistry(logger)
    registry.compressionTiming.startsByCallId.set("unrelated", 1)

    await assert.rejects(
        () =>
            registry.withSessionMutationAndInitialize(
                noParentSessions(),
                "fresh-commit-throw",
                () => messages,
                (history) => history,
                undefined,
                async (state) => {
                    state.currentTurn = 99
                    state.compressionTiming.startsByCallId.set("speculative", 2)
                    return true
                },
                {
                    commit: () => {
                        throw new Error("fresh external commit failed")
                    },
                },
            ),
        /fresh external commit failed/,
    )

    assert.equal(registry.size, 0)
    assert.equal(registry.get("fresh-commit-throw"), undefined)
    assert.deepEqual([...registry.compressionTiming.startsByCallId.entries()], [["unrelated", 1]])
    const recovered = await registry.getOrCreate(noParentSessions(), "fresh-commit-throw", messages)
    assert.equal(recovered.sessionId, "fresh-commit-throw")
})

test("post-commit failure leaves accepted state visible and releases a fresh barrier", async () => {
    const registry = new SessionStateRegistry(logger)
    await assert.rejects(
        () =>
            registry.withSessionMutationAndInitialize(
                noParentSessions(),
                "post-throw",
                () => messages,
                (history) => history,
                undefined,
                async (state) => {
                    state.currentTurn = 7
                    return "accepted"
                },
                {
                    commitResult: (result) => result === "accepted",
                    postCommit: () => {
                        throw new Error("effect flush failed")
                    },
                },
            ),
        /effect flush failed/,
    )

    const accepted = registry.get("post-throw")
    assert.ok(accepted)
    assert.equal(accepted?.currentTurn, 7)
    await registry.withSessionMutation("post-throw", (state) => {
        state.currentTurn = 8
    })
    assert.equal(registry.get("post-throw")?.currentTurn, 8)

    await registry.getOrCreate(noParentSessions(), "existing-post-throw", messages)
    await assert.rejects(
        () =>
            registry.withSessionMutationAndInitialize(
                noParentSessions(),
                "existing-post-throw",
                () => messages,
                (history) => history,
                undefined,
                async (state) => {
                    state.currentTurn = 11
                    return true
                },
                {
                    postCommit: () => {
                        throw new Error("existing effect flush failed")
                    },
                },
            ),
        /existing effect flush failed/,
    )
    assert.equal(registry.get("existing-post-throw")?.currentTurn, 11)
})

test("registry reads fail closed during existing-session mutation and recover afterward", async () => {
    const registry = new SessionStateRegistry(logger)
    const state = await registry.getOrCreate(noParentSessions(), "visibility", messages)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    let started!: () => void
    const startedSignal = new Promise<void>((resolve) => {
        started = resolve
    })

    const work = registry.withSessionMutation("visibility", async (liveState) => {
        liveState.currentTurn = 42
        started()
        await blocked
    })
    await startedSignal
    assert.equal(registry.get("visibility"), undefined)
    assert.deepEqual(registry.all(), [])
    release()
    await work
    assert.equal(registry.get("visibility"), state)
    assert.equal(registry.get("visibility")?.currentTurn, 42)
})
