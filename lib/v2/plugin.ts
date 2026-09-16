import type { Plugin as V2Api } from "@opencode/plugin"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { SessionStateRegistry } from "../state"
import type { HostPermissionSnapshot } from "../host-permissions"
import { createV2ContextHandler } from "./context"
import { createV2Host } from "./host"

/**
 * V2 setup for the primary context lifecycle. Tools, commands, catalog reload,
 * RPC/TUI, and auxiliary session hooks intentionally remain in later phases.
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
    }

    const registration = await context.session.hook(
        "context",
        createV2ContextHandler(host, registry, logger, config, prompts, hostPermissions),
    )

    return async () => {
        await registration.dispose()
    }
}
