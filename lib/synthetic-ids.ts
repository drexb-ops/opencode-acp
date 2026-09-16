/**
 * IDs allocated by ACP for messages that are implementation details rather
 * than user/model conversation. Keep this classification in one place: refs,
 * projections, and persisted-state cleanup must agree about ownership.
 */
const ACP_SYNTHETIC_ID_PATTERN =
    /^msg_(?:dcp_summary_|dcp_text_|acp_recap_|acp_notice_|acp_summary_)/

const ACP_OWNED_ID_PATTERN = /^msg_(?:dcp_summary_|dcp_text_|acp_recap_|acp_notice_)[0-9a-f]{16}$/

const ACP_OWNED_NOTICE_ID_PATTERN = /^msg_acp_notice_[0-9a-f]{16}$/

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
