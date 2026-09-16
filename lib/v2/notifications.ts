import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { AcpRpc, AcpNotification } from "../../rpc"
import type { NotificationInput, NotificationSink } from "../host"
import type { Logger } from "../logger"

type Emit = RpcRegistration<typeof AcpRpc>["events"]["emit"]

export interface V2NotificationBridge {
    readonly sink: NotificationSink
    setLogger(logger: Logger): void
    connect(emit: Emit): void
    disconnect(): void
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Adapt the server RPC registration to the shared notification contract.
 * Emission is intentionally not awaited: missing TUI listeners and a detached
 * client are normal runtime states and cannot be allowed to gate compression.
 */
export function createV2NotificationBridge(logger?: Logger): V2NotificationBridge {
    let emit: Emit | undefined
    let currentLogger = logger

    const reportFailure = (error: unknown) => {
        try {
            void currentLogger?.warn("V2 RPC notification delivery failed", {
                error: errorText(error),
            })
        } catch {}
    }

    const sink: NotificationSink = {
        notify(input: NotificationInput): void {
            const currentEmit = emit
            if (!currentEmit) return

            const payload: AcpNotification = {
                title: input.title,
                message: input.message,
                variant: input.variant,
                ...(input.duration === undefined ? {} : { duration: input.duration }),
            }
            try {
                void Promise.resolve(currentEmit("notification", payload)).catch(reportFailure)
            } catch (error) {
                reportFailure(error)
            }
        },
    }

    return {
        sink,
        setLogger(nextLogger) {
            currentLogger = nextLogger
        },
        connect(nextEmit) {
            emit = nextEmit
        },
        disconnect() {
            emit = undefined
        },
    }
}
