import type { Logger } from "../logger"
import { applyPendingCompressionDurations, buildCompressionTimingKey } from "../compress/timing"
import { saveSessionState, type SessionState, type SessionStateRegistry } from "../state"

export interface V2ExecuteBeforeEvent {
    tool: string
    sessionID: string
    messageID: string
    id: string
}

export type V2ExecuteAfterEvent = V2ExecuteBeforeEvent &
    ({ status: "completed"; result: unknown } | { status: "error"; error: unknown })

function isCompressEvent(event: { tool: string }): boolean {
    return event.tool === "compress"
}

/**
 * Build the single V2 timing hook pair. The registry owns the shared timing
 * maps; only state/block attachment is serialized through the session guard.
 */
export function createV2CompressionTimingHandlers(
    registry: SessionStateRegistry,
    logger: Logger,
): {
    before(event: V2ExecuteBeforeEvent): void
    after(event: V2ExecuteAfterEvent): Promise<void>
} {
    const timing = registry.compressionTiming

    return {
        before(event) {
            if (!isCompressEvent(event)) return
            const key = buildCompressionTimingKey(event.messageID, event.id, event.sessionID)
            if (timing.startsByCallId.has(key)) return
            timing.startsByCallId.set(key, Date.now())
        },
        async after(event) {
            if (!isCompressEvent(event)) return
            const key = buildCompressionTimingKey(event.messageID, event.id, event.sessionID)
            const run = async (state: SessionState) => {
                const startedAt = timing.startsByCallId.get(key)
                timing.startsByCallId.delete(key)
                timing.pendingByCallId.delete(key)

                if (event.status === "error" || startedAt === undefined) return
                timing.pendingByCallId.set(key, {
                    messageId: event.messageID,
                    callId: event.id,
                    durationMs: Math.max(0, Date.now() - startedAt),
                })

                const updates = applyPendingCompressionDurations(state)
                if (updates <= 0) return
                try {
                    await saveSessionState(state, logger)
                } catch (error) {
                    logger.warn("Failed to persist V2 compression timing", {
                        sessionId: event.sessionID,
                        messageID: event.messageID,
                        callID: event.id,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
                logger.info("Attached V2 compression time to blocks", {
                    sessionId: event.sessionID,
                    messageID: event.messageID,
                    callID: event.id,
                    blocks: updates,
                })
            }

            try {
                if (registry.withSessionMutation) {
                    await registry.withSessionMutation(event.sessionID, run)
                } else {
                    const state = registry.get(event.sessionID)
                    if (state) await run(state)
                    else {
                        timing.startsByCallId.delete(key)
                        timing.pendingByCallId.delete(key)
                    }
                }
            } catch (error) {
                timing.startsByCallId.delete(key)
                timing.pendingByCallId.delete(key)
                logger.warn("V2 compression timing hook failed", {
                    sessionId: event.sessionID,
                    messageID: event.messageID,
                    callID: event.id,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        },
    }
}
