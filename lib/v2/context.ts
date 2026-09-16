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
import type { HostPermissionSnapshot } from "../host-permissions"
import type { SessionState, SessionStateRegistry } from "../state"
import type { Logger } from "../logger"
import type { V2HostAdapter } from "./host"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    type V2ProjectionModel,
} from "./projection"

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
): (event: V2ContextEvent) => Promise<void> {
    return async (event) => {
        try {
            if (!Array.isArray(event.messages) || !Array.isArray(event.system)) return
            if (AUXILIARY_AGENT_NAMES.has(event.agent)) return
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
                return
            }

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

            await registry.getOrCreate(host.sessions, event.sessionID, projection.messages, config)

            const run = async (state: SessionState) => {
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
                event.messages = patch.messages
                if (systemPrompt) event.system.push(SystemPartSchema.make(systemPrompt))
                await commitPreparedMessageTransformTransaction(prepared, state, logger)
            }

            // `withSessionMutation` is present in the Phase 3 registry. Keep the
            // fallback for lightweight test registries used by V1-era fixtures.
            if (registry.withSessionMutation) {
                await registry.withSessionMutation(event.sessionID, run)
            } else {
                const state = registry.get(event.sessionID)
                if (state) await run(state)
            }
        } catch (error) {
            logger.warn("V2 context hook failed closed", {
                sessionId: event.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}
