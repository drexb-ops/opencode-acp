import type { PluginInput } from "@opencode-ai/plugin"
import type { HostServices } from "../host"
import { createLegacyHostServices } from "../host/legacy"

/**
 * The structural client adapter is implemented once in lib/host/legacy.ts.
 * Keeping this typed entrypoint thin gives V1 callers compile-time guidance
 * without maintaining a second response or notification translation.
 */
export function createV1Host(ctx: Pick<PluginInput, "client">): HostServices {
    return createLegacyHostServices(ctx.client)
}
