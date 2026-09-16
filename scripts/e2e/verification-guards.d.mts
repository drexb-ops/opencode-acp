export interface PermissionProjectionComparison {
    schema: string
    toolOwned: ProjectionFieldComparison
    hostContext: ProjectionFieldComparison
    unknownFields: ProjectionFieldComparison
}

export interface ProjectionFieldComparison {
    equal: boolean
    changedFields: string[]
    fieldDigests: Array<{ field: string; before: string; after: string }>
}

export interface OwnedDirectoryIdentity {
    requestedPath: string
    realPath: string
    basename: string
    device: number
    inode: number
}

export const EXACT_V2_DIRECTORY_DIAGNOSTIC: string
export const ACP_TOOL_OWNED_FIELDS: readonly string[]
export const ACP_HOST_CONTEXT_FIELDS: readonly string[]
export const ACP_PROJECTION_FIELD_PATHS: readonly string[]

export function redactedText(value: unknown): { hash: string; length: number }
export function safeDiagnosticId(value: unknown): string | null
export function stableSerialize(value: unknown): string
export function projectAcpState(state: unknown): Record<string, any>
export function comparePermissionProjections(
    beforeState: unknown,
    afterState: unknown,
): PermissionProjectionComparison
export function isProtectedNoTargetEvidence(
    checkpoint: unknown,
    options?: { preservedRecentMessages?: number; expectedBaseline?: number },
): boolean
export function assertNudgeCheckpointSequence(
    checkpoints: unknown[],
    options: {
        expectedCompressEmissions?: number
        expectedBaselines: { initial: number; first: number; second: number }
    },
): { initialBaseline: number; firstBaseline: number; secondBaseline: number }

export function classifyV2FallbackAttempt(input: {
    status: number
    inventoryActive: boolean
    freshLines: string[]
}): {
    accepted: boolean
    statusMatches: boolean
    inventoryInactive: boolean
    exactDiagnosticMatched: boolean
    freshLineCount: number
    exactLineCount: number
    unexpectedDiagnostics: string[]
}

export function buildMinimalProbeEnv(options?: {
    home?: string
    tmpdir?: string
    pathValue?: string
    userconfig?: string
    globalconfig?: string
    cache?: string
    npm?: boolean
}): Record<string, string>
export function assertMinimalProbeEnv(env: Record<string, string>, npm?: boolean): true
export function captureOwnedDirectory(
    candidate: string,
    options?: { label?: string; parent?: string; prefix?: string },
): OwnedDirectoryIdentity
export function validateOwnedDirectory(
    identity: OwnedDirectoryIdentity,
    options?: { parent?: string; prefix?: string },
): OwnedDirectoryIdentity
export function removeOwnedDirectory(
    identity: OwnedDirectoryIdentity,
    options?: { parent?: string; prefix?: string },
): true
