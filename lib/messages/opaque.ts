/** True for algorithm-only V2 parts that must never rewrite host-owned data. */
export function isAcpOpaquePart(part: unknown): boolean {
    return (
        part !== null &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as { __acpOpaque?: unknown }).__acpOpaque === true
    )
}
