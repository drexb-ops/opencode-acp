/**
 * Billion-context (`bili`) proxy detection in opencode provider config.
 *
 * Manual proxy mode (`bili start` + a provider whose baseURL is pointed at
 * the proxy) does NOT set `BILLION_CONTEXT_PROXY` — that env var is only set
 * by the `bili <client>` launcher. The `/bili/` path prefix in a provider
 * baseURL is the documented zero-config self-detection signal (billion-context
 * CONFIGURATION.md): `http://<proxy-host>:<port>/bili/<upstream-url>`.
 *
 * When a provider routes through the proxy, the proxy handles context
 * compression itself, so ACP must disable itself (same behavior as the
 * `BILLION_CONTEXT_PROXY` env-var guard in index.ts).
 */

export const BILI_PROXY_MARKER = "/bili/"

export interface BiliProxyMatch {
    provider: string
    baseURL: string
}

export interface V2BiliProxyMatch extends BiliProxyMatch {
    model?: string
}

function extractBaseURL(entry: unknown): string | undefined {
    if (!entry || typeof entry !== "object") return undefined
    const record = entry as Record<string, unknown>
    const options = record.options
    if (options && typeof options === "object") {
        const optionBaseURL = (options as Record<string, unknown>).baseURL
        if (typeof optionBaseURL === "string" && optionBaseURL.length > 0) {
            return optionBaseURL
        }
    }
    // Defensive fallback: some configs place baseURL at the provider top
    // level rather than under `options`.
    const topLevelBaseURL = record.baseURL
    if (typeof topLevelBaseURL === "string" && topLevelBaseURL.length > 0) {
        return topLevelBaseURL
    }
    return undefined
}

/**
 * Scan opencode's provider config for every provider whose baseURL routes
 * through the bili proxy (contains the `/bili/` path prefix).
 *
 * Pure function — safe to unit test. Returns `[]` for null/undefined/non-object
 * input and for providers without a string baseURL.
 */
export function findBiliProxyProviders(provider: unknown): BiliProxyMatch[] {
    if (!provider || typeof provider !== "object") return []
    const matches: BiliProxyMatch[] = []
    for (const [name, entry] of Object.entries(provider as Record<string, unknown>)) {
        const baseURL = extractBaseURL(entry)
        if (baseURL !== undefined && baseURL.includes(BILI_PROXY_MARKER)) {
            matches.push({ provider: name, baseURL })
        }
    }
    return matches
}

function catalogData(value: unknown): readonly unknown[] {
    if (Array.isArray(value)) return value
    if (!value || typeof value !== "object") return []
    const data = (value as Record<string, unknown>).data
    return Array.isArray(data) ? data : []
}

function settingsBaseURL(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined
    const settings = (value as Record<string, unknown>).settings
    if (!settings || typeof settings !== "object") return undefined
    const baseURL = (settings as Record<string, unknown>).baseURL
    return typeof baseURL === "string" && baseURL.length > 0 ? baseURL : undefined
}

/**
 * Scan the exact V2 Provider.Info and Model.Info catalog shapes. V2 exposes
 * provider/model settings under `settings.baseURL`; unlike the legacy config
 * hook, a top-level baseURL is deliberately not treated as a V2 match.
 */
export function findV2BiliProxyProviders(
    providerCatalog: unknown,
    modelCatalog: unknown = [],
): V2BiliProxyMatch[] {
    const matches: V2BiliProxyMatch[] = []
    const seen = new Set<string>()

    for (const value of catalogData(providerCatalog)) {
        if (!value || typeof value !== "object") continue
        const provider = value as Record<string, unknown>
        const providerID = typeof provider.id === "string" ? provider.id : undefined
        const baseURL = settingsBaseURL(value)
        if (!providerID || !baseURL || !baseURL.includes(BILI_PROXY_MARKER)) continue
        const key = `${providerID}\n${baseURL}`
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ provider: providerID, baseURL })
    }

    for (const value of catalogData(modelCatalog)) {
        if (!value || typeof value !== "object") continue
        const model = value as Record<string, unknown>
        const providerID = typeof model.providerID === "string" ? model.providerID : undefined
        const modelID = typeof model.id === "string" ? model.id : undefined
        const baseURL = settingsBaseURL(value)
        if (!providerID || !modelID || !baseURL || !baseURL.includes(BILI_PROXY_MARKER)) continue
        const key = `${providerID}\n${modelID}\n${baseURL}`
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ provider: providerID, model: modelID, baseURL })
    }

    return matches
}
