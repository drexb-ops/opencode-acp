/** ACP version, injected at build time by tsup define */
declare const ACP_VERSION: string | undefined
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "../config"
import {
    createAcpContextRecapToolDefinition,
    createAcpStatusToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    createSearchContextToolDefinition,
} from "../compress"
import type { ToolFactoryContext } from "../compress"
import { createV1Tool } from "./tools"
import { createV1Host } from "./host"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
} from "../host-permissions"
import { Logger } from "../logger"
import { SessionStateRegistry } from "../state"
import { PromptStore } from "../prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../hooks"
import { configureClientAuth, isSecureMode } from "../auth"
import { findBiliProxyProviders } from "../bili-proxy"
import { startAutoUpdate } from "../update"
import { createManagedNotificationSink } from "../notifications"

const server: Plugin = (async (ctx) => {
    const host = createV1Host(ctx)
    const notifications = createManagedNotificationSink(host.notifications)
    const runtimeHost = { ...host, notifications }
    const config = getConfig({ directory: ctx.directory, notifications })

    if (!config.enabled) {
        notifications.dispose()
        return {}
    }

    if (process.env.BILLION_CONTEXT_PROXY) {
        console.log(
            "[opencode-acp] disabled: BILLION_CONTEXT_PROXY detected — proxy handles compression",
        )
        notifications.dispose()
        return {}
    }

    const logger = new Logger(config.debug, config.debug ? "debug" : config.logLevel)
    logger.info("ACP plugin initialized", {
        version: typeof ACP_VERSION !== "undefined" ? ACP_VERSION : "dev",
        workspace: ctx.directory,
        logLevel: logger.level,
        debug: config.debug,
        autoUpdate: config.autoUpdate,
        secureMode: isSecureMode(),
    })
    const registry = new SessionStateRegistry(logger, ctx.directory)
    const prompts = new PromptStore(
        logger,
        ctx.directory,
        config.experimental.customPrompts,
        config.compress.candidates === true,
    )
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    // [FIX #312] Seed the model-limit catalog so the FIRST request after a
    // model switch resolves the new model's context window (the per-request
    // system.transform refresh only fills entries for models already used in
    // this instance). Fire-and-forget — never blocks init; outcome is logged
    // so a silent degrade (empty catalog / failed fetch) is debuggable. On
    // failure the fallback is per-request refresh, the pre-fix behavior.
    registry.hydrateModelLimits(host.models).then(
        (recorded) => {
            if (recorded > 0) {
                logger.info("Model limit catalog seeded from provider config", {
                    models: recorded,
                })
            } else {
                logger.warn(
                    "Model limit catalog seeding recorded no entries — " +
                        "falling back to per-request refresh (system.transform)",
                )
            }
        },
        (error) => {
            logger.warn(
                "Model limit catalog seeding failed — " +
                    "falling back to per-request refresh (system.transform)",
                { error: error instanceof Error ? error.message : String(error) },
            )
        },
    )

    logger.info("DCP initialized")

    const updateCleanup = startAutoUpdate(notifications, config.autoUpdate, logger)

    const compressToolContext: ToolFactoryContext = {
        host: runtimeHost,
        registry,
        logger,
        config,
        prompts,
    }

    // [FIX #337] Manual proxy mode: the bili proxy may be detected in a
    // provider baseURL by the config hook (the BILLION_CONTEXT_PROXY env var
    // is only set by the `bili <client>` launcher, not by manual proxy mode).
    // When detected, every ACP hook becomes a no-op so the proxy handles
    // compression alone. Assigned (not latched) so a config reload that
    // removes the proxy restores ACP behavior.
    let disabledByBiliProxy = false
    const guard =
        <TArgs extends unknown[]>(fn: (...args: TArgs) => Promise<void>) =>
        (...args: TArgs): Promise<void> =>
            disabledByBiliProxy ? Promise.resolve() : fn(...args)
    let disposed = false

    return {
        "experimental.chat.system.transform": guard(
            createSystemPromptHandler(registry, logger, config, prompts),
        ),
        "experimental.chat.messages.transform": guard(
            createChatMessageTransformHandler(
                runtimeHost,
                registry,
                logger,
                config,
                prompts,
                hostPermissions,
            ),
        ) as any,
        "experimental.text.complete": guard(createTextCompleteHandler()),
        "command.execute.before": guard(
            createCommandExecuteHandler(
                runtimeHost,
                registry,
                logger,
                config,
                ctx.directory,
                hostPermissions,
            ),
        ),
        event: guard(createEventHandler(registry, logger)),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress: createV1Tool(createCompressRangeToolDefinition(compressToolContext)),
                decompress: createV1Tool(createDecompressToolDefinition(compressToolContext)),
                search_context: createV1Tool(
                    createSearchContextToolDefinition(compressToolContext),
                ),
                acp_status: createV1Tool(createAcpStatusToolDefinition(compressToolContext)),
                acp_context_recap: createV1Tool(
                    createAcpContextRecapToolDefinition(compressToolContext),
                ),
            }),
        },
        config: async (opencodeConfig) => {
            // [FIX #337] Manual proxy mode: a provider baseURL routed through
            // the bili proxy (`/bili/` prefix) means the proxy handles context
            // compression — ACP must stay fully off, mirroring the
            // BILLION_CONTEXT_PROXY env-var guard. Denying the ACP tools
            // removes them from the LLM tool list (verified against a live
            // opencode instance), and the guard flag no-ops every hook.
            const biliMatches = findBiliProxyProviders(opencodeConfig.provider)
            disabledByBiliProxy = biliMatches.length > 0
            if (biliMatches.length > 0) {
                console.log(
                    "[opencode-acp] disabled: /bili/ proxy detected in provider baseURL (" +
                        biliMatches.map((m) => m.provider).join(", ") +
                        ") — proxy handles compression",
                )
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    compress: "deny",
                    decompress: "deny",
                    search_context: "deny",
                    acp_status: "deny",
                    acp_context_recap: "deny",
                } as typeof permission
                return
            }

            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["acp"] = {
                    template: "",
                    description: "Show available ACP commands",
                }
            }

            const toolsToAdd: string[] = []
            if (config.compress.permission !== "deny" && !config.allowSubAgents) {
                toolsToAdd.push("compress", "decompress", "search_context", "acp_status")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    compress: config.compress.permission,
                    acp_status: "allow",
                } as typeof permission
            }

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
        dispose: async () => {
            if (disposed) return
            disposed = true
            await updateCleanup()
            notifications.dispose()
        },
    }
}) satisfies Plugin

export default server
