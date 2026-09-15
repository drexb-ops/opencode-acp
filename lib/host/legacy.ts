import { filterMessages } from "../messages/shape"
import type {
    HostServices,
    HostSessionInfo,
    ModelInventory,
    ModelInventoryEntry,
    NoticeInput,
    NotificationInput,
    SessionService,
} from "./types"

type LegacySessionApi = {
    get?: (input: { path: { id: string } }) => Promise<unknown>
    messages?: (input: { path: { id: string } }) => Promise<unknown>
    prompt?: (input: {
        path: { id: string }
        body: {
            noReply: boolean
            agent: string | undefined
            model: { providerID: string; modelID: string } | undefined
            variant: string | undefined
            parts: Array<{ type: "text"; text: string; ignored: boolean }>
        }
    }) => Promise<unknown>
}

type LegacyClient = {
    session?: LegacySessionApi
    config?: {
        providers?: () => Promise<unknown>
    }
    tui?: {
        showToast?: (input: { body: NotificationInput }) => Promise<unknown> | unknown
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined
}

function asLegacyClient(value: unknown): LegacyClient {
    return (asRecord(value) as LegacyClient | undefined) ?? {}
}

function responseData(value: unknown): unknown {
    const record = asRecord(value)
    return record && "data" in record ? record.data : value
}

function sessionInfo(value: unknown): HostSessionInfo | undefined {
    const data = asRecord(responseData(value))
    if (!data) return undefined

    const parentID = data.parentID
    return {
        id: typeof data.id === "string" ? data.id : undefined,
        parentID: typeof parentID === "string" ? parentID : parentID === null ? null : undefined,
    }
}

function providerEntries(value: unknown): ModelInventoryEntry[] {
    const payload = asRecord(responseData(value))
    const providers = payload?.providers
    if (!Array.isArray(providers)) return []

    const entries: ModelInventoryEntry[] = []
    for (const providerValue of providers) {
        const provider = asRecord(providerValue)
        const providerId = provider?.id
        const models = provider?.models
        if (typeof providerId !== "string" || !models || typeof models !== "object") continue

        for (const [modelId, modelValue] of Object.entries(models)) {
            const model = asRecord(modelValue)
            const limit = asRecord(model?.limit)
            const context = limit?.context
            entries.push({
                providerId,
                modelId,
                contextLimit: typeof context === "number" && context > 0 ? context : undefined,
            })
        }
    }
    return entries
}

function createLegacySessionService(client: LegacyClient): SessionService {
    const session = client.session
    return {
        async get(sessionID) {
            const response = await session?.get?.({ path: { id: sessionID } })
            return sessionInfo(response)
        },
        async messages(sessionID) {
            const response = await session?.messages?.({ path: { id: sessionID } })
            return filterMessages(responseData(response))
        },
        async parentMessages(sessionID) {
            const response = await session?.messages?.({ path: { id: sessionID } })
            return filterMessages(responseData(response))
        },
    }
}

function createLegacyModelInventory(client: LegacyClient): ModelInventory {
    return {
        async list() {
            const response = await client.config?.providers?.()
            return providerEntries(response)
        },
    }
}

function createLegacyNotificationSink(client: LegacyClient) {
    return {
        async notify(input: NotificationInput) {
            await client.tui?.showToast?.({ body: input })
        },
    }
}

function createLegacyNoticeSink(client: LegacyClient) {
    return {
        async send(input: NoticeInput) {
            const metadata = input.metadata
            const model =
                metadata?.providerId && metadata.modelId
                    ? {
                          providerID: metadata.providerId,
                          modelID: metadata.modelId,
                      }
                    : undefined
            await client.session?.prompt?.({
                path: { id: input.sessionID },
                body: {
                    noReply: true,
                    agent: metadata?.agent,
                    model,
                    variant: metadata?.variant,
                    parts: [{ type: "text", text: input.text, ignored: true }],
                },
            })
        },
    }
}

/** Build a host from the old structural client shape used by legacy callers/tests. */
export function createLegacyHostServices(client: unknown): HostServices {
    const legacyClient = asLegacyClient(client)
    return {
        sessions: createLegacySessionService(legacyClient),
        models: createLegacyModelInventory(legacyClient),
        notices: createLegacyNoticeSink(legacyClient),
        notifications: createLegacyNotificationSink(legacyClient),
    }
}

export function isSessionService(value: unknown): value is SessionService {
    const record = asRecord(value)
    return (
        typeof record?.get === "function" &&
        typeof record.messages === "function" &&
        typeof record.parentMessages === "function"
    )
}

export function isModelInventory(value: unknown): value is ModelInventory {
    const record = asRecord(value)
    return typeof record?.list === "function"
}

export function isHostServices(value: unknown): value is HostServices {
    const record = asRecord(value)
    return (
        isSessionService(record?.sessions) &&
        isModelInventory(record?.models) &&
        asRecord(record?.notices) !== undefined &&
        typeof asRecord(record?.notices)?.send === "function" &&
        asRecord(record?.notifications) !== undefined &&
        typeof asRecord(record?.notifications)?.notify === "function"
    )
}

/** Normalize a host contract while retaining compatibility with old callers. */
export function resolveHostServices(value: unknown): HostServices {
    return isHostServices(value) ? value : createLegacyHostServices(value)
}

export function resolveSessionService(value: unknown): SessionService {
    return isSessionService(value) ? value : createLegacyHostServices(value).sessions
}

export function resolveModelInventory(value: unknown): ModelInventory {
    return isModelInventory(value) ? value : createLegacyHostServices(value).models
}

export type { LegacyClient }
