import { findV2BiliProxyProviders } from "../bili-proxy"
import type { Logger } from "../logger"
import {
    detectV2CatalogCapabilities,
    isV2CatalogUpdateEvent,
    v2CatalogListEntries,
    type V2CatalogCapabilities,
} from "./capabilities"
import type { V2Context } from "./host"

export type { V2Context } from "./host"

export interface V2ProxyState {
    disabled: boolean
}

export async function catalogHasV2BiliProxy(
    context: V2Context,
    capabilities = detectV2CatalogCapabilities(context),
): Promise<boolean> {
    const [providers, models] = await Promise.all([
        capabilities.listProviders(),
        capabilities.listModels(),
    ])
    return (
        findV2BiliProxyProviders(
            v2CatalogListEntries(providers, "provider"),
            v2CatalogListEntries(models, "model"),
        ).length > 0
    )
}

export async function initializeV2ProxyState(
    context: V2Context,
    state: V2ProxyState,
    logger: Logger,
): Promise<void> {
    try {
        state.disabled = await catalogHasV2BiliProxy(context)
    } catch (error) {
        logger.warn("V2 initial catalog proxy lookup failed", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

/**
 * Subscribe once to catalog changes and preserve the last valid state when a
 * provider/model lookup fails. The caller owns domain reloads in onChanged.
 */
export function startV2ProxyMonitor(
    context: V2Context,
    state: V2ProxyState,
    logger: Logger,
    onChanged: (disabled: boolean, previousDisabled: boolean) => Promise<void> | void,
): { stop(): Promise<void> } {
    let capabilities: V2CatalogCapabilities
    try {
        capabilities = detectV2CatalogCapabilities(context)
        if (!capabilities.providerAvailable || !capabilities.modelAvailable) {
            throw new Error("provider and model list capabilities are both required")
        }
    } catch (error) {
        logger.warn("V2 catalog proxy monitor unavailable", {
            error: error instanceof Error ? error.message : String(error),
        })
        return { stop: async () => {} }
    }
    const controller = new AbortController()
    let stopped = false
    const subscription = context.event.subscribe({ signal: controller.signal })
    const iterator = subscription[Symbol.asyncIterator]()
    const eventLoop = (async () => {
        try {
            for (;;) {
                const result = await iterator.next()
                if (result.done) return
                const event = result.value
                if (controller.signal.aborted || !isV2CatalogUpdateEvent(capabilities, event))
                    continue
                let nextDisabled: boolean
                try {
                    nextDisabled = await catalogHasV2BiliProxy(context, capabilities)
                } catch (error) {
                    logger.warn("V2 catalog proxy refresh failed; retaining prior state", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                    continue
                }
                if (nextDisabled === state.disabled) continue
                const previousDisabled = state.disabled
                // Publish the new state before reload so replayed transforms see
                // the transition immediately. If either domain cannot reload,
                // restore the last valid state; the identical catalog event can
                // then retry instead of being swallowed as a no-op.
                state.disabled = nextDisabled
                try {
                    await onChanged(nextDisabled, previousDisabled)
                } catch (error) {
                    state.disabled = previousDisabled
                    logger.warn("V2 ACP catalog reload failed", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                logger.warn("V2 catalog event loop stopped", {
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }
    })()

    return {
        async stop() {
            if (stopped) return
            stopped = true
            controller.abort()
            try {
                await iterator.return?.()
            } catch (error) {
                logger.warn("V2 catalog iterator cleanup failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
            }
            await eventLoop
        },
    }
}
