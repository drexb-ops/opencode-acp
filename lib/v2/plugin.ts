import type { Plugin as V2Api } from "@opencode/plugin"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { SessionStateRegistry } from "../state"
import type { HostPermissionSnapshot } from "../host-permissions"
import { createV2ContextHandler } from "./context"
import { createV2Host } from "./host"
import { createV2CommandTransform } from "./commands"
import { createV2ToolTransform } from "./tools"
import { createV2CompressionTimingHandlers } from "./timing"
import { initializeV2ProxyState, startV2ProxyMonitor, type V2ProxyState } from "./proxy"

type Registration = { dispose(): Promise<void> }

/**
 * V2 setup for ACP's supported runtime surface. Registrations are deliberately
 * created once; catalog changes replay their existing transform callbacks via
 * the public reload methods instead of adding duplicate transforms.
 */
export const setup: V2Api.Plugin["setup"] = async (context) => {
    const notifications = {
        // Configuration warnings are allowed to be dropped until the V2 RPC/TUI
        // sink is implemented. Keeping this sink explicit makes config loading
        // independent from any V1 client/auth machinery.
        notify: () => {},
    }
    const config = getConfig({
        directory: context.location.directory,
        notifications,
    })

    if (!config.enabled) return
    if (process.env.BILLION_CONTEXT_PROXY) return

    const logger = new Logger(config.debug, config.debug ? "debug" : config.logLevel)
    const registry = new SessionStateRegistry(logger, context.location.directory)
    const prompts = new PromptStore(
        logger,
        context.location.directory,
        config.experimental.customPrompts,
        config.compress.candidates === true,
    )
    const host = createV2Host(context, {
        directory: context.location.directory,
    })
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
        v2Agents: {},
    }
    const proxyState: V2ProxyState = { disabled: false }
    const registrations: Registration[] = []

    try {
        // Resolve provider and model catalogs before any transform can be
        // replayed. A failed initial read leaves ACP enabled; subsequent
        // catalog.updated events can establish a valid disabled state.
        await initializeV2ProxyState(context, proxyState, logger)

        const factoryContext = {
            host,
            registry,
            logger,
            config,
            prompts,
        }
        const isEnabled = () => !proxyState.disabled

        registrations.push(
            await context.tool.transform(
                createV2ToolTransform(factoryContext, host, hostPermissions, isEnabled),
            ),
        )
        registrations.push(
            await context.command.transform(
                createV2CommandTransform(
                    host,
                    registry,
                    logger,
                    config,
                    hostPermissions,
                    context.location.directory,
                    isEnabled,
                ),
            ),
        )

        const contextHandler = createV2ContextHandler(
            host,
            registry,
            logger,
            config,
            prompts,
            hostPermissions,
        )
        registrations.push(
            await context.session.hook("context", async (event) => {
                if (!isEnabled()) return
                await contextHandler(event)
            }),
        )

        const timing = createV2CompressionTimingHandlers(registry, logger)
        registrations.push(
            await context.tool.hook("execute.before", async (event) => {
                timing.before(event)
            }),
        )
        registrations.push(
            await context.tool.hook("execute.after", async (event) => {
                await timing.after(event)
            }),
        )

        const monitor = startV2ProxyMonitor(context, proxyState, logger, async () => {
            await Promise.all([context.tool.reload(), context.command.reload()])
        })
        let stopped = false

        return async () => {
            if (stopped) return
            stopped = true
            await monitor.stop()
            for (const registration of [...registrations].reverse()) {
                await registration.dispose()
            }
        }
    } catch (error) {
        for (const registration of [...registrations].reverse()) {
            try {
                await registration.dispose()
            } catch {}
        }
        throw error
    }
}
