import { Message as AiMessage } from "@opencode/ai"
import type { ContentPart as AiContentPart, Message as AiMessageValue } from "@opencode/ai"
import type { WithParts } from "../../state"
import type {
    Part,
    PointerKey,
    V2ContentOrigin,
    V2ContextPatch,
    V2OutgoingPointer,
    V2PatchRejected,
    V2PatchRejection,
    V2Projection,
    V2ProvenanceEntry,
    V2PatchResult,
} from "./types"
import {
    aiContent,
    aiMessageId,
    aiRole,
    canonical,
    contentId,
    contentText,
    contentType,
    fingerprintOutgoing,
    isAcpOwnedId,
    isRecord,
    projectionMarker,
    stringValue,
} from "./shared"

interface AppliedPatchState {
    /** Arrays returned by ACP's own successful patches. */
    outputs: WeakSet<object>
    /** Latest ACP-created content object for each original pointer. */
    parts: Map<PointerKey, AiContentPart>
    /** Original pointers intentionally removed by an ACP patch. */
    removed: Set<PointerKey>
    /** Provider-owned message objects retained by an ACP patch. */
    opaqueMessages: Set<object>
}

const appliedPatchStates = new WeakMap<object, AppliedPatchState>()

function pointerKey(pointer: V2OutgoingPointer): PointerKey | undefined {
    return pointer.contentIndex === undefined
        ? undefined
        : `${pointer.messageIndex}:${pointer.contentIndex}`
}

function currentContainsPart(
    messages: readonly AiMessageValue[],
    expected: AiContentPart,
): boolean {
    return messages.some((message) => aiContent(message).some((part) => part === expected))
}

function finalPartForReference(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    reference: { pointer: V2OutgoingPointer; part: AiContentPart },
): AiContentPart | undefined {
    const originalMessage = projection.originalMessages[reference.pointer.messageIndex]
    const originalMessageID = aiMessageId(originalMessage)
    let message = originalMessageID
        ? messages.find((candidate) => aiMessageId(candidate) === originalMessageID)
        : undefined

    const originalType = contentType(reference.part)
    const originalPartID = contentId(reference.part)
    if (!message && originalPartID) {
        message = messages.find((candidate) =>
            aiContent(candidate).some(
                (part) => contentType(part) === originalType && contentId(part) === originalPartID,
            ),
        )
    }
    if (!message) message = messages[reference.pointer.messageIndex]
    if (!message) return undefined

    const indexed =
        reference.pointer.contentIndex === undefined
            ? undefined
            : aiContent(message)[reference.pointer.contentIndex]
    if (indexed && (indexed === reference.part || contentType(indexed) === originalType)) {
        if (!originalPartID || contentId(indexed) === originalPartID) return indexed
    }
    if (originalPartID) {
        return aiContent(message).find(
            (part) => contentType(part) === originalType && contentId(part) === originalPartID,
        )
    }
    return indexed
}

function currentPointerForProjection(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    pointer: V2OutgoingPointer,
): V2OutgoingPointer {
    const originalMessage = projection.originalMessages[pointer.messageIndex]
    const originalMessageID = aiMessageId(originalMessage)
    let messageIndex = originalMessageID
        ? messages.findIndex((message) => aiMessageId(message) === originalMessageID)
        : -1
    const originalPart =
        pointer.contentIndex === undefined
            ? undefined
            : aiContent(originalMessage)[pointer.contentIndex]
    if (messageIndex < 0 && originalPart) {
        const originalPartType = contentType(originalPart)
        const originalPartID = contentId(originalPart)
        if (originalPartID) {
            messageIndex = messages.findIndex((message) =>
                aiContent(message).some(
                    (part) =>
                        contentType(part) === originalPartType &&
                        contentId(part) === originalPartID,
                ),
            )
        }
    }
    return {
        messageIndex: messageIndex >= 0 ? messageIndex : pointer.messageIndex,
        contentIndex: pointer.contentIndex,
    }
}

function originalPartsForOrigin(
    projection: V2Projection,
    origin: V2ContentOrigin,
): AiContentPart[] {
    const references = origin.originalContent ?? []
    if (references.length > 0) return references.map((reference) => reference.part)
    return origin.outgoing.flatMap((pointer) => {
        if (pointer.contentIndex === undefined) return []
        const part = aiContent(projection.originalMessages[pointer.messageIndex])[
            pointer.contentIndex
        ]
        return part ? [part] : []
    })
}

function reject(code: V2PatchRejection["code"], message: string): V2PatchRejected {
    return { accepted: false, ok: false, rejection: { code, message } }
}

function transformedMessageId(message: WithParts): string | undefined {
    return isRecord(message.info) ? stringValue(message.info.id) : undefined
}

function transformedPartState(part: Part): Record<string, unknown> | undefined {
    const value: unknown = part
    if (!isRecord(value)) return undefined
    return isRecord(value.state) ? value.state : undefined
}

function stateStatus(part: Part): string | undefined {
    return stringValue(transformedPartState(part)?.status)
}

function stateInput(part: Part): unknown {
    return transformedPartState(part)?.input
}

function stateOutput(part: Part): string | undefined {
    return stringValue(transformedPartState(part)?.output)
}

function cloneAiMessage(
    message: AiMessageValue,
    content: readonly AiContentPart[],
): AiMessageValue {
    return Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
        content: [...content],
    }) as AiMessageValue
}

function cloneAiContent(part: AiContentPart, update: Record<string, unknown>): AiContentPart {
    return { ...part, ...update } as AiContentPart
}

function setContentPart(
    originals: readonly AiMessageValue[],
    replacements: Map<number, AiMessageValue>,
    pointer: V2OutgoingPointer,
    update: Record<string, unknown>,
): void {
    if (pointer.contentIndex === undefined) return
    const message = replacements.get(pointer.messageIndex) ?? originals[pointer.messageIndex]
    if (!message) return
    const content = [...aiContent(message)] as AiContentPart[]
    const part = content[pointer.contentIndex]
    if (!part) return
    content[pointer.contentIndex] = cloneAiContent(part, update)
    replacements.set(pointer.messageIndex, cloneAiMessage(message, content))
}

function removeContentPointers(
    removed: Set<PointerKey>,
    pointers: readonly V2OutgoingPointer[],
): void {
    for (const pointer of pointers) {
        if (pointer.contentIndex !== undefined)
            removed.add(`${pointer.messageIndex}:${pointer.contentIndex}`)
    }
}

function normalizedMessagesById(
    messages: readonly WithParts[],
): Map<string, WithParts> | V2PatchRejected {
    const result = new Map<string, WithParts>()
    for (const message of messages) {
        const id = transformedMessageId(message)
        if (!id) return reject("unknown-origin", "A transformed message has no stable ID")
        if (result.has(id))
            return reject("duplicate-message-id", `Transformed message ID ${id} is duplicated`)
        result.set(id, message)
    }
    return result
}

function transformedPartsByOrigin(message: WithParts): Map<string, Part> | V2PatchRejected {
    const result = new Map<string, Part>()
    for (const part of message.parts ?? []) {
        const key = projectionMarker(part)
        if (!key) continue
        if (result.has(key)) return reject("ambiguous-origin", `Origin ${key} is duplicated`)
        result.set(key, part)
    }
    return result
}

function validateTransformedCallIds(messages: readonly WithParts[]): V2PatchRejected | undefined {
    const callIds = new Set<string>()
    for (const message of messages) {
        for (const part of message.parts ?? []) {
            if (part.type !== "tool") continue
            const callID = stringValue(part.callID)
            if (!callID) continue
            if (callIds.has(callID))
                return reject("duplicate-call-id", `Call ID ${callID} is duplicated`)
            callIds.add(callID)
        }
    }
    return undefined
}

function validateTransformedOrder(
    projection: V2Projection,
    messages: readonly WithParts[],
): V2PatchRejected | undefined {
    const sourceIndexById = new Map(
        projection.entries
            .filter((entry) => entry.normalizedMessageId)
            .map((entry) => [entry.normalizedMessageId!, entry.sourceIndex]),
    )
    let previousSourceIndex = -1
    for (const message of messages) {
        const id = transformedMessageId(message)
        if (!id) continue
        const sourceIndex = sourceIndexById.get(id)
        if (sourceIndex !== undefined) {
            if (sourceIndex < previousSourceIndex) {
                return reject("invalid-order", "Transformed source messages are not monotonic")
            }
            previousSourceIndex = sourceIndex
        }
        const entry = projection.entries.find((candidate) => candidate.normalizedMessageId === id)
        if (!entry) continue
        const expected = entry.origins.map((origin) => origin.key)
        let expectedIndex = 0
        for (const part of message.parts ?? []) {
            const key = projectionMarker(part)
            if (!key) continue
            const position = expected.indexOf(key)
            if (position < 0) continue
            if (position < expectedIndex) {
                return reject("invalid-order", `Origin order changed for message ${id}`)
            }
            expectedIndex = position + 1
        }
    }
    return undefined
}

function validateBaseline(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
): V2PatchRejected | undefined {
    if (!projection.valid) {
        return reject(
            "projection-invalid",
            projection.rejection?.message ?? "V2 projection is invalid",
        )
    }
    if (projection.fingerprint !== projection.baselineFingerprint) {
        return reject(
            "fingerprint-mismatch",
            "V2 projection fingerprint was changed after normalization",
        )
    }
    const applied = appliedPatchStates.get(projection)
    const isOwnAppliedOutput = applied?.outputs.has(messages as object) === true
    const appliedContentMatches =
        applied !== undefined &&
        [...applied.parts.values()].every((part) => currentContainsPart(messages, part)) &&
        [...applied.opaqueMessages].every((message) => messages.includes(message as AiMessageValue))
    const currentFingerprint = fingerprintOutgoing(messages)
    if (
        currentFingerprint !== projection.outgoingFingerprint &&
        !isOwnAppliedOutput &&
        !appliedContentMatches
    ) {
        return reject(
            "fingerprint-mismatch",
            "Lowered V2 message identities no longer match the projection",
        )
    }
    for (const entry of projection.entries) {
        for (const origin of entry.origins) {
            for (const reference of origin.originalContent ?? []) {
                const key = pointerKey(reference.pointer)
                if (key === undefined) continue
                if (isOwnAppliedOutput || appliedContentMatches) {
                    const patchedPart = applied.parts.get(key)
                    if (patchedPart !== undefined) {
                        if (!currentContainsPart(messages, patchedPart)) {
                            return reject(
                                origin.opaque ? "opaque-origin" : "fingerprint-mismatch",
                                origin.opaque
                                    ? "Provider-owned opaque content changed before patching"
                                    : "Lowered patchable content changed before patching",
                            )
                        }
                        continue
                    }
                    if (applied.removed.has(key)) continue
                }

                const message = messages[reference.pointer.messageIndex]
                const part =
                    reference.pointer.contentIndex === undefined
                        ? undefined
                        : aiContent(message)[reference.pointer.contentIndex]
                if (part !== reference.part) {
                    return reject(
                        origin.opaque ? "opaque-origin" : "fingerprint-mismatch",
                        origin.opaque
                            ? "Provider-owned opaque content changed before patching"
                            : "Lowered patchable content changed before patching",
                    )
                }
            }
        }
    }
    const ids = new Set<string>()
    const calls = new Set<string>()
    const results = new Set<string>()
    const mappedCallIds = new Set(projection.entries.flatMap((entry) => entry.toolCallIds))
    for (const message of messages) {
        const id = aiMessageId(message)
        if (id) {
            if (ids.has(id))
                return reject("duplicate-message-id", `Outgoing message ID ${id} is duplicated`)
            ids.add(id)
        }
        for (const part of aiContent(message)) {
            const type = contentType(part)
            if ((type === "tool-call" || type === "tool-result") && contentId(part)) {
                const callID = contentId(part)!
                if (type === "tool-call") {
                    if (calls.has(callID))
                        return reject("duplicate-call-id", `Call ID ${callID} is duplicated`)
                    calls.add(callID)
                } else if (mappedCallIds.has(callID)) {
                    if (results.has(callID))
                        return reject("duplicate-call-id", `Tool result ID ${callID} is duplicated`)
                    results.add(callID)
                }
            }
        }
    }
    for (const origin of projection.outgoing) {
        if (!origin.opaque && (origin.opaqueContent?.size ?? 0) === 0) continue
        if (isOwnAppliedOutput || appliedContentMatches) {
            if (
                origin.opaqueMessage !== undefined &&
                !applied.opaqueMessages.has(origin.opaqueMessage as object)
            ) {
                return reject(
                    "opaque-origin",
                    "Provider-owned opaque message changed before patching",
                )
            }
        } else {
            const message = messages[origin.messageIndex]
            if (!message) return reject("opaque-origin", "An opaque outgoing message disappeared")
            if (origin.opaqueMessage !== undefined && message !== origin.opaqueMessage) {
                return reject(
                    "opaque-origin",
                    "Provider-owned opaque message changed before patching",
                )
            }
        }
        for (const [contentIndex, originalPart] of origin.opaqueContent ?? []) {
            if (!isOwnAppliedOutput && !appliedContentMatches) {
                const message = messages[origin.messageIndex]
                const part = aiContent(message)[contentIndex]
                if (!part || part !== originalPart) {
                    return reject(
                        "opaque-origin",
                        "Provider-owned opaque content changed before patching",
                    )
                }
            }
        }
    }
    return undefined
}

function outputCallIds(messages: readonly AiMessageValue[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) {
        for (const part of aiContent(message)) {
            if (contentType(part) === "tool-call" && contentId(part)) ids.add(contentId(part)!)
        }
    }
    return ids
}

function outputResultIds(messages: readonly AiMessageValue[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) {
        for (const part of aiContent(message)) {
            if (contentType(part) === "tool-result" && contentId(part)) ids.add(contentId(part)!)
        }
    }
    return ids
}

function validateFinalMessages(
    messages: readonly AiMessageValue[],
    mappedCallIds: ReadonlySet<string>,
    removedCallIds: ReadonlySet<string>,
): V2PatchRejected | undefined {
    const ids = new Set<string>()
    const calls = outputCallIds(messages)
    const results = outputResultIds(messages)
    const resultCounts = new Map<string, number>()
    for (const message of messages) {
        const id = aiMessageId(message)
        if (id) {
            if (ids.has(id))
                return reject("duplicate-message-id", `Final message ID ${id} is duplicated`)
            ids.add(id)
        }
        try {
            // Message.make is the public @opencode/ai 2.0.3 schema/runtime
            // validator. The returned class is not used, so provider-owned
            // objects retain their original identity and unknown extensions.
            AiMessage.make(message)
        } catch (error) {
            return reject(
                "invalid-schema",
                `Final V2 message schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
        for (const part of aiContent(message)) {
            if (contentType(part) !== "tool-result") continue
            const resultID = contentId(part)
            if (!resultID || !mappedCallIds.has(resultID)) continue
            const count = (resultCounts.get(resultID) ?? 0) + 1
            resultCounts.set(resultID, count)
            if (count > 1) {
                return reject("duplicate-call-id", `Tool result ID ${resultID} is duplicated`)
            }
        }
    }
    for (const callID of mappedCallIds) {
        if (removedCallIds.has(callID)) {
            if (calls.has(callID) || results.has(callID)) {
                return reject(
                    "invalid-tool-pair",
                    `Removed call ${callID} still has a call or result`,
                )
            }
        }
    }
    for (const callID of results) {
        if (mappedCallIds.has(callID) && !calls.has(callID)) {
            return reject("invalid-tool-pair", `Mapped tool result ${callID} has no call`)
        }
    }
    return undefined
}

function sourceOrderIsMonotonic(
    projection: V2Projection,
    retainedEntries: readonly V2ProvenanceEntry[],
): V2PatchRejected | undefined {
    let previous = -1
    for (const entry of retainedEntries) {
        const indices = entry.outgoingMessageIndices
            .filter((index) => index >= 0)
            .sort((a, b) => a - b)
        if (indices.length === 0) continue
        if (indices[0] < previous) {
            return reject(
                "invalid-order",
                "Retained source messages no longer have monotonic lowered order",
            )
        }
        previous = indices[indices.length - 1]
    }
    void projection
    return undefined
}

function nearestInsertionIndex(
    projection: V2Projection,
    transformed: readonly WithParts[],
    transformedIndex: number,
    retainedIds: ReadonlySet<string>,
    removedOutgoing: ReadonlySet<number>,
): number {
    const hasLaterRetainedSource = transformed.slice(transformedIndex + 1).some((message) => {
        const id = transformedMessageId(message)
        return id !== undefined && retainedIds.has(id)
    })
    if (!hasLaterRetainedSource) return projection.originalMessages.length

    for (let index = transformedIndex - 1; index >= 0; index--) {
        const id = transformedMessageId(transformed[index])
        if (!id || !retainedIds.has(id)) continue
        const entry = projection.entries.find((candidate) => candidate.normalizedMessageId === id)
        const outgoing = entry?.outgoingMessageIndices
            .filter((candidate) => !removedOutgoing.has(candidate))
            .sort((left, right) => right - left)
        if (outgoing && outgoing.length > 0) return outgoing[0] + 1
    }
    for (let index = transformedIndex + 1; index < transformed.length; index++) {
        const id = transformedMessageId(transformed[index])
        if (!id || !retainedIds.has(id)) continue
        const entry = projection.entries.find((candidate) => candidate.normalizedMessageId === id)
        const outgoing = entry?.outgoingMessageIndices
            .filter((candidate) => !removedOutgoing.has(candidate))
            .sort((left, right) => left - right)
        if (outgoing && outgoing.length > 0) return outgoing[0]
    }
    return projection.originalMessages.length
}

function makeInsertedMessage(message: WithParts): AiMessageValue | V2PatchRejected {
    const id = transformedMessageId(message)
    if (!id || !isAcpOwnedId(id)) {
        return reject("invalid-insertion", "Only ACP-owned deterministic IDs may be inserted")
    }
    const role = isRecord(message.info) && message.info.role === "assistant" ? "assistant" : "user"
    const parts = (message.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text" as const, text: stringValue(part.text) ?? "" }))
    if (parts.length === 0) return reject("invalid-insertion", `ACP insertion ${id} has no text`)
    try {
        return AiMessage.make({ id, role, content: parts })
    } catch (error) {
        return reject(
            "invalid-insertion",
            `ACP insertion ${id} is not a valid @opencode/ai message: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/**
 * Compare the original algorithm projection with its transformed copy and
 * apply only representable edits to the original provider-ready messages.
 *
 * This function never mutates `projection.originalMessages` or the input array.
 * It returns a complete replacement array on success and a typed rejection on
 * ambiguity/fingerprint/opaque-boundary failure.
 */
export function applyV2ContextPatch(
    projection: V2Projection,
    transformed: readonly WithParts[],
    currentMessages: readonly AiMessageValue[] = projection.originalMessages,
): V2PatchResult {
    try {
        const baselineError = validateBaseline(projection, currentMessages)
        if (baselineError) return baselineError
        const transformedMap = normalizedMessagesById(transformed)
        if ("accepted" in transformedMap) return transformedMap
        const transformedCallError = validateTransformedCallIds(transformed)
        if (transformedCallError) return transformedCallError
        const transformedOrderError = validateTransformedOrder(projection, transformed)
        if (transformedOrderError) return transformedOrderError

        const sourceEntries = projection.entries.filter((entry) => entry.normalizedMessageId)
        const knownSourceIds = new Set(sourceEntries.map((entry) => entry.normalizedMessageId!))
        const removedMessages = new Set<number>()
        const removedContent = new Set<PointerKey>()
        const removedContentParts = new Set<AiContentPart>()
        const replacements = new Map<number, AiMessageValue>()
        const removedMessageIds: string[] = []
        const removedCallIds: string[] = []
        const editedMessageIds = new Set<string>()
        const editedCallIds = new Set<string>()
        const mappedCallIds = new Set<string>()

        for (const entry of sourceEntries) {
            const normalizedId = entry.normalizedMessageId!
            for (const callID of entry.toolCallIds) mappedCallIds.add(callID)
            const transformedMessage = transformedMap.get(normalizedId)
            if (!transformedMessage) {
                if (entry.outgoingMessageIndices.length === 0) continue
                if (!entry.allowSourceRemoval || (entry.opaque && entry.providerCheckpoint)) {
                    return reject(
                        "opaque-origin",
                        `Cannot remove opaque source message ${entry.sourceMessageId ?? normalizedId}`,
                    )
                }
                for (const messageIndex of entry.outgoingMessageIndices)
                    removedMessages.add(messageIndex)
                removedMessageIds.push(entry.sourceMessageId ?? normalizedId)
                for (const origin of entry.origins) {
                    for (const part of originalPartsForOrigin(projection, origin)) {
                        removedContentParts.add(part)
                    }
                }
                for (const callID of entry.toolCallIds) removedCallIds.push(callID)
                continue
            }

            const originalNormalized = projection.messages.find(
                (message) => transformedMessageId(message) === normalizedId,
            )
            if (
                originalNormalized &&
                isRecord(originalNormalized.info) &&
                isRecord(transformedMessage.info) &&
                originalNormalized.info.role !== transformedMessage.info.role
            ) {
                return reject(
                    "ambiguous-origin",
                    `Role changed for normalized message ${normalizedId}`,
                )
            }
            const originalPartsByOrigin = new Map<string, V2ContentOrigin>()
            for (const origin of entry.origins) originalPartsByOrigin.set(origin.key, origin)
            const transformedPartsResult = transformedPartsByOrigin(transformedMessage)
            if ("accepted" in transformedPartsResult) return transformedPartsResult
            const transformedParts = transformedPartsResult
            for (const origin of entry.origins) {
                const transformedPart = transformedParts.get(origin.key)
                if (!transformedPart) {
                    if (origin.kind === "tool" && origin.callId) {
                        removeContentPointers(removedContent, origin.outgoing)
                        for (const part of originalPartsForOrigin(projection, origin)) {
                            removedContentParts.add(part)
                        }
                        removedCallIds.push(origin.callId)
                        continue
                    }
                    if (origin.opaque) {
                        return reject("opaque-origin", `Opaque origin ${origin.key} was removed`)
                    }
                    removeContentPointers(removedContent, origin.outgoing)
                    for (const part of originalPartsForOrigin(projection, origin)) {
                        removedContentParts.add(part)
                    }
                    continue
                }
                if (origin.kind === "tool") {
                    const transformedValue: unknown = transformedPart
                    const transformedTool = isRecord(transformedValue)
                        ? stringValue(transformedValue.tool)
                        : undefined
                    const transformedCallID = isRecord(transformedValue)
                        ? stringValue(transformedValue.callID)
                        : undefined
                    if (
                        transformedTool !== origin.normalizedToolName ||
                        transformedCallID !== origin.callId
                    ) {
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} identity changed`,
                        )
                    }
                    const status = stateStatus(transformedPart)
                    if (!status) {
                        return reject(
                            "unknown-origin",
                            `Tool ${origin.callId ?? "unknown"} has no valid state`,
                        )
                    }
                    if (
                        status !==
                        stateStatus(
                            projection.messages
                                .find((message) => transformedMessageId(message) === normalizedId)
                                ?.parts.find((part) => projectionMarker(part) === origin.key) ??
                                transformedPart,
                        )
                    ) {
                        // A status transition changes whether lowering emits a
                        // result. ACP cannot synthesize provider state safely.
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} changed state`,
                        )
                    }
                    const input = stateInput(transformedPart)
                    if (canonical(input) !== origin.normalizedInput && !origin.call) {
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} has no lowered call`,
                        )
                    }
                    if (origin.call && canonical(input) !== origin.normalizedInput) {
                        setContentPart(
                            currentMessages,
                            replacements,
                            currentPointerForProjection(projection, currentMessages, origin.call),
                            {
                                input: isRecord(input) ? input : {},
                            },
                        )
                        editedCallIds.add(origin.callId ?? "")
                    }
                    const output = stateOutput(transformedPart)
                    if (
                        origin.normalizedOutput !== undefined &&
                        output !== origin.normalizedOutput
                    ) {
                        if (!origin.result || !origin.representableOutput) {
                            return reject(
                                "opaque-origin",
                                `Tool result ${origin.callId ?? "unknown"} is opaque`,
                            )
                        }
                        const resultPointer = currentPointerForProjection(
                            projection,
                            currentMessages,
                            origin.result,
                        )
                        const resultMessage =
                            replacements.get(resultPointer.messageIndex) ??
                            currentMessages[resultPointer.messageIndex]
                        const resultPart =
                            resultPointer.contentIndex === undefined
                                ? undefined
                                : aiContent(resultMessage)[resultPointer.contentIndex]
                        const resultValue =
                            resultPart === undefined
                                ? undefined
                                : (resultPart as unknown as Record<string, unknown>).result
                        if (!isRecord(resultValue)) {
                            return reject(
                                "opaque-origin",
                                `Tool result ${origin.callId ?? "unknown"} is unavailable`,
                            )
                        }
                        setContentPart(currentMessages, replacements, resultPointer, {
                            result: { ...resultValue, value: output ?? "" },
                        })
                        editedCallIds.add(origin.callId ?? "")
                    }
                    const transformedError = stringValue(
                        transformedPartState(transformedPart)?.error,
                    )
                    if (
                        origin.normalizedError !== undefined &&
                        transformedError !== origin.normalizedError
                    ) {
                        return reject(
                            "opaque-origin",
                            `Tool error ${origin.callId ?? "unknown"} is opaque`,
                        )
                    }
                    continue
                }
                const transformedText = contentText(transformedPart)
                if (transformedText === undefined) {
                    return reject("unknown-origin", `Origin ${origin.key} no longer has text`)
                }
                if (origin.opaque) {
                    if (transformedText !== origin.normalizedText) {
                        return reject("opaque-origin", `Opaque origin ${origin.key} was changed`)
                    }
                    continue
                }
                if (transformedText === origin.normalizedText) continue
                if (origin.outgoing.length !== 1 || origin.outgoing[0].contentIndex === undefined) {
                    return reject(
                        "ambiguous-origin",
                        `Text origin ${origin.key} has no unique lowered part`,
                    )
                }
                setContentPart(
                    currentMessages,
                    replacements,
                    currentPointerForProjection(projection, currentMessages, origin.outgoing[0]),
                    { text: transformedText },
                )
                editedMessageIds.add(normalizedId)
            }

            // ACP nudge/id parts are deliberately not source origins. They may
            // be inserted into a known message, but only as plain ACP text.
            const sourceOriginKeys = new Set(originalPartsByOrigin.keys())
            for (const part of transformedMessage.parts ?? []) {
                const key = projectionMarker(part)
                if (key && sourceOriginKeys.has(key)) continue
                if (part.type === "step-start" || part.type === "step-finish") continue
                if (
                    part.type !== "text" ||
                    !stringValue(part.text) ||
                    !(
                        stringValue(part.id)?.startsWith("prt_dcp_text_") ||
                        stringValue(part.id)?.startsWith("prt_dcp_summary_")
                    )
                ) {
                    return reject(
                        "unknown-origin",
                        `Transformed part in ${normalizedId} has no provenance`,
                    )
                }
                if (entry.opaque) continue
                const target = entry.outgoingMessageIndices.find(
                    (index) => !removedMessages.has(index),
                )
                if (target === undefined)
                    return reject("invalid-insertion", `No target for ACP part ${part.id}`)
                const targetMessage = replacements.get(target) ?? currentMessages[target]
                const content = [...aiContent(targetMessage)] as AiContentPart[]
                let insertionIndex = content.length
                if (aiRole(targetMessage) === "assistant") {
                    const firstTool = entry.origins
                        .filter(
                            (origin) =>
                                origin.kind === "tool" && origin.call?.messageIndex === target,
                        )
                        .map((origin) => origin.call?.contentIndex)
                        .filter((index): index is number => index !== undefined)
                        .sort((left, right) => left - right)[0]
                    if (firstTool !== undefined) insertionIndex = firstTool
                }
                content.splice(insertionIndex, 0, { type: "text", text: part.text })
                replacements.set(target, cloneAiMessage(targetMessage, content))
                editedMessageIds.add(normalizedId)
            }
        }

        const retainedIds = new Set<string>()
        for (const entry of sourceEntries) {
            if (transformedMap.has(entry.normalizedMessageId!))
                retainedIds.add(entry.normalizedMessageId!)
        }
        const sourceOrderError = sourceOrderIsMonotonic(
            projection,
            sourceEntries.filter((entry) => retainedIds.has(entry.normalizedMessageId!)),
        )
        if (sourceOrderError) return sourceOrderError

        const insertions: Array<{ index: number; message: AiMessageValue; order: number }> = []
        for (let transformedIndex = 0; transformedIndex < transformed.length; transformedIndex++) {
            const message = transformed[transformedIndex]
            const id = transformedMessageId(message)
            if (!id || knownSourceIds.has(id)) continue
            const inserted = makeInsertedMessage(message)
            if ("accepted" in inserted) {
                // Internal-only helper messages must not reach the patch layer.
                if (
                    message.parts.every(
                        (part) => part.type === "step-start" || part.type === "step-finish",
                    )
                ) {
                    continue
                }
                return inserted
            }
            const existingIndex = currentMessages.findIndex(
                (candidate) => aiMessageId(candidate) === id,
            )
            if (existingIndex >= 0) {
                const existingOwner = projection.outgoing[existingIndex]
                if (!existingOwner?.owned && !isAcpOwnedId(id)) {
                    return reject(
                        "invalid-insertion",
                        `ACP insertion ID ${id} collides with host content`,
                    )
                }
                replacements.set(existingIndex, inserted)
                editedMessageIds.add(id)
                continue
            }
            const index = nearestInsertionIndex(
                projection,
                transformed,
                transformedIndex,
                retainedIds,
                removedMessages,
            )
            insertions.push({ index, message: inserted, order: transformedIndex })
        }

        for (const [messageIndex, message] of replacements) {
            if (removedMessages.has(messageIndex)) continue
            // In a repeated patch an ACP insertion can occupy an index that
            // belonged to a host message in the original lowered array after
            // an earlier source removal. It is still safe to replace that
            // position because the insertion ID is ACP-owned.
            if (isAcpOwnedId(aiMessageId(message))) continue
            const opaqueOrigin = projection.outgoing[messageIndex]
            if (
                opaqueOrigin?.opaqueMessage !== undefined &&
                message !== opaqueOrigin.opaqueMessage
            ) {
                return reject("opaque-origin", "A replacement changed provider-owned content")
            }
            for (const [contentIndex, originalPart] of opaqueOrigin?.opaqueContent ?? []) {
                const candidate = aiContent(message)[contentIndex]
                if (!candidate || candidate !== originalPart) {
                    return reject("opaque-origin", "A replacement changed provider-owned content")
                }
            }
        }

        // Remove content only after all source comparisons have succeeded. A
        // call and its role=tool result are always removed together.
        for (const callID of removedCallIds) {
            const pointers: V2OutgoingPointer[] = []
            for (const entry of sourceEntries) {
                for (const origin of entry.origins) {
                    if (origin.kind === "tool" && origin.callId === callID)
                        pointers.push(...origin.outgoing)
                }
            }
            removeContentPointers(removedContent, pointers)
        }
        for (const [messageIndex, message] of currentMessages.entries()) {
            const messageID = aiMessageId(message)
            const removedSourceMessage =
                removedMessages.has(messageIndex) &&
                (currentMessages === projection.originalMessages ||
                    projection.originalMessages.includes(message))
            if (
                removedSourceMessage ||
                (messageID !== undefined && removedMessageIds.includes(messageID))
            )
                continue
            const baseMessage = replacements.get(messageIndex) ?? message
            const content = aiContent(baseMessage)
            const kept = content.filter(
                (part, contentIndex) =>
                    !removedContentParts.has(part) &&
                    !(
                        currentMessages === projection.originalMessages &&
                        removedContent.has(`${messageIndex}:${contentIndex}`)
                    ),
            )
            if (kept.length !== content.length)
                replacements.set(messageIndex, cloneAiMessage(baseMessage, kept))
        }

        const finalMessages: AiMessageValue[] = []
        const insertionByIndex = new Map<
            number,
            Array<{ message: AiMessageValue; order: number }>
        >()
        for (const insertion of insertions) {
            const list = insertionByIndex.get(insertion.index) ?? []
            list.push({ message: insertion.message, order: insertion.order })
            insertionByIndex.set(insertion.index, list)
        }
        for (const [index, list] of insertionByIndex) {
            if (index === 0) {
                list.sort((left, right) => left.order - right.order)
            }
        }
        const appendAt = (index: number) => {
            const pending = insertionByIndex.get(index)
            if (!pending) return
            pending.sort((left, right) => left.order - right.order)
            finalMessages.push(...pending.map((entry) => entry.message))
        }
        appendAt(0)
        for (let index = 0; index < currentMessages.length; index++) {
            if (!removedMessages.has(index)) {
                const message = replacements.get(index) ?? currentMessages[index]
                const hadRemovedContent =
                    [...removedContent].some((key) => key.startsWith(`${index}:`)) ||
                    aiContent(message).some((part) => removedContentParts.has(part))
                // Empty uncorrelated host messages are outside ACP ownership and
                // must survive. A mapped message emptied by an explicit ACP
                // call/content removal can be omitted safely.
                if (aiContent(message).length > 0 || !hadRemovedContent) finalMessages.push(message)
            }
            appendAt(index + 1)
        }

        const finalError = validateFinalMessages(
            finalMessages,
            mappedCallIds,
            new Set(removedCallIds),
        )
        if (finalError) return finalError
        const nextApplied: AppliedPatchState = appliedPatchStates.get(projection) ?? {
            outputs: new WeakSet<object>(),
            parts: new Map(),
            removed: new Set(),
            opaqueMessages: new Set<object>(),
        }
        for (const entry of projection.entries) {
            for (const origin of entry.origins) {
                for (const reference of origin.originalContent ?? []) {
                    const key = pointerKey(reference.pointer)
                    if (key === undefined) continue
                    if (
                        removedContent.has(key) ||
                        removedMessages.has(reference.pointer.messageIndex) ||
                        (origin.kind === "tool" &&
                            origin.callId !== undefined &&
                            removedCallIds.includes(origin.callId))
                    ) {
                        nextApplied.removed.add(key)
                        continue
                    }
                    const part = finalPartForReference(projection, finalMessages, reference)
                    if (part !== undefined) nextApplied.parts.set(key, part)
                }
            }
        }
        for (const origin of projection.outgoing) {
            if (origin.opaqueMessage !== undefined) {
                nextApplied.opaqueMessages.add(origin.opaqueMessage as object)
            }
            for (const [contentIndex, part] of origin.opaqueContent ?? []) {
                nextApplied.parts.set(`${origin.messageIndex}:${contentIndex}`, part)
            }
        }
        nextApplied.outputs.add(finalMessages as object)
        appliedPatchStates.set(projection, nextApplied)
        return {
            accepted: true,
            ok: true,
            messages: finalMessages,
            patch: {
                removedMessageIds,
                removedCallIds: [...new Set(removedCallIds)],
                editedMessageIds: [...editedMessageIds].filter(Boolean),
                editedCallIds: [...editedCallIds].filter(Boolean),
                insertedMessageIds: insertions.map((entry) => aiMessageId(entry.message) ?? ""),
            },
        }
    } catch (error) {
        return reject(
            "invalid-schema",
            `V2 context patch failed closed: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/** Alias used by callers that describe the operation as patch derivation. */
export const deriveV2ContextPatch = applyV2ContextPatch
export const patchV2Messages = applyV2ContextPatch
