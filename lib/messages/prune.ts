import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { createSyntheticUserMessage, stripHallucinationsFromString } from "./utils"
import { isAcpNonRemovableMessage, isV2ProjectedMessage } from "./opaque"
import { COMPRESSED_BLOCK_HEADER } from "../compress/state"
import {
    isAcpOwnedId,
    v2CompressionSummaryMessageId,
    v2CompressionSummarySeed,
} from "../synthetic-ids"

interface V2SummaryRecovery {
    /** Blocks whose source messages are safe to remove in this projection. */
    prunableBlockIds: Set<number>
    insertedBlockIds: Set<number>
}

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    const v2Recovery = messages.some(isV2ProjectedMessage)
        ? recoverMissingV2CompressionSummaries(state, logger, messages)
        : undefined
    filterCompressedRanges(state, messages, v2Recovery?.prunableBlockIds)
    stripStepMarkers(messages)
}

const MAX_STEP_FINISH_REASON = 50

const stripStepMarkers = (messages: WithParts[]): void => {
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let changed = false
        const filtered: typeof parts = []

        for (const part of parts) {
            if (part.type === "step-start") {
                changed = true
                continue
            }

            if (part.type === "step-finish") {
                const reason = (part as { reason?: unknown }).reason
                if (typeof reason === "string" && reason.length > MAX_STEP_FINISH_REASON) {
                    const truncated = reason.slice(0, MAX_STEP_FINISH_REASON) + "..."
                    // Skip when already truncated: keeps `changed` false on idempotent
                    // re-runs so the parts array reference (and prefix cache) stays stable.
                    if (truncated !== reason) {
                        filtered.push({ ...part, reason: truncated })
                        changed = true
                        continue
                    }
                }
            }

            filtered.push(part)
        }

        if (changed) {
            msg.parts = filtered
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    messages: WithParts[],
    allowedBlockIds?: ReadonlySet<number>,
): void => {
    if (state.prune.messages.byMessageId.size === 0) {
        return
    }

    const messageIdCounts = new Map<string, number>()
    for (const message of messages) {
        messageIdCounts.set(message.info.id, (messageIdCounts.get(message.info.id) ?? 0) + 1)
    }

    const survive: boolean[] = messages.map((msg) => {
        // Older persisted blocks may claim an opaque V2 source. Keep it visible
        // throughout budgeting as well as patching; restoration is a last guard.
        if (isAcpNonRemovableMessage(msg)) return true
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        if (!pruneEntry || pruneEntry.activeBlockIds.length === 0) {
            return true
        }
        // A duplicated raw ID cannot be correlated to one exact provider
        // message. Fail closed rather than removing either copy.
        if ((messageIdCounts.get(msg.info.id) ?? 0) !== 1) return true

        // Membership is persisted separately from each block's effective source
        // IDs.  Do not let a stale/corrupt membership entry remove a current
        // message merely because the raw ID happens to be present in the map.
        const activeBlockIds = pruneEntry.activeBlockIds.filter((blockId) => {
            const block = state.prune.messages.blocksById.get(blockId)
            // Keep compatibility with the old V1 unit-level state shape, where
            // only byMessageId was populated. V2 always has block records after
            // load/rebuild and therefore takes the strict branch below.
            if (!block) return allowedBlockIds === undefined
            return block?.active === true && block.effectiveMessageIds.includes(msg.info.id)
        })
        if (activeBlockIds.length === 0) return true

        // An orphaned persisted block is only allowed to remove sources after a
        // deterministic ACP-owned summary has been materialized.  Blocks whose
        // original compress call is still visible are included in the allowlist
        // by the recovery pass and retain their existing summary-bearing call.
        if (allowedBlockIds && activeBlockIds.some((blockId) => !allowedBlockIds.has(blockId))) {
            return true
        }
        return false
    })

    // [FIX preserve-first-user] zhipuai-lb (and most providers) reject requests
    // with zero user-role messages (code 1214, "The messages parameter is
    // illegal"), freezing the session. The first user message is the session's
    // original task — it must always survive compression to guarantee API
    // validity. This is simpler and more reliable than the previous
    // "restore most recent pruned user" approach, which depended on the
    // pruned message still being in the messages array (not guaranteed after
    // OpenCode compaction).
    const firstUserIdx = messages.findIndex((msg) => msg.info.role === "user")
    if (firstUserIdx >= 0) {
        survive[firstUserIdx] = true
    }

    const result: WithParts[] = []
    for (let i = 0; i < messages.length; i++) {
        if (survive[i]) {
            result.push(messages[i]!)
        }
    }

    messages.length = 0
    messages.push(...result)
}

function blockSort(left: CompressionBlock, right: CompressionBlock): number {
    const createdAt = left.createdAt - right.createdAt
    return createdAt !== 0 ? createdAt : left.blockId - right.blockId
}

function hasExactActiveMembership(
    state: SessionState,
    blockId: number,
    messageId: string,
): boolean {
    const entry = state.prune.messages.byMessageId.get(messageId)
    return (
        entry?.activeBlockIds.includes(blockId) === true &&
        state.prune.messages.activeBlockIds.has(blockId)
    )
}

function messageHasText(message: WithParts, text: string): boolean {
    return message.parts.some((part) => part.type === "text" && part.text === text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizedSummaryBody(value: string): string {
    const sanitized = stripHallucinationsFromString(value).trim()
    return sanitized.startsWith(COMPRESSED_BLOCK_HEADER)
        ? sanitized.slice(COMPRESSED_BLOCK_HEADER.length).trim()
        : sanitized
}

function recoverableSummaryText(value: string): { body: string; text: string } | undefined {
    const body = normalizedSummaryBody(value)
    if (body.length === 0) return undefined
    return { body, text: `${COMPRESSED_BLOCK_HEADER}\n${body}` }
}

function summaryPayloads(part: Extract<WithParts["parts"][number], { type: "tool" }>): string[] {
    if (part.state.status !== "completed" || !isRecord(part.state.input)) return []
    const input = part.state.input
    const values: string[] = []
    if (typeof input.summary === "string") values.push(input.summary)
    if (Array.isArray(input.content)) {
        for (const entry of input.content) {
            if (isRecord(entry) && typeof entry.summary === "string") values.push(entry.summary)
        }
    }
    return values
}

function hasValidVisibleCompressionCarrier(
    messagesById: ReadonlyMap<string, WithParts>,
    block: CompressionBlock,
    summaryBody: string,
): boolean {
    if (!block.compressMessageId || !block.compressCallId) return false
    const message = messagesById.get(block.compressMessageId)
    return (
        message?.parts.some((part) => {
            if (
                part.type !== "tool" ||
                part.tool !== "compress" ||
                part.callID !== block.compressCallId
            ) {
                return false
            }
            return summaryPayloads(part).some((payload) => {
                const body = normalizedSummaryBody(payload)
                return (
                    body.length > 0 && (body === summaryBody || summaryBody.startsWith(`${body}\n`))
                )
            })
        }) === true
    )
}

/**
 * Recover the provider-visible half of a persisted V2 compression.
 *
 * A V2 compression call is normally the anchor that carries its summary.  The
 * call can, however, be removed by OpenCode while the selected source messages
 * remain.  V1 keeps the historical call/anchor behavior, while V2 must add an
 * ACP-owned deterministic message before pruning those sources.  If no source
 * remains, this intentionally does nothing: the block is historical and must
 * not claim current wire savings.
 */
function recoverMissingV2CompressionSummaries(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): V2SummaryRecovery {
    const original = messages.slice()
    const messagesById = new Map<string, WithParts>()
    const messageIndexes = new Map<string, number>()
    const duplicateIds = new Set<string>()
    for (let index = 0; index < original.length; index++) {
        const message = original[index]!
        const id = message.info.id
        if (messagesById.has(id)) duplicateIds.add(id)
        messagesById.set(id, message)
        messageIndexes.set(id, index)
    }

    const prunableBlockIds = new Set<number>()
    const insertedBlockIds = new Set<number>()
    const insertions = new Map<number, WithParts[]>()
    const firstUserIndex = original.findIndex((message) => message.info.role === "user")

    const activeBlocks = [...state.prune.messages.activeBlockIds]
        .map((blockId) => state.prune.messages.blocksById.get(blockId))
        .filter((block): block is CompressionBlock => block?.active === true)
        .sort(blockSort)

    for (const block of activeBlocks) {
        const visibleSourceIndices: number[] = []
        const removableSourceIndices: number[] = []
        let hasUnsafeMembership = false

        for (const messageId of [...new Set(block.effectiveMessageIds)]) {
            if (duplicateIds.has(messageId)) {
                hasUnsafeMembership = true
                continue
            }
            const message = messagesById.get(messageId)
            if (!message) continue
            const index = messageIndexes.get(messageId)
            if (index === undefined) continue
            visibleSourceIndices.push(index)
            if (isAcpNonRemovableMessage(message)) continue
            if (!hasExactActiveMembership(state, block.blockId, messageId)) {
                hasUnsafeMembership = true
                continue
            }
            removableSourceIndices.push(index)
        }

        const recoverableSummary = recoverableSummaryText(block.summary)
        if (!recoverableSummary) {
            logger.warn("Skipped V2 compression summary recovery", {
                blockId: block.blockId,
                reason: "empty or metadata-only summary",
            })
            continue
        }

        // Only the exact completed call that created this block may carry its
        // summary. A colliding/incomplete compress part is not pruning proof.
        if (hasValidVisibleCompressionCarrier(messagesById, block, recoverableSummary.body)) {
            if (!hasUnsafeMembership) prunableBlockIds.add(block.blockId)
            continue
        }

        // OpenCode compaction may remove every effective source and the call.
        // Keep the archive active, but do not synthesize an orphan summary or
        // report savings for a request that contains none of its source range.
        if (removableSourceIndices.length === 0) {
            if (visibleSourceIndices.length === 0) {
                logger.debug("Skipped historical V2 compression summary recovery", {
                    blockId: block.blockId,
                    reason: "no visible effective sources",
                })
            }
            continue
        }
        if (hasUnsafeMembership) {
            logger.warn("Skipped V2 compression summary recovery", {
                blockId: block.blockId,
                reason: "stale source membership",
            })
            continue
        }

        const baseMessage = original.find((message) => message.info.role === "user") ?? original[0]
        if (!baseMessage) continue

        const synthetic = createSyntheticUserMessage(
            baseMessage,
            recoverableSummary.text,
            v2CompressionSummarySeed(block.blockId),
        )
        const syntheticId = synthetic.info.id
        if (syntheticId !== v2CompressionSummaryMessageId(block.blockId)) {
            logger.warn("Skipped V2 compression summary recovery", {
                blockId: block.blockId,
                reason: "synthetic summary ID derivation mismatch",
            })
            continue
        }
        const existing = messagesById.get(syntheticId)
        if (existing) {
            // A matching ACP-owned message is already provider-visible.  A
            // collision with host content, or a stale ACP message with another
            // body, fails closed so sources are never removed without the right
            // summary.
            if (isAcpOwnedId(syntheticId) && messageHasText(existing, recoverableSummary.text)) {
                insertedBlockIds.add(block.blockId)
                prunableBlockIds.add(block.blockId)
            } else {
                logger.warn("Skipped V2 compression summary recovery", {
                    blockId: block.blockId,
                    reason: "synthetic summary ID collision",
                })
            }
            continue
        }

        let insertionIndex = Math.min(...removableSourceIndices)
        // The normal V2 patch contract always keeps the first user message.
        // Place a summary after it when the compressed range starts there, so
        // the resulting provider request remains a valid user-led conversation.
        if (firstUserIndex >= 0 && insertionIndex <= firstUserIndex) {
            insertionIndex = firstUserIndex + 1
        }
        const pending = insertions.get(insertionIndex) ?? []
        pending.push(synthetic)
        insertions.set(insertionIndex, pending)
        insertedBlockIds.add(block.blockId)
        prunableBlockIds.add(block.blockId)
    }

    if (insertions.size > 0) {
        const rebuilt: WithParts[] = []
        for (let index = 0; index <= original.length; index++) {
            const pending = insertions.get(index)
            if (pending) rebuilt.push(...pending)
            if (index < original.length) rebuilt.push(original[index]!)
        }
        messages.length = 0
        messages.push(...rebuilt)
    }

    if (insertedBlockIds.size > 0) {
        logger.debug("Recovered persisted V2 compression summaries", {
            blockIds: [...insertedBlockIds].sort((left, right) => left - right),
        })
    }
    return { prunableBlockIds, insertedBlockIds }
}
