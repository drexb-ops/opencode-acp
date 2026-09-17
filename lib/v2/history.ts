import type { Message as AiMessageValue } from "@opencode/ai"
import type { V2ProjectionModel } from "./projection"

export type V2HistoryCompatibilityStatus = "supported" | "degraded" | "unsupported"

export type V2HistoryCompatibilityCode =
    | "provider-checkpoint-provenance-unavailable"
    | "provider-checkpoint-provenance-invalid"
    | "provider-checkpoint-provenance-mismatch"
    | "provider-checkpoint-no-correlated-suffix"

export const V2_COMPACTION_TIMESTAMP_FIELD = "__acpV2CompactionTimestamp"

export interface V2ScopedProjectedHistory {
    /**
     * Original public source objects after the last native checkpoint. The
     * checkpoint itself is deliberately excluded so normalization cannot claim
     * an unknown prefix range.
     */
    readonly projected: readonly unknown[]
    readonly checkpointIds: readonly string[]
    /** Transient epoch marker copied onto the first normalized message. */
    readonly nativeCompactionTimestamp?: number
}

/**
 * Compact proof recorded only after a scoped V2 context patch has committed.
 * It contains identities, never provider checkpoint payloads or request text.
 */
export interface V2AcceptedNativeSuffixContext {
    readonly sessionID: string
    readonly checkpointIds: readonly string[]
    readonly nativeCompactionTimestamp?: number
    readonly model: V2ProjectionModel
    readonly sourceIds: readonly string[]
}

export interface V2HistoryCompatibility extends V2ScopedProjectedHistory {
    /** `supported` only means no native checkpoint was observed in public history. */
    readonly status: V2HistoryCompatibilityStatus
    /** Callers must return the original request without applying an ACP patch. */
    readonly preserveOriginalRequest: boolean
    readonly code?: V2HistoryCompatibilityCode
    readonly diagnostic?: string
    /**
     * Exact public-source/outgoing ID matches after the last native checkpoint.
     * This is evidence for a future scoped strategy, not authorization to mutate
     * the current whole-request transform.
     */
    readonly independentlyCorrelatedSourceIds: readonly string[]
    /** Outgoing IDs which cannot be directly correlated to public source IDs. */
    readonly uncorrelatedOutgoingIds: readonly string[]
    /** Scoped source IDs without a direct lowered outgoing ID. */
    readonly uncorrelatedScopedSourceIds: readonly string[]
}

interface NativeCheckpoint {
    readonly index: number
    readonly id: string
    readonly providerID?: string
    readonly modelID?: string
    readonly timestamp?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function stringField(
    recordValue: Record<string, unknown> | undefined,
    field: string,
): string | undefined {
    const value = recordValue?.[field]
    return typeof value === "string" ? value : undefined
}

function nativeCheckpoint(value: unknown, index: number): NativeCheckpoint | undefined {
    const source = record(value)
    if (
        source?.type !== "compaction" ||
        source.status !== "completed" ||
        !record(source.providerContext)
    ) {
        return undefined
    }
    const providerContext = record(source.providerContext)
    const provenance = record(providerContext?.provenance)
    const time = record(source.time)
    const created = time?.created
    return {
        index,
        id: stringField(source, "id") ?? `source-${index}`,
        providerID: stringField(provenance, "providerID"),
        modelID: stringField(provenance, "modelID"),
        timestamp:
            typeof created === "number" && Number.isFinite(created) && created > 0
                ? created
                : undefined,
    }
}

function sourceIds(projected: readonly unknown[]): Set<string> {
    const ids = new Set<string>()
    for (let index = 0; index < projected.length; index++) {
        const id = stringField(record(projected[index]), "id")
        if (id) ids.add(id)
    }
    return ids
}

function outgoingIds(messages: readonly AiMessageValue[]): readonly string[] {
    const ids = new Set<string>()
    for (const message of messages) {
        const id = stringField(record(message), "id")
        if (id) ids.add(id)
    }
    return [...ids]
}

function checkpoints(projected: readonly unknown[]): NativeCheckpoint[] {
    return projected
        .map(nativeCheckpoint)
        .filter((checkpoint): checkpoint is NativeCheckpoint => checkpoint !== undefined)
}

/**
 * Restrict a public latest-history view to sources after its final native
 * checkpoint. The original source objects and IDs are retained unchanged.
 */
export function scopeV2ProjectedHistory(projected: readonly unknown[]): V2ScopedProjectedHistory {
    const nativeCheckpoints = checkpoints(projected)
    const latest = nativeCheckpoints[nativeCheckpoints.length - 1]
    return {
        projected: latest ? projected.slice(latest.index + 1) : projected,
        checkpointIds: nativeCheckpoints.map((checkpoint) => checkpoint.id),
        nativeCompactionTimestamp: latest?.timestamp,
    }
}

function report(
    status: V2HistoryCompatibilityStatus,
    preserveOriginalRequest: boolean,
    scope: V2ScopedProjectedHistory,
    correlated: readonly string[],
    uncorrelated: readonly string[],
    uncorrelatedSources: readonly string[],
    code?: V2HistoryCompatibilityCode,
    diagnostic?: string,
): V2HistoryCompatibility {
    return {
        status,
        preserveOriginalRequest,
        code,
        diagnostic,
        ...scope,
        independentlyCorrelatedSourceIds: correlated,
        uncorrelatedOutgoingIds: uncorrelated,
        uncorrelatedScopedSourceIds: uncorrelatedSources,
    }
}

/**
 * Public `session.context()` always uses the model-neutral `latest` boundary.
 * The runner instead selects native checkpoint windows with full route
 * provenance. Plugin hooks receive only Model.Ref, so they cannot prove the
 * two histories describe the same outgoing request. A directly correlated
 * suffix remains safe because it is normalized without the checkpoint, leaving
 * every uncorrelated outgoing object provider-owned and opaque.
 */
export function assessV2HistoryCompatibility(
    projected: readonly unknown[],
    currentModel: V2ProjectionModel,
    outgoing: readonly AiMessageValue[],
): V2HistoryCompatibility {
    const nativeCheckpoints = checkpoints(projected)
    const scope = scopeV2ProjectedHistory(projected)
    if (nativeCheckpoints.length === 0) {
        return report("supported", false, scope, [], [], [])
    }

    const latest = nativeCheckpoints[nativeCheckpoints.length - 1]
    const scopedSourceIds = sourceIds(scope.projected)
    const outgoingMessageIds = outgoingIds(outgoing)
    const outgoingIdSet = new Set(outgoingMessageIds)
    const correlated = outgoingMessageIds.filter((id) => scopedSourceIds.has(id))
    const uncorrelated = outgoingMessageIds.filter((id) => !scopedSourceIds.has(id))
    const uncorrelatedSources = [...scopedSourceIds].filter((id) => !outgoingIdSet.has(id))

    let routeCode: V2HistoryCompatibilityCode
    let routeDiagnostic: string

    if (!latest.providerID || !latest.modelID) {
        routeCode = "provider-checkpoint-provenance-invalid"
        routeDiagnostic = `Native checkpoint ${latest.id} has no usable public provider/model provenance.`
    } else if (
        latest.providerID !== currentModel.providerID ||
        latest.modelID !== currentModel.id
    ) {
        routeCode = "provider-checkpoint-provenance-mismatch"
        routeDiagnostic = `Native checkpoint ${latest.id} belongs to ${latest.providerID}/${latest.modelID}, while the request uses ${currentModel.providerID}/${currentModel.id}.`
    } else {
        routeCode = "provider-checkpoint-provenance-unavailable"
        routeDiagnostic = `Native checkpoint ${latest.id} needs full route provenance, but the public plugin hook exposes only ${currentModel.providerID}/${currentModel.id}.`
    }

    if (correlated.length === 0) {
        return report(
            "unsupported",
            true,
            scope,
            correlated,
            uncorrelated,
            uncorrelatedSources,
            "provider-checkpoint-no-correlated-suffix",
            `ACP preserved the V2 request because ${routeDiagnostic} No post-checkpoint public source has an exact lowered outgoing ID. OpenCode must expose model-aware session history before ACP can transform this request safely.`,
        )
    }

    return report(
        "degraded",
        false,
        scope,
        correlated,
        uncorrelated,
        uncorrelatedSources,
        routeCode,
        `ACP is using only directly correlated post-checkpoint sources. ${routeDiagnostic} Uncorrelated outgoing messages remain provider-owned and opaque.`,
    )
}

/**
 * Record the native checkpoint epoch on the first normalized message without
 * changing persisted source data. State initialization recognizes this marker
 * to reconcile refs and nudges to the same boundary as direct tools.
 */
export function attachV2CompactionTimestamp<T extends { info: unknown }>(
    messages: T[],
    timestamp: number | undefined,
): T[] {
    if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return messages
    const first = messages[0]
    const info = first ? record(first.info) : undefined
    if (info) info[V2_COMPACTION_TIMESTAMP_FIELD] = timestamp
    return messages
}

/**
 * Native suffixes read by direct tools have no outgoing request to prove their
 * lowering. Keep them searchable, but mark every unverified source
 * non-removable until a committed context patch authorizes its exact ID.
 */
export function protectUnverifiedV2NativeSuffix<T extends { info: unknown }>(
    messages: T[],
    checkpointIds: readonly string[],
    authorizedSourceIds: ReadonlySet<string>,
): T[] {
    if (checkpointIds.length === 0) return messages
    for (const message of messages) {
        const info = record(message.info)
        const id = stringField(info, "id")
        if (!info || !id || !authorizedSourceIds.has(id)) {
            if (info) info.__acpNonRemovable = true
        }
    }
    return messages
}
