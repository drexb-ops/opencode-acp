import type { Message as AiMessageValue, SystemPart } from "@opencode/ai"
import { SystemPart as SystemPartSchema } from "@opencode/ai"
import type { PluginConfig } from "../config"
import { compressPermission } from "../compress-permission"
import { buildProtectedToolsExtension } from "../prompts/extensions/system"
import { renderSystemPrompt, type PromptStore } from "../prompts"
import {
    commitPreparedMessageTransformTransaction,
    prepareMessageTransformTransaction,
} from "../hooks"
import type { HostPermissionRule, HostPermissionSnapshot } from "../host-permissions"
import type { SessionState, SessionStateRegistry } from "../state"
import type { Logger } from "../logger"
import type { V2HostAdapter } from "./host"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    type V2ProjectionModel,
} from "./projection"
import { isAcpOwnedNoticeId } from "./projection/shared"

export interface V2ContextEvent {
    readonly sessionID: string
    readonly agent: string
    readonly model: V2ProjectionModel
    system: SystemPart[]
    messages: AiMessageValue[]
}

function modelLimitFromInventory(
    inventory: readonly { providerId: string; modelId: string; contextLimit?: number }[],
    model: V2ProjectionModel,
): number | undefined {
    const limit = inventory.find(
        (entry) => entry.providerId === model.providerID && entry.modelId === model.id,
    )?.contextLimit
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
}

const AUXILIARY_AGENT_NAMES = new Set(["title", "summary", "compaction"])

async function refreshV2AgentPermissions(
    host: V2HostAdapter,
    hostPermissions: HostPermissionSnapshot,
    agent: string,
    logger: Logger,
): Promise<void> {
    if (!host.agentPermissions) return

    let rules: readonly HostPermissionRule[]
    try {
        rules = await host.agentPermissions(agent)
    } catch (error) {
        logger.warn("V2 agent permission lookup failed closed", {
            agent,
            error: error instanceof Error ? error.message : String(error),
        })
        rules = [{ action: "*", resource: "*", effect: "deny" }]
    }
    hostPermissions.v2Agents = {
        ...(hostPermissions.v2Agents ?? {}),
        [agent]: rules,
    }
}

/**
 * Build the primary V2 context hook. The callback deliberately owns one
 * registry guard for the complete operation; system rendering happens inside
 * that operation and never calls the V1 system hook or acquires a second lock.
 */
export function createV2ContextHandler(
    host: V2HostAdapter,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    isActive: () => boolean = () => true,
): (event: V2ContextEvent) => Promise<void> {
    return async (event) => {
        try {
            if (!Array.isArray(event.messages) || !Array.isArray(event.system)) return
            if (AUXILIARY_AGENT_NAMES.has(event.agent)) return
            if (!isActive()) return
            await refreshV2AgentPermissions(host, hostPermissions, event.agent, logger)

            let requestModelLimit: number | undefined
            let modelLimitKnown = false
            let inventory: readonly {
                providerId: string
                modelId: string
                contextLimit?: number
            }[] = []
            try {
                inventory = await host.models.list()
                await registry.hydrateModelLimits({ list: async () => inventory })
            } catch (error) {
                logger.warn("V2 model catalog lookup failed", {
                    sessionId: event.sessionID,
                    model: `${event.model.providerID}/${event.model.id}`,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
            // Resolve after hydration so a transient catalog omission/failure
            // cannot discard a valid cached limit. A direct inventory fallback
            // is retained for lightweight registries used by tests.
            requestModelLimit = registry.resolveModelLimit(event.model.providerID, event.model.id)
            if (requestModelLimit === undefined) {
                requestModelLimit = modelLimitFromInventory(inventory, event.model)
                if (requestModelLimit !== undefined) {
                    registry.recordModelLimit(
                        event.model.providerID,
                        event.model.id,
                        requestModelLimit,
                    )
                }
            }
            modelLimitKnown = requestModelLimit !== undefined

            const loadProjection = async () => {
                // The registry reservation is installed before this callback is
                // invoked. Reading projected history outside that reservation
                // would allow an older snapshot to commit after a newer request.
                const projected = await host.projectedContext(event.sessionID)
                const projection = normalizeV2ProjectedHistory(projected, event.messages, {
                    sessionID: event.sessionID,
                    agent: event.agent,
                    directory: host.directory,
                    currentModel: event.model,
                })
                if (!projection.valid) {
                    logger.warn("V2 context projection rejected", {
                        sessionId: event.sessionID,
                        reason: projection.rejection?.message,
                    })
                }
                return projection
            }

            const run = async (
                state: SessionState,
                projection: Awaited<ReturnType<typeof loadProjection>>,
            ) => {
                if (!projection.valid || !isActive()) return
                const prepared = await prepareMessageTransformTransaction(
                    projection.messages,
                    state,
                    config,
                    logger,
                    prompts,
                    hostPermissions,
                    requestModelLimit,
                    modelLimitKnown,
                    (text) =>
                        host.notifications.notify({
                            title: "ACP: Nudge Injected",
                            message: text,
                            variant: "info",
                            duration: 5000,
                        }),
                    true,
                )
                // A non-resuming command notice remains in projected session
                // history for the user, but must be removed from every later
                // provider request. The patcher then removes only this
                // ACP-owned source message from the original V2 messages.
                prepared.workingMessages = prepared.workingMessages.filter(
                    (message) =>
                        !isAcpOwnedNoticeId(
                            typeof message.info.id === "string" ? message.info.id : undefined,
                        ),
                )
                const patch = applyV2ContextPatch(
                    projection,
                    prepared.workingMessages,
                    event.messages,
                )
                if (!patch.accepted) {
                    logger.warn("V2 context patch rejected; preserving provider request", {
                        sessionId: event.sessionID,
                        reason: patch.rejection.message,
                    })
                    return
                }

                if (!isActive()) return

                let systemPrompt: string | undefined
                if (
                    !(prepared.workingState.isSubAgent && !config.allowSubAgents) &&
                    compressPermission(prepared.workingState, config) !== "deny"
                ) {
                    systemPrompt = renderSystemPrompt(
                        prompts.getRuntimePrompts(),
                        buildProtectedToolsExtension(config.compress.protectedTools),
                        prepared.workingState.isSubAgent && config.allowSubAgents,
                    )
                }

                // No event/state/effect mutation occurs until the projection,
                // patch, final schemas, and system text have all succeeded.
                if (!isActive()) return
                event.messages = patch.messages
                if (systemPrompt) event.system.push(SystemPartSchema.make(systemPrompt))
                await commitPreparedMessageTransformTransaction(
                    prepared,
                    state,
                    logger,
                    undefined,
                    isActive,
                )
            }

            // Reserve before projected history is fetched/normalized, then keep
            // initialization, transformation, patch validation, and commit in
            // that one reservation.
            if (registry.withSessionMutationAndInitialize) {
                await registry.withSessionMutationAndInitialize(
                    host.sessions,
                    event.sessionID,
                    loadProjection,
                    (projection) =>
                        isActive() && projection.valid ? projection.messages : undefined,
                    config,
                    run,
                )
            } else {
                // Compatibility for lightweight registry doubles from older
                // V2 fixtures. Real registries always use the atomic path.
                const projection = await loadProjection()
                if (!projection.valid) return
                await registry.getOrCreate(
                    host.sessions,
                    event.sessionID,
                    projection.messages,
                    config,
                )
                const state = registry.get(event.sessionID)
                if (state) await run(state, projection)
            }
        } catch (error) {
            logger.warn("V2 context hook failed closed", {
                sessionId: event.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}
