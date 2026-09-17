import { randomBytes } from "node:crypto"
import type { Plugin as V2Api } from "@opencode/plugin"
import type { HostServices, ModelInventoryEntry, NotificationSink, SessionService } from "../host"
import type { HostPermissionRule } from "../host-permissions"
import {
    attachV2CompactionTimestamp,
    protectUnverifiedV2NativeSuffix,
    scopeV2ProjectedHistory,
    type V2AcceptedNativeSuffixContext,
    type V2ScopedProjectedHistory,
} from "./history"
import {
    normalizeV2ProjectedHistory,
    type V2ProjectionModel,
    type V2ProjectionOptions,
} from "./projection"
import { detectV2CatalogCapabilities, v2CatalogListEntries } from "./capabilities"

export type V2Context = Parameters<V2Api.Plugin["setup"]>[0]

export interface V2HostAdapter extends HostServices {
    /** Read the public projected history without lowering it a second time. */
    projectedContext(sessionID: string): Promise<readonly unknown[]>
    /** Resolve the active agent ID for a session without exposing the client. */
    sessionAgent?(sessionID: string): Promise<string | undefined>
    /** Resolve one agent's effective, ordered V2 permission rules. */
    agentPermissions?(agentID: string): Promise<readonly HostPermissionRule[]>
    /**
     * Record compact evidence after an accepted V2 context patch. Direct tools
     * use it to distinguish a verified native suffix from cold history.
     */
    recordAcceptedNativeSuffix?(evidence: V2AcceptedNativeSuffixContext): void
    readonly directory: string
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function projectionModel(value: unknown): V2ProjectionModel | undefined {
    const model = record(value)
    const id = typeof model?.id === "string" ? model.id : undefined
    const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
    const variant = typeof model?.variant === "string" ? model.variant : undefined
    if (!id || !providerID) return undefined
    return variant ? { id, providerID, variant } : { id, providerID }
}

function sameModel(left: V2ProjectionModel, right: V2ProjectionModel): boolean {
    return (
        left.id === right.id &&
        left.providerID === right.providerID &&
        left.variant === right.variant
    )
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index])
}

interface NativeSuffixAuthorization {
    readonly checkpointIds: readonly string[]
    readonly nativeCompactionTimestamp: number
    readonly model: V2ProjectionModel
    readonly sourceIds: ReadonlySet<string>
}

const MAX_NATIVE_SUFFIX_AUTHORIZATIONS = 64
const MAX_NATIVE_SUFFIX_SOURCE_IDS = 512
const MAX_NATIVE_SUFFIX_CHECKPOINT_IDS = 16

function createNativeSuffixAuthorizations() {
    const bySession = new Map<string, NativeSuffixAuthorization>()
    const empty = new Set<string>()

    const discardOldest = () => {
        while (bySession.size >= MAX_NATIVE_SUFFIX_AUTHORIZATIONS) {
            const oldest = bySession.keys().next()
            if (oldest.done) return
            bySession.delete(oldest.value)
        }
    }

    const recordAccepted = (evidence: V2AcceptedNativeSuffixContext): void => {
        const checkpointIds = [
            ...new Set(
                evidence.checkpointIds.filter(
                    (id): id is string => typeof id === "string" && id.length > 0,
                ),
            ),
        ]
        const sourceIds = [
            ...new Set(
                evidence.sourceIds.filter(
                    (id): id is string => typeof id === "string" && id.length > 0,
                ),
            ),
        ]
        const timestamp = evidence.nativeCompactionTimestamp
        const model = projectionModel(evidence.model)
        if (
            !evidence.sessionID ||
            checkpointIds.length === 0 ||
            checkpointIds.length > MAX_NATIVE_SUFFIX_CHECKPOINT_IDS ||
            sourceIds.length === 0 ||
            sourceIds.length > MAX_NATIVE_SUFFIX_SOURCE_IDS ||
            timestamp === undefined ||
            !Number.isFinite(timestamp) ||
            timestamp <= 0 ||
            !model
        ) {
            bySession.delete(evidence.sessionID)
            return
        }

        if (!bySession.has(evidence.sessionID)) discardOldest()
        bySession.set(evidence.sessionID, {
            checkpointIds,
            nativeCompactionTimestamp: timestamp,
            model,
            sourceIds: new Set(sourceIds),
        })
    }

    const authorizedSourceIds = (
        sessionID: string,
        scope: V2ScopedProjectedHistory,
        model: V2ProjectionModel | undefined,
    ): ReadonlySet<string> => {
        if (scope.checkpointIds.length === 0) {
            bySession.delete(sessionID)
            return empty
        }
        const authorization = bySession.get(sessionID)
        if (
            !authorization ||
            !model ||
            scope.nativeCompactionTimestamp === undefined ||
            authorization.nativeCompactionTimestamp !== scope.nativeCompactionTimestamp ||
            !sameIds(authorization.checkpointIds, scope.checkpointIds) ||
            !sameModel(authorization.model, model)
        ) {
            bySession.delete(sessionID)
            return empty
        }
        return authorization.sourceIds
    }

    return { recordAccepted, authorizedSourceIds }
}

function createSessionService(
    context: V2Context,
    projectionOptions: V2ProjectionOptions,
    authorizations: ReturnType<typeof createNativeSuffixAuthorizations>,
): SessionService {
    const projectedContext = async (sessionID: string): Promise<readonly unknown[]> => {
        return (await context.session.context({ sessionID })) as readonly unknown[]
    }

    const sessionModel = async (sessionID: string): Promise<V2ProjectionModel | undefined> => {
        try {
            const response: unknown = await context.session.get({ sessionID })
            const responseRecord = record(response)
            const session = record(responseRecord?.data) ?? responseRecord
            return projectionModel(session?.model) ?? projectionOptions.currentModel
        } catch {
            return projectionOptions.currentModel
        }
    }

    const normalizedPublicHistory = async (sessionID: string) => {
        const scope = scopeV2ProjectedHistory(await projectedContext(sessionID))
        const authorizedSourceIds =
            scope.checkpointIds.length > 0
                ? authorizations.authorizedSourceIds(
                      sessionID,
                      scope,
                      await sessionModel(sessionID),
                  )
                : new Set<string>()
        const messages = normalizeV2ProjectedHistory(scope.projected, [], {
            ...projectionOptions,
            sessionID,
        }).messages
        return protectUnverifiedV2NativeSuffix(
            attachV2CompactionTimestamp(messages, scope.nativeCompactionTimestamp),
            scope.checkpointIds,
            authorizedSourceIds,
        )
    }

    return {
        async get(sessionID) {
            const response: unknown = await context.session.get({ sessionID })
            const responseRecord = record(response)
            const session = record(responseRecord?.data) ?? responseRecord
            return {
                id: typeof session?.id === "string" ? session.id : sessionID,
                parentID: typeof session?.parentID === "string" ? session.parentID : undefined,
            }
        },
        async messages(sessionID) {
            return normalizedPublicHistory(sessionID)
        },
        async parentMessages(sessionID) {
            return normalizedPublicHistory(sessionID)
        },
    }
}

function createModelInventory(context: V2Context): {
    list: () => Promise<readonly ModelInventoryEntry[]>
} {
    return {
        async list() {
            const capabilities = detectV2CatalogCapabilities(context)
            const response = await capabilities.listModels()
            const data: Record<string, unknown>[] = v2CatalogListEntries(response, "model").filter(
                (value): value is Record<string, unknown> => record(value) !== undefined,
            )
            const entries: ModelInventoryEntry[] = []
            for (const model of data) {
                const providerId =
                    typeof model.providerID === "string" ? model.providerID : undefined
                const modelId = typeof model.id === "string" ? model.id : undefined
                if (!providerId || !modelId) continue
                const contextLimit = record(model.limit)?.context
                entries.push({
                    providerId,
                    // Model.Ref and catalog entries use the public `id` field for
                    // request matching. `modelID` is retained by OpenCode for
                    // provider metadata and is not the event.model key.
                    modelId,
                    contextLimit: typeof contextLimit === "number" ? contextLimit : undefined,
                })
            }
            return entries
        },
    }
}

function createAgentPermissions(context: V2Context) {
    return async (agentID: string): Promise<readonly HostPermissionRule[]> => {
        const response: unknown = await context.agent.get({ agentID })
        const responseRecord = record(response)
        const data = record(responseRecord?.data)
        const permissions = data?.permissions
        if (!Array.isArray(permissions)) {
            throw new Error(`V2 agent ${agentID} returned no permission rules`)
        }

        return permissions.map((value): HostPermissionRule => {
            const rule = record(value)
            if (
                typeof rule?.action !== "string" ||
                typeof rule.resource !== "string" ||
                (rule.effect !== "allow" && rule.effect !== "ask" && rule.effect !== "deny")
            ) {
                throw new Error(`V2 agent ${agentID} returned an invalid permission rule`)
            }
            return { action: rule.action, resource: rule.resource, effect: rule.effect }
        })
    }
}

function createSessionAgent(context: V2Context) {
    return async (sessionID: string): Promise<string | undefined> => {
        const response: unknown = await context.session.get({ sessionID })
        const responseRecord = record(response)
        const session = record(responseRecord?.data) ?? responseRecord
        return typeof session?.agent === "string" ? session.agent : undefined
    }
}

function createNoticeSink(context: V2Context) {
    return {
        async send(input: Parameters<HostServices["notices"]["send"]>[0]) {
            const id = `msg_acp_notice_${randomBytes(8).toString("hex")}`
            const metadata: Record<string, string | boolean> = { acpOwned: true }
            const sourceMetadata = input.metadata
            if (typeof sourceMetadata?.providerId === "string")
                metadata.providerId = sourceMetadata.providerId
            if (typeof sourceMetadata?.modelId === "string")
                metadata.modelId = sourceMetadata.modelId
            if (typeof sourceMetadata?.agent === "string") metadata.agent = sourceMetadata.agent
            if (typeof sourceMetadata?.variant === "string")
                metadata.variant = sourceMetadata.variant

            await context.session.synthetic({
                sessionID: input.sessionID,
                id,
                text: input.text,
                metadata,
                resume: false,
            })
        },
    }
}

/**
 * Adapt only the public V2 session/catalog domains needed by the shared ACP
 * state and transform engine. No V1 client, private server API, or auth data is
 * reachable through this adapter.
 */
export function createV2Host(
    context: V2Context,
    projectionOptions: V2ProjectionOptions = {},
    notifications?: NotificationSink,
): V2HostAdapter {
    const authorizations = createNativeSuffixAuthorizations()
    const sessions = createSessionService(context, projectionOptions, authorizations)
    return {
        sessions,
        models: createModelInventory(context),
        projectedContext: async (sessionID) =>
            (await context.session.context({ sessionID })) as readonly unknown[],
        directory: context.location.directory,
        recordAcceptedNativeSuffix: authorizations.recordAccepted,
        sessionAgent: createSessionAgent(context),
        agentPermissions: createAgentPermissions(context),
        notices: createNoticeSink(context),
        notifications: notifications ?? {
            // Keep lightweight host fixtures and standalone callers usable when
            // they do not install the server RPC bridge.
            notify: () => {},
        },
    }
}
