import type { Logger } from "../logger"
import { applyPendingCompressionDurations, buildCompressionTimingKey } from "../compress/timing"
import { saveSessionState, type SessionState, type SessionStateRegistry } from "../state"
import type { V2OperationTracker } from "./lifecycle"

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

let nextV2TimingInstanceId = 0

/**
 * Build the single V2 timing hook pair. The registry owns the shared timing
 * maps; only state/block attachment is serialized through the session guard.
 */
export function createV2CompressionTimingHandlers(
    registry: SessionStateRegistry,
    logger: Logger,
    operations?: V2OperationTracker,
): {
    before(event: V2ExecuteBeforeEvent): void
    after(event: V2ExecuteAfterEvent): Promise<void>
    /** Remove only timing entries created by this plugin instance. */
    dispose(): void
} {
    const timing = registry.compressionTiming
    // Keep each lifecycle's transient keys disjoint.  A reload can overlap an
    // old instance's cleanup, and a future instance must not accidentally
    // inherit (or be erased with) the old instance's execute-before entry.
    const instancePrefix = `v2:${++nextV2TimingInstanceId}:`
    const timingKey = (event: V2ExecuteBeforeEvent): string =>
        `${instancePrefix}${buildCompressionTimingKey(event.messageID, event.id, event.sessionID)}`
    const ownedKeys = new Set<string>()

    const releaseOwnedKey = (key: string): void => {
        if (!ownedKeys.delete(key)) return
        timing.startsByCallId.delete(key)
        timing.pendingByCallId.delete(key)
    }

    return {
        before(event) {
            if (!isCompressEvent(event)) return
            if (operations && !operations.isActive) return
            const key = timingKey(event)
            if (timing.startsByCallId.has(key)) return
            timing.startsByCallId.set(key, Date.now())
            ownedKeys.add(key)
        },
        async after(event) {
            if (!isCompressEvent(event)) return
            const execute = async (isActive: () => boolean = () => true) => {
                const key = timingKey(event)
                const run = async (state: SessionState) => {
                    if (!isActive()) return
                    // A before hook in this timing handler owns the key.  Do
                    // not consume another plugin instance's entry when two
                    // lifecycles share a registry in a host/test fixture.
                    if (!ownedKeys.has(key)) return
                    const startedAt = timing.startsByCallId.get(key)
                    timing.startsByCallId.delete(key)
                    timing.pendingByCallId.delete(key)

                    if (event.status === "error" || startedAt === undefined) {
                        releaseOwnedKey(key)
                        return
                    }
                    timing.pendingByCallId.set(key, {
                        messageId: event.messageID,
                        callId: event.id,
                        durationMs: Math.max(0, Date.now() - startedAt),
                    })

                    const updates = applyPendingCompressionDurations(state)
                    if (updates <= 0) {
                        releaseOwnedKey(key)
                        return
                    }
                    if (!isActive()) return
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
                    if (!isActive()) return
                    logger.info("Attached V2 compression time to blocks", {
                        sessionId: event.sessionID,
                        messageID: event.messageID,
                        callID: event.id,
                        blocks: updates,
                    })
                    releaseOwnedKey(key)
                }

                try {
                    if (registry.withSessionMutation) {
                        await registry.withSessionMutation(event.sessionID, run)
                    } else {
                        const state = registry.get(event.sessionID)
                        if (state) await run(state)
                        else {
                            releaseOwnedKey(key)
                        }
                    }
                } catch (error) {
                    releaseOwnedKey(key)
                    logger.warn("V2 compression timing hook failed", {
                        sessionId: event.sessionID,
                        messageID: event.messageID,
                        callID: event.id,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }
            if (operations) {
                await operations.run("timing", async (lease) => execute(lease.isActive))
            } else {
                await execute()
            }
        },
        dispose() {
            for (const key of [...ownedKeys]) releaseOwnedKey(key)
        },
    }
}
