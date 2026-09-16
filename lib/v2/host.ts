import { randomBytes } from "node:crypto"
import type { Plugin as V2Api } from "@opencode/plugin"
import type { HostServices, ModelInventoryEntry, NotificationSink, SessionService } from "../host"
import type { HostPermissionRule } from "../host-permissions"
import { normalizeV2ProjectedHistory, type V2ProjectionOptions } from "./projection"

export type V2Context = Parameters<V2Api.Plugin["setup"]>[0]

export interface V2HostAdapter extends HostServices {
    /** Read the public projected history without lowering it a second time. */
    projectedContext(sessionID: string): Promise<readonly unknown[]>
    /** Resolve the active agent ID for a session without exposing the client. */
    sessionAgent?(sessionID: string): Promise<string | undefined>
    /** Resolve one agent's effective, ordered V2 permission rules. */
    agentPermissions?(agentID: string): Promise<readonly HostPermissionRule[]>
    readonly directory: string
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function createSessionService(
    context: V2Context,
    projectionOptions: V2ProjectionOptions,
): SessionService {
    const projectedContext = async (sessionID: string): Promise<readonly unknown[]> => {
        return (await context.session.context({ sessionID })) as readonly unknown[]
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
            const projected = await projectedContext(sessionID)
            return normalizeV2ProjectedHistory(projected, [], {
                ...projectionOptions,
                sessionID,
            }).messages
        },
        async parentMessages(sessionID) {
            const projected = await projectedContext(sessionID)
            return normalizeV2ProjectedHistory(projected, [], {
                ...projectionOptions,
                sessionID,
            }).messages
        },
    }
}

function createModelInventory(context: V2Context): {
    list: () => Promise<readonly ModelInventoryEntry[]>
} {
    return {
        async list() {
            const response: unknown = await context.catalog.model.list()
            const result = record(response)
            const data: Record<string, unknown>[] = Array.isArray(result?.data)
                ? result.data.filter(
                      (value): value is Record<string, unknown> => record(value) !== undefined,
                  )
                : []
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
    const sessions = createSessionService(context, projectionOptions)
    return {
        sessions,
        models: createModelInventory(context),
        projectedContext: async (sessionID) =>
            (await context.session.context({ sessionID })) as readonly unknown[],
        directory: context.location.directory,
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
