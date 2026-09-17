import type { WithParts } from "../state"
import { countTokens } from "../token-utils"

/** Values available on OpenCode's V2 `session.context` event. */
export interface V2WireTokenInput {
    /** System parts are separate from canonical request messages in V2. */
    system: readonly unknown[]
    /** Canonical messages that the host will lower to the provider request. */
    messages: readonly unknown[]
    /** Current tool definitions, when the host supplied them on the event. */
    tools?: unknown
}

/** Exact V2 projection ownership for each `messages[index]`, when available. */
export interface V2TokenBudgetInput extends V2WireTokenInput {
    normalizedMessages: readonly WithParts[]
    /**
     * Parallel to `messages`; use `projection.outgoing.map((entry) =>
     * entry.normalizedMessageId)`. Undefined means the raw message is truly
     * unowned and must remain conservative rather than position-matched.
     */
    outgoingNormalizedMessageIds?: readonly (string | undefined)[]
}

export interface V2WireTokenEstimate {
    /** ACP semantic estimates; provider-specific multimodal billing may differ. */
    systemTokens: number
    toolTokens: number
    messageTokens: number
    totalTokens: number
}

/**
 * Per-request V2 accounting passed to the shared transform.
 *
 * The baseline uses current host values, not historical assistant usage.
 * `estimateMessages` keeps non-projectable message cost while applying ACP's
 * semantic projected content after prune/truncation/injection.
 */
export interface V2TokenBudget extends V2WireTokenEstimate {
    overheadTokens: number
    safetyOverheadTokens: number
    normalizedMessageTokens: number
    estimateMessages(messages: readonly WithParts[]): number
    estimateSafetyMessages(messages: readonly WithParts[]): number
}

export interface V2RequestTokenAccounting {
    readonly source: "provider-calibrated" | "semantic-estimate"
    readonly calibrationRatio: number
    readonly overheadTokens: number
    readonly safetyOverheadTokens: number
    /** Stable semantic estimate used only for persisted growth/cadence state. */
    readonly growthEstimate: (messages: readonly WithParts[]) => number
    /** Conservative semantic estimate used by truncation and hard guards. */
    readonly safetyEstimate: (messages: readonly WithParts[]) => number
    /** Provider-calibrated estimate used only for user-visible nudge thresholds. */
    readonly nudgeEstimate: (messages: readonly WithParts[]) => number
    /** Kept as the nudge estimate for callers using the initial V2 contract. */
    estimateMessages(messages: readonly WithParts[]): number
}

interface MessageTokenEntry {
    id?: string
    tokens: number
}

interface ProjectedMessageTokenEntry extends MessageTokenEntry {
    callIDs: readonly string[]
}

const MAX_TOKENIZER_INPUT_CHARS = 16_384
const MAX_COLLECTION_ENTRIES = 64
const MAX_TRAVERSAL_DEPTH = 8
const MAX_TRAVERSAL_NODES = 1_024
const MAX_REQUEST_CACHE_ENTRIES = 512
const MAX_SORT_KEY_CHARS = 128
const HEURISTIC_BYTES_PER_TOKEN = 3
const OPAQUE_TRUNCATION_RESIDUAL_TOKENS = 64
const MAX_RESIDUAL_TOKENS = 1_000_000_000
const SAFETY_ESTIMATE_MARGIN = 1.05
const SAFETY_ESTIMATE_FIXED_TOKENS = 256
const OPAQUE_REMAINDER_MARKER = "__acpEstimateOpaqueRemainder"
const OPAQUE_TOOL_SCHEMA_MARKER = "__acpEstimateUnknownToolSchema"

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

/**
 * Tokenization is expensive, while a transform repeatedly estimates the same
 * visible parts. This cache is scoped to one V2 request/budget; it cannot grow
 * across sessions or retain payloads after the transform completes.
 */
class RequestTokenCounter {
    private readonly tokensBySerializedValue = new Map<string, number>()

    constructor(private readonly conservativeOmissions = false) {}

    count(value: unknown, opaque = false): number {
        const serialized = serializeModelValue(value, this.conservativeOmissions)
        const cacheKey = `${serialized.residualTokens}\u0000${serialized.text}`
        const cached = this.tokensBySerializedValue.get(cacheKey)
        if (cached !== undefined) return cached
        const tokens =
            (opaque ? Math.max(1, countTokens(serialized.text)) : countTokens(serialized.text)) +
            serialized.residualTokens
        if (this.tokensBySerializedValue.size < MAX_REQUEST_CACHE_ENTRIES) {
            this.tokensBySerializedValue.set(cacheKey, tokens)
        }
        return tokens
    }
}

interface SerializedModelValue {
    text: string
    residualTokens: number
}

interface SerializationState {
    seen: WeakSet<object>
    remainingTextChars: number
    remainingTraversalNodes: number
    residualTokens: number
    conservativeOmissions: boolean
}

function residualForChars(chars: number): number {
    return Math.max(0, Math.ceil(chars / 4))
}

function addResidualTokens(state: SerializationState, tokens: number): void {
    state.residualTokens = Math.min(
        MAX_RESIDUAL_TOKENS,
        state.residualTokens + Math.max(0, Math.ceil(tokens)),
    )
}

function residualForText(value: string, start = 0): number {
    let tokens = 0
    for (let offset = start; offset < value.length; offset += MAX_TOKENIZER_INPUT_CHARS) {
        tokens += countTokens(value.slice(offset, offset + MAX_TOKENIZER_INPUT_CHARS))
        if (tokens >= MAX_RESIDUAL_TOKENS) return MAX_RESIDUAL_TOKENS
    }
    return tokens
}

function addTextResidual(state: SerializationState, value: string, start: number): void {
    addResidualTokens(
        state,
        state.conservativeOmissions
            ? residualForText(value, start)
            : residualForChars(value.length - start),
    )
}

function addOmittedResidual(state: SerializationState, count = 1): void {
    addResidualTokens(
        state,
        state.conservativeOmissions
            ? MAX_RESIDUAL_TOKENS
            : OPAQUE_TRUNCATION_RESIDUAL_TOKENS * Math.max(1, count),
    )
}

function boundedText(value: string, state: SerializationState): string {
    const length = Math.min(value.length, state.remainingTextChars)
    const visible = value.slice(0, length)
    state.remainingTextChars -= length
    if (length < value.length) {
        addTextResidual(state, value, length)
        return `[text:${visible}…${value.length - length} chars omitted]`
    }
    return `[text:${visible}]`
}

interface BoundedRecordKey {
    raw: string
    prefix: string
    omittedChars: number
    sortKey: string
}

function boundedRecordKey(raw: string, ordinal: number): BoundedRecordKey {
    const prefix = raw.slice(0, MAX_SORT_KEY_CHARS)
    const omittedChars = raw.length - prefix.length
    // Never compare the unbounded raw key. The ordinal is a deterministic tie
    // breaker for equal bounded descriptors; raw remains only for lookup.
    const sortKey = `${prefix}\u0000${raw.length}\u0000${ordinal.toString().padStart(3, "0")}`
    return { raw, prefix, omittedChars, sortKey }
}

function compareBoundedKeys(left: BoundedRecordKey, right: BoundedRecordKey): number {
    return left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0
}

function serializeModelValue(value: unknown, conservativeOmissions = false): SerializedModelValue {
    const state: SerializationState = {
        seen: new WeakSet<object>(),
        remainingTextChars: MAX_TOKENIZER_INPUT_CHARS,
        remainingTraversalNodes: MAX_TRAVERSAL_NODES,
        residualTokens: 0,
        conservativeOmissions,
    }
    let text = serializeBoundedValue(value, state, 0)
    if (text.length > MAX_TOKENIZER_INPUT_CHARS) {
        addTextResidual(state, text, MAX_TOKENIZER_INPUT_CHARS)
        text = text.slice(0, MAX_TOKENIZER_INPUT_CHARS) + "…[framing omitted]"
    }
    return { text, residualTokens: state.residualTokens }
}

/**
 * Stable, bounded semantic framing. Large text and binary payloads contribute
 * a documented size heuristic after a bounded representative prefix; no image
 * bytes are base64 encoded or sent to the tokenizer.
 */
function serializeBoundedValue(value: unknown, state: SerializationState, depth: number): string {
    if (state.remainingTraversalNodes <= 0) {
        addOmittedResidual(state)
        return "[traversal budget exhausted]"
    }
    state.remainingTraversalNodes--
    if (value === undefined) return "undefined"
    if (value === null) return "null"
    if (typeof value === "string") return boundedText(value, state)
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value)
    }
    if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`
    if (value instanceof Uint8Array) {
        addResidualTokens(
            state,
            Math.max(1, Math.ceil(value.byteLength / HEURISTIC_BYTES_PER_TOKEN)),
        )
        return `[bytes:${value.byteLength}]`
    }
    if (value instanceof ArrayBuffer) {
        addResidualTokens(
            state,
            Math.max(1, Math.ceil(value.byteLength / HEURISTIC_BYTES_PER_TOKEN)),
        )
        return `[bytes:${value.byteLength}]`
    }
    if (value instanceof Date) return `date:${value.toISOString()}`
    if (typeof value !== "object") return "[unserializable value]"
    if (depth >= MAX_TRAVERSAL_DEPTH) {
        addOmittedResidual(state)
        return "[max-depth opaque value]"
    }
    if (state.seen.has(value)) return "[cycle]"

    state.seen.add(value)
    try {
        if (Array.isArray(value)) {
            const entries: string[] = []
            const limit = Math.min(value.length, MAX_COLLECTION_ENTRIES)
            for (let index = 0; index < limit; index++) {
                if (state.remainingTraversalNodes <= 0) {
                    const omitted = value.length - index
                    addOmittedResidual(state, omitted)
                    entries.push(`[${omitted} entries omitted]`)
                    return `[${entries.join(",")}]`
                }
                entries.push(serializeBoundedValue(value[index], state, depth + 1))
            }
            if (limit < value.length) {
                addOmittedResidual(state, value.length - limit)
                entries.push(`[${value.length - limit} entries omitted]`)
            }
            return `[${entries.join(",")}]`
        }
        if (value instanceof Map) {
            const entries: string[] = []
            let count = 0
            for (const [key, entry] of value) {
                if (count >= MAX_COLLECTION_ENTRIES) {
                    break
                }
                if (state.remainingTraversalNodes <= 0) {
                    break
                }
                entries.push(
                    `${serializeBoundedValue(key, state, depth + 1)}:${serializeBoundedValue(entry, state, depth + 1)}`,
                )
                count++
            }
            if (count < value.size) {
                addOmittedResidual(state, value.size - count)
                entries.push(`[${value.size - count} entries omitted]`)
            }
            return `map:{${entries.join(",")}}`
        }
        if (value instanceof Set) {
            const entries: string[] = []
            let count = 0
            for (const entry of value) {
                if (count >= MAX_COLLECTION_ENTRIES) {
                    break
                }
                if (state.remainingTraversalNodes <= 0) {
                    break
                }
                entries.push(serializeBoundedValue(entry, state, depth + 1))
                count++
            }
            if (count < value.size) {
                addOmittedResidual(state, value.size - count)
                entries.push(`[${value.size - count} entries omitted]`)
            }
            return `set:[${entries.join(",")}]`
        }

        const record = value as Record<string, unknown>
        const keys: BoundedRecordKey[] = []
        let omittedKeyCount = 0
        for (const key in record) {
            if (!Object.prototype.hasOwnProperty.call(record, key)) continue
            if (keys.length >= MAX_COLLECTION_ENTRIES) {
                omittedKeyCount++
                continue
            }
            keys.push(boundedRecordKey(key, keys.length))
        }
        keys.sort(compareBoundedKeys)
        const entries: string[] = []
        for (let index = 0; index < keys.length; index++) {
            if (state.remainingTraversalNodes <= 0) {
                addOmittedResidual(state, keys.length - index + omittedKeyCount)
                entries.push("[record entries omitted]")
                return `{${entries.sort().join(",")}}`
            }
            const key = keys[index]!
            if (key.raw === OPAQUE_REMAINDER_MARKER) {
                addOmittedResidual(state)
                entries.push("[opaque record entries omitted]")
                continue
            }
            if (key.raw === OPAQUE_TOOL_SCHEMA_MARKER) {
                addResidualTokens(state, OPAQUE_TRUNCATION_RESIDUAL_TOKENS)
                entries.push("[unknown tool schema]")
                continue
            }
            if (key.omittedChars > 0) {
                addResidualTokens(state, residualForChars(key.omittedChars))
            }
            entries.push(
                `${boundedText(key.prefix, state)}:${serializeBoundedValue(record[key.raw], state, depth + 1)}`,
            )
        }
        if (omittedKeyCount > 0) {
            addOmittedResidual(state, omittedKeyCount)
            entries.push(`[${omittedKeyCount} additional record entries omitted]`)
        }
        return `{${entries.sort().join(",")}}`
    } catch {
        addOmittedResidual(state)
        return "[unserializable value]"
    } finally {
        state.seen.delete(value)
    }
}

/** Strip only ACP/transport identity from an opaque content-part envelope. */
function opaquePartValue(part: Record<string, unknown>): Record<string, unknown> {
    const value: Record<string, unknown> = {}
    try {
        let count = 0
        for (const key in part) {
            if (!Object.prototype.hasOwnProperty.call(part, key)) continue
            if (count >= MAX_COLLECTION_ENTRIES) {
                value[OPAQUE_REMAINDER_MARKER] = 1
                break
            }
            count++
            if (
                key === "id" ||
                key === "messageID" ||
                key === "sessionID" ||
                key === "callID" ||
                key === "__acpOrigin" ||
                key === "__acpOpaque" ||
                key === "__acpInternal" ||
                key === "providerExecuted"
            ) {
                continue
            }
            value[key] = part[key]
        }
    } catch {
        value[OPAQUE_REMAINDER_MARKER] = 1
    }
    return value
}

function partProviderPayload(part: Record<string, unknown>): Record<string, unknown> | undefined {
    const payload: Record<string, unknown> = {}
    if (part.encrypted !== undefined) payload.encrypted = part.encrypted
    if (part.native !== undefined) payload.native = part.native
    if (part.providerMetadata !== undefined) payload.providerMetadata = part.providerMetadata
    return Object.keys(payload).length > 0 ? payload : undefined
}

function withProviderPayload(
    value: Record<string, unknown>,
    provider: Record<string, unknown> | undefined,
) {
    return provider ? { ...value, provider } : value
}

function rawContentValue(part: unknown): unknown {
    if (!isRecord(part)) return { type: "opaque", value: part }
    const type = stringValue(part.type)
    const provider = partProviderPayload(part)
    if (type === "text" || type === "reasoning") {
        return withProviderPayload({ type, text: stringValue(part.text) ?? "" }, provider)
    }
    if (type === "tool-call") {
        return withProviderPayload(
            {
                type,
                name: stringValue(part.name) ?? stringValue(part.tool) ?? "tool",
                input: part.input,
            },
            provider,
        )
    }
    if (type === "tool-result") {
        return withProviderPayload(
            {
                type,
                name: stringValue(part.name) ?? stringValue(part.tool) ?? "tool",
                result: part.result,
            },
            provider,
        )
    }
    return opaquePartValue(part)
}

function rawMessageValue(message: unknown): unknown {
    if (!isRecord(message)) return { role: "unknown", content: [rawContentValue(message)] }
    const content = Array.isArray(message.content) ? message.content : [message.content]
    const value: Record<string, unknown> = {
        role: stringValue(message.role) ?? "unknown",
        content: boundedContentValues(content, rawContentValue),
    }
    // OpenCode retains these provider-owned values on native checkpoints.
    // They are not ACP identity metadata and may affect the provider's
    // effective request even when the user-visible content is short.
    if (message.native !== undefined) value.native = message.native
    if (message.providerMetadata !== undefined) value.providerMetadata = message.providerMetadata
    return value
}

function rawMessageId(message: unknown): string | undefined {
    return isRecord(message) ? stringValue(message.id) : undefined
}

function rawToolCallID(message: unknown): string | undefined {
    if (!isRecord(message) || !Array.isArray(message.content)) return undefined
    for (const part of message.content.slice(0, MAX_COLLECTION_ENTRIES)) {
        if (!isRecord(part)) continue
        const type = stringValue(part.type)
        if (type === "tool-call" || type === "tool-result") {
            const id = stringValue(part.id)
            if (id) return id
        }
    }
    return undefined
}

/**
 * Project the V2 hook's tool map to the schema-only value that OpenCode lowers
 * into the provider request. Runtime executors, options, callbacks, and
 * internal IDs are deliberately not traversed: they are not wire content.
 * Unknown definitions retain one bounded residual marker for safety.
 */
function providerToolDefinition(name: string, value: unknown): Record<string, unknown> {
    const definition: Record<string, unknown> = { type: "tool", name }
    if (!isRecord(value)) {
        definition[OPAQUE_TOOL_SCHEMA_MARKER] = 1
        return definition
    }

    const description = stringValue(value.description)
    if (description !== undefined) definition.description = description

    const input = value.input ?? value.inputSchema ?? value.parameters
    if (input !== undefined && typeof input !== "function") {
        definition.inputSchema = input
    } else {
        definition[OPAQUE_TOOL_SCHEMA_MARKER] = 1
    }

    // Direct canonical definitions may include an output schema. The V2 hook
    // map normally omits this field, but it is provider-facing when present.
    if (value.outputSchema !== undefined && typeof value.outputSchema !== "function") {
        definition.outputSchema = value.outputSchema
    }
    return definition
}

function providerToolValue(tools: unknown): unknown {
    if (Array.isArray(tools)) {
        const definitions = tools.slice(0, MAX_COLLECTION_ENTRIES).map((tool, index) => {
            const name = isRecord(tool) ? stringValue(tool.name) : undefined
            return providerToolDefinition(name ?? `tool-${index}`, tool)
        })
        if (tools.length > definitions.length) {
            definitions.push({
                [OPAQUE_REMAINDER_MARKER]: tools.length - definitions.length,
            })
        }
        return definitions
    }
    if (!isRecord(tools)) return { [OPAQUE_TOOL_SCHEMA_MARKER]: 1 }

    // Accept a direct canonical definition as well as the V2 name-keyed map.
    if (
        typeof tools.name === "string" &&
        (tools.input !== undefined || tools.inputSchema !== undefined)
    ) {
        return [providerToolDefinition(tools.name, tools)]
    }

    const keys = Object.keys(tools)
    const definitions = keys
        .slice(0, MAX_COLLECTION_ENTRIES)
        .map((name) => providerToolDefinition(name, tools[name]))
    if (keys.length > definitions.length) {
        definitions.push({ [OPAQUE_REMAINDER_MARKER]: keys.length - definitions.length })
    }
    return definitions
}

function projectedPartValue(part: unknown): unknown | undefined {
    if (!isRecord(part)) return { type: "opaque", value: part }
    const type = stringValue(part.type)
    if (type === "step-start" || type === "step-finish") return undefined
    if (type === "text" || type === "reasoning") {
        return { type, text: stringValue(part.text) ?? "" }
    }
    if (type === "tool") {
        const state = isRecord(part.state) ? part.state : {}
        return {
            type,
            name: stringValue(part.tool) ?? "tool",
            input: state.input,
            output: state.output,
            error: state.error,
        }
    }
    return opaquePartValue(part)
}

function projectedMessageValue(message: WithParts): unknown {
    return {
        role: stringValue(message.info.role) ?? "unknown",
        content: boundedContentValues(message.parts, projectedPartValue).filter(
            (part) => part !== undefined,
        ),
    }
}

function boundedContentValues(
    values: readonly unknown[],
    map: (value: unknown) => unknown | undefined,
): unknown[] {
    const limit = Math.min(values.length, MAX_COLLECTION_ENTRIES)
    const result: unknown[] = []
    for (let index = 0; index < limit; index++) {
        const value = map(values[index])
        if (value !== undefined) result.push(value)
    }
    if (limit < values.length) {
        result.push({ [OPAQUE_REMAINDER_MARKER]: values.length - limit })
    }
    return result
}

function rawMessageEntries(
    messages: readonly unknown[],
    counter: RequestTokenCounter,
    callOwners?: ReadonlyMap<string, string>,
    knownProjectedIds?: ReadonlySet<string>,
    outgoingNormalizedMessageIds?: readonly (string | undefined)[],
): MessageTokenEntry[] {
    const entries: MessageTokenEntry[] = []
    const groupedIndexes = new Map<string, number>()
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        const messageID = rawMessageId(message)
        const toolCallID = rawToolCallID(message)
        const callOwner = toolCallID ? callOwners?.get(toolCallID) : undefined
        // A supplied projection sidecar is authoritative. In particular, an
        // ID-less system with an explicit owner must not also become an
        // uncorrelated raw prefix; an explicit undefined stays unowned.
        const id =
            outgoingNormalizedMessageIds !== undefined
                ? outgoingNormalizedMessageIds[index]
                : messageID && knownProjectedIds?.has(messageID)
                  ? messageID
                  : (callOwner ?? messageID)
        const tokens = counter.count(rawMessageValue(message))
        // A canonical tool result is a separate role=tool message, but ACP's
        // normalized tool part owns the same call. Group them only when a V2
        // projection supplied that owner; direct wire estimates remain literal.
        if (callOwners && id) {
            const existing = groupedIndexes.get(id)
            if (existing !== undefined) {
                entries[existing]!.tokens += tokens
                continue
            }
            groupedIndexes.set(id, entries.length)
        }
        entries.push({ id, tokens })
    }
    return entries
}

function projectedMessageEntries(
    messages: readonly WithParts[],
    counter: RequestTokenCounter,
): ProjectedMessageTokenEntry[] {
    return messages.map((message) => ({
        id: stringValue(message.info.id),
        tokens: counter.count(projectedMessageValue(message)),
        callIDs: message.parts.slice(0, MAX_COLLECTION_ENTRIES).flatMap((part) => {
            if (!isRecord(part) || part.type !== "tool") return []
            const callID = stringValue(part.callID)
            return callID ? [callID] : []
        }),
    }))
}

interface SourceResidualTokens {
    /** Raw request messages without an exact projected owner stay forever. */
    uncorrelatedTokens: number
    /** Known source residuals are retained only while that source remains. */
    bySourceID: ReadonlyMap<string, number>
}

/**
 * Preserve raw excess per exact source rather than one aggregate delta.
 *
 * Uncorrelated provider/native values have no safe ownership proof, so they
 * remain in every estimate. Known projected sources retain their raw residual
 * only while the matching normalized source remains after prune.
 */
function sourceResidualTokens(
    raw: readonly MessageTokenEntry[],
    projected: readonly MessageTokenEntry[],
): SourceResidualTokens {
    const projectedByID = new Map(
        projected.flatMap((entry) => (entry.id ? [[entry.id, entry.tokens] as const] : [])),
    )
    const bySourceID = new Map<string, number>()
    let uncorrelatedTokens = 0

    for (const entry of raw) {
        const projectedTokens = entry.id ? projectedByID.get(entry.id) : undefined
        if (projectedTokens === undefined || !entry.id) {
            // Do not guess by source position: an opaque native prefix could be
            // paired with an unrelated mutable suffix and disappear after prune.
            uncorrelatedTokens += entry.tokens
            continue
        }
        const residual = Math.max(0, entry.tokens - projectedTokens)
        if (residual > 0) bySourceID.set(entry.id, residual)
    }

    return { uncorrelatedTokens, bySourceID }
}

function systemPartValue(part: unknown): unknown {
    if (isRecord(part) && typeof part.text === "string") {
        return { type: "system", text: part.text }
    }
    return isRecord(part) ? opaquePartValue(part) : { type: "opaque-system", value: part }
}

function estimateV2WireTokensWithCounter(
    input: V2WireTokenInput,
    counter: RequestTokenCounter,
    messageEntries = rawMessageEntries(input.messages, counter),
): V2WireTokenEstimate {
    const systemTokens = input.system.reduce<number>(
        (total, part) => total + counter.count(systemPartValue(part), true),
        0,
    )
    const messageTokens = messageEntries.reduce((total, entry) => total + entry.tokens, 0)
    const toolTokens =
        input.tools === undefined ? 0 : counter.count(providerToolValue(input.tools), true)
    return {
        systemTokens,
        toolTokens,
        messageTokens,
        totalTokens: systemTokens + toolTokens + messageTokens,
    }
}

/** Estimate exactly one V2 event shape, keeping system, messages, and tools disjoint. */
export function estimateV2WireTokens(input: V2WireTokenInput): V2WireTokenEstimate {
    return estimateV2WireTokensWithCounter(input, new RequestTokenCounter())
}

/**
 * Count ACP's mutable projection from model-visible semantics only. ACP IDs,
 * session IDs, origin markers, and step parts are algorithm bookkeeping rather
 * than provider prompt content.
 */
export function estimateV2ProjectedMessageTokens(messages: readonly WithParts[]): number {
    const counter = new RequestTokenCounter()
    return projectedMessageEntries(messages, counter).reduce(
        (total, entry) => total + entry.tokens,
        0,
    )
}

export function createV2TokenBudget(input: V2TokenBudgetInput): V2TokenBudget {
    const counter = new RequestTokenCounter()
    const safetyCounter = new RequestTokenCounter(true)
    const normalizedEntries = projectedMessageEntries(input.normalizedMessages, counter)
    const callOwners = new Map<string, string>()
    const knownProjectedIds = new Set<string>()
    normalizedEntries.forEach((entry) => {
        if (!entry.id) return
        knownProjectedIds.add(entry.id)
        entry.callIDs.forEach((callID) => callOwners.set(callID, entry.id!))
    })
    const rawEntries = rawMessageEntries(
        input.messages,
        counter,
        callOwners,
        knownProjectedIds,
        input.outgoingNormalizedMessageIds,
    )
    const wire = estimateV2WireTokensWithCounter(input, counter, rawEntries)
    const safetyNormalizedEntries = projectedMessageEntries(input.normalizedMessages, safetyCounter)
    const safetyRawEntries = rawMessageEntries(
        input.messages,
        safetyCounter,
        callOwners,
        knownProjectedIds,
        input.outgoingNormalizedMessageIds,
    )
    const safetyWire = estimateV2WireTokensWithCounter(input, safetyCounter, safetyRawEntries)
    const normalizedMessageTokens = normalizedEntries.reduce(
        (total, entry) => total + entry.tokens,
        0,
    )
    const residuals = sourceResidualTokens(rawEntries, normalizedEntries)
    const safetyResiduals = sourceResidualTokens(safetyRawEntries, safetyNormalizedEntries)
    const overheadTokens = wire.systemTokens + wire.toolTokens
    const safetyOverheadTokens = safetyWire.systemTokens + safetyWire.toolTokens

    const estimateCurrent = (
        messages: readonly WithParts[],
        currentCounter: RequestTokenCounter,
        currentOverheadTokens: number,
        currentResiduals: SourceResidualTokens,
    ): number => {
        const visibleSourceIDs = new Set(
            messages
                .map((message) => stringValue(message.info.id))
                .filter((id): id is string => id !== undefined),
        )
        let visibleResidualTokens = currentResiduals.uncorrelatedTokens
        for (const [sourceID, tokens] of currentResiduals.bySourceID) {
            if (visibleSourceIDs.has(sourceID)) visibleResidualTokens += tokens
        }
        return (
            currentOverheadTokens +
            visibleResidualTokens +
            projectedMessageEntries(messages, currentCounter).reduce(
                (total, entry) => total + entry.tokens,
                0,
            )
        )
    }

    return {
        ...wire,
        overheadTokens,
        safetyOverheadTokens,
        normalizedMessageTokens,
        estimateMessages(messages) {
            return estimateCurrent(messages, counter, overheadTokens, residuals)
        },
        estimateSafetyMessages(messages) {
            return estimateCurrent(messages, safetyCounter, safetyOverheadTokens, safetyResiduals)
        },
    }
}

/**
 * Build the three estimates needed by the V2 transform.
 *
 * `growthEstimate` stays in stable semantic units for persisted cadence state.
 * `safetyEstimate` applies an upward-only provider calibration plus framing
 * margin for truncation/hard-guard decisions. A valid OpenCode provider total
 * is used as the nudge baseline; only the bounded semantic delta is added to it.
 * This keeps provider/tokenizer variance from becoming a user-visible
 * "critically full" claim while still making compression and new ACP text
 * visible to the next threshold decision.
 */
export function createV2RequestTokenAccounting(
    budget: V2TokenBudget,
    baselineMessages: readonly WithParts[],
    providerReportedTokens: number | undefined,
): V2RequestTokenAccounting {
    const semanticBaseline = budget.estimateMessages(baselineMessages)
    const providerIsUsable =
        typeof providerReportedTokens === "number" &&
        Number.isFinite(providerReportedTokens) &&
        providerReportedTokens > 0 &&
        semanticBaseline > 0
    const calibrationRatio = providerIsUsable ? providerReportedTokens / semanticBaseline : 1
    const growthEstimate = (messages: readonly WithParts[]) => budget.estimateMessages(messages)
    const safetyCalibrationRatio = Math.max(1, calibrationRatio)
    const safetyOverheadTokens =
        Math.ceil(budget.safetyOverheadTokens * safetyCalibrationRatio * SAFETY_ESTIMATE_MARGIN) +
        SAFETY_ESTIMATE_FIXED_TOKENS
    const safetyEstimate = (messages: readonly WithParts[]) =>
        Math.max(
            0,
            Math.ceil(
                budget.estimateSafetyMessages(messages) *
                    safetyCalibrationRatio *
                    SAFETY_ESTIMATE_MARGIN,
            ) + SAFETY_ESTIMATE_FIXED_TOKENS,
        )
    const nudgeEstimate = (messages: readonly WithParts[]) => {
        if (!providerIsUsable) return growthEstimate(messages)
        const semanticDelta = growthEstimate(messages) - semanticBaseline
        return Math.max(0, Math.round(providerReportedTokens + semanticDelta * calibrationRatio))
    }
    return {
        source: providerIsUsable ? "provider-calibrated" : "semantic-estimate",
        calibrationRatio,
        overheadTokens: Math.max(0, Math.round(budget.overheadTokens * calibrationRatio)),
        safetyOverheadTokens,
        growthEstimate,
        safetyEstimate,
        nudgeEstimate,
        estimateMessages: nudgeEstimate,
    }
}
