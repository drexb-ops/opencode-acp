import type { Plugin } from "@opencode/plugin/tui"
import { AcpRpc, type AcpNotification } from "./rpc"

export const ACP_TUI_PLUGIN_ID = "opencode-acp-tui"

const plugin = {
    id: ACP_TUI_PLUGIN_ID,
    setup(context) {
        const unsubscribe = context.client.rpc(AcpRpc).events.on("notification", (event) => {
            // JSON Schema definitions intentionally expose unknown event data to
            // generic clients. The server has already validated this payload.
            context.ui.toast.show(event.data as AcpNotification)
        })

        return unsubscribe
    },
} satisfies Plugin.Definition

export default plugin
