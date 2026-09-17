import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { normalizeV2ProjectedHistory } from "../lib/v2/projection"
import { createSessionState } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildStatusReport } from "../lib/compress/status"
import { handleContextCommand } from "../lib/commands/context"
import { Logger } from "../lib/logger"
import { attachV2CompactionTimestamp } from "../lib/v2/history"

function fixture() {
    const messages = normalizeV2ProjectedHistory(
        [
            {
                type: "compaction",
                id: "c",
                status: "completed",
                time: { created: 1 },
                summary: "short",
                recent: "recent",
                tokens: {
                    input: 653137,
                    output: 955,
                    reasoning: 723,
                    cache: { read: 0, write: 0 },
                },
            },
            { type: "user", id: "u", text: "continue" },
        ],
        [],
        { sessionID: "diagnostics" },
    ).messages
    const state = createSessionState()
    state.sessionId = "diagnostics"
    assignMessageRefs(state, messages)
    return { messages, state }
}

test("cold V2 status reports unknown overhead rather than inferring compaction usage", () => {
    const { messages, state } = fixture()
    const output = buildStatusReport({ state }, messages)
    assert.doesNotMatch(output, /653[.,]1K|65313[0-9]/)
    assert.match(output, /overhead.*unavailable/i)
})

test("zero V2 overhead remains authoritative in status", () => {
    const { messages, state } = fixture()
    state.systemPromptTokens = 0
    const output = buildStatusReport({ state }, messages)
    assert.match(output, /0 system/)
    assert.doesNotMatch(output, /overhead.*unavailable/i)
})

test("V2 suffix diagnostics disclose the unobservable native prefix", () => {
    const { messages, state } = fixture()
    attachV2CompactionTimestamp(messages, 123)
    assert.match(buildStatusReport({ state }, messages), /native checkpoint prefix.*outside/i)
})

test("V2 context command uses current overhead and labels historical savings", async () => {
    const { messages, state } = fixture()
    state.systemPromptTokens = 1200
    state.stats.totalPruneTokens = 600000
    let output = ""
    await handleContextCommand({
        state,
        messages,
        sessionId: "diagnostics",
        logger: new Logger(false, "silent"),
        notices: {
            send: async (input) => {
                output = input.text
            },
        },
    })
    assert.match(output, /1\.2K tokens/)
    assert.doesNotMatch(output, /653[.,]1K|Without ACP/)
    assert.match(output, /historical/i)
    assert.match(output, /projected.*estimate/i)
})
