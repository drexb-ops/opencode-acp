import "./test-env"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Message } from "@opencode/ai"
import { getConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { SessionStateRegistry } from "../lib/state"
import { createV2ContextHandler } from "../lib/v2/context"
import { createV2Tool } from "../lib/v2/tools"
import { normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { createCompressRangeToolDefinition } from "../lib/compress/range"
import type { V2HostAdapter } from "../lib/v2/host"
import { createV2Host } from "../lib/v2/host"

test("V2 compress removes selected originals on the next request with opaque tools and repeated systems", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-wire-"))
    const config = getConfig({ directory: storage, notifications: { notify() {} } })
    config.storagePath = storage
    config.autoUpdate = false
    config.pruneNotification = "off"
    const logger = new Logger(false, "silent")
    const prompts = new PromptStore(logger, storage)
    const model = { providerID: "test", id: "model" }
    const sessionID = "wire-session"
    const sentinel = "ORIGINAL_WIRE_SENTINEL " + "completed implementation detail ".repeat(500)
    const summary = "WIRE_SUMMARY: completed implementation decisions and verified behavior."
    const checkpointText =
        "<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\ncheckpoint\n</summary>\n\n<recent-context>\nrecent\n</recent-context>\n</conversation-checkpoint>"
    const checkpoint = Message.make({ id: "checkpoint", role: "user", content: checkpointText })
    const shellCall = {
        type: "tool-call" as const,
        id: "shell-call",
        name: "shell",
        input: { command: "true" },
        providerExecuted: false,
    }
    const shellResult = {
        type: "tool-result" as const,
        id: "shell-call",
        name: "shell",
        providerExecuted: false,
        result: {
            type: "content" as const,
            value: [
                { type: "text" as const, text: "stdout" },
                { type: "text" as const, text: "exit 0" },
            ],
        },
    }
    // These canonical values follow pinned OpenCode lowering: ID-less systems,
    // one assistant call and a separate role=tool multipart result.
    const outgoing = [
        checkpoint,
        Message.system("Repeated instruction"),
        Message.system("Repeated instruction"),
        Message.make({ id: "task", role: "user", content: "Keep the task visible" }),
        Message.make({ id: "old", role: "assistant", content: sentinel }),
        Message.make({ id: "shell", role: "assistant", content: [shellCall] }),
        Message.tool(shellResult),
        ...Array.from({ length: 8 }, (_, i) =>
            Message.make({
                id: `recent-${i}`,
                role: "assistant",
                content: "recent protected context ".repeat(120),
            }),
        ),
        Message.make({ id: "latest", role: "user", content: "Please continue" }),
    ]
    const originalCall = outgoing.find((message) => message.id === "shell")!.content[0]!
    const originalResult = outgoing.find((message) => message.role === "tool")!.content[0]!
    const expectedCall = structuredClone(originalCall)
    const expectedResult = structuredClone(originalResult)
    const sources: unknown[] = [
        {
            type: "compaction",
            id: "checkpoint",
            status: "completed",
            reason: "manual",
            time: { created: 1 },
            summary: "checkpoint",
            recent: "recent",
            tokens: { input: 653137, output: 955, reasoning: 723, cache: { read: 0, write: 0 } },
        },
        { type: "system", id: "sys-1", text: "Repeated instruction" },
        { type: "system", id: "sys-2", text: "Repeated instruction" },
        { type: "user", id: "task", time: { created: 2 }, text: "Keep the task visible" },
        {
            type: "assistant",
            id: "old",
            time: { created: 3, completed: 4 },
            model,
            content: [{ type: "text", text: sentinel }],
        },
        {
            type: "assistant",
            id: "shell",
            time: { created: 5, completed: 6 },
            model,
            content: [
                {
                    type: "tool",
                    id: "shell-call",
                    name: "shell",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { command: "true" },
                        content: [
                            { type: "text", text: "stdout" },
                            { type: "text", text: "exit 0" },
                        ],
                    },
                },
            ],
        },
        ...Array.from({ length: 8 }, (_, i) => ({
            type: "assistant",
            id: `recent-${i}`,
            model,
            time: { created: 10 + i, completed: 11 + i },
            content: [{ type: "text", text: "recent protected context ".repeat(120) }],
        })),
        { type: "user", id: "latest", time: { created: 20 }, text: "Please continue" },
    ]
    const host: V2HostAdapter = {
        directory: storage,
        sessions: {
            get: async (id) => ({ id }),
            messages: async () =>
                normalizeV2ProjectedHistory(sources, [], { sessionID, currentModel: model })
                    .messages,
            parentMessages: async () => [],
        },
        models: {
            list: async () => [
                { providerId: model.providerID, modelId: model.id, contextLimit: 400000 },
            ],
        },
        projectedContext: async () => sources,
        notices: { send: async () => {} },
        notifications: { notify() {} },
    }
    const registry = new SessionStateRegistry(logger, storage)
    const permission = { agents: {} }
    const handle = createV2ContextHandler(host, registry, logger, config, prompts, permission)
    const event = () => ({
        sessionID,
        agent: "build",
        model,
        system: [{ type: "text" as const, text: "System instructions" }],
        messages: [...outgoing],
    })
    try {
        const first = event()
        await handle(first)
        const state = registry.get(sessionID)
        assert.ok(state, "valid initial history must commit registry state")
        assert.ok(
            (state.systemPromptTokens ?? Infinity) < 20000,
            "old compaction usage must not become system overhead",
        )
        const ref = state.messageIds.byRawId.get("old")!
        const args = { topic: "completed work", content: [{ startId: ref, endId: ref, summary }] }
        const factory = { host, registry, logger, config, prompts }
        const tool = createV2Tool(
            createCompressRangeToolDefinition(factory),
            factory,
            host,
            permission,
        )
        const result = await tool.execute(args, {
            sessionID,
            agent: "build",
            messageID: "compress-msg",
            id: "compress-call",
            progress: async () => {},
        })
        assert.match(String(result.content), /^Compressed 1 messages/)

        sources.push({
            type: "assistant",
            id: "compress-msg",
            model,
            time: { created: 21, completed: 22 },
            content: [
                {
                    type: "tool",
                    id: "compress-call",
                    name: "compress",
                    executed: false,
                    state: {
                        status: "completed",
                        input: args,
                        content: [{ type: "text", text: String(result.content) }],
                    },
                },
            ],
        })
        outgoing.push(
            Message.make({
                id: "compress-msg",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: "compress-call",
                        name: "compress",
                        input: args,
                        providerExecuted: false,
                    },
                ],
            }),
        )
        outgoing.push(
            Message.tool({
                type: "tool-result",
                id: "compress-call",
                name: "compress",
                result: { type: "text", value: String(result.content) },
                providerExecuted: false,
            }),
        )
        const next = event()
        const originalSize = JSON.stringify(next.messages).length
        await handle(next)
        const wire = JSON.stringify(next.messages)
        assert.equal(wire.includes("ORIGINAL_WIRE_SENTINEL"), false)
        assert.equal(wire.includes(summary), true)
        assert.ok(wire.length < originalSize - 10000)
        assert.ok(next.messages.includes(checkpoint))
        assert.ok(next.messages.some((message) => message.content.includes(originalCall)))
        assert.ok(next.messages.some((message) => message.content.includes(originalResult)))
        assert.deepEqual(originalCall, expectedCall)
        assert.deepEqual(originalResult, expectedResult)
        assert.equal(next.messages.filter((message) => message.role === "system").length, 2)
        assert.ok(wire.includes("Please continue"))
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("native suffix needs accepted context authorization before a cold tool can compress it", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-native-wire-"))
    const config = getConfig({ directory: storage, notifications: { notify() {} } })
    config.storagePath = storage
    config.autoUpdate = false
    config.pruneNotification = "off"
    const logger = new Logger(false, "silent")
    const prompts = new PromptStore(logger, storage)
    const model = { providerID: "new-provider", id: "new-model" }
    const sessionID = "native-wire"
    const target = "NATIVE_SUFFIX_TARGET " + "older suffix details ".repeat(600)
    const sources: unknown[] = [
        {
            type: "compaction",
            id: "native",
            status: "completed",
            reason: "manual",
            time: { created: 5 },
            model: { providerID: "old-provider", id: "old-model" },
            summary: "",
            recent: "",
            providerContext: {
                version: 1,
                provenance: {
                    providerID: "old-provider",
                    provider: "openai",
                    modelID: "old-model",
                    route: "test",
                    protocol: "openai-responses",
                    endpoint: "test-endpoint-hash",
                },
                messages: [],
            },
        },
        { type: "user", id: "task", text: "task", time: { created: 6 } },
        {
            type: "assistant",
            id: "old-suffix",
            model,
            time: { created: 7, completed: 8 },
            content: [{ type: "text", text: target }],
        },
        ...Array.from({ length: 8 }, (_, i) => ({
            type: "assistant",
            id: `new-${i}`,
            model,
            time: { created: 10 + i, completed: 11 + i },
            content: [{ type: "text", text: "keep recent context ".repeat(200) }],
        })),
        { type: "user", id: "latest", text: "continue", time: { created: 30 } },
    ]
    const prefix = Message.make({
        id: "reexpanded-original",
        role: "user",
        content: "native prefix must remain unchanged",
    })
    const outgoing = [
        prefix,
        Message.make({ id: "task", role: "user", content: "task" }),
        Message.make({ id: "old-suffix", role: "assistant", content: target }),
        ...Array.from({ length: 8 }, (_, i) =>
            Message.make({
                id: `new-${i}`,
                role: "assistant",
                content: "keep recent context ".repeat(200),
            }),
        ),
        Message.make({ id: "latest", role: "user", content: "continue" }),
    ]
    const api = {
        location: { directory: storage },
        session: {
            context: async () => sources,
            get: async () => ({ id: sessionID, model, agent: "build" }),
            synthetic: async () => {},
        },
        agent: {
            get: async () => ({
                data: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
            }),
        },
        catalog: {
            model: {
                list: async () => ({
                    data: [
                        { providerID: model.providerID, id: model.id, limit: { context: 400000 } },
                    ],
                }),
            },
        },
    }
    const host = createV2Host(api as never, { currentModel: model }, { notify() {} })
    const registry = new SessionStateRegistry(logger, storage)
    const permission = { agents: {} }
    const handler = createV2ContextHandler(host, registry, logger, config, prompts, permission)
    const factory = { host, registry, logger, config, prompts }
    const tool = createV2Tool(createCompressRangeToolDefinition(factory), factory, host, permission)
    const args = {
        topic: "native suffix",
        content: [
            {
                startId: "m00002",
                endId: "m00002",
                summary: "NATIVE_SUFFIX_SUMMARY retained decisions.",
            },
        ],
    }
    const toolContext = {
        sessionID,
        agent: "build",
        messageID: "compress-msg",
        id: "compress-call",
        progress: async () => {},
    }
    const event = () => ({
        sessionID,
        agent: "build",
        model,
        system: [{ type: "text" as const, text: "system" }],
        messages: [...outgoing],
    })
    try {
        const cold = await tool.execute(args, toolContext)
        assert.match(String(cold.content), /non-removable|provider-owned/)
        assert.equal(registry.get(sessionID), undefined)
        const first = event()
        await handler(first)
        assert.ok(registry.get(sessionID))
        assert.equal(registry.get(sessionID)!.lastCompaction, 5)
        assert.ok(first.messages.includes(prefix))
        const ref = registry.get(sessionID)!.messageIds.byRawId.get("old-suffix")!
        args.content[0].startId = ref
        args.content[0].endId = ref
        const result = await tool.execute(args, toolContext)
        assert.match(String(result.content), /^Compressed 1 messages/)
        sources.push({
            type: "assistant",
            id: "compress-msg",
            model,
            time: { created: 31, completed: 32 },
            content: [
                {
                    type: "tool",
                    id: "compress-call",
                    name: "compress",
                    executed: false,
                    state: {
                        status: "completed",
                        input: args,
                        content: [{ type: "text", text: String(result.content) }],
                    },
                },
            ],
        })
        outgoing.push(
            Message.make({
                id: "compress-msg",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: "compress-call",
                        name: "compress",
                        input: args,
                        providerExecuted: false,
                    },
                ],
            }),
        )
        outgoing.push(
            Message.tool({
                type: "tool-result",
                id: "compress-call",
                name: "compress",
                result: { type: "text", value: String(result.content) },
                providerExecuted: false,
            }),
        )
        const next = event()
        await handler(next)
        assert.ok(next.messages.includes(prefix))
        assert.equal(JSON.stringify(next.messages).includes("NATIVE_SUFFIX_TARGET"), false)
        assert.equal(JSON.stringify(next.messages).includes("NATIVE_SUFFIX_SUMMARY"), true)
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})
