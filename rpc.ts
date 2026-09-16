import { Rpc } from "@opencode/plugin/rpc"

/** The JSON-safe toast payload shared by the V2 server and TUI plugins. */
export type AcpNotification = {
    title: string
    message: string
    variant: "info" | "warning" | "error" | "success"
    duration?: number
}

const acpNotificationSchema = {
    type: "object",
    properties: {
        title: { type: "string" },
        message: { type: "string" },
        variant: {
            type: "string",
            enum: ["info", "warning", "error", "success"],
        },
        duration: { type: "number" },
    },
    required: ["title", "message", "variant"],
    additionalProperties: false,
} as const

/** Public RPC contract for ACP notifications. */
export const AcpRpc = Rpc.define({
    id: "opencode-acp",
    methods: {},
    events: {
        notification: {
            schema: acpNotificationSchema,
        },
    },
})
