import type { ModelInventory } from "../host"
import { resolveModelInventory } from "../host/legacy"

/**
 * [FIX #312] Catalog of per-model context limits, keyed `${providerID}/${modelID}`.
 *
 * Within one LLM request the host fires experimental.chat.messages.transform
 * BEFORE experimental.chat.system.transform (sst/opencode: session/prompt.ts
 * triggers messages.transform, then llm/request.ts triggers system.transform
 * during handle.process). state.modelContextLimit is written only by the
 * system hook, so on the first request after a model switch every percentage
 * threshold (emergencyThresholdPercent, min/maxContextLimit "%", GC tiers) is
 * still computed against the PREVIOUS model's
 * limit. This catalog lets the messages hook reconcile against the model
 * named on the request's user message instead of waiting one turn.
 *
 * Entries are recorded live by the system hook every request and seeded once
 * at plugin init from the host's model inventory.
 *
 * Standalone factory (not embedded in SessionStateRegistry) so the test
 * registry stub can compose the SAME implementation instead of hand-rolling
 * a drift-prone copy.
 */
export interface ModelLimitCatalog {
    record(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void
    resolve(providerId: string | undefined, modelId: string | undefined): number | undefined
    hydrate(inventory: ModelInventory): Promise<number>
    /** @deprecated Use hydrate() with a host model inventory. */
    hydrateFromClient(client: unknown): Promise<number>
}

export function createModelLimitCatalog(): ModelLimitCatalog {
    const modelLimits = new Map<string, number>()
    return {
        record(providerId, modelId, limit) {
            if (!providerId || !modelId || typeof limit !== "number" || limit <= 0) return
            modelLimits.set(`${providerId}/${modelId}`, limit)
        },
        resolve(providerId, modelId) {
            if (!providerId || !modelId) return undefined
            return modelLimits.get(`${providerId}/${modelId}`)
        },
        /**
         * Best-effort one-time seed from a host-neutral model inventory. Never
         * throws; returns the number of model-limit entries recorded.
         */
        async hydrate(inventory: ModelInventory): Promise<number> {
            try {
                const entries = await inventory.list()
                let recorded = 0
                for (const entry of entries) {
                    if (
                        typeof entry.providerId !== "string" ||
                        typeof entry.modelId !== "string" ||
                        typeof entry.contextLimit !== "number" ||
                        entry.contextLimit <= 0
                    ) {
                        continue
                    }
                    modelLimits.set(`${entry.providerId}/${entry.modelId}`, entry.contextLimit)
                    recorded++
                }
                return recorded
            } catch {
                return 0
            }
        },
        /**
         * Compatibility bridge for older test/integration callers. The V1
         * production adapter translates its client in lib/v1/host.ts and calls
         * hydrate() directly.
         */
        async hydrateFromClient(client: unknown): Promise<number> {
            return this.hydrate(resolveModelInventory(client))
        },
    }
}
