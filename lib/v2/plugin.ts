import type { Plugin as V2Api } from "@opencode/plugin"
import { AcpRpc } from "../../rpc"
import { getConfig } from "../config"
import { createManagedNotificationSink } from "../notifications"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { SessionStateRegistry } from "../state"
import type { HostPermissionSnapshot } from "../host-permissions"
import { startAutoUpdate } from "../update"
import { createV2ContextHandler } from "./context"
import { createV2Host } from "./host"
import { createV2CommandTransform } from "./commands"
import { createV2NotificationBridge } from "./notifications"
import { createV2ToolTransform } from "./tools"
import { createV2CompressionTimingHandlers } from "./timing"
import { initializeV2ProxyState, startV2ProxyMonitor, type V2ProxyState } from "./proxy"

type Cleanup = () => Promise<void> | void
type Registration = { dispose(): Promise<void> }

function ownRegistration(resources: Cleanup[], registration: Registration): void {
    resources.push(() => registration.dispose())
}

async function disposeAll(resources: Cleanup[], logger?: Logger): Promise<void> {
    for (const cleanup of [...resources].reverse()) {
        try {
            await cleanup()
        } catch (error) {
            try {
                void logger?.warn("V2 ACP resource cleanup failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
            } catch {}
        }
    }
}

/**
 * V2 setup for ACP's supported runtime surface. Every resource created by this
 * function is pushed onto one stack and released in reverse order. This keeps
 * partial setup failures equivalent to a normal unload and prevents catalog
 * reloads from creating duplicate transforms.
 */
export const setup: V2Api.Plugin["setup"] = async (context) => {
    const resources: Cleanup[] = []
    let disposed = false

    const bridge = createV2NotificationBridge()
    const notifications = createManagedNotificationSink(bridge.sink)
    resources.push(() => notifications.dispose())

    let logger: Logger | undefined
    let disposePromise: Promise<void> | undefined
    const dispose = async (): Promise<void> => {
        if (disposePromise) return disposePromise
        disposed = true
        disposePromise = disposeAll(resources, logger)
        return disposePromise
    }

    try {
        const config = getConfig({
            directory: context.location.directory,
            notifications,
        })

        if (!config.enabled || process.env.BILLION_CONTEXT_PROXY) {
            await dispose()
            return
        }

        logger = new Logger(config.debug, config.debug ? "debug" : config.logLevel)
        bridge.setLogger(logger)

        const registry = new SessionStateRegistry(logger, context.location.directory)
        const prompts = new PromptStore(
            logger,
            context.location.directory,
            config.experimental.customPrompts,
            config.compress.candidates === true,
        )

        const rpcRegistration = await context.rpc.register(AcpRpc, {})
        ownRegistration(resources, rpcRegistration)
        bridge.connect(rpcRegistration.events.emit)
        // Disconnect before disposing the registration so an in-flight or late
        // notification cannot target a detached TUI client.
        resources.push(() => bridge.disconnect())

        const host = createV2Host(
            context,
            {
                directory: context.location.directory,
            },
            notifications,
        )
        const hostPermissions: HostPermissionSnapshot = {
            global: undefined,
            agents: {},
            v2Agents: {},
        }
        const proxyState: V2ProxyState = { disabled: false }

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
        const isEnabled = () => !disposed && !proxyState.disabled

        ownRegistration(
            resources,
            await context.tool.transform(
                createV2ToolTransform(factoryContext, host, hostPermissions, isEnabled),
            ),
        )
        ownRegistration(
            resources,
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
        ownRegistration(
            resources,
            await context.session.hook("context", async (event) => {
                if (!isEnabled()) return
                await contextHandler(event)
            }),
        )

        const timing = createV2CompressionTimingHandlers(registry, logger)
        ownRegistration(
            resources,
            await context.tool.hook("execute.before", async (event) => {
                if (!isEnabled()) return
                timing.before(event)
            }),
        )
        ownRegistration(
            resources,
            await context.tool.hook("execute.after", async (event) => {
                if (!isEnabled()) return
                await timing.after(event)
            }),
        )

        const monitor = startV2ProxyMonitor(context, proxyState, logger, async () => {
            if (disposed) return
            await Promise.all([context.tool.reload(), context.command.reload()])
        })
        resources.push(() => monitor.stop())

        const updateCleanup = startAutoUpdate(notifications, config.autoUpdate, logger)
        resources.push(updateCleanup)

        return dispose
    } catch (error) {
        await dispose()
        throw error
    }
}
