import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import type { Message as AiMessage, ContentPart } from "@opencode/ai"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    type V2Projection,
} from "../lib/v2/projection"

const model = { id: "model-a", providerID: "provider-a" }

function sourceMessages() {
    return [
        { type: "user", id: "u-1", time: { created: 1 }, text: "keep this request" },
        {
            type: "assistant",
            id: "a-1",
            time: { created: 2 },
            agent: "code",
            model,
            content: [
                { type: "reasoning", text: "old reasoning" },
                { type: "text", text: "historical answer <dcp-message-id>m00001</dcp-message-id>" },
                {
                    type: "tool",
                    id: "call-1",
                    name: "read",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { path: "a.ts" },
                        content: [{ type: "text", text: "tool output" }],
                        time: { start: 2, end: 3 },
                        metadata: { source: "fixture" },
                    },
                },
            ],
        },
        { type: "user", id: "u-2", time: { created: 3 }, text: "latest request" },
    ]
}

function outgoingMessages(): AiMessage[] {
    return [
        Message.make({
            id: "u-1",
            role: "user",
            content: [{ type: "text", text: "keep this request" }],
        }),
        Message.make({
            id: "a-1",
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "old reasoning",
                    cache: { type: "ephemeral" },
                    providerMetadata: { provider: { trace: "retain" } },
                },
                {
                    type: "text",
                    text: "historical answer <dcp-message-id>m00001</dcp-message-id>",
                    metadata: { source: "history" },
                },
                {
                    type: "tool-call",
                    id: "call-1",
                    name: "read",
                    input: { path: "a.ts" },
                    cache: { type: "ephemeral" },
                    providerMetadata: { provider: { native: "retain" } },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call-1",
                    name: "read",
                    result: { type: "text", value: "tool output" },
                    providerMetadata: { provider: { nativeResult: "retain" } },
                },
            ],
        }),
        Message.make({ id: "u-2", role: "user", content: "latest request" }),
        // This host-added message has no projected source and must stay in place.
        Message.make({ id: "host-extra", role: "user", content: "host content" }),
    ]
}

function buildProjection(): { projection: V2Projection; outgoing: AiMessage[] } {
    const outgoing = outgoingMessages()
    const projection = normalizeV2ProjectedHistory(sourceMessages(), outgoing, {
        sessionID: "s",
        agent: "code",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    return { projection, outgoing }
}

function clonedMessages(projection: V2Projection): ReturnType<typeof structuredClone> {
    return structuredClone(projection.messages)
}

test("applies text/reasoning and representable tool edits without losing provider fields", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    const reasoning = assistant.parts.find((part) => part.type === "reasoning")!
    const text = assistant.parts.find((part) => part.type === "text")!
    const tool = assistant.parts.find((part) => part.type === "tool")!
    reasoning.text = "new reasoning"
    text.text = "new historical answer"
    tool.state.input = { path: "b.ts" }
    tool.state.output = "new tool output"

    const result = applyV2ContextPatch(projection, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    const assistantOutput = result.messages.find((message) => message.id === "a-1")!
    const reasoningOutput = assistantOutput.content.find((part) => part.type === "reasoning")!
    const textOutput = assistantOutput.content.find((part) => part.type === "text")!
    const callOutput = assistantOutput.content.find((part) => part.type === "tool-call")!
    assert.equal(reasoningOutput.text, "new reasoning")
    assert.equal(textOutput.text, "new historical answer")
    assert.deepEqual(callOutput.input, { path: "b.ts" })
    assert.equal(reasoningOutput.cache.type, "ephemeral")
    assert.deepEqual(reasoningOutput.providerMetadata, { provider: { trace: "retain" } })
    assert.equal(callOutput.cache.type, "ephemeral")
    assert.deepEqual(callOutput.providerMetadata, { provider: { native: "retain" } })
    const resultOutput = result.messages.find((message) => message.role === "tool")!.content[0]
    assert.deepEqual(resultOutput.result, { type: "text", value: "new tool output" })
    assert.deepEqual(resultOutput.providerMetadata, { provider: { nativeResult: "retain" } })
})

test("keeps opaque attachments/system content and uncorrelated host messages while patching safe text", () => {
    const projected = [
        {
            type: "system",
            id: "system-1",
            time: { created: 1 },
            text: "do not rewrite this system message",
        },
        {
            type: "user",
            id: "user-with-file",
            time: { created: 2 },
            text: "safe text",
            files: [
                {
                    data: "image-bytes",
                    mime: "image/png",
                    source: { type: "inline" },
                    name: "image.png",
                },
            ],
        },
    ]
    const attachment: ContentPart = {
        type: "media",
        mediaType: "image/png",
        data: "image-bytes",
        filename: "image.png",
    }
    const outgoing = [
        Message.make({ role: "system", content: "do not rewrite this system message" }),
        Message.make({
            id: "user-with-file",
            role: "user",
            content: [{ type: "text", text: "safe text" }, attachment],
        }),
        Message.make({ id: "uncorrelated", role: "user", content: "survive me" }),
    ]
    const p = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "opaque-session",
        currentModel: model,
    })
    const transformed = clonedMessages(p)
    transformed
        .find((message) => message.info.id === "user-with-file")!
        .parts.find((part) => part.type === "text")!.text = "safe text edited"

    const result = applyV2ContextPatch(p, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(result.messages[0].content[0].text, "do not rewrite this system message")
    assert.equal(result.messages[1].content[0].text, "safe text edited")
    assert.strictEqual(result.messages[1].content[1], outgoing[1].content[1])
    assert.equal(result.messages[2].id, "uncorrelated")
})

test("removes tool call/result atomically and inserts deterministic ACP synthetic messages", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")
    const synthetic = structuredClone(transformed[0])
    synthetic.info.id = "msg_dcp_summary_1234567890abcdef"
    synthetic.parts = [
        {
            id: "prt_dcp_summary_1234567890abcdef",
            sessionID: "s",
            messageID: synthetic.info.id,
            type: "text",
            text: "ACP summary",
        },
    ]
    transformed.push(synthetic)

    const result = applyV2ContextPatch(projection, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(
        result.messages.some((message) =>
            message.content.some((part) => part.type === "tool-call" && part.id === "call-1"),
        ),
        false,
    )
    assert.equal(
        result.messages.some((message) => message.role === "tool"),
        false,
    )
    assert.equal(
        result.messages.some((message) => message.id === synthetic.info.id),
        true,
    )
    assert.deepEqual(result.patch.removedCallIds, ["call-1"])
    assert.deepEqual(result.patch.insertedMessageIds, [synthetic.info.id])
})

test("rejects fingerprint and opaque-boundary mismatches without changing the original objects", () => {
    const { projection, outgoing } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed[0].parts[0].text = "edited safely"
    const originalFirst = outgoing[0]
    const fingerprintProjection = { ...projection, fingerprint: "tampered" }
    const fingerprintResult = applyV2ContextPatch(fingerprintProjection, transformed)
    assert.equal(fingerprintResult.accepted, false)
    if (!fingerprintResult.accepted)
        assert.equal(fingerprintResult.rejection.code, "fingerprint-mismatch")
    const systemProjected = [
        { type: "system", id: "sys", time: { created: 1 }, text: "opaque" },
        { type: "user", id: "u", time: { created: 2 }, text: "safe" },
    ]
    const systemOutgoing = [
        Message.make({ role: "system", content: "opaque" }),
        Message.make({ id: "u", role: "user", content: "safe" }),
    ]
    const opaqueProjection = normalizeV2ProjectedHistory(systemProjected, systemOutgoing, {
        sessionID: "opaque",
        currentModel: model,
    })
    const changed = [...systemOutgoing]
    const changedSystem = {
        ...changed[0],
        content: [{ type: "text", text: "changed" }],
    } as AiMessage
    changed[0] = changedSystem
    const opaqueResult = applyV2ContextPatch(
        opaqueProjection,
        [
            {
                ...opaqueProjection.messages[1],
                parts: [{ ...opaqueProjection.messages[1].parts[0], text: "safe 2" }],
            },
        ],
        changed,
    )
    assert.equal(opaqueResult.accepted, false)
    if (!opaqueResult.accepted) assert.equal(opaqueResult.rejection.code, "opaque-origin")
    const attachmentSource = {
        type: "user",
        id: "user-with-file",
        time: { created: 2 },
        text: "safe",
        files: [
            {
                data: "image-bytes",
                mime: "image/png",
                source: { type: "inline" },
                name: "image.png",
            },
        ],
    }
    const attachmentMessage = Message.make({
        id: "user-with-file",
        role: "user",
        content: [
            { type: "text", text: "safe" },
            {
                type: "media" as const,
                mediaType: "image/png",
                data: "image-bytes",
                filename: "image.png",
            },
        ],
    })
    const attachmentProjection = normalizeV2ProjectedHistory(
        [attachmentSource],
        [attachmentMessage],
        { sessionID: "attachment", currentModel: model },
    )
    const attachmentTransformed = clonedMessages(attachmentProjection)
    attachmentTransformed[0].parts[0].text = "safe edited"
    const replacedAttachment = [
        {
            ...attachmentMessage,
            content: attachmentMessage.content.map((part, index) =>
                index === 1 ? { ...part } : part,
            ),
        },
    ] as AiMessage[]
    const attachmentResult = applyV2ContextPatch(
        attachmentProjection,
        attachmentTransformed,
        replacedAttachment,
    )
    assert.equal(attachmentResult.accepted, false)
    if (!attachmentResult.accepted) assert.equal(attachmentResult.rejection.code, "opaque-origin")
    assert.strictEqual(outgoing[0], originalFirst)
})

test("repeated patching is idempotent and preserves empty uncorrelated messages", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "latest edited"
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
    if (!second.accepted) return
    assert.deepEqual(second.messages, first.messages)
    assert.equal(
        second.messages.some((message) => message.id === "host-extra"),
        true,
    )
})

test("rejects a same-ID replacement of patchable lowered content", () => {
    const { projection, outgoing } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "edited request"

    const replaced = outgoing.map((message) => {
        if (message.id !== "u-2") return message
        return Message.make({ id: "u-2", role: "user", content: "provider replaced text" })
    })
    const result = applyV2ContextPatch(projection, transformed, replaced)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "fingerprint-mismatch")
})

test("rejects same-ID replacement of an uncorrelated provider message", () => {
    const { projection, outgoing } = buildProjection()
    const replacement = [...outgoing]
    replacement[4] = Message.make({ id: "host-extra", role: "user", content: "replaced host" })
    const result = applyV2ContextPatch(projection, projection.messages, replacement)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "opaque-origin")
})

test("repeated patching accepts ACP-owned output objects after an insertion", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")
    const synthetic = structuredClone(transformed[0])
    synthetic.info.id = "msg_dcp_summary_abcdefabcdefabcd"
    synthetic.parts = [
        {
            id: "prt_dcp_summary_abcdefabcdefabcd",
            sessionID: "s",
            messageID: synthetic.info.id,
            type: "text",
            text: "ACP summary",
        },
    ]
    transformed.push(synthetic)

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
})

test("repeated removal remains idempotent after tool-pair deletion", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
    if (!second.accepted) return
    assert.deepEqual(second.messages, first.messages)

    const copiedArray = [...first.messages]
    const third = applyV2ContextPatch(projection, transformed, copiedArray)
    assert.equal(third.accepted, true)
})
