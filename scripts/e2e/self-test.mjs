#!/usr/bin/env node

import assert from "node:assert/strict"
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"
import {
    ACP_PROJECTION_FIELD_PATHS,
    assertMinimalProbeEnv,
    assertNudgeCheckpointSequence,
    buildMinimalProbeEnv,
    captureOwnedDirectory,
    classifyV2FallbackAttempt,
    comparePermissionProjections,
    projectAcpState,
    removeOwnedDirectory,
    stableSerialize,
} from "./verification-guards.mjs"

function fixture(order = "first") {
    const block = {
        blockId: 1,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 12,
        summaryTokens: 4,
        durationMs: 5,
        mode: "range",
        topic: "SECRET_SENTINEL_TOPIC",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "msg_anchor",
        compressMessageId: "msg_compress",
        compressCallId: "call_1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["SECRET_SENTINEL_MESSAGE"],
        directToolIds: ["tool_1"],
        effectiveMessageIds: ["SECRET_SENTINEL_EFFECTIVE"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "SECRET_SENTINEL_SUMMARY",
        survivedCount: 0,
        generation: "young",
    }
    const state = {
        sessionId: "ses_self_test",
        isSubAgent: false,
        compressPermission: "ask",
        prune: {
            messages: {
                byMessageId:
                    order === "first"
                        ? {
                              SECRET_SENTINEL_RAW: {
                                  tokenCount: 1,
                                  allBlockIds: [1],
                                  activeBlockIds: [1],
                              },
                          }
                        : new Map([
                              [
                                  "SECRET_SENTINEL_RAW",
                                  { tokenCount: 1, allBlockIds: [1], activeBlockIds: [1] },
                              ],
                          ]),
                blocksById: order === "first" ? { 1: block } : new Map([[1, block]]),
                activeBlockIds: order === "first" ? [1] : new Set([1]),
                activeByAnchorMessageId:
                    order === "first" ? { msg_anchor: 1 } : new Map([["msg_anchor", 1]]),
                nextBlockId: 2,
                nextRunId: 3,
                markedForCleanup: [],
                membershipsVerified: true,
            },
        },
        nudges: {
            contextLimitAnchors: new Set(["msg_anchor"]),
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
            lastPerMessageNudgeTurn: 2,
            lastPerMessageNudgeTokens: 100,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: false,
            compressBaselineSet: false,
            lastProcessedCompressMessageId: undefined,
        },
        stats: { pruneTokenCounter: 12, totalPruneTokens: 12 },
        compressionTiming: {
            startsByCallId: new Map([["call_1", 1]]),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map([
            [
                "call_1",
                {
                    tool: "compress",
                    parameters: { secret: "SECRET_SENTINEL_ARGUMENT", z: 1 },
                    status: "completed",
                    error: "SECRET_SENTINEL_ERROR",
                    turn: 2,
                    tokenCount: 3,
                },
            ],
        ]),
        toolIdList: ["compress"],
        messageIds: {
            byRawId: { SECRET_SENTINEL_MESSAGE: "m00001" },
            byRef: { m00001: "SECRET_SENTINEL_MESSAGE" },
            nextRef: 2,
        },
        lastCompaction: 0,
        currentTurn: 2,
        modelContextLimit: 100000,
        modelProviderID: "SECRET_SENTINEL_PROVIDER",
        modelID: "SECRET_SENTINEL_MODEL",
        systemPromptTokens: 4,
        storageDir: "/SECRET_SENTINEL_PATH",
        qualityGateRetryPending: false,
        noContextLimitWarned: false,
        unknownSecret: "SECRET_SENTINEL_UNKNOWN",
    }
    return state
}

function runProjectionChecks() {
    const first = projectAcpState(fixture("first"))
    const second = projectAcpState(fixture("second"))
    assert.equal(stableSerialize(first), stableSerialize(second), "projection is deterministic")
    assert.deepEqual(
        [...first.coveredFields].sort(),
        [...ACP_PROJECTION_FIELD_PATHS].sort(),
        "projection declares complete mutable-state field coverage",
    )
    const retained = JSON.stringify({
        projection: first,
        comparison: comparePermissionProjections(fixture(), fixture()),
    })
    assert.equal(
        retained.includes("SECRET_SENTINEL"),
        false,
        "retained projection redacts every sentinel",
    )
    assert.equal(
        retained.includes("/SECRET_SENTINEL_PATH"),
        false,
        "retained projection redacts paths",
    )
    assert.deepEqual(
        projectAcpState(fixture()).toolParameters[0].parameterKeys,
        ["secret", "z"],
        "tool parameter projection retains sorted structural keys only",
    )
    const unknownMutation = fixture()
    unknownMutation.addedUnknownSecret = "SECRET_SENTINEL_ADDED_UNKNOWN"
    const unknownComparison = comparePermissionProjections(fixture(), unknownMutation)
    assert.equal(unknownComparison.unknownFields.equal, false, "unknown-field mutation is detected")
    assert.equal(
        JSON.stringify({
            comparison: unknownComparison,
            projection: projectAcpState(unknownMutation),
        }).includes("SECRET_SENTINEL"),
        false,
        "unknown-field mutation remains redacted in retained JSON",
    )
}

function runFallbackChecks() {
    const exact = ["configured plugin path must be a directory"]
    assert.equal(
        classifyV2FallbackAttempt({ status: 10, inventoryActive: false, freshLines: exact })
            .accepted,
        true,
        "exact-only fallback is accepted",
    )
    assert.equal(
        classifyV2FallbackAttempt({
            status: 10,
            inventoryActive: false,
            freshLines: [...exact, "SchemaError: invalid plugin definition"],
        }).accepted,
        false,
        "exact plus schema failure is rejected",
    )
    assert.equal(
        classifyV2FallbackAttempt({
            status: 10,
            inventoryActive: false,
            // The old exact line is intentionally absent: only fresh lines are classified.
            freshLines: ["plugin activation failed: unexpected import error"],
        }).accepted,
        false,
        "stale exact text cannot mask a new unrelated failure",
    )
    assert.equal(
        classifyV2FallbackAttempt({ status: 0, inventoryActive: false, freshLines: exact })
            .accepted,
        false,
        "status mismatch is rejected",
    )
}

function runEnvironmentChecks() {
    const npmEnv = buildMinimalProbeEnv({
        home: "/tmp/self-test-home",
        tmpdir: "/tmp/self-test-tmp",
        userconfig: "/tmp/self-test-npmrc",
        globalconfig: "/tmp/self-test-global-npmrc",
        cache: "/tmp/self-test-cache",
        npm: true,
    })
    assertMinimalProbeEnv(npmEnv, true)
    assert.equal("NPM_TOKEN" in npmEnv, false)
    assert.equal("npm_config_registry" in npmEnv, false)
    assert.equal("NODE_AUTH_TOKEN" in npmEnv, false)
    assert.throws(() =>
        assertMinimalProbeEnv({ ...npmEnv, NPM_TOKEN: "SECRET_SENTINEL_TOKEN" }, true),
    )
}

function runCleanupChecks() {
    const parent = "/tmp/opencode"
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(path.join(parent, "opencode-acp-verifier-self-test-"))
    const identity = captureOwnedDirectory(root, {
        label: "self-test cleanup root",
        parent,
        prefix: "opencode-acp-verifier-self-test-",
    })
    const moved = `${root}-moved`
    renameSync(root, moved)
    mkdirSync(root)
    assert.throws(
        () =>
            removeOwnedDirectory(identity, { parent, prefix: "opencode-acp-verifier-self-test-" }),
        /identity changed/,
        "cleanup refuses an inode replacement",
    )
    const replacement = captureOwnedDirectory(root, {
        label: "self-test replacement",
        parent,
        prefix: "opencode-acp-verifier-self-test-",
    })
    removeOwnedDirectory(replacement, { parent, prefix: "opencode-acp-verifier-self-test-" })
    const movedIdentity = captureOwnedDirectory(moved, {
        label: "self-test moved root",
        parent,
        prefix: "opencode-acp-verifier-self-test-",
    })
    removeOwnedDirectory(movedIdentity, { parent, prefix: "opencode-acp-verifier-self-test-" })

    const target = mkdtempSync(path.join(parent, "opencode-acp-verifier-target-"))
    const link = `${parent}/opencode-acp-verifier-link-${process.pid}`
    symlinkSync(target, link)
    assert.throws(() => captureOwnedDirectory(link, { label: "self-test symlink" }), /symlink/)
    rmSync(link, { force: true })
    const targetIdentity = captureOwnedDirectory(target, {
        label: "self-test target",
        parent,
        prefix: "opencode-acp-verifier-target-",
    })
    removeOwnedDirectory(targetIdentity, { parent, prefix: "opencode-acp-verifier-target-" })
}

function runNudgeChecks() {
    const expectedBaselines = { initial: 15, first: 11370, second: 23059 }
    const firstExpected = expectedBaselines.first
    const secondExpected = expectedBaselines.second
    const checkpoints = [
        {
            checkpoint: "initial-baseline",
            persisted: {
                lastPerMessageNudgeTokens: 15,
                lastNudgeShownTokens: null,
                blockCount: 0,
            },
            request: { nudgeDetected: false, compressCallCount: 0 },
            emittedCompressCount: 0,
        },
        {
            checkpoint: "protected-no-target-1",
            phase: "protected-no-target",
            persisted: {
                lastPerMessageNudgeTokens: 15,
                lastNudgeShownTokens: null,
                blockCount: 0,
            },
            request: {
                nudgeDetected: false,
                compressCallCount: 0,
                calledCompress: false,
                emittedCompressCount: 0,
            },
            protectedEvidence: {
                configuredPreserveRecentMessages: 10,
                blockedRefCount: 0,
                protectedRefCount: 0,
                compressibleRefCount: 10,
                messageRefCount: 10,
                blockRefCount: 0,
                candidateOrRangeText: false,
                withinConfiguredWindow: true,
                complete: true,
            },
            preToolCheckpoint: { hostStateObservable: false, providerNudgeObserved: false },
            emittedCompressCount: 0,
        },
        {
            checkpoint: "first-nudge-observed",
            persisted: {
                lastPerMessageNudgeTokens: firstExpected,
                lastNudgeShownTokens: null,
                blockCount: 1,
            },
            request: { nudgeDetected: true, compressCallCount: 0, nudgeSystemTokens: 6500 },
            preToolCheckpoint: {
                hostStateObservable: false,
                providerNudgeObserved: true,
                observedSystemTokens: 6500,
            },
            emittedCompressCount: 1,
        },
        {
            checkpoint: "post-first-compression",
            persisted: {
                lastPerMessageNudgeTokens: firstExpected,
                lastNudgeShownTokens: null,
                blockCount: 1,
            },
            request: { nudgeDetected: false, compressCallCount: 0 },
            transition: { baseline: 15, preCompressTokens: 240, postCompressTokens: 11370 },
            emittedCompressCount: 1,
        },
        {
            checkpoint: "second-nudge-observed",
            persisted: {
                lastPerMessageNudgeTokens: secondExpected,
                lastNudgeShownTokens: null,
                blockCount: 2,
            },
            request: { nudgeDetected: true, compressCallCount: 0, nudgeSystemTokens: 6500 },
            preToolCheckpoint: {
                hostStateObservable: false,
                providerNudgeObserved: true,
                observedSystemTokens: 6500,
            },
            emittedCompressCount: 2,
        },
        {
            checkpoint: "post-second-compression",
            persisted: {
                lastPerMessageNudgeTokens: secondExpected,
                lastNudgeShownTokens: null,
                blockCount: 2,
            },
            request: { nudgeDetected: false, compressCallCount: 0 },
            transition: {
                baseline: 11370,
                preCompressTokens: 330,
                postCompressTokens: 23059,
            },
            emittedCompressCount: 2,
        },
    ]
    assertNudgeCheckpointSequence(checkpoints, {
        expectedCompressEmissions: 2,
        expectedBaselines,
    })
    const corrupted = JSON.parse(JSON.stringify(checkpoints))
    corrupted[1].persisted.lastPerMessageNudgeTokens = 0
    assert.throws(
        () =>
            assertNudgeCheckpointSequence(corrupted, {
                expectedCompressEmissions: 2,
                expectedBaselines,
            }),
        /baseline changed/,
    )
    const corruptedPostBaseline = JSON.parse(JSON.stringify(checkpoints))
    corruptedPostBaseline[3].persisted.lastPerMessageNudgeTokens = 999
    assert.throws(
        () =>
            assertNudgeCheckpointSequence(corruptedPostBaseline, {
                expectedCompressEmissions: 2,
                expectedBaselines,
            }),
        /baseline mismatch/,
    )
}

runProjectionChecks()
runFallbackChecks()
runEnvironmentChecks()
runCleanupChecks()
runNudgeChecks()
console.log(
    "PASS E2E verifier self-tests (projection, fallback exclusivity, env, cleanup, nudge mutation checks)",
)
