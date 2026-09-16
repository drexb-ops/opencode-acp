import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Message, SystemPart } from "@opencode/ai"
import type { PluginConfig } from "../lib/config"
import { createV2ContextHandler } from "../lib/v2/context"
import { createV2Host, type V2Context, type V2HostAdapter } from "../lib/v2/host"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import {
    cloneSessionState,
    saveSessionState,
    SessionStateRegistry,
    type CompressionBlock,
    type WithParts,
} from "../lib/state"

const modelA = { id: "model-a", providerID: "provider-a" }
const modelB = { id: "model-b", providerID: "provider-b" }

function config(storagePath: string, debug = false): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        storagePath,
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 90_000,
            minContextLimit: 80_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            reasoning: { drop: true, threshold: 2048 },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

function host(
    projectedBySession: Map<string, readonly unknown[]>,
    models: readonly { providerId: string; modelId: string; contextLimit?: number }[],
    parentBySession = new Map<string, string | undefined>(),
    notificationMessages: string[] = [],
): V2HostAdapter {
    const projectedContext = async (sessionID: string) => projectedBySession.get(sessionID) ?? []
    const sessions = {
        get: async (sessionID: string) => ({
            id: sessionID,
            parentID: parentBySession.get(sessionID),
        }),
        messages: async (sessionID: string): Promise<WithParts[]> => [],
        parentMessages: async (sessionID: string): Promise<WithParts[]> => [],
    }
    return {
        sessions,
        models: { list: async () => models },
        notices: { send: async () => {} },
        notifications: {
            notify: (input) => {
                notificationMessages.push(input.message)
            },
        },
        projectedContext,
        directory: "/tmp/opencode-v2-context",
    }
}

function context(
    sessionID: string,
    model: { id: string; providerID: string },
    messages: ReturnType<typeof Message.make>[],
) {
    return {
        sessionID,
        agent: "code",
        model,
        system: [],
        messages,
    }
}

function runHandler(
    projected: readonly unknown[],
    outgoing: ReturnType<typeof Message.make>[],
    selectedModel = modelA,
    inventory = [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
        { providerId: "provider-b", modelId: "model-b", contextLimit: 200_000 },
    ],
) {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-context-"))
    const logger = new Logger(false)
    const cfg = config(storage)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    const projectedBySession = new Map<string, readonly unknown[]>([["session", projected]])
    const adapter = host(projectedBySession, inventory)
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    return {
        storage,
        registry,
        adapter,
        config: cfg,
        logger,
        prompts,
        event: context("session", selectedModel, outgoing),
        handler,
    }
}

test("V2 host uses direct Promise session/catalog response shapes for child and parent history", async () => {
    const contextCalls: string[] = []
    const getCalls: string[] = []
    const history = new Map<string, readonly unknown[]>([
        [
            "child",
            [{ type: "user", id: "child-user", time: { created: 1 }, text: "child request" }],
        ],
        [
            "parent",
            [
                { type: "user", id: "parent-user", time: { created: 1 }, text: "parent request" },
                {
                    type: "assistant",
                    id: "parent-assistant",
                    time: { created: 2 },
                    model: modelA,
                    content: [
                        {
                            type: "tool",
                            id: "parent-call",
                            name: "read",
                            state: { status: "running", input: { path: "a.ts" } },
                        },
                    ],
                },
            ],
        ],
    ])
    const apiContext = {
        location: { directory: "/workspace/direct-api" },
        session: {
            get: async ({ sessionID }: { sessionID: string }) => {
                getCalls.push(sessionID)
                return { id: sessionID, parentID: sessionID === "child" ? "parent" : undefined }
            },
            context: async ({ sessionID }: { sessionID: string }) => {
                contextCalls.push(sessionID)
                return history.get(sessionID) ?? []
            },
        },
        catalog: {
            model: {
                list: async () => ({
                    location: {
                        directory: "/workspace/direct-api",
                        project: {
                            id: "project",
                            directory: "/workspace/direct-api",
                            canonical: "project",
                        },
                    },
                    data: [
                        {
                            id: "model-a",
                            modelID: "provider-model-a",
                            providerID: "provider-a",
                            limit: { context: 123_456, output: 4096 },
                        },
                    ],
                }),
            },
        },
    } as unknown as V2Context
    const adapter = createV2Host(apiContext)

    const child = await adapter.sessions.get("child")
    assert.deepEqual(child, { id: "child", parentID: "parent" })
    const childMessages = await adapter.sessions.messages("child")
    assert.equal(childMessages[0]?.info.id, "child-user")
    assert.equal(childMessages[0]?.info.sessionID, "child")

    const parentMessages = await adapter.sessions.parentMessages("parent")
    assert.deepEqual(
        parentMessages.map((message) => message.info.id),
        ["parent-user", "parent-assistant"],
    )
    assert.equal(
        parentMessages[1]?.parts.find((part) => part.type === "tool")?.callID,
        "parent-call",
    )

    const inventory = await adapter.models.list()
    assert.deepEqual(inventory, [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 123_456 },
    ])
    assert.deepEqual(getCalls, ["child"])
    assert.deepEqual(contextCalls, ["child", "parent"])
})

test("primary V2 context hook patches messages then appends a structured system part", async () => {
    const projected = [
        { type: "user", id: "user-1", time: { created: 1 }, text: "request" },
        {
            type: "assistant",
            id: "assistant-1",
            time: { created: 2 },
            model: modelA,
            content: [{ type: "text", text: "answer" }],
        },
    ]
    const outgoing = [
        Message.make({ id: "user-1", role: "user", content: "request" }),
        Message.make({ id: "assistant-1", role: "assistant", content: "answer" }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.equal(run.event.messages[0]?.id, "user-1")
        assert.match(run.event.messages[0]?.content[0]?.text ?? "", /request/)
        assert.equal(run.event.messages[1]?.id, "assistant-1")
        assert.match(run.event.messages[1]?.content[0]?.text ?? "", /answer/)
        assert.equal(run.event.system.length, 1)
        assert.equal(run.event.system[0]?.type, "text")
        assert.match(run.event.system[0]?.text ?? "", /decompress/i)
        assert.equal(run.registry.get("session")?.modelContextLimit, 100_000)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 model switches use the selected event model's catalog limit", async () => {
    const projected = [{ type: "user", id: "switch-user", time: { created: 1 }, text: "request" }]
    const outgoing = [Message.make({ id: "switch-user", role: "user", content: "request" })]
    const run = runHandler(projected, outgoing, modelB)
    await run.handler(run.event)
    try {
        const state = run.registry.get("session")
        assert.ok(state)
        assert.equal(state.modelContextLimit, 200_000)
        assert.equal(state.modelProviderID, "provider-b")
        assert.equal(state.modelID, "model-b")
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 context resolves cached limits after catalog omission/failure without masking a switch", async () => {
    const projected = [{ type: "user", id: "cached-user", time: { created: 1 }, text: "request" }]
    const first = runHandler(
        projected,
        [Message.make({ id: "cached-user", role: "user", content: "request" })],
        modelA,
        [{ providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 }],
    )
    await first.handler(first.event)
    try {
        assert.equal(first.registry.get("session")?.modelContextLimit, 100_000)

        first.adapter.models.list = async () => {
            throw new Error("temporary catalog outage")
        }
        const transientEvent = context("session", modelA, [
            Message.make({ id: "cached-user", role: "user", content: "request" }),
        ])
        await first.handler(transientEvent)
        assert.equal(first.registry.get("session")?.modelContextLimit, 100_000)
        assert.equal(first.registry.get("session")?.modelID, "model-a")

        first.adapter.models.list = async () => []
        const switchedEvent = context("session", modelB, [
            Message.make({ id: "cached-user", role: "user", content: "request" }),
        ])
        await first.handler(switchedEvent)
        const switchedState = first.registry.get("session")
        assert.ok(switchedState)
        assert.equal(switchedState.modelContextLimit, undefined)
        assert.equal(switchedState.modelProviderID, "provider-b")
        assert.equal(switchedState.modelID, "model-b")
    } finally {
        rmSync(first.storage, { recursive: true, force: true })
    }
})

test("completed V2 compaction resets transient state while retaining active compression blocks", async () => {
    const initial = runHandler(
        [{ type: "user", id: "before", time: { created: 1 }, text: "before" }],
        [Message.make({ id: "before", role: "user", content: "before" })],
    )
    await initial.handler(initial.event)
    const state = initial.registry.get("session")!
    state.nudges.lastPerMessageNudgeTokens = 42
    state.toolParameters.set("tool", {
        tool: "read",
        parameters: {},
        turn: 1,
    })
    state.prune.messages.activeBlockIds.add(7)
    const compaction = {
        type: "compaction",
        id: "compact-1",
        time: { created: 10 },
        status: "completed",
        reason: "auto",
        summary: "old summary",
        recent: "recent context",
    }
    const projected = [
        compaction,
        { type: "user", id: "after", time: { created: 11 }, text: "after" },
    ]
    const outgoing = [
        Message.make({
            id: "compact-1",
            role: "user",
            content:
                "<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\nold summary\n</summary>\n\n<recent-context>\nrecent context\n</recent-context>\n</conversation-checkpoint>",
        }),
        Message.make({ id: "after", role: "user", content: "after" }),
    ]
    initial.event.messages = outgoing
    initial.event.model = modelA
    const projectedBySession = new Map<string, readonly unknown[]>([["session", projected]])
    const adapter = host(projectedBySession, [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
    ])
    const handler = createV2ContextHandler(
        adapter,
        initial.registry,
        new Logger(false),
        config(initial.storage),
        new PromptStore(new Logger(false), "/tmp/opencode-v2-context"),
        { global: undefined, agents: {} },
    )
    await handler(initial.event)
    try {
        assert.notEqual(initial.registry.get("session")?.nudges.lastPerMessageNudgeTokens, 42)
        assert.equal(initial.registry.get("session")?.toolParameters.size, 0)
        assert.equal(initial.registry.get("session")?.prune.messages.activeBlockIds.has(7), true)
    } finally {
        rmSync(initial.storage, { recursive: true, force: true })
    }
})

test("V2 sanitation is outbound-only for historical assistant text", async () => {
    const stale = "assistant <dcp-message-id>m00001</dcp-message-id>"
    const projected = [
        { type: "user", id: "sanitize-user", time: { created: 1 }, text: "request" },
        {
            type: "assistant",
            id: "sanitize-assistant",
            time: { created: 2 },
            model: modelA,
            content: [{ type: "text", text: stale }],
        },
    ]
    const outgoing = [
        Message.make({ id: "sanitize-user", role: "user", content: "request" }),
        Message.make({ id: "sanitize-assistant", role: "assistant", content: stale }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.match(run.event.messages[1]?.content[0]?.text ?? "", /^assistant /)
        assert.equal(run.event.messages[1]?.content[0]?.text.includes("m00001"), false)
        assert.equal((projected[1] as Record<string, unknown>).content[0].text, stale)
        const stateFile = join(run.storage, "session.json")
        assert.equal(readFileSync(stateFile, "utf8").includes(stale), false)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 ACP-owned command notices stay in history but never reach outbound context", async () => {
    const noticeID = "msg_acp_notice_0123456789abcdef"
    const projected = [
        {
            type: "synthetic",
            id: noticeID,
            time: { created: 1 },
            text: "[ACP Status] command output",
            metadata: { acpOwned: true },
        },
        { type: "user", id: "notice-user", time: { created: 2 }, text: "continue" },
    ]
    const outgoing = [
        Message.make({ id: noticeID, role: "user", content: "[ACP Status] command output" }),
        Message.make({ id: "notice-user", role: "user", content: "continue" }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.equal(
            run.event.messages.some((message) => message.id === noticeID),
            false,
        )
        assert.equal(
            run.event.messages.some((message) => message.id === "notice-user"),
            true,
        )
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 denied agent permissions suppress the ACP prompt and nudges", async () => {
    const projected = [{ type: "user", id: "denied-user", time: { created: 1 }, text: "request" }]
    const run = runHandler(projected, [
        Message.make({ id: "denied-user", role: "user", content: "request" }),
    ])
    run.adapter.agentPermissions = async () => [{ action: "*", resource: "*", effect: "deny" }]
    await run.handler(run.event)
    try {
        assert.equal(run.registry.get("session")?.compressPermission, "deny")
        assert.equal(run.event.system.length, 0)
        assert.equal(
            run.event.messages.some((message) =>
                message.content.some(
                    (part) => part.type === "text" && /compress tool/i.test(part.text),
                ),
            ),
            false,
        )
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 rejected patch rolls back live state, event, persistence, and deferred effects", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-rejection-"))
    const logger = new Logger(false, "silent")
    const cfg = config(storage, true)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    const notifications: string[] = []
    const deferredEffects: string[] = []
    const projectedBySession = new Map<string, readonly unknown[]>([
        ["session", [{ type: "user", id: "initial", time: { created: 1 }, text: "initial" }]],
    ])
    const adapter = host(
        projectedBySession,
        [{ providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 }],
        new Map(),
        notifications,
    )
    logger.saveContext = async () => {
        deferredEffects.push("debug-context")
    }
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    await handler(
        context("session", modelA, [
            Message.make({ id: "initial", role: "user", content: "initial" }),
        ]),
    )

    try {
        const state = registry.get("session")
        assert.ok(state)
        const block: CompressionBlock = {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 10,
            summaryTokens: 2,
            durationMs: 0,
            topic: "rollback",
            startId: "system-source",
            endId: "system-source",
            anchorMessageId: "system-source",
            compressMessageId: "system-source",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: ["system-source"],
            directToolIds: [],
            effectiveMessageIds: ["system-source"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "rollback",
            survivedCount: 0,
        }
        state.prune.messages.blocksById.set(1, block)
        state.prune.messages.activeBlockIds.add(1)
        state.prune.messages.activeByAnchorMessageId.set("system-source", 1)
        state.prune.messages.byMessageId.set("system-source", {
            tokenCount: 10,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
        state.prune.messages.membershipsVerified = true
        state.prune.messages.structureVersion = 1
        state.prune.messages.lastSyncedStructureVersion = 0
        state.nudges.lastPerMessageNudgeTokens = 77
        await saveSessionState(state, logger)
        const persistedBefore = readFileSync(join(storage, "session.json"), "utf8")
        const stateBefore = cloneSessionState(state)
        notifications.length = 0
        deferredEffects.length = 0

        projectedBySession.set("session", [
            { type: "system", id: "system-source", time: { created: 2 }, text: "opaque system" },
            { type: "user", id: "after-rejection", time: { created: 3 }, text: "safe user" },
        ])
        const event = context("session", modelA, [
            Message.make({ role: "system", content: "opaque system" }),
            Message.make({ id: "after-rejection", role: "user", content: "safe user" }),
        ])
        const eventMessagesBefore = event.messages
        const eventSystemBefore = event.system
        const eventMessageValues = [...event.messages]
        const eventSystemValues = [...event.system]

        await handler(event)

        assert.strictEqual(event.messages, eventMessagesBefore)
        assert.deepEqual(event.messages, eventMessageValues)
        assert.strictEqual(event.system, eventSystemBefore)
        assert.deepEqual(event.system, eventSystemValues)
        assert.deepEqual(cloneSessionState(state), stateBefore)
        assert.equal(readFileSync(join(storage, "session.json"), "utf8"), persistedBefore)
        assert.deepEqual(notifications, [])
        assert.deepEqual(deferredEffects, [])
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})
