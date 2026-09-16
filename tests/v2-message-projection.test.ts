import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import type { Message as AiMessage } from "@opencode/ai"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    type V2Projection,
} from "../lib/v2/projection"

const MODEL = { id: "model-a", providerID: "provider-a" }
const SID = "v2-projection-session"

function textPart(text: string, metadata?: Record<string, unknown>) {
    return { type: "text" as const, text, ...(metadata ? { metadata } : {}) }
}

function userSource(
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return { type: "user", id, time: { created: 1 }, text, ...extra }
}

function assistantSource(
    id: string,
    content: readonly Record<string, unknown>[],
    model = MODEL,
): Record<string, unknown> {
    return { type: "assistant", id, time: { created: 2 }, agent: "code", model, content }
}

function normalize(projected: readonly unknown[], outgoing: readonly AiMessage[]): V2Projection {
    return normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: SID,
        agent: "code",
        currentModel: MODEL,
    })
}

test("normalizes every public source category and derives assistant step markers", () => {
    const projected = [
        { type: "agent-switched", id: "control-agent", time: { created: 0 }, agent: "code" },
        { type: "model-switched", id: "control-model", time: { created: 0 }, model: MODEL },
        {
            type: "system",
            id: "sys-1",
            time: { created: 1 },
            text: "operator system text",
        },
        userSource("u-1", "user text", {
            skills: [{ id: "skill-1", name: "guide", text: "skill text" }],
            files: [
                {
                    data: Buffer.from("plain file").toString("base64"),
                    mime: "text/plain",
                    source: { type: "inline" },
                    name: "notes.txt",
                    description: "notes",
                },
                {
                    data: "image-data",
                    mime: "image/png",
                    source: { type: "inline" },
                    name: "screen.png",
                },
                {
                    data: "pdf-data",
                    mime: "application/pdf",
                    source: { type: "uri", uri: "https://example.test/doc.pdf" },
                    name: "doc.pdf",
                },
                {
                    data: Buffer.from("src/main.ts").toString("base64"),
                    mime: "application/x-directory",
                    source: { type: "uri", uri: "file:///workspace/src" },
                    name: "src",
                },
            ],
        }),
        {
            type: "skill",
            id: "skill-message",
            time: { created: 2 },
            skill: "skill-1",
            name: "guide",
            text: "resolved skill body",
        },
        {
            type: "shell",
            id: "shell-1",
            time: { created: 3 },
            shellID: "sh-1",
            command: "git status",
            status: "exited",
            output: { output: "clean", cursor: 5, size: 5, truncated: false },
        },
        {
            type: "location-switched",
            id: "location-1",
            time: { created: 4 },
            location: { directory: "/workspace" },
        },
        { type: "synthetic", id: "host-synthetic", time: { created: 5 }, text: "host notice" },
        assistantSource("a-1", [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "assistant answer" },
        ]),
        { type: "idle", id: "idle-1", time: { created: 6 }, outcome: "succeeded" },
    ]

    const attachmentMetadata = (file: Record<string, unknown>) => ({
        attachment: {
            source: file.source,
            name: file.name,
            description: file.description,
        },
    })
    const outgoing = [
        Message.make({
            role: "system",
            content: [textPart("operator system text")],
        }),
        Message.make({
            id: "u-1",
            role: "user",
            content: [
                textPart("skill text"),
                textPart("user text"),
                textPart(
                    "\n\nAttached file: notes.txt\nDescription: notes\n\nplain file",
                    attachmentMetadata((projected[3] as Record<string, unknown>).files[0]),
                ),
                {
                    type: "media" as const,
                    mediaType: "image/png",
                    data: "image-data",
                    filename: "screen.png",
                },
                {
                    type: "media" as const,
                    mediaType: "application/pdf",
                    data: "pdf-data",
                    filename: "doc.pdf",
                },
                textPart(
                    "\n\nAttached directory: file:///workspace/src\n\nsrc/main.ts",
                    attachmentMetadata((projected[3] as Record<string, unknown>).files[3]),
                ),
            ],
        }),
        Message.make({ id: "skill-message", role: "user", content: "resolved skill body" }),
        Message.make({
            id: "shell-1",
            role: "user",
            content:
                "The following shell command was executed by the user:\n\nCommand:\ngit status\n\nOutput:\nclean",
        }),
        Message.make({
            id: "location-1",
            role: "user",
            content: "The working directory has been changed to /workspace.",
        }),
        Message.make({ id: "host-synthetic", role: "user", content: "host notice" }),
        Message.make({
            id: "a-1",
            role: "assistant",
            content: [
                { type: "reasoning", text: "private reasoning" },
                textPart("assistant answer"),
            ],
        }),
    ]

    const projection = normalize(projected, outgoing)
    assert.equal(projection.valid, true)
    assert.deepEqual(
        projection.messages.map((message) => message.info.id),
        ["sys-1", "u-1", "skill-message", "shell-1", "location-1", "host-synthetic", "a-1"],
    )
    const assistant = projection.messages.find((message) => message.info.id === "a-1")
    assert.ok(assistant)
    assert.equal(assistant.parts[0]?.type, "step-start")
    assert.equal(assistant.parts[1]?.type, "reasoning")
    assert.equal(assistant.parts[2]?.type, "text")
    const userEntry = projection.entries.find((entry) => entry.sourceMessageId === "u-1")
    assert.ok(userEntry)
    assert.equal(userEntry.origins.filter((origin) => origin.kind === "attachment").length, 4)
    assert.equal(
        userEntry.origins
            .filter((origin) => origin.kind === "attachment")
            .every((origin) => origin.opaque),
        true,
    )
    assert.equal(projection.entries.find((entry) => entry.sourceType === "system")?.protected, true)
    assert.equal(
        projection.entries.some((entry) => entry.sourceType === "control"),
        false,
    )
})

test("correlates executed and separate role-tool results by call ID", () => {
    const projected = [
        userSource("u-2", "request"),
        assistantSource("a-2", [
            {
                type: "tool",
                id: "executed-call",
                name: "provider_tool",
                executed: true,
                state: {
                    status: "completed",
                    input: { value: 1 },
                    content: [{ type: "text", text: "provider output" }],
                    time: { start: 2, end: 3 },
                    metadata: { source: "provider" },
                    providerState: { checkpoint: "call" },
                    providerResultState: { checkpoint: "result" },
                },
                time: { created: 2 },
            },
            {
                type: "tool",
                id: "host-call",
                name: "host_tool",
                executed: false,
                state: {
                    status: "completed",
                    input: { value: 2 },
                    content: [{ type: "text", text: "host output" }],
                    time: { start: 2, end: 3 },
                    metadata: { source: "host" },
                    providerState: { checkpoint: "call" },
                    providerResultState: { checkpoint: "result" },
                },
                time: { created: 2 },
            },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "u-2", role: "user", content: "request" }),
        Message.make({
            id: "a-2",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "executed-call",
                    name: "provider_tool",
                    input: { value: 1 },
                    providerExecuted: true,
                    providerMetadata: { provider: { checkpoint: "keep" } },
                },
                {
                    type: "tool-result" as const,
                    id: "executed-call",
                    name: "provider_tool",
                    result: { type: "text" as const, value: "provider output" },
                    providerExecuted: true,
                },
                {
                    type: "tool-call" as const,
                    id: "host-call",
                    name: "host_tool",
                    input: { value: 2 },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "host-call",
                    name: "host_tool",
                    result: { type: "text" as const, value: "host output" },
                },
            ],
        }),
    ]
    const projection = normalize(projected, outgoing)
    assert.equal(projection.valid, true)
    const entry = projection.entries.find((candidate) => candidate.sourceMessageId === "a-2")
    assert.ok(entry)
    assert.deepEqual(entry.toolCallIds, ["executed-call", "host-call"])
    const executed = entry.origins.find((origin) => origin.callId === "executed-call")
    const separate = entry.origins.find((origin) => origin.callId === "host-call")
    assert.deepEqual(executed?.call, { messageIndex: 1, contentIndex: 0 })
    assert.deepEqual(executed?.result, { messageIndex: 1, contentIndex: 1 })
    assert.deepEqual(separate?.result, { messageIndex: 2, contentIndex: 0 })
    assert.equal(executed?.representableOutput, true)
    assert.equal(separate?.representableOutput, true)
})

test("rejects duplicate source/call IDs before a context patch can mutate output", () => {
    const projected = [
        userSource("duplicate", "one"),
        userSource("duplicate", "two"),
        assistantSource("assistant", [
            { type: "tool", id: "same-call", name: "a", state: { status: "running", input: {} } },
            { type: "tool", id: "same-call", name: "b", state: { status: "running", input: {} } },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "duplicate", role: "user", content: "one" }),
        Message.make({
            id: "assistant",
            role: "assistant",
            content: [
                { type: "tool-call" as const, id: "same-call", name: "a", input: {} },
                { type: "tool-call" as const, id: "same-call", name: "b", input: {} },
            ],
        }),
    ]
    const projection = normalize(projected, outgoing)
    assert.equal(projection.valid, false)
    assert.equal(projection.rejection?.code, "duplicate-source-id")
    const result = applyV2ContextPatch(projection, projection.messages)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "projection-invalid")
})

test("records running, completed, failed, and provider-checkpoint compaction provenance", () => {
    const checkpoint = Message.make({
        id: "checkpoint-message",
        role: "assistant",
        content: [{ type: "text", text: "decoded provider checkpoint" }],
        providerMetadata: { provider: { opaque: true } },
    })
    const projected = [
        {
            type: "compaction",
            id: "running-compaction",
            time: { created: 1 },
            status: "running",
            reason: "auto",
            summary: "pending",
            recent: "pending",
        },
        {
            type: "compaction",
            id: "completed-compaction",
            time: { created: 2 },
            status: "completed",
            reason: "auto",
            summary: "summary",
            recent: "recent",
            providerContext: {
                providerID: "provider-a",
                provider: "provider-a",
                modelID: "model-a",
                route: "responses",
                protocol: "openai-responses",
                endpoint: "https://provider.example/v1/responses",
                version: 1,
                provenance: {},
                messages: [],
            },
        },
        {
            type: "compaction",
            id: "failed-compaction",
            time: { created: 3 },
            status: "failed",
            reason: "manual",
            error: { type: "error", message: "failed" },
        },
    ]
    const projection = normalize(projected, [checkpoint])
    assert.equal(projection.valid, true)
    assert.equal(projection.messages.length, 1)
    assert.equal(
        projection.entries.find((entry) => entry.status === "running")?.normalizedMessageId,
        undefined,
    )
    assert.equal(
        projection.entries.find((entry) => entry.status === "failed")?.normalizedMessageId,
        undefined,
    )
    const providerEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "completed-compaction",
    )
    assert.ok(providerEntry)
    assert.equal(providerEntry.sourceType, "provider-checkpoint")
    assert.equal(providerEntry.protected, true)
    assert.equal(providerEntry.outgoingMessageIndices[0], 0)
})

test("normalizes valid tool lifecycle states and preserves provider/file result data", () => {
    const projected = [
        userSource("tools-user", "run the tools"),
        assistantSource("tools-assistant", [
            {
                type: "tool",
                id: "running-call",
                name: "running",
                executed: false,
                state: {
                    status: "running",
                    input: { path: "a.ts" },
                    time: { start: 1 },
                    metadata: { phase: "running" },
                    providerState: { cursor: "run" },
                },
            },
            {
                type: "tool",
                id: "streaming-call",
                name: "streaming",
                executed: false,
                state: {
                    status: "streaming",
                    input: '{"path":"b.ts"}',
                    time: { start: 2 },
                    metadata: { phase: "streaming" },
                    providerState: { cursor: "stream" },
                },
            },
            {
                type: "tool",
                id: "error-call",
                name: "error-tool",
                executed: false,
                state: {
                    status: "error",
                    input: { path: "c.ts" },
                    error: { name: "ToolError", message: "provider failed" },
                    time: { start: 3, end: 4 },
                    metadata: { phase: "error" },
                    providerResultState: { retryable: true },
                },
            },
            {
                type: "tool",
                id: "file-call",
                name: "file-tool",
                executed: false,
                state: {
                    status: "completed",
                    input: { path: "out.txt" },
                    content: [
                        {
                            type: "file",
                            uri: "file:///tmp/out.txt",
                            mime: "text/plain",
                            name: "out.txt",
                        },
                    ],
                    time: { start: 5, end: 6 },
                    metadata: { phase: "file" },
                    providerState: { cursor: "file" },
                    providerResultState: { checksum: "abc" },
                },
            },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "tools-user", role: "user", content: "run the tools" }),
        Message.make({
            id: "tools-assistant",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "running-call",
                    name: "running",
                    input: { path: "a.ts" },
                    providerMetadata: { provider: { state: "running" } },
                },
                {
                    type: "tool-call" as const,
                    id: "streaming-call",
                    name: "streaming",
                    input: { path: "b.ts" },
                    providerMetadata: { provider: { state: "streaming" } },
                },
                {
                    type: "tool-call" as const,
                    id: "error-call",
                    name: "error-tool",
                    input: { path: "c.ts" },
                    providerMetadata: { provider: { state: "error" } },
                },
                {
                    type: "tool-call" as const,
                    id: "file-call",
                    name: "file-tool",
                    input: { path: "out.txt" },
                    providerMetadata: { provider: { state: "file" } },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "error-call",
                    name: "error-tool",
                    result: { type: "error" as const, value: "provider failed" },
                    providerResultState: { retryable: true },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "file-call",
                    name: "file-tool",
                    result: {
                        type: "content" as const,
                        value: [
                            {
                                type: "file" as const,
                                uri: "file:///tmp/out.txt",
                                mime: "text/plain",
                                name: "out.txt",
                            },
                        ],
                    },
                    providerResultState: { checksum: "abc" },
                },
            ],
        }),
    ]

    const projection = normalize(projected, outgoing)
    assert.equal(projection.valid, true)
    const entry = projection.entries.find(
        (candidate) => candidate.sourceMessageId === "tools-assistant",
    )
    assert.ok(entry)
    assert.deepEqual(entry.toolCallIds, [
        "running-call",
        "streaming-call",
        "error-call",
        "file-call",
    ])
    assert.equal(
        entry.origins.find((origin) => origin.callId === "running-call")?.normalizedInput,
        '{"path":"a.ts"}',
    )
    assert.equal(entry.origins.find((origin) => origin.callId === "error-call")?.opaque, true)
    assert.equal(entry.origins.find((origin) => origin.callId === "file-call")?.opaque, true)
    const normalizedTools = entry.origins
        .filter((origin) => origin.kind === "tool")
        .map((origin) =>
            projection.messages[1]?.parts.find((part) => part.__acpOrigin === origin.key),
        )
    assert.deepEqual(
        normalizedTools.map((part) => part?.state?.status),
        ["running", "pending", "error", "completed"],
    )

    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    const errorResult = result.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "error-call")
    const fileResult = result.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "file-call")
    assert.deepEqual(errorResult?.result, {
        type: "error",
        value: "provider failed",
    })
    assert.deepEqual(fileResult?.result, {
        type: "content",
        value: [
            {
                type: "file",
                uri: "file:///tmp/out.txt",
                mime: "text/plain",
                name: "out.txt",
            },
        ],
    })
    assert.deepEqual(
        result.messages
            .flatMap((message) => message.content)
            .find((part) => part.type === "tool-call" && part.id === "running-call")
            ?.providerMetadata,
        { provider: { state: "running" } },
    )
})
