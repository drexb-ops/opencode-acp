/**
 * Runtime adaptation for the public V2 catalog domains. OpenCode 2.0.3 groups
 * these under `catalog`; newer V2 releases expose the same domains at the
 * context top level. Keep every operation within one family rather than
 * combining endpoints from different shapes.
 */

export type V2CatalogFamily = "catalog" | "top-level"

export interface V2CatalogCapabilities {
    readonly family: V2CatalogFamily
    readonly updateEventTypes: readonly string[]
    readonly providerAvailable: boolean
    readonly modelAvailable: boolean
    listProviders(): Promise<unknown>
    listModels(): Promise<unknown>
}

export class V2CapabilityError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "V2CapabilityError"
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function isListMethod(value: unknown): value is (this: Record<string, unknown>) => unknown {
    return typeof value === "function"
}

interface V2ListDomain {
    list(): Promise<unknown>
}

function listDomain(value: unknown): V2ListDomain | undefined {
    const domain = record(value)
    const list = domain?.list
    if (!domain || !isListMethod(list)) return undefined
    return {
        async list() {
            return list.call(domain)
        },
    }
}

interface V2CatalogDomains {
    readonly provider?: V2ListDomain
    readonly model?: V2ListDomain
}

function catalogDomains(provider: unknown, model: unknown): V2CatalogDomains | undefined {
    const providerDomain = listDomain(provider)
    const modelDomain = listDomain(model)
    if (!providerDomain && !modelDomain) return undefined
    return {
        ...(providerDomain ? { provider: providerDomain } : {}),
        ...(modelDomain ? { model: modelDomain } : {}),
    }
}

function unavailableList(family: V2CatalogFamily, domain: "provider" | "model") {
    return async (): Promise<never> => {
        throw new V2CapabilityError(
            `V2 ${family} ${domain}.list capability is unavailable in this OpenCode package`,
        )
    }
}

function capabilities(family: V2CatalogFamily, domains: V2CatalogDomains): V2CatalogCapabilities {
    const provider = domains.provider
    const model = domains.model
    return {
        family,
        updateEventTypes:
            family === "catalog" ? ["catalog.updated"] : ["provider.updated", "model.updated"],
        providerAvailable: provider !== undefined,
        modelAvailable: model !== undefined,
        listProviders: provider ? () => provider.list() : unavailableList(family, "provider"),
        listModels: model ? () => model.list() : unavailableList(family, "model"),
    }
}

/**
 * Resolve one public catalog family. 2.0.3 is intentionally checked first so a
 * future compatibility alias cannot accidentally change its event contract.
 * Consumers must require the domains they need, but domains are never combined
 * across catalog families.
 */
export function detectV2CatalogCapabilities(context: unknown): V2CatalogCapabilities {
    const root = record(context)
    const catalog = record(root?.catalog)
    const pinned = catalogDomains(catalog?.provider, catalog?.model)
    if (pinned) {
        return capabilities("catalog", pinned)
    }

    const latest = catalogDomains(root?.provider, root?.model)
    if (latest) {
        return capabilities("top-level", latest)
    }

    throw new V2CapabilityError(
        "V2 provider/model catalog capability is unavailable; expected catalog or top-level provider/model domains from the installed OpenCode package",
    )
}

/**
 * The generated Promise client unwraps `{ data }` and returns an array. Test
 * bridges and transport adapters can still expose the HTTP response envelope,
 * so accept both public response forms and reject every other shape.
 */
export function v2CatalogListEntries(
    response: unknown,
    domain: "provider" | "model",
): readonly unknown[] {
    if (Array.isArray(response)) return response
    const envelope = record(response)
    if (Array.isArray(envelope?.data)) return envelope.data
    throw new V2CapabilityError(
        `V2 ${domain}.list returned an invalid response; expected an array or an object with a data array`,
    )
}

export function isV2CatalogUpdateEvent(
    capabilities: V2CatalogCapabilities,
    event: unknown,
): boolean {
    const eventRecord = record(event)
    return (
        typeof eventRecord?.type === "string" &&
        capabilities.updateEventTypes.includes(eventRecord.type)
    )
}
