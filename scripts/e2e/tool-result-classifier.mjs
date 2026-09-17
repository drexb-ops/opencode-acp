/**
 * Payload-free classification for fake-provider observations.
 *
 * ACP's host wrapper can serialize a caught tool failure as a completed host
 * result. Compression therefore requires ACP's real positive result instead
 * of treating every unrecognized string as success.
 */

const FAILURE_TEXT =
    /(?:^|\n)\s*(?:error:|ACP cannot request|ACP tool execution is disabled|ACP .* execution failed|ACP (?:compress|decompress|search_context|acp_status|acp_context_recap) failed:|ACP\b[^\n]*(?:\binactive\b|\bdisabled\b|\bnot active\b)|permission .* blocked|invalid .* input|COMPRESSION REJECTED|QUALITY GATE FAILURE)/i

const COMPRESS_SUCCESS =
    /^\s*Compressed\s+\d+\s+messages?\s+into\s+\[Compressed conversation section\]\./i

export function classifyToolResult(name, text) {
    if (name === "compress") return COMPRESS_SUCCESS.test(text) ? "completed" : "error"
    return FAILURE_TEXT.test(text) ? "error" : "completed"
}
