import type { Plugin as V2Api } from "@opencode/plugin"
import type { HostServices, ModelInventoryEntry, SessionService } from "../host"
import { normalizeV2ProjectedHistory, type V2ProjectionOptions } from "./projection"

export type V2Context = Parameters<V2Api.Plugin["setup"]>[0]

export interface V2HostAdapter extends HostServices {
    /** Read the public projected history without lowering it a second time. */
    projectedContext(sessionID: string): Promise<readonly unknown[]>
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

/**
 * Adapt only the public V2 session/catalog domains needed by the shared ACP
 * state and transform engine. No V1 client, private server API, or auth data is
 * reachable through this adapter.
 */
export function createV2Host(
    context: V2Context,
    projectionOptions: V2ProjectionOptions = {},
): V2HostAdapter {
    const sessions = createSessionService(context, projectionOptions)
    return {
        sessions,
        models: createModelInventory(context),
        projectedContext: async (sessionID) =>
            (await context.session.context({ sessionID })) as readonly unknown[],
        directory: context.location.directory,
        notices: {
            // V2 notices are intentionally a non-throwing placeholder until the
            // later RPC/TUI phase. Context transforms must never depend on it.
            send: async () => {},
        },
        notifications: {
            // Likewise, server-only V2 setup has no notification transport yet.
            notify: () => {},
        },
    }
}
