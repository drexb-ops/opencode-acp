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
import { saveSessionState } from "../lib/state/persistence"
import { getActiveSummaryTokenUsage } from "../lib/state/utils"
import { SessionStateRegistry } from "../lib/state"
import { createV2ContextHandler } from "../lib/v2/context"
import { normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { createCompressRangeToolDefinition } from "../lib/compress/range"
import { createV2Tool } from "../lib/v2/tools"
import type { V2HostAdapter } from "../lib/v2/host"
import type { CompressionBlock, SessionState } from "../lib/state/types"

interface Fixture {
    storage: string
    config: ReturnType<typeof getConfig>
    logger: Logger
    prompts: PromptStore
    model: { providerID: string; id: string }
    sessionID: string
    sources: unknown[]
    outgoing: Message[]
    checkpoint: Message
    repeatedSystem: Message
    task: Message
    oldMessages: Message[]
    secondaryMessages: Message[]
    shellCall: unknown
    shellResultPart: unknown
    shell: Message
    shellResult: Message
    latest: Message
    sentinel: string
    summary: string
    secondarySummary: string
}

interface SeededBlock {
    blockId: number
    blockCount: number
    byMessageCount: number
    nextBlockId: number
    nextRunId: number
    totalPruneTokens: number
    blockIds: number[]
}

function createFixture(): Fixture {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-persisted-wire-"))
    const config = getConfig({ directory: storage, notifications: { notify() {} } })
    config.storagePath = storage
    config.autoUpdate = false
    config.pruneNotification = "off"

    const logger = new Logger(false, "silent")
    const prompts = new PromptStore(logger, storage)
    const model = { providerID: "test", id: "model" }
    const sessionID = "persisted-wire-session"
    const sentinel = "PERSISTED_ORIGINAL_SENTINEL " + "older implementation detail ".repeat(500)
    const summary =
        "PERSISTED_ORPHAN_SUMMARY: completed implementation decisions and verified behavior."
    const secondarySummary = "PERSISTED_SECOND_ORPHAN_SUMMARY: independently recovered later work."

    const checkpointText =
        "<conversation-checkpoint>\nThis provider checkpoint is historical context.\n\n<summary>checkpoint</summary>\n<recent-context>recent</recent-context>\n</conversation-checkpoint>"
    const checkpoint = Message.make({ id: "checkpoint", role: "user", content: checkpointText })
    const repeatedSystem = Message.system("Repeated provider instruction")
    const task = Message.make({ id: "task", role: "user", content: "Keep the task visible" })
    const oldMessages = Array.from({ length: 6 }, (_, index) =>
        Message.make({
            id: `old-${index}`,
            role: "assistant",
            content: `${sentinel} SOURCE_${index}`,
        }),
    )
    const secondaryMessages = Array.from({ length: 2 }, (_, index) =>
        Message.make({
            id: `secondary-${index}`,
            role: "assistant",
            content:
                `SECONDARY_ORIGINAL_SENTINEL_${index} ` +
                "later implementation detail ".repeat(180),
        }),
    )
    const shellCall = {
        type: "tool-call" as const,
        id: "shell-call",
        name: "shell",
        input: { command: "true" },
        providerExecuted: false,
    }
    const shellResultPart = {
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
    const shell = Message.make({ id: "shell", role: "assistant", content: [shellCall] })
    const shellResult = Message.tool(shellResultPart)
    const recentMessages = Array.from({ length: 8 }, (_, index) =>
        Message.make({
            id: `recent-${index}`,
            role: "assistant",
            content: "unrelated recent context ".repeat(120),
        }),
    )
    const latest = Message.make({ id: "latest", role: "user", content: "Please continue" })

    const outgoing = [
        checkpoint,
        repeatedSystem,
        task,
        ...oldMessages,
        ...secondaryMessages,
        shell,
        shellResult,
        ...recentMessages,
        latest,
    ]
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
        { type: "system", id: "sys-1", text: "Repeated provider instruction" },
        { type: "user", id: "task", time: { created: 2 }, text: "Keep the task visible" },
        ...oldMessages.map((message, index) => ({
            type: "assistant",
            id: message.id,
            time: { created: 3 + index * 2, completed: 4 + index * 2 },
            model,
            content: [{ type: "text", text: `${sentinel} SOURCE_${index}` }],
        })),
        ...secondaryMessages.map((message, index) => ({
            type: "assistant",
            id: message.id,
            time: { created: 15 + index * 2, completed: 16 + index * 2 },
            model,
            content: [
                {
                    type: "text",
                    text:
                        `SECONDARY_ORIGINAL_SENTINEL_${index} ` +
                        "later implementation detail ".repeat(180),
                },
            ],
        })),
        {
            type: "assistant",
            id: "shell",
            time: { created: 20, completed: 21 },
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
        ...recentMessages.map((message, index) => ({
            type: "assistant",
            id: message.id,
            model,
            time: { created: 30 + index, completed: 31 + index },
            content: [{ type: "text", text: "unrelated recent context ".repeat(120) }],
        })),
        { type: "user", id: "latest", time: { created: 50 }, text: "Please continue" },
    ]

    return {
        storage,
        config,
        logger,
        prompts,
        model,
        sessionID,
        sources,
        outgoing,
        checkpoint,
        repeatedSystem,
        task,
        oldMessages,
        secondaryMessages,
        shellCall: shell.content[0]!,
        shellResultPart: shellResult.content[0]!,
        shell,
        shellResult,
        latest,
        sentinel,
        summary,
        secondarySummary,
    }
}

function createHost(fixture: Fixture): V2HostAdapter {
    return {
        directory: fixture.storage,
        sessions: {
            get: async (id) => ({ id }),
            messages: async () =>
                normalizeV2ProjectedHistory(fixture.sources, [], {
                    sessionID: fixture.sessionID,
                    currentModel: fixture.model,
                }).messages,
            parentMessages: async () => [],
        },
        models: {
            list: async () => [
                {
                    providerId: fixture.model.providerID,
                    modelId: fixture.model.id,
                    contextLimit: 400000,
                },
            ],
        },
        projectedContext: async () => fixture.sources,
        notices: { send: async () => {} },
        notifications: { notify() {} },
    }
}

function createEvent(
    fixture: Fixture,
    messages = fixture.outgoing,
): {
    sessionID: string
    agent: string
    model: { providerID: string; id: string }
    system: { type: "text"; text: string }[]
    messages: Message[]
} {
    return {
        sessionID: fixture.sessionID,
        agent: "build",
        model: fixture.model,
        system: [{ type: "text", text: "System instructions" }],
        messages: [...messages],
    }
}

async function seedPersistedBlock(
    fixture: Fixture,
    includeSecondaryBlock = false,
    mutate?: (block: CompressionBlock, state: SessionState) => void,
): Promise<SeededBlock> {
    const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
    const host = createHost(fixture)
    const permission = { agents: {} }
    const handler = createV2ContextHandler(
        host,
        registry,
        fixture.logger,
        fixture.config,
        fixture.prompts,
        permission,
    )

    await handler(createEvent(fixture))
    const initialized = registry.get(fixture.sessionID)
    assert.ok(initialized, "initial V2 context must initialize state")
    const startId = initialized.messageIds.byRawId.get(fixture.oldMessages[0]!.id)
    const endId = initialized.messageIds.byRawId.get(fixture.oldMessages.at(-1)!.id)
    assert.ok(startId && endId, "all selected source IDs must be addressable")

    const factory = {
        host,
        registry,
        logger: fixture.logger,
        config: fixture.config,
        prompts: fixture.prompts,
    }
    const tool = createV2Tool(createCompressRangeToolDefinition(factory), factory, host, permission)
    const args = {
        topic: "persisted old work",
        content: [{ startId, endId, summary: fixture.summary }],
    }
    const result = await tool.execute(args, {
        sessionID: fixture.sessionID,
        agent: "build",
        messageID: "compress-message",
        id: "compress-call",
        progress: async () => {},
    })
    assert.match(String(result.content), /^Compressed 6 messages/)

    if (includeSecondaryBlock) {
        const afterFirstCompression = registry.get(fixture.sessionID)
        assert.ok(afterFirstCompression)
        const secondaryStartId = afterFirstCompression.messageIds.byRawId.get(
            fixture.secondaryMessages[0]!.id,
        )
        const secondaryEndId = afterFirstCompression.messageIds.byRawId.get(
            fixture.secondaryMessages.at(-1)!.id,
        )
        assert.ok(secondaryStartId && secondaryEndId)
        const secondaryResult = await tool.execute(
            {
                topic: "persisted second work",
                content: [
                    {
                        startId: secondaryStartId,
                        endId: secondaryEndId,
                        summary: fixture.secondarySummary,
                    },
                ],
            },
            {
                sessionID: fixture.sessionID,
                agent: "build",
                messageID: "compress-message-2",
                id: "compress-call-2",
                progress: async () => {},
            },
        )
        assert.match(String(secondaryResult.content), /^Compressed 2 messages/)
    }

    const seeded = registry.get(fixture.sessionID)
    assert.ok(seeded, "real compression must persist state")
    const activeBlocks = [...seeded.prune.messages.blocksById.values()].filter(
        (block) => block.active,
    )
    assert.equal(activeBlocks.length, includeSecondaryBlock ? 2 : 1)

    // The real tool created the block. Clearing only this historical anchor
    // field models a persisted old block whose compress assistant/tool call was
    // later removed from public history by OpenCode; source IDs remain intact.
    for (const block of activeBlocks) {
        block.compressMessageId = undefined
        mutate?.(block, seeded)
    }
    await saveSessionState(seeded, fixture.logger)

    return {
        blockId: activeBlocks[0]!.blockId,
        blockCount: seeded.prune.messages.blocksById.size,
        byMessageCount: seeded.prune.messages.byMessageId.size,
        nextBlockId: seeded.prune.messages.nextBlockId,
        nextRunId: seeded.prune.messages.nextRunId,
        totalPruneTokens: seeded.stats.totalPruneTokens,
        blockIds: activeBlocks.map((block) => block.blockId),
    }
}

function summaryMessages(messages: readonly Message[], summary: string): Message[] {
    return messages.filter((message) => JSON.stringify(message).includes(summary))
}

test("V2 reload restores a persisted orphan summary onto the provider wire", async () => {
    const fixture = createFixture()
    try {
        const seeded = await seedPersistedBlock(fixture)
        const host = createHost(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const permission = { agents: {} }
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            permission,
        )

        assert.equal(registry.get(fixture.sessionID), undefined, "reload registry starts cold")
        const next = createEvent(fixture)
        const originalWireSize = JSON.stringify(next.messages).length
        await handler(next)
        const wire = JSON.stringify(next.messages)
        const summaries = summaryMessages(next.messages, fixture.summary)

        assert.equal(wire.includes(fixture.sentinel), false)
        assert.equal(summaries.length, 1, "stored summary must reach the actual V2 request")
        assert.match(summaries[0]!.id, /^msg_dcp_summary_[0-9a-f]{16}$/)
        assert.doesNotMatch(wire, /<dcp-message-id>b\d+<\/dcp-message-id>/)
        assert.ok(wire.length < originalWireSize - 10000, "the selected original wire must shrink")
        assert.ok(next.messages.includes(fixture.checkpoint))
        assert.ok(next.messages.includes(fixture.repeatedSystem))
        assert.equal(
            next.messages.some((message) => message.id === fixture.task.id),
            true,
        )
        assert.equal(
            next.messages.some((message) => message.id === fixture.latest.id),
            true,
        )
        assert.ok(
            next.messages.some(
                (message) =>
                    Array.isArray(message.content) &&
                    message.content.some((part) => part === fixture.shellCall),
            ),
            "opaque assistant part identity must survive",
        )
        assert.ok(
            next.messages.some(
                (message) =>
                    Array.isArray(message.content) &&
                    message.content.some((part) => part === fixture.shellResultPart),
            ),
            "opaque result part identity must survive",
        )
        assert.equal(
            next.messages.some((message) =>
                fixture.oldMessages.some((oldMessage) => message.id === oldMessage.id),
            ),
            false,
            "all selected original messages must be absent from the provider request",
        )
        const summaryIndex = next.messages.indexOf(summaries[0]!)
        assert.ok(next.messages.indexOf(fixture.checkpoint) < summaryIndex)
        assert.ok(
            summaryIndex < next.messages.findIndex((message) => message.id === fixture.shell.id),
        )

        const loaded = registry.get(fixture.sessionID)
        assert.ok(loaded)
        assert.deepEqual([...loaded.prune.messages.blocksById.keys()], [seeded.blockId])
        assert.ok(
            loaded.prune.messages.blocksById.get(seeded.blockId)?.summary.includes(fixture.summary),
            "persisted block summary must be loaded before recovery",
        )
        assert.equal(loaded.prune.messages.blocksById.size, seeded.blockCount)
        assert.equal(loaded.prune.messages.byMessageId.size, seeded.byMessageCount)
        assert.equal(loaded.prune.messages.nextBlockId, seeded.nextBlockId)
        assert.equal(loaded.prune.messages.nextRunId, seeded.nextRunId)
        assert.equal(loaded.messageIds.byRawId.has(summaries[0]!.id), false)

        const repeat = createEvent(fixture)
        await handler(repeat)
        const repeatedSummaries = summaryMessages(repeat.messages, fixture.summary)
        const afterRepeat = registry.get(fixture.sessionID)
        assert.ok(afterRepeat)
        assert.equal(repeatedSummaries.length, 1, "repeated hooks must not duplicate summaries")
        assert.equal(repeatedSummaries[0]!.id, summaries[0]!.id)
        assert.deepEqual([...afterRepeat.prune.messages.blocksById.keys()], [seeded.blockId])
        assert.equal(afterRepeat.prune.messages.nextBlockId, seeded.nextBlockId)
        assert.equal(afterRepeat.prune.messages.nextRunId, seeded.nextRunId)
        assert.equal(afterRepeat.prune.messages.byMessageId.size, seeded.byMessageCount)
        assert.equal(afterRepeat.messageIds.byRawId.has(repeatedSummaries[0]!.id), false)
        for (const entry of afterRepeat.prune.messages.byMessageId.values()) {
            assert.equal(new Set(entry.allBlockIds).size, entry.allBlockIds.length)
            assert.equal(new Set(entry.activeBlockIds).size, entry.activeBlockIds.length)
        }

        const replayedOutput = createEvent(fixture, next.messages)
        await handler(replayedOutput)
        assert.equal(
            summaryMessages(replayedOutput.messages, fixture.summary).length,
            1,
            "replaying an already patched output must not duplicate the summary",
        )
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 metadata-only persisted summary fails closed without pruning sources", async () => {
    const fixture = createFixture()
    try {
        await seedPersistedBlock(fixture, false, (block) => {
            block.summary = `[Compressed conversation section]\n<dcp-message-id>b${block.blockId}</dcp-message-id>`
            block.summaryTokens = 1
        })
        const host = createHost(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            { agents: {} },
        )
        const next = createEvent(fixture)
        await handler(next)

        assert.equal(
            next.messages.some((message) => /^msg_dcp_summary_[0-9a-f]{16}$/.test(message.id)),
            false,
        )
        assert.equal(
            fixture.oldMessages.every((oldMessage) =>
                next.messages.some((message) => message.id === oldMessage.id),
            ),
            true,
            "corrupt metadata-only summary must preserve every selected source",
        )
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 mismatched visible compress carrier cannot suppress summary recovery", async () => {
    const fixture = createFixture()
    try {
        await seedPersistedBlock(fixture, false, (block) => {
            block.compressMessageId = "fake-compress-carrier"
            block.compressCallId = "expected-compress-call"
        })
        const wrongInput = {
            topic: "unrelated",
            content: [{ startId: "m1", endId: "m2", summary: "wrong summary" }],
        }
        const fakeCall = {
            type: "tool-call" as const,
            id: "wrong-compress-call",
            name: "compress",
            input: wrongInput,
        }
        const fakeCarrier = Message.make({
            id: "fake-compress-carrier",
            role: "assistant",
            content: [fakeCall],
        })
        fixture.outgoing.push(fakeCarrier)
        fixture.sources.push({
            type: "assistant",
            id: fakeCarrier.id,
            parentIndex: 0,
            model: { id: fixture.model.id, providerID: fixture.model.providerID },
            time: { created: 15 },
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            content: [
                {
                    type: "tool",
                    id: fakeCall.id,
                    name: fakeCall.name,
                    state: {
                        status: "completed",
                        input: wrongInput,
                        output: "unrelated compression",
                    },
                },
            ],
        })

        const host = createHost(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            { agents: {} },
        )
        const next = createEvent(fixture)
        await handler(next)

        assert.equal(summaryMessages(next.messages, fixture.summary).length, 1)
        assert.equal(
            next.messages.some((message) => message.id === fakeCarrier.id),
            true,
        )
        assert.equal(
            fixture.oldMessages.some((oldMessage) =>
                next.messages.some((message) => message.id === oldMessage.id),
            ),
            false,
        )
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 recovers multiple persisted orphan blocks in deterministic order", async () => {
    const fixture = createFixture()
    try {
        const seeded = await seedPersistedBlock(fixture, true)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const handler = createV2ContextHandler(
            createHost(fixture),
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            { agents: {} },
        )
        const event = createEvent(fixture)
        await handler(event)

        const firstSummary = summaryMessages(event.messages, fixture.summary)
        const secondSummary = summaryMessages(event.messages, fixture.secondarySummary)
        assert.equal(firstSummary.length, 1)
        assert.equal(secondSummary.length, 1)
        assert.ok(
            event.messages.indexOf(firstSummary[0]!) < event.messages.indexOf(secondSummary[0]!),
        )
        assert.deepEqual(
            [...registry.get(fixture.sessionID)!.prune.messages.blocksById.keys()],
            seeded.blockIds,
        )

        const repeat = createEvent(fixture)
        await handler(repeat)
        const repeatedFirstSummary = summaryMessages(repeat.messages, fixture.summary)
        const repeatedSecondSummary = summaryMessages(repeat.messages, fixture.secondarySummary)
        assert.equal(repeatedFirstSummary.length, 1)
        assert.equal(repeatedSecondSummary.length, 1)
        assert.notEqual(repeatedFirstSummary[0]!.id, repeatedSecondSummary[0]!.id)
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 keeps an all-absent persisted block historical without wire savings", async () => {
    const fixture = createFixture()
    try {
        const seeded = await seedPersistedBlock(fixture)
        fixture.sources.splice(0, fixture.sources.length, {
            type: "user",
            id: fixture.latest.id,
            time: { created: 60 },
            text: "Please continue",
        })
        const current = [fixture.latest]
        const host = createHost(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const permission = { agents: {} }
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            permission,
        )
        const event = createEvent(fixture, current)
        await handler(event)

        const wire = JSON.stringify(event.messages)
        const loaded = registry.get(fixture.sessionID)
        assert.ok(loaded)
        assert.equal(event.messages.length, 1)
        assert.equal(event.messages[0]?.id, fixture.latest.id)
        assert.match(String(event.messages[0]?.content[0]?.text), /^Please continue/)
        assert.equal(wire.includes(fixture.summary), false)
        assert.equal(
            getActiveSummaryTokenUsage(
                loaded,
                new Set(event.messages.map((message) => message.id)),
            ),
            0,
            "a block with no visible source/call must not count current summary usage",
        )
        assert.equal(loaded.stats.totalPruneTokens, seeded.totalPruneTokens)
        assert.equal(loaded.prune.messages.blocksById.get(seeded.blockId)?.active, true)
        assert.equal(loaded.prune.messages.activeBlockIds.has(seeded.blockId), true)
        assert.equal(loaded.prune.messages.blocksById.get(seeded.blockId)?.deactivatedByUser, false)
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 refuses stale persisted membership instead of removing a same-ID message", async () => {
    const fixture = createFixture()
    try {
        const seeded = await seedPersistedBlock(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const host = createHost(fixture)
        const permission = { agents: {} }
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            permission,
        )
        await handler(createEvent(fixture))
        const loaded = registry.get(fixture.sessionID)
        assert.ok(loaded)
        loaded.prune.messages.byMessageId.set("unrelated", {
            tokenCount: 100,
            allBlockIds: [seeded.blockId],
            activeBlockIds: [seeded.blockId],
        })

        const unrelated = Message.make({
            id: "unrelated",
            role: "assistant",
            content: "STALE_MEMBERSHIP_SENTINEL",
        })
        fixture.sources.push({
            type: "assistant",
            id: "unrelated",
            model: fixture.model,
            time: { created: 70, completed: 71 },
            content: [{ type: "text", text: "STALE_MEMBERSHIP_SENTINEL" }],
        })
        const event = createEvent(fixture, [...fixture.outgoing, unrelated])
        await handler(event)

        assert.ok(
            event.messages.some(
                (message) =>
                    message.id === unrelated.id &&
                    message.content.some(
                        (part) =>
                            part.type === "text" &&
                            part.text.startsWith("STALE_MEMBERSHIP_SENTINEL"),
                    ),
            ),
            "stale membership must not remove the message",
        )
        assert.equal(JSON.stringify(event.messages).includes(fixture.sentinel), false)
        assert.equal(summaryMessages(event.messages, fixture.summary).length, 1)
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})

test("V2 rejects a same-ID replay with changed content instead of claiming savings", async () => {
    const fixture = createFixture()
    try {
        await seedPersistedBlock(fixture)
        const registry = new SessionStateRegistry(fixture.logger, fixture.storage)
        const host = createHost(fixture)
        const permission = { agents: {} }
        const handler = createV2ContextHandler(
            host,
            registry,
            fixture.logger,
            fixture.config,
            fixture.prompts,
            permission,
        )
        const changed = Message.make({
            id: fixture.oldMessages[0]!.id,
            role: "assistant",
            content: "CHANGED_SAME_ID_SENTINEL",
        })
        const replay = createEvent(fixture, [
            fixture.checkpoint,
            fixture.task,
            changed,
            fixture.latest,
        ])
        await handler(replay)

        assert.ok(replay.messages.includes(changed), "changed same-ID content must be preserved")
        assert.equal(JSON.stringify(replay.messages).includes(fixture.summary), false)
        assert.equal(JSON.stringify(replay.messages).includes("CHANGED_SAME_ID_SENTINEL"), true)
    } finally {
        rmSync(fixture.storage, { recursive: true, force: true })
    }
})
