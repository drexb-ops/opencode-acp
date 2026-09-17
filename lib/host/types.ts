import type { WithParts } from "../state/types"

/** The subset of a host session record needed by ACP state initialization. */
export interface HostSessionInfo {
    id?: string
    parentID?: string | null
}

/**
 * Session access used by ACP. The host owns response decoding and projection;
 * the shared engine only receives ACP's message envelope.
 */
export interface SessionService {
    get(sessionID: string): Promise<HostSessionInfo | undefined>
    messages(sessionID: string): Promise<WithParts[]>
    parentMessages(sessionID: string): Promise<WithParts[]>
}

/** A model/context-limit entry independent of either host's catalog shape. */
export interface ModelInventoryEntry {
    providerId: string
    modelId: string
    contextLimit?: number
}

export interface ModelInventory {
    list(): Promise<readonly ModelInventoryEntry[]>
}

export type NotificationVariant = "info" | "warning" | "error" | "success"

export interface NotificationInput {
    title: string
    message: string
    variant: NotificationVariant
    duration?: number
}

export interface NotificationSink {
    notify(input: NotificationInput): Promise<void> | void
}

export interface NoticeMetadata {
    providerId?: string
    modelId?: string
    agent?: string
    variant?: string
    /** Marks V2 synthetic history entries owned by ACP. */
    acpOwned?: boolean
}

/**
 * An ACP-owned notice is visible to the user but must not resume a model turn.
 * V1 implements this with an ignored/no-reply prompt; V2 uses a synthetic
 * non-resuming message.
 */
export interface NoticeInput {
    sessionID: string
    text: string
    metadata?: NoticeMetadata
}

export interface NoticeSink {
    send(input: NoticeInput): Promise<void>
}

/**
 * Host-neutral services used by shared ACP execution. Keeping these as named,
 * focused services makes it possible for each runtime to adapt only the APIs it
 * actually exposes.
 */
export interface HostServices {
    sessions: SessionService
    models: ModelInventory
    notices: NoticeSink
    notifications: NotificationSink
    /**
     * Raw IDs of session messages the host classifies as non-removable from
     * outgoing context (provider-owned records such as completed native
     * compactions). Only hosts with content-level provenance implement this;
     * the shared engine treats absence as "all sources removable".
     */
    nonRemovableSourceIds?(sessionID: string): Promise<ReadonlySet<string>>
}
