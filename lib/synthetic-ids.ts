/**
 * IDs allocated by ACP for messages that are implementation details rather
 * than user/model conversation. Keep this classification in one place: refs,
 * projections, and persisted-state cleanup must agree about ownership.
 */
const ACP_SYNTHETIC_ID_PATTERN =
    /^msg_(?:dcp_summary_|dcp_text_|acp_recap_|acp_notice_|acp_summary_)/

const ACP_OWNED_ID_PATTERN = /^msg_(?:dcp_summary_|dcp_text_|acp_recap_|acp_notice_)[0-9a-f]{16}$/

const ACP_OWNED_NOTICE_ID_PATTERN = /^msg_acp_notice_[0-9a-f]{16}$/
const ACP_SYNTHETIC_HASH_LENGTH = 16
const V2_COMPRESSION_SUMMARY_SEED = "acp-v2-compression-summary"

export function v2CompressionSummarySeed(blockId: number): string {
    return `${V2_COMPRESSION_SUMMARY_SEED}:${blockId}`
}

export function v2CompressionSummaryMessageId(blockId: number): string {
    const hash = createHash("sha256")
        .update(v2CompressionSummarySeed(blockId))
        .digest("hex")
        .slice(0, ACP_SYNTHETIC_HASH_LENGTH)
    return `msg_dcp_summary_${hash}`
}

export function isAcpSyntheticId(value: string | undefined): boolean {
    return value !== undefined && ACP_SYNTHETIC_ID_PATTERN.test(value)
}

/** IDs that are safe to insert into a V2 provider request. */
export function isAcpOwnedId(value: string | undefined): boolean {
    return value !== undefined && ACP_OWNED_ID_PATTERN.test(value)
}

export function isAcpOwnedNoticeId(value: string | undefined): boolean {
    return value !== undefined && ACP_OWNED_NOTICE_ID_PATTERN.test(value)
}
import { createHash } from "node:crypto"
