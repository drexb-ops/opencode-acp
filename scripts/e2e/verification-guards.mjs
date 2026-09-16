import { createHash } from "node:crypto"
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs"
import path from "node:path"

/**
 * Small, dependency-free helpers shared by the installed-artifact verifier and
 * the V2 driver.  The helpers deliberately return diagnostics rather than
 * source values: E2E artifacts are often retained after a failed run.
 */

export const EXACT_V2_DIRECTORY_DIAGNOSTIC = "configured plugin path must be a directory"

const SAFE_ID_PATTERNS = [
    /^m\d{1,6}$/,
    /^b\d{1,6}$/,
    /^(?:call|msg|part|tool|ses|run|acp)_[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/,
]

const SAFE_TOOL_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const SAFE_FIELD_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,79}$/

export const ACP_TOOL_OWNED_FIELDS = [
    "prune",
    "stats",
    "compressionTiming",
    "toolParameters",
    "toolIdList",
    "qualityGateRetryPending",
    "noContextLimitWarned",
]

export const ACP_HOST_CONTEXT_FIELDS = [
    "sessionId",
    "isSubAgent",
    "compressPermission",
    "messageIds",
    "lastCompaction",
    "currentTurn",
    "modelContextLimit",
    "modelProviderID",
    "modelID",
    "systemPromptTokens",
    "storageDir",
    "lastUpdated",
    "sessionName",
    // Nudge baselines are recomputed from the host's newly assembled context;
    // they are projected in full but compared separately from a permission
    // tool's prune/cache/stat mutations.
    "nudges",
]

/** Every mutable SessionState field is listed here and emitted in the projection. */
export const ACP_PROJECTION_FIELD_PATHS = [
    "sessionId",
    "isSubAgent",
    "compressPermission",
    "prune.messages.byMessageId",
    "prune.messages.blocksById",
    "prune.messages.activeBlockIds",
    "prune.messages.activeByAnchorMessageId",
    "prune.messages.nextBlockId",
    "prune.messages.nextRunId",
    "prune.messages.markedForCleanup",
    "prune.messages.membershipsVerified",
    "prune.messages.structureVersion",
    "prune.messages.lastSyncedStructureVersion",
    "prune.messages.hideConsumedIndex",
    "nudges.contextLimitAnchors",
    "nudges.turnNudgeAnchors",
    "nudges.iterationNudgeAnchors",
    "nudges.lastPerMessageNudgeTurn",
    "nudges.lastPerMessageNudgeTokens",
    "nudges.lastNudgeShownTokens",
    "nudges.lastToolOutputNudgeTokens",
    "nudges.lastTier2NudgeTokens",
    "nudges.lastTier3NudgeTokens",
    "nudges.shouldInjectThisTurn",
    "nudges.compressBaselineSet",
    "nudges.lastProcessedCompressMessageId",
    "stats.pruneTokenCounter",
    "stats.totalPruneTokens",
    "compressionTiming.startsByCallId",
    "compressionTiming.pendingByCallId",
    "toolParameters",
    "toolIdList",
    "messageIds.byRawId",
    "messageIds.byRef",
    "messageIds.nextRef",
    "lastCompaction",
    "currentTurn",
    "modelContextLimit",
    "modelProviderID",
    "modelID",
    "systemPromptTokens",
    "storageDir",
    "lastUpdated",
    "sessionName",
    "qualityGateRetryPending",
    "noContextLimitWarned",
]

function isObject(value) {
    return value !== null && typeof value === "object"
}

function entriesOf(value) {
    if (value instanceof Map) return [...value.entries()]
    if (isObject(value) && !Array.isArray(value) && !(value instanceof Set)) {
        return Object.entries(value)
    }
    return []
}

function valuesOf(value) {
    if (value instanceof Set) return [...value.values()]
    if (Array.isArray(value)) return [...value]
    if (value instanceof Map) return [...value.values()]
    if (isObject(value)) return Object.values(value)
    return []
}

function textHash(value) {
    return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`
}

export function redactedText(value) {
    const text = typeof value === "string" ? value : String(value ?? "")
    return { hash: textHash(text), length: text.length }
}

function safeField(value) {
    const text = String(value)
    if (SAFE_FIELD_PATTERN.test(text)) {
        return text
    }
    return textHash(text)
}

export function safeDiagnosticId(value) {
    if (typeof value !== "string") return null
    return SAFE_ID_PATTERNS.some((pattern) => pattern.test(value)) ? value : textHash(value)
}

function safeToolName(value) {
    if (typeof value !== "string") return null
    const normalized = value.trim().toLowerCase()
    return SAFE_TOOL_PATTERN.test(normalized) ? normalized : textHash(value)
}

function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanOrNull(value) {
    return typeof value === "boolean" ? value : null
}

function sortedStrings(values, mapper = (value) => value) {
    return values
        .map(mapper)
        .filter((value) => value !== null && value !== undefined)
        .sort((left, right) => String(left).localeCompare(String(right)))
}

function sortedNumbers(values) {
    return values
        .filter((value) => typeof value === "number" && Number.isFinite(value))
        .sort((left, right) => left - right)
}

/**
 * Canonical JSON used for comparisons. Object keys are sorted recursively;
 * arrays retain order because an array can represent message order.
 */
export function stableSerialize(value) {
    return JSON.stringify(value, (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
            return Object.fromEntries(
                Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
            )
        }
        return item
    })
}

function digestValue(value) {
    return textHash(stableSerialize(value) ?? String(value))
}

function redactedShape(value, depth = 0) {
    if (value === undefined) return { kind: "undefined" }
    if (value === null) return { kind: "null" }
    if (typeof value === "string") return { kind: "string", ...redactedText(value) }
    if (typeof value === "number") return { kind: "number", finite: Number.isFinite(value) }
    if (typeof value === "boolean") return { kind: "boolean", value }
    if (typeof value === "bigint") return { kind: "bigint" }
    if (typeof value === "function") return { kind: "function" }
    if (depth > 1) return { kind: Array.isArray(value) ? "array" : "object", truncated: true }
    if (value instanceof Map) {
        return {
            kind: "map",
            count: value.size,
            keys: sortedStrings([...value.keys()], (key) => safeField(key)),
        }
    }
    if (value instanceof Set) {
        return { kind: "set", count: value.size }
    }
    if (Array.isArray(value)) {
        return {
            kind: "array",
            count: value.length,
            itemKinds: sortedStrings(value.map((item) => redactedShape(item, depth + 1).kind)),
        }
    }
    return {
        kind: "object",
        keys: sortedStrings(Object.keys(value), (key) => safeField(key)),
        count: Object.keys(value).length,
    }
}

function projectIdList(value) {
    return sortedStrings(valuesOf(value), (item) => safeDiagnosticId(item))
}

function projectNumberList(value) {
    return sortedNumbers(valuesOf(value))
}

function projectStringMap(value, valueMapper = (item) => safeDiagnosticId(item)) {
    const rows = entriesOf(value).map(([key, item]) => ({
        key: safeDiagnosticId(key) ?? safeField(key),
        value: valueMapper(item),
    }))
    return rows.sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
}

function projectPrunedEntry(entry) {
    const value = isObject(entry) ? entry : {}
    return {
        tokenCount: numberOrNull(value.tokenCount),
        allBlockIds: projectNumberList(value.allBlockIds),
        activeBlockIds: projectNumberList(value.activeBlockIds),
    }
}

function projectBlock(block, fallbackId) {
    const value = isObject(block) ? block : {}
    return {
        blockId: numberOrNull(value.blockId) ?? numberOrNull(fallbackId),
        runId: numberOrNull(value.runId),
        active: booleanOrNull(value.active),
        deactivatedByUser: booleanOrNull(value.deactivatedByUser),
        deactivatedByUserDeep: booleanOrNull(value.deactivatedByUserDeep),
        compressedTokens: numberOrNull(value.compressedTokens),
        effectiveCompressedTokens: numberOrNull(value.effectiveCompressedTokens),
        summaryTokens: numberOrNull(value.summaryTokens),
        durationMs: numberOrNull(value.durationMs),
        mode: typeof value.mode === "string" ? value.mode : null,
        tier: numberOrNull(value.tier),
        topic: redactedText(value.topic),
        batchTopic: value.batchTopic === undefined ? null : redactedText(value.batchTopic),
        startId: safeDiagnosticId(value.startId),
        endId: safeDiagnosticId(value.endId),
        anchorMessageId: safeDiagnosticId(value.anchorMessageId),
        compressMessageId: safeDiagnosticId(value.compressMessageId),
        compressCallId: safeDiagnosticId(value.compressCallId),
        includedBlockIds: projectNumberList(value.includedBlockIds),
        consumedBlockIds: projectNumberList(value.consumedBlockIds),
        parentBlockIds: projectNumberList(value.parentBlockIds),
        directMessageIds: projectIdList(value.directMessageIds),
        directToolIds: projectIdList(value.directToolIds),
        effectiveMessageIds: projectIdList(value.effectiveMessageIds),
        effectiveToolIds: projectIdList(value.effectiveToolIds),
        createdAt: numberOrNull(value.createdAt),
        deactivatedAt: numberOrNull(value.deactivatedAt),
        deactivatedByBlockId: numberOrNull(value.deactivatedByBlockId),
        summary: redactedText(value.summary),
        survivedCount: numberOrNull(value.survivedCount),
        generation: typeof value.generation === "string" ? value.generation : null,
    }
}

function projectHideConsumedIndex(value) {
    if (!isObject(value)) return null
    return {
        version: numberOrNull(value.version),
        allBlockCallIds: projectIdList(value.allBlockCallIds),
        liveRangeKeysByCallId: entriesOf(value.liveRangeKeysByCallId)
            .map(([key, ranges]) => ({
                key: safeDiagnosticId(key) ?? safeField(key),
                count: valuesOf(ranges).length,
                keys: sortedStrings(valuesOf(ranges), (item) => safeField(item)),
            }))
            .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right))),
        activeCallIds: projectIdList(value.activeCallIds),
    }
}

function projectPrune(value) {
    const prune = isObject(value) ? value : {}
    const messages = isObject(prune.messages) ? prune.messages : {}
    return {
        messages: {
            byMessageId: entriesOf(messages.byMessageId)
                .map(([key, item]) => ({
                    key: safeDiagnosticId(key) ?? safeField(key),
                    value: projectPrunedEntry(item),
                }))
                .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right))),
            blocksById: entriesOf(messages.blocksById)
                .map(([key, item]) => projectBlock(item, key))
                .sort((left, right) => (left.blockId ?? 0) - (right.blockId ?? 0)),
            activeBlockIds: projectNumberList(messages.activeBlockIds),
            activeByAnchorMessageId: entriesOf(messages.activeByAnchorMessageId)
                .map(([key, item]) => ({
                    key: safeDiagnosticId(key) ?? safeField(key),
                    value: numberOrNull(item),
                }))
                .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right))),
            nextBlockId: numberOrNull(messages.nextBlockId),
            nextRunId: numberOrNull(messages.nextRunId),
            markedForCleanup: projectNumberList(messages.markedForCleanup),
            membershipsVerified: booleanOrNull(messages.membershipsVerified),
            structureVersion: numberOrNull(messages.structureVersion),
            lastSyncedStructureVersion: numberOrNull(messages.lastSyncedStructureVersion),
            hideConsumedIndex: projectHideConsumedIndex(messages.hideConsumedIndex),
        },
    }
}

function projectNudges(value) {
    const nudges = isObject(value) ? value : {}
    return {
        contextLimitAnchors: projectIdList(nudges.contextLimitAnchors),
        turnNudgeAnchors: projectIdList(nudges.turnNudgeAnchors),
        iterationNudgeAnchors: projectIdList(nudges.iterationNudgeAnchors),
        lastPerMessageNudgeTurn: numberOrNull(nudges.lastPerMessageNudgeTurn),
        lastPerMessageNudgeTokens: numberOrNull(nudges.lastPerMessageNudgeTokens),
        lastNudgeShownTokens: numberOrNull(nudges.lastNudgeShownTokens),
        lastToolOutputNudgeTokens: numberOrNull(nudges.lastToolOutputNudgeTokens),
        lastTier2NudgeTokens: numberOrNull(nudges.lastTier2NudgeTokens),
        lastTier3NudgeTokens: numberOrNull(nudges.lastTier3NudgeTokens),
        shouldInjectThisTurn: booleanOrNull(nudges.shouldInjectThisTurn),
        compressBaselineSet: booleanOrNull(nudges.compressBaselineSet),
        lastProcessedCompressMessageId: safeDiagnosticId(nudges.lastProcessedCompressMessageId),
    }
}

function projectTiming(value) {
    const timing = isObject(value) ? value : {}
    return {
        startsByCallId: entriesOf(timing.startsByCallId)
            .map(([key, item]) => ({
                key: safeDiagnosticId(key) ?? safeField(key),
                value: numberOrNull(item),
            }))
            .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right))),
        pendingByCallId: entriesOf(timing.pendingByCallId)
            .map(([key, item]) => ({
                key: safeDiagnosticId(key) ?? safeField(key),
                shape: redactedShape(item),
            }))
            .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right))),
    }
}

function projectToolParameters(value) {
    return entriesOf(value)
        .map(([key, item]) => {
            const entry = isObject(item) ? item : {}
            const parameters = entry.parameters
            return {
                key: safeDiagnosticId(key) ?? safeField(key),
                tool: safeToolName(entry.tool),
                parameters: redactedShape(parameters),
                parameterKeys:
                    isObject(parameters) &&
                    !Array.isArray(parameters) &&
                    !(parameters instanceof Map)
                        ? sortedStrings(Object.keys(parameters), (name) => safeField(name))
                        : [],
                status: typeof entry.status === "string" ? entry.status : null,
                error: entry.error === undefined ? null : redactedText(entry.error),
                turn: numberOrNull(entry.turn),
                tokenCount: numberOrNull(entry.tokenCount),
            }
        })
        .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
}

function projectMessageIds(value) {
    const ids = isObject(value) ? value : {}
    return {
        byRawId: projectStringMap(ids.byRawId),
        byRef: projectStringMap(ids.byRef),
        nextRef: numberOrNull(ids.nextRef),
    }
}

function projectUnknownFields(state) {
    const known = new Set([
        "sessionId",
        "isSubAgent",
        "compressPermission",
        "prune",
        "nudges",
        "stats",
        "compressionTiming",
        "toolParameters",
        "toolIdList",
        "messageIds",
        "lastCompaction",
        "currentTurn",
        "modelContextLimit",
        "modelProviderID",
        "modelID",
        "systemPromptTokens",
        "storageDir",
        "lastUpdated",
        "sessionName",
        "qualityGateRetryPending",
        "noContextLimitWarned",
    ])
    return Object.keys(state ?? {})
        .filter((key) => !known.has(key))
        .map((key) => ({ key: safeField(key), shape: redactedShape(state[key]) }))
        .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
}

/**
 * Project all mutable ACP state into bounded, deterministic diagnostics.
 * Summaries, message content, tool arguments/results, paths, provider values,
 * and arbitrary strings are represented by hashes/shapes only.
 */
export function projectAcpState(state) {
    const value = isObject(state) ? state : {}
    return {
        projectionVersion: 1,
        coveredFields: [...ACP_PROJECTION_FIELD_PATHS],
        sessionId: safeDiagnosticId(value.sessionId),
        isSubAgent: booleanOrNull(value.isSubAgent),
        compressPermission:
            value.compressPermission === "allow" ||
            value.compressPermission === "ask" ||
            value.compressPermission === "deny"
                ? value.compressPermission
                : null,
        prune: projectPrune(value.prune),
        nudges: projectNudges(value.nudges),
        stats: {
            pruneTokenCounter: numberOrNull(value.stats?.pruneTokenCounter),
            totalPruneTokens: numberOrNull(value.stats?.totalPruneTokens),
        },
        compressionTiming: projectTiming(value.compressionTiming),
        toolParameters: projectToolParameters(value.toolParameters ?? value.toolCache),
        toolIdList: sortedStrings(valuesOf(value.toolIdList), (item) => safeToolName(item)),
        messageIds: projectMessageIds(value.messageIds),
        lastCompaction: numberOrNull(value.lastCompaction),
        currentTurn: numberOrNull(value.currentTurn),
        modelContextLimit: numberOrNull(value.modelContextLimit),
        modelProviderID:
            value.modelProviderID === undefined ? null : redactedText(value.modelProviderID),
        modelID: value.modelID === undefined ? null : redactedText(value.modelID),
        systemPromptTokens: numberOrNull(value.systemPromptTokens),
        storageDir: value.storageDir === undefined ? null : redactedText(value.storageDir),
        lastUpdated: value.lastUpdated === undefined ? null : redactedText(value.lastUpdated),
        sessionName: value.sessionName === undefined ? null : redactedText(value.sessionName),
        qualityGateRetryPending: booleanOrNull(value.qualityGateRetryPending),
        noContextLimitWarned: booleanOrNull(value.noContextLimitWarned),
        unknownFields: projectUnknownFields(value),
    }
}

function projectionFieldValue(projection, field) {
    return projection?.[field]
}

function compareProjectionFields(before, after, fields) {
    const changedFields = []
    const fieldDigests = []
    for (const field of fields) {
        const beforeValue = projectionFieldValue(before, field)
        const afterValue = projectionFieldValue(after, field)
        const beforeDigest = digestValue(beforeValue)
        const afterDigest = digestValue(afterValue)
        fieldDigests.push({ field, before: beforeDigest, after: afterDigest })
        if (beforeDigest !== afterDigest) changedFields.push(field)
    }
    return {
        equal: changedFields.length === 0,
        changedFields,
        fieldDigests,
    }
}

/** Compare tool-owned mutations separately from legitimate host context/ref updates. */
export function comparePermissionProjections(beforeState, afterState) {
    const before = projectAcpState(beforeState)
    const after = projectAcpState(afterState)
    return {
        schema: "acp-permission-comparison-v1",
        toolOwned: compareProjectionFields(before, after, ACP_TOOL_OWNED_FIELDS),
        hostContext: compareProjectionFields(before, after, ACP_HOST_CONTEXT_FIELDS),
        unknownFields: compareProjectionFields(before, after, ["unknownFields"]),
    }
}

/**
 * The prompt sentinel is only a phase label. Proof that the preserved window
 * was actually protected must come from outbound message structure.
 */
export function isProtectedNoTargetEvidence(
    checkpoint,
    { preservedRecentMessages = 10, expectedBaseline = 15 } = {},
) {
    const request = checkpoint?.request ?? {}
    const persisted = checkpoint?.persisted ?? {}
    const evidence = checkpoint?.protectedEvidence ?? {}
    return (
        checkpoint?.phase === "protected-no-target" &&
        persisted.blockCount === 0 &&
        persisted.lastPerMessageNudgeTokens === expectedBaseline &&
        request.nudgeDetected === false &&
        request.compressCallCount === 0 &&
        request.calledCompress === false &&
        request.emittedCompressCount === 0 &&
        evidence.configuredPreserveRecentMessages === preservedRecentMessages &&
        ((evidence.blockedRefCount >= preservedRecentMessages &&
            evidence.compressibleRefCount === 0) ||
            (evidence.blockedRefCount === 0 &&
                evidence.withinConfiguredWindow === true &&
                evidence.messageRefCount > 0 &&
                evidence.messageRefCount <= preservedRecentMessages)) &&
        evidence.blockRefCount === 0 &&
        evidence.candidateOrRangeText === false
    )
}

function checkpoint(name, checkpoints) {
    return checkpoints.find((item) => item?.checkpoint === name)
}

/** Assert the installed historical no-target → two real nudges transition. */
export function assertNudgeCheckpointSequence(checkpoints, options = {}) {
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
        throw new Error("nudge checkpoint sequence is empty")
    }
    const initial = checkpoint("initial-baseline", checkpoints)
    const first = checkpoint("first-nudge-observed", checkpoints)
    const firstPost = checkpoint("post-first-compression", checkpoints)
    const second = checkpoint("second-nudge-observed", checkpoints)
    const secondPost = checkpoint("post-second-compression", checkpoints)
    for (const [name, value] of [
        ["initial-baseline", initial],
        ["first-nudge-observed", first],
        ["post-first-compression", firstPost],
        ["second-nudge-observed", second],
        ["post-second-compression", secondPost],
    ]) {
        if (!value) throw new Error(`missing nudge checkpoint ${name}`)
    }
    const initialBaseline = initial.persisted?.lastPerMessageNudgeTokens
    if (typeof initialBaseline !== "number")
        throw new Error("initial nudge baseline is not numeric")
    const expectedBaselines = options.expectedBaselines
    if (
        !expectedBaselines ||
        ![expectedBaselines.initial, expectedBaselines.first, expectedBaselines.second].every(
            (value) => typeof value === "number" && Number.isFinite(value),
        )
    ) {
        throw new Error("exact expected nudge baselines are required")
    }
    if (initialBaseline !== expectedBaselines.initial) {
        throw new Error(
            `initial nudge baseline mismatch: expected ${expectedBaselines.initial}, got ${initialBaseline}`,
        )
    }

    const protectedCheckpoints = checkpoints.filter(
        (item) =>
            item?.phase === "protected-no-target" ||
            String(item?.checkpoint).startsWith("protected-no-target-"),
    )
    if (protectedCheckpoints.length === 0)
        throw new Error("protected no-target phase was not observed")
    let completeProtectedEvidence = false
    for (const item of protectedCheckpoints) {
        if (item.persisted?.lastPerMessageNudgeTokens !== initialBaseline) {
            throw new Error(
                `nudge baseline changed during protected no-target phase at ${item.checkpoint}`,
            )
        }
        if (item.persisted?.blockCount !== 0) {
            throw new Error(
                `protected no-target checkpoint has a compression block at ${item.checkpoint}`,
            )
        }
        if (
            item.persisted?.lastNudgeShownTokens !== null &&
            item.persisted?.lastNudgeShownTokens !== undefined
        ) {
            throw new Error(
                `unexpected shown-token value during no-target phase at ${item.checkpoint}`,
            )
        }
        if (item.protectedEvidence?.complete === true) {
            completeProtectedEvidence = true
            if (
                !isProtectedNoTargetEvidence(item, { expectedBaseline: expectedBaselines.initial })
            ) {
                throw new Error(
                    `protected no-target structural evidence failed at ${item.checkpoint}`,
                )
            }
        }
    }
    if (!completeProtectedEvidence) {
        throw new Error("protected no-target phase never reached complete structural evidence")
    }

    if (first.request?.nudgeDetected !== true) throw new Error("first nudge was not observed")
    if (second.request?.nudgeDetected !== true) throw new Error("second nudge was not observed")
    if (first.preToolCheckpoint?.hostStateObservable !== false) {
        throw new Error("first nudge incorrectly claims transient shown-token observability")
    }
    if (second.preToolCheckpoint?.hostStateObservable !== false) {
        throw new Error("second nudge incorrectly claims transient shown-token observability")
    }
    if (
        first.request?.nudgeSystemTokens === null ||
        first.request?.nudgeSystemTokens === undefined
    ) {
        throw new Error("first nudge lacks provider-visible system-token evidence")
    }
    if (
        second.request?.nudgeSystemTokens === null ||
        second.request?.nudgeSystemTokens === undefined
    ) {
        throw new Error("second nudge lacks provider-visible system-token evidence")
    }
    if (
        firstPost.persisted?.lastNudgeShownTokens !== null &&
        firstPost.persisted?.lastNudgeShownTokens !== undefined
    ) {
        throw new Error("first post-tool checkpoint did not clear the transient shown-token field")
    }
    if (
        secondPost.persisted?.lastNudgeShownTokens !== null &&
        secondPost.persisted?.lastNudgeShownTokens !== undefined
    ) {
        throw new Error("second post-tool checkpoint did not clear the transient shown-token field")
    }
    if (firstPost.persisted?.blockCount !== 1)
        throw new Error("first nudge did not produce exactly one block")
    if (secondPost.persisted?.blockCount !== 2)
        throw new Error("second nudge did not produce exactly two blocks")

    if (firstPost.transition?.baseline !== expectedBaselines.initial) {
        throw new Error("first transition did not start from the exact initial baseline")
    }
    if (secondPost.transition?.baseline !== expectedBaselines.first) {
        throw new Error("second transition did not start from the exact first baseline")
    }
    if (firstPost.persisted?.lastPerMessageNudgeTokens !== expectedBaselines.first) {
        throw new Error(
            `first post-compression baseline mismatch: expected ${expectedBaselines.first}, got ${firstPost.persisted?.lastPerMessageNudgeTokens}`,
        )
    }
    if (secondPost.persisted?.lastPerMessageNudgeTokens !== expectedBaselines.second) {
        throw new Error(
            `second post-compression baseline mismatch: expected ${expectedBaselines.second}, got ${secondPost.persisted?.lastPerMessageNudgeTokens}`,
        )
    }
    const expectedEmissions = options.expectedCompressEmissions ?? 2
    const emissions = secondPost.emittedCompressCount ?? second.emittedCompressCount
    if (emissions !== expectedEmissions) {
        throw new Error(
            `expected exactly ${expectedEmissions} nudge-triggered compress emissions, got ${emissions}`,
        )
    }
    return {
        initialBaseline,
        firstBaseline: expectedBaselines.first,
        secondBaseline: expectedBaselines.second,
    }
}

function stripAnsi(value) {
    return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
}

function lineIsExactDiagnostic(line) {
    return stripAnsi(line).includes(EXACT_V2_DIRECTORY_DIAGNOSTIC)
}

const FATAL_DIAGNOSTIC_PATTERN =
    /\b(?:schema|import|activation|activate|fatal|exception|stack\s+trace|failed|failure|invalid|cannot|unable|rejected|crash|module)\b/i

const ALLOWED_SURROUNDING_PATTERNS = [
    /^timestamp=\S+\s+level=(?:INFO|DEBUG|TRACE)\s+\S+\s+message="(?:cli starting|Sent HTTP response|database schema bootstrap (?:started|completed)|watcher (?:subscribe|started)|location services booted)"(?:\s|$)/i,
    /^timestamp=\S+\s+level=INFO\s+\S+\s+message=event(?:\s|$)/i,
]

function exactLineHasAdditionalFatalDiagnostic(line) {
    const withoutExpected = stripAnsi(line).replace(EXACT_V2_DIRECTORY_DIAGNOSTIC, "")
    const withoutLevelPrefix = withoutExpected.replace(
        /^\s*(?:\[[^\]]+\]\s*)?(?:debug|info|trace|warn|error|fatal)\s*[:\-]?\s*/i,
        "",
    )
    return FATAL_DIAGNOSTIC_PATTERN.test(withoutLevelPrefix)
}

/**
 * Classify only lines belonging to one fresh activation attempt. Unknown
 * surrounding lines are rejected; the allowlist is intentionally small so a
 * schema/import/activation error cannot ride along with the known limitation.
 */
export function classifyV2FallbackAttempt({ status, inventoryActive, freshLines }) {
    const lines = Array.isArray(freshLines) ? freshLines.map(stripAnsi) : []
    const exactLines = lines.filter(lineIsExactDiagnostic)
    const unexpected = []
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || lineIsExactDiagnostic(line)) {
            if (lineIsExactDiagnostic(line) && exactLineHasAdditionalFatalDiagnostic(line)) {
                unexpected.push("exact-line-with-additional-diagnostic")
            }
            continue
        }
        if (ALLOWED_SURROUNDING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
            continue
        }
        if (FATAL_DIAGNOSTIC_PATTERN.test(trimmed)) {
            unexpected.push("fatal-diagnostic")
            continue
        }
        unexpected.push("unallowlisted-surrounding-line")
    }
    const statusMatches = status === 10
    const inactive = inventoryActive === false
    const accepted = statusMatches && inactive && exactLines.length > 0 && unexpected.length === 0
    return {
        accepted,
        statusMatches,
        inventoryInactive: inactive,
        exactDiagnosticMatched: exactLines.length > 0,
        freshLineCount: lines.length,
        exactLineCount: exactLines.length,
        unexpectedDiagnostics: [...new Set(unexpected)],
    }
}

const NPM_ALLOWLIST = new Set([
    "HOME",
    "TMPDIR",
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_IGNORE_SCRIPTS",
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_FUND",
    "NPM_CONFIG_UPDATE_NOTIFIER",
])

const NODE_ALLOWLIST = new Set(["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL", "TZ"])

export function buildMinimalProbeEnv({
    home,
    tmpdir,
    pathValue = process.env.PATH ?? path.dirname(process.execPath),
    userconfig,
    globalconfig,
    cache,
    npm = false,
} = {}) {
    const env = {
        HOME: home,
        TMPDIR: tmpdir,
        PATH: pathValue,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
    }
    if (npm) {
        Object.assign(env, {
            NPM_CONFIG_USERCONFIG: userconfig,
            NPM_CONFIG_GLOBALCONFIG: globalconfig,
            NPM_CONFIG_CACHE: cache,
            NPM_CONFIG_IGNORE_SCRIPTS: "true",
            NPM_CONFIG_AUDIT: "false",
            NPM_CONFIG_FUND: "false",
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
        })
    }
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
}

export function assertMinimalProbeEnv(env, npm = false) {
    const allowed = npm ? NPM_ALLOWLIST : NODE_ALLOWLIST
    const unexpected = Object.keys(env).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) {
        throw new Error(
            `probe environment contains non-allowlisted keys: ${unexpected.sort().join(",")}`,
        )
    }
    if (
        Object.keys(env).some((key) =>
            /(?:TOKEN|AUTH|PASSWORD|SECRET|CREDENTIAL|API_KEY)/i.test(key),
        )
    ) {
        throw new Error("probe environment contains credential-like variables")
    }
    return true
}

export function captureOwnedDirectory(
    candidate,
    { label = "owned directory", parent, prefix } = {},
) {
    let lstat
    try {
        lstat = lstatSync(candidate)
    } catch {
        throw new Error(`${label} does not exist`)
    }
    if (lstat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
    if (!lstat.isDirectory()) throw new Error(`${label} must be a directory`)
    const realPath = realpathSync(candidate)
    const realStat = statSync(realPath)
    if (!realStat.isDirectory()) throw new Error(`${label} is not a real directory`)
    if (parent !== undefined) {
        const parentPath = realpathSync(parent)
        const relative = path.relative(parentPath, realPath)
        if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`${label} is outside its approved parent`)
        }
    }
    if (prefix !== undefined && !path.basename(realPath).startsWith(prefix)) {
        throw new Error(`${label} has an unexpected generated name`)
    }
    return {
        requestedPath: candidate,
        realPath,
        basename: path.basename(realPath),
        device: realStat.dev,
        inode: realStat.ino,
    }
}

export function validateOwnedDirectory(identity, { parent, prefix } = {}) {
    if (!identity || typeof identity.realPath !== "string") {
        throw new Error("cleanup requires an owned directory identity")
    }
    const current = captureOwnedDirectory(identity.realPath, {
        label: "owned cleanup directory",
        parent,
        prefix,
    })
    if (
        current.realPath !== identity.realPath ||
        current.device !== identity.device ||
        current.inode !== identity.inode
    ) {
        throw new Error("owned cleanup directory identity changed")
    }
    return current
}

export function removeOwnedDirectory(identity, options = {}) {
    const current = validateOwnedDirectory(identity, options)
    rmSync(current.realPath, { recursive: true, force: true })
    return true
}
