/**
 * Shared recognition of failed ACP tool results on OpenCode V2.
 *
 * The pinned Promise tool adapter (`@opencode/plugin@2.0.3`) has no safe
 * native error-return channel: a rejected promise becomes an untyped Effect
 * defect, losing structured metadata and risking turn-level failure.
 * `createV2Tool` therefore returns RESOLVED results with the error text in
 * `content`, and the host records those tool parts with
 * `state.status === "completed"`.
 *
 * This module centralizes failure recognition so the internal V2 projection
 * can report such tools as failed WITHOUT rewriting provider-owned output:
 * - explicit failure metadata (`acpFailed: true`) written by
 *   `createV2Tool`'s `errorResult` is authoritative;
 * - the anchored output pattern recognizes compatible historical records
 *   created before that metadata existed.
 *
 * The module is intentionally dependency-free so unit tests, the projection,
 * and the installed E2E fake provider can all reuse the same recognition.
 */

export const V2_ACP_TOOL_NAMES = [
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_context_recap",
] as const

export type V2AcpToolName = (typeof V2_ACP_TOOL_NAMES)[number]

/** Metadata key marking a resolved ACP error result as a failure. */
export const ACP_FAILURE_METADATA_KEY = "acpFailed" as const

/**
 * Position-0 anchored prefixes of every resolved ACP error result produced
 * by `createV2Tool`:
 * - `ACP <tool> failed: ...` (execution catch-all)
 * - `ACP is shutting down; ...` (lifecycle deny)
 * - `ACP is currently disabled because a /bili/ proxy is active.`
 * - `ACP direct tools are disabled for child sessions ...`
 * - `ACP could not verify the session parent; ...`
 * - `ACP could not resolve the active agent permission; ...`
 * - `ACP tool execution is disabled by the active agent or ACP configuration...`
 * - `ACP cannot request an interactive permission on OpenCode V2.0.3. ...`
 * - `Invalid <tool> input: ...`
 *
 * Deliberately NOT multiline-anchored: quoted historical failure text inside
 * a larger successful output must never match.
 */
export const ACP_FAILURE_OUTPUT_PATTERN =
    /^(?:ACP (?:[a-z][a-z_]* failed|is shutting down|is currently disabled|direct tools are disabled|could not verify the session parent|could not resolve the active agent permission|tool execution is disabled|cannot request an interactive permission)|Invalid [a-z][a-z_]* input:)/

export function isAcpToolName(name: string | undefined): name is V2AcpToolName {
    return typeof name === "string" && (V2_ACP_TOOL_NAMES as readonly string[]).includes(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Decide whether a host-recorded completed ACP tool result is actually a
 * failure. Explicit failure metadata wins; otherwise fall back to the
 * historical output-text pattern. Non-ACP tools never match.
 */
export function isAcpFailedToolOutput(
    toolName: string | undefined,
    rawState: Record<string, unknown>,
    neutralizedOutput: string,
): boolean {
    if (!isAcpToolName(toolName)) return false
    if (isRecord(rawState.metadata) && rawState.metadata[ACP_FAILURE_METADATA_KEY] === true)
        return true
    return ACP_FAILURE_OUTPUT_PATTERN.test(neutralizedOutput)
}
