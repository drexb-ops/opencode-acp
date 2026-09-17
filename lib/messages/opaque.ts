/** True for algorithm-only V2 parts that must never rewrite host-owned data. */
export function isAcpOpaquePart(part: unknown): boolean {
    return (
        part !== null &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as { __acpOpaque?: unknown }).__acpOpaque === true
    )
}

/** Source-level removal policy, distinct from whether individual parts may be edited. */
export function isAcpNonRemovableMessage(message: unknown): boolean {
    if (message === null || typeof message !== "object") return false
    const info = (message as { info?: unknown }).info
    return (
        info !== null &&
        typeof info === "object" &&
        (info as { __acpNonRemovable?: unknown }).__acpNonRemovable === true
    )
}

/** Identifies a transient V2 algorithm projection without consulting token usage. */
export function isV2ProjectedMessage(message: unknown): boolean {
    if (message === null || typeof message !== "object") return false
    const info = (message as { info?: unknown }).info
    return (
        info !== null &&
        typeof info === "object" &&
        (info as { __acpV2?: unknown }).__acpV2 === true
    )
}

/** Native-prefix bytes are outside the public suffix returned to direct tools. */
export function hasV2NativePrefix(messages: readonly { info: unknown }[]): boolean {
    return messages.some((message) => {
        if (!isV2ProjectedMessage(message)) return false
        const timestamp = (message.info as { __acpV2CompactionTimestamp?: unknown })
            .__acpV2CompactionTimestamp
        return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    })
}
