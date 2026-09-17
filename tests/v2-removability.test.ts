import "./test-env"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getConfig } from "../lib/config"
import { normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { createSessionState, SessionStateRegistry } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext } from "../lib/compress/search"
import { prepareExecutableRangePlans } from "../lib/compress/range-utils"
import { buildCompressibleRanges } from "../lib/messages/inject/utils"
import { planCompressionCandidates } from "../lib/messages/inject/candidates"
import { createCompressRangeToolDefinition } from "../lib/compress/range"
import { createV2Tool } from "../lib/v2/tools"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import type { V2HostAdapter } from "../lib/v2/host"
import { prune } from "../lib/messages/prune"

const model = { providerID: "test", id: "model" }
function fixture() {
    const config = getConfig({ directory: tmpdir(), notifications: { notify() {} } })
    config.autoUpdate = false
    config.pruneNotification = "off"
    const sources: unknown[] = [
        {
            type: "compaction",
            id: "checkpoint",
            status: "completed",
            reason: "manual",
            time: { created: 1 },
            summary: "opaque history ".repeat(1000),
            recent: "",
            providerState: { responseId: "test" },
        },
        ...Array.from({ length: 8 }, (_, i) => ({
            type: "assistant",
            id: `a${i}`,
            time: { created: 10 + i, completed: 11 + i },
            model,
            content: [{ type: "text", text: `history ${i} `.repeat(1000) }],
        })),
        { type: "user", id: "latest", time: { created: 30 }, text: "continue" },
    ]
    const messages = normalizeV2ProjectedHistory(sources, [], {
        sessionID: "removability",
        currentModel: model,
    }).messages
    const state = createSessionState()
    assignMessageRefs(state, messages)
    const ref = (id: string) => state.messageIds.byRawId.get(id)!
    return { config, sources, messages, state, ref }
}

test("V2 non-removable sources cannot enter executable range accounting", () => {
    const { config, messages, state, ref } = fixture()
    const context = buildSearchContext(state, messages)
    assert.throws(
        () =>
            prepareExecutableRangePlans(
                {
                    topic: "checkpoint",
                    startId: ref("checkpoint"),
                    endId: ref("checkpoint"),
                    summary: "summary",
                },
                context,
                state,
                config,
            ),
        /non-removable|provider-owned/i,
    )
    const mixed = prepareExecutableRangePlans(
        { topic: "mixed", startId: ref("checkpoint"), endId: ref("a0"), summary: "summary" },
        context,
        state,
        config,
    )
    assert.deepEqual(mixed.plans[0].selection.messageIds, ["a0"])
    assert.equal(mixed.plans[0].selection.messageTokenById.has("checkpoint"), false)
})

test("historical pruning membership cannot hide a protected V2 checkpoint from budgeting", () => {
    const { config, messages, state } = fixture()
    state.prune.messages.byMessageId.set("checkpoint", {
        tokenCount: 10000,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const checkpoint = messages[0]
    prune(state, new Logger(false, "silent"), config, messages)
    assert.ok(messages.includes(checkpoint))
})

test("part opacity does not prevent atomic removal of a multipart tool source", () => {
    const { config, sources, state } = fixture()
    sources.splice(1, 0, {
        type: "assistant",
        id: "multipart",
        model,
        time: { created: 2, completed: 3 },
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
                        { type: "text", text: "output ".repeat(1500) },
                        { type: "text", text: "exit 0" },
                    ],
                },
            },
        ],
    })
    const messages = normalizeV2ProjectedHistory(sources, [], {
        sessionID: "removability",
        currentModel: model,
    }).messages
    assignMessageRefs(state, messages)
    const ref = state.messageIds.byRawId.get("multipart")!
    const planned = prepareExecutableRangePlans(
        { topic: "tool", startId: ref, endId: ref, summary: "summary" },
        buildSearchContext(state, messages),
        state,
        config,
    )
    assert.deepEqual(planned.plans[0].selection.messageIds, ["multipart"])
    assert.deepEqual(planned.plans[0].selection.toolIds, ["shell-call"])
})

test("range and candidate guidance exclude checkpoints consistently across turns", () => {
    const { config, messages, state, ref } = fixture()
    const checkpointRef = ref("checkpoint")
    for (let turn = 0; turn < 2; turn++) {
        state.currentTurn = turn
        const ranges = buildCompressibleRanges(messages, state, config.compress.protectedTools)
        assert.equal(
            ranges.compressible.some((range) => range.startRef === checkpointRef),
            false,
        )
        const candidates = planCompressionCandidates(messages, state, config)
        assert.equal(
            candidates.candidates.some((candidate) =>
                candidate.sourceMessageIds.includes("checkpoint"),
            ),
            false,
        )
        assert.ok(
            candidates.candidates.some((candidate) => candidate.sourceMessageIds.includes("a0")),
        )
    }
})

test("real V2 compress rejects an opaque-only selection without saving a block", async () => {
    const { config, messages, sources } = fixture()
    const storage = mkdtempSync(join(tmpdir(), "acp-removability-"))
    config.storagePath = storage
    const logger = new Logger(false, "silent")
    const host: V2HostAdapter = {
        directory: storage,
        sessions: {
            get: async (id) => ({ id }),
            messages: async () => structuredClone(messages),
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async () => {} },
        notifications: { notify() {} },
        projectedContext: async () => sources,
    }
    const registry = new SessionStateRegistry(logger, storage)
    const prompts = new PromptStore(logger, storage)
    try {
        await registry.getOrCreate(host.sessions, "removability", messages, config)
        const state = registry.get("removability")!
        assignMessageRefs(state, messages)
        const ref = state.messageIds.byRawId.get("checkpoint")!
        const factory = { host, registry, logger, config, prompts }
        const tool = createV2Tool(createCompressRangeToolDefinition(factory), factory, host, {
            agents: {},
        })
        const result = await tool.execute(
            {
                topic: "checkpoint",
                content: [{ startId: ref, endId: ref, summary: "summary of history" }],
            },
            {
                sessionID: "removability",
                messageID: "compress",
                id: "call",
                agent: "build",
                progress: async () => {},
            },
        )
        assert.match(String(result.content), /non-removable|provider-owned/i)
        assert.equal(registry.get("removability")!.prune.messages.blocksById.size, 0)
        assert.equal(registry.get("removability")!.stats.totalPruneTokens, 0)
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})
