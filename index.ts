import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Api } from "@opencode/plugin"

type V2Plugin = V2Api.Plugin
type DualPlugin = V2Plugin & {
    server: V1Plugin
}

const setup: V2Plugin["setup"] = async (context) => {
    const { setup: initializeV2 } = await import("./lib/v2/plugin")
    return initializeV2(context)
}

const server: V1Plugin = async (input, options) => {
    const { default: initializeV1 } = await import("./lib/v1/plugin")
    return initializeV1(input, options)
}

const plugin = {
    id: "opencode-acp",
    setup,
    server,
} satisfies DualPlugin

export default plugin
