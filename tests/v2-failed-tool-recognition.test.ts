/**
 * Issue #426 — failed V2 ACP tool results must be recognized as failures.
 *
 * The pinned V2 Promise adapter has no safe native error channel, so
 * createV2Tool returns resolved results for caught execution failures and
 * the host records them with status "completed". These tests pin the fix:
 * - explicit `acpFailed` metadata (or compatible historical failure output)
 *   is projected internally as a failed tool without touching provider-owned
 *   output;
 * - cold rebuild does not reconstruct blocks from failed compress calls;
 * - warm nudge handling treats failed attempts as attempts (anchors reset)
 *   but never advances success baselines; successful compress still does.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import "./test-env"
import {
    ACP_FAILURE_METADATA_KEY,
    ACP_FAILURE_OUTPUT_PATTERN,
    V2_ACP_TOOL_NAMES,
    isAcpFailedToolOutput,
    isAcpToolName,
} from "../lib/v2/projection/acp-failure"
import { toolState } from "../lib/v2/projection/shared"
import { rebuildCompressionState } from "../lib/state/rebuild"
import { createSessionState } from "../lib/state/state"
import type { SessionState } from "../lib/state/types"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { createTestRegistry } from "./registry-stub"
import type { WithParts } from "@opencode-ai/plugin"

// ─── (a) acp-failure pure module ────────────────────────────────────────────

const FAILURE_MESSAGES = [
    "ACP cannot request an interactive permission on OpenCode V2.0.3. Set the active agent's `compress` permission to `allow` or `deny`, then retry.",
    "ACP tool execution is disabled by the active agent or ACP configuration. Choose `allow` for the `compress` permission to enable it.",
    "ACP direct tools are disabled for child sessions when `allowSubAgents` is false.",
    "ACP could not verify the session parent; direct tool execution was blocked.",
    "ACP is shutting down; this operation was not executed.",
    "ACP is currently disabled because a /bili/ proxy is active.",
    "ACP could not resolve the active agent permission; execution was blocked.",
    "Invalid compress input: content must have at least one entry",
    "ACP compress failed: simulated execution failure",
    "ACP decompress failed: block b7 not found",
]

const SUCCESS_MESSAGES = [
    "Compressed 4 messages into [Compressed conversation section].",
    "[Compressed conversation section]\n\nSummary of m00001-m00004.",
    "No active compression blocks.",
    'No matches found for query "decoder".',
    "Restored 3 messages from b5.",
    "Context usage 42% — 84k / 200k tokens.",
]

describe("acp-failure module", () => {
    it("exposes exactly the five ACP tool names", () => {
        assert.deepEqual(
            [...V2_ACP_TOOL_NAMES],
            ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
        )
    })

    it("matches every known failure shape at position zero", () => {
        for (const message of FAILURE_MESSAGES) {
            assert.ok(
                ACP_FAILURE_OUTPUT_PATTERN.test(message),
                `should match failure shape: ${message.slice(0, 40)}...`,
            )
        }
    })

    it("never matches failure text appearing mid-output", () => {
        const quoted = "Previous attempt said:\nACP compress failed: timeout\nRetrying now."
        assert.ok(!ACP_FAILURE_OUTPUT_PATTERN.test(quoted))
        const recap =
            "[Compressed conversation section]\n\nEarlier run noted ACP decompress failed: b3 missing."
        assert.ok(!ACP_FAILURE_OUTPUT_PATTERN.test(recap))
    })

    it("never matches genuine success outputs", () => {
        for (const message of SUCCESS_MESSAGES) {
            assert.ok(!ACP_FAILURE_OUTPUT_PATTERN.test(message), `must not match: ${message}`)
        }
    })

    it("classifies tool names precisely", () => {
        for (const name of V2_ACP_TOOL_NAMES) {
            assert.equal(isAcpToolName(name), true)
        }
        assert.equal(isAcpToolName("bash"), false)
        assert.equal(isAcpToolName("read"), false)
        assert.equal(isAcpToolName(undefined), false)
    })

    it("treats explicit acpFailed metadata as authoritative", () => {
        const rawState = { status: "completed", metadata: { [ACP_FAILURE_METADATA_KEY]: true } }
        // Metadata wins even when the text looks like a success.
        assert.equal(
            isAcpFailedToolOutput(
                "compress",
                rawState,
                "Compressed 4 messages into [Compressed conversation section].",
            ),
            true,
        )
        // Metadata wins even with empty output.
        assert.equal(isAcpFailedToolOutput("acp_status", { ...rawState }, ""), true)
        // Absent metadata falls back to the pattern.
        assert.equal(
            isAcpFailedToolOutput("compress", { status: "completed" }, FAILURE_MESSAGES[8]),
            true,
        )
        assert.equal(
            isAcpFailedToolOutput("compress", { status: "completed" }, SUCCESS_MESSAGES[0]),
            false,
        )
        // Explicit false metadata must not override... it simply means "not flagged";
        // recognition then depends on the output pattern.
        assert.equal(
            isAcpFailedToolOutput(
                "compress",
                { metadata: { [ACP_FAILURE_METADATA_KEY]: false } },
                SUCCESS_MESSAGES[0],
            ),
            false,
        )
    })

    it("ignores non-ACP tools regardless of content or metadata", () => {
        assert.equal(
            isAcpFailedToolOutput(
                "bash",
                { metadata: { [ACP_FAILURE_METADATA_KEY]: true } },
                FAILURE_MESSAGES[8],
            ),
            false,
        )
        assert.equal(isAcpFailedToolOutput(undefined, {}, FAILURE_MESSAGES[8]), false)
    })
})

// ─── (b) projection: toolState recognizes failed ACP results ────────────────

function completedHostState(overrides: Record<string, unknown> = {}) {
    return {
        status: "completed",
        input: { topic: "work", content: [{ startId: "m00001", endId: "m00004", summary: "s" }] },
        title: "compress",
        metadata: {},
        content: [
            { type: "text", text: "Compressed 4 messages into [Compressed conversation section]." },
        ],
        time: { start: 1, end: 2 },
        ...overrides,
    }
}

describe("toolState projection of V2 ACP results", () => {
    it("projects a completed result with acpFailed metadata as an internal error", () => {
        const result = toolState({
            name: "compress",
            state: completedHostState({
                metadata: { [ACP_FAILURE_METADATA_KEY]: true, acpError: "execution" },
                content: [
                    { type: "text", text: "ACP compress failed: simulated execution failure" },
                ],
            }),
        })
        assert.equal(result.state.status, "error")
        assert.equal(result.state.error, "ACP compress failed: simulated execution failure")
        assert.deepEqual(result.state.input, {
            topic: "work",
            content: [{ startId: "m00001", endId: "m00004", summary: "s" }],
        })
        assert.deepEqual(result.state.metadata, {
            [ACP_FAILURE_METADATA_KEY]: true,
            acpError: "execution",
        })
        // No provider-owned output is exposed: origin correlation and patching
        // must leave the lowered result untouched.
        assert.equal(result.output, undefined)
        assert.equal(result.error, "ACP compress failed: simulated execution failure")
        assert.equal(result.opaqueResult, false)
    })

    it("recognizes historical failure output without metadata", () => {
        for (const message of FAILURE_MESSAGES) {
            const result = toolState({
                name: "compress",
                state: completedHostState({ content: [{ type: "text", text: message }] }),
            })
            assert.equal(
                result.state.status,
                "error",
                `expected error for: ${message.slice(0, 40)}...`,
            )
            assert.equal(result.output, undefined)
        }
    })

    it("keeps successful ACP results completed with their output", () => {
        for (const message of SUCCESS_MESSAGES) {
            const result = toolState({
                name: "compress",
                state: completedHostState({ content: [{ type: "text", text: message }] }),
            })
            assert.equal(result.state.status, "completed", `expected completed for: ${message}`)
            assert.equal(result.state.output, message)
            assert.equal(result.error, undefined)
        }
    })

    it("leaves non-ACP completed results untouched even with error-looking text", () => {
        const result = toolState({
            name: "bash",
            state: completedHostState({
                content: [{ type: "text", text: "ACP compress failed: quoted from log" }],
            }),
        })
        assert.equal(result.state.status, "completed")
        assert.equal(result.state.output, "ACP compress failed: quoted from log")
        assert.equal(result.error, undefined)
    })

    it("does not misclassify multi-line success output that quotes failure text later", () => {
        const text =
            "Restored 3 messages from b5.\nHistorical note: ACP decompress failed: b3 missing."
        const result = toolState({
            name: "decompress",
            state: completedHostState({ content: [{ type: "text", text }] }),
        })
        assert.equal(result.state.status, "completed")
        assert.equal(result.state.output, text)
    })

    it("preserves native host error states unchanged", () => {
        const result = toolState({
            name: "compress",
            state: {
                status: "error",
                input: {},
                error: { message: "native provider error" },
            },
        })
        assert.equal(result.state.status, "error")
        assert.equal(result.state.error, "native provider error")
        assert.equal(result.state.output, undefined)
    })

    it("preserves running states unchanged", () => {
        const result = toolState({
            name: "compress",
            state: { status: "running", input: {} },
        })
        assert.equal(result.state.status, "running")
    })
})

// ─── (c) cold rebuild skips failed compress calls ───────────────────────────

function buildRebuildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        logLevel: "silent",
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            minCompressRange: 0,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            maxSummaryLengthHard: 4000,
            maxVisibleSegments: 3,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function rebuildUserMessage(id: string, sessionID: string): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text: `user ${id}`, id: `${id}-p1`, sessionID, messageID: id }],
    }
}

function rebuildAssistantMessage(id: string, sessionID: string, extraParts: any[]): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID, messageID: id },
            { type: "text", text: `assistant ${id}`, id: `${id}-p1`, sessionID, messageID: id },
            ...extraParts,
        ],
    }
}

// Post-projection internal shapes: a failed V2 compress arrives here as an
// error-status part (no output); a successful one as completed + output.
function failedCompressPart(callID: string, sessionID: string, messageId: string) {
    return {
        type: "tool",
        tool: "compress",
        callID,
        id: `part-${callID}`,
        sessionID,
        messageID: messageId,
        state: {
            status: "error",
            input: {
                topic: "work",
                content: [{ startId: "m00001", endId: "m00004", summary: "s" }],
            },
            error: "ACP compress failed: simulated execution failure",
        },
    }
}

function successfulCompressPart(callID: string, sessionID: string, messageId: string) {
    return {
        type: "tool",
        tool: "compress",
        callID,
        id: `part-${callID}`,
        sessionID,
        messageID: messageId,
        state: {
            status: "completed",
            input: {
                topic: "work",
                content: [{ startId: "m00001", endId: "m00004", summary: "s" }],
            },
            output: "Compressed 4 messages into [Compressed conversation section].",
        },
    }
}

describe("cold rebuild after failure", () => {
    it("does not reconstruct a block from a failed compress call", () => {
        const SID = "rebuild-fail-cold"
        const config = buildRebuildConfig()
        const logger = new Logger(false)
        const state = createSessionState()
        state.sessionId = SID
        const messages: WithParts[] = [
            rebuildUserMessage("u1", SID),
            rebuildAssistantMessage("a1", SID, [failedCompressPart("c-fail", SID, "a1")]),
            rebuildUserMessage("u2", SID),
            rebuildAssistantMessage("a2", SID, []),
        ]
        const blocks = rebuildCompressionState(state, messages, config, logger)
        assert.equal(blocks, 0)
        assert.equal(state.prune.messages.blocksById.size, 0)
    })

    it("reconstructs only the successful call when one failed and one succeeded", () => {
        const SID = "rebuild-mixed-cold"
        const config = buildRebuildConfig()
        const logger = new Logger(false)
        const state = createSessionState()
        state.sessionId = SID
        const messages: WithParts[] = [
            rebuildUserMessage("u1", SID),
            rebuildAssistantMessage("a1", SID, [failedCompressPart("c-fail", SID, "a1")]),
            rebuildUserMessage("u2", SID),
            rebuildAssistantMessage("a2", SID, [successfulCompressPart("c-ok", SID, "a2")]),
            rebuildUserMessage("u3", SID),
            rebuildAssistantMessage("a3", SID, []),
        ]
        const blocks = rebuildCompressionState(state, messages, config, logger)
        assert.equal(blocks, 1)
        assert.equal(state.prune.messages.blocksById.size, 1)
    })
})

// ─── (d) warm nudge baselines across turns ──────────────────────────────────

const NUDGE_SID = "v2-fail-nudge-warm"

function buildNudgeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        logLevel: "silent",
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            minCompressRange: 0,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            // Production default per AGENTS.md §5.7.1 — the recent zone must
            // actually protect messages for this scenario to mirror production.
            preserveRecentMessages: 20,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            maxSummaryLengthHard: 4000,
            maxVisibleSegments: 3,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
    return { ...base, ...overrides }
}

function nudgeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: NUDGE_SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: NUDGE_SID, messageID: id }],
    }
}

function nudgeAssistantMessage(
    id: string,
    text: string,
    extraParts: any[] = [],
    tokenOverrides: { input?: number; output?: number } = {},
): WithParts {
    return {
        info: {
            id,
            sessionID: NUDGE_SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: {
                input: tokenOverrides.input ?? 100,
                output: tokenOverrides.output ?? 50,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: NUDGE_SID, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: NUDGE_SID, messageID: id },
            ...extraParts,
        ],
    }
}

function bashToolPart(messageId: string, callID: string, chars: number) {
    return {
        type: "tool",
        tool: "bash",
        callID,
        id: `part-${callID}`,
        sessionID: NUDGE_SID,
        messageID: messageId,
        state: { status: "completed", input: { command: "build" }, output: "x".repeat(chars) },
    }
}

/**
 * History deep enough that, with preserveRecentMessages: 20, more than 20
 * messages exist and the pre-recent-zone portion holds well over
 * EFFECTIVE_MIN_COMPRESSIBLE_TOKENS (1250) of compressible content. The final
 * assistant message carries realistic prompt sizes so current-token usage
 * (derived from the last assistant info.tokens, Bug 17) sits past the min
 * nudge limit.
 */
function buildHistory(pairs: number, charsPerOutput: number): WithParts[] {
    const messages: WithParts[] = []
    for (let i = 0; i < pairs; i += 1) {
        const uid = `h-u${i}`
        const aid = `h-a${i}`
        const isLast = i === pairs - 1
        messages.push(nudgeUserMessage(uid, `history user ${i}`))
        messages.push(
            nudgeAssistantMessage(
                aid,
                `history assistant ${i}`,
                [bashToolPart(aid, `h-c${i}`, charsPerOutput)],
                isLast ? { input: 100000, output: 50000 } : {},
            ),
        )
    }
    return messages
}

function setupNudgePipeline(stateOverrides: Partial<SessionState> = {}) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-v2fail-nudge-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = NUDGE_SID
    // Matches the working e2e-blocks-nudges harness: the transform pipeline
    // resolves limits against a known model window.
    state.modelContextLimit = 200000
    Object.assign(state, stateOverrides)

    const config = buildNudgeConfig()
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({ data: { parentID: null } }) } },
        createTestRegistry(state),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {
                    system: "ACP system",
                    compressRange: "compress range",
                    compressMessage: "compress message",
                    contextLimitNudge: "nudge",
                    turnNudge: "turn nudge",
                    iterationNudge: "iteration nudge",
                    manualExtension: "",
                    subagentExtension: "",
                }
            },
        },
        { global: undefined, agents: {} },
    )
    return { state, handler, tempDir }
}

async function runTurn(
    handler: ReturnType<typeof setupNudgePipeline>["handler"],
    messages: WithParts[],
) {
    const output = { messages }
    await handler({}, output)
    return output.messages
}

describe("warm nudge baseline behavior around compress attempts", () => {
    it("failed compress resets pending-nudge state but never advances the success baseline", async () => {
        const { state, handler } = setupNudgePipeline()
        // An established baseline is required for the nudge path to fire
        // (matches the e2e-blocks-nudges harness); mid-session it is always set.
        state.nudges.lastPerMessageNudgeTokens = 0
        const history = buildHistory(26, 12000)
        const u1 = nudgeUserMessage("u-turn1", "keep going")
        const a1 = nudgeAssistantMessage("a-turn1", "working")
        const u2 = nudgeUserMessage("u-turn2", "context is huge, please compress")
        // Post-projection internal shape of a failed V2 compress: status
        // "error", no output.
        const a2 = nudgeAssistantMessage("a-turn2", "attempting compression", [
            failedCompressPart("c-fail-warm", NUDGE_SID, "a-turn2"),
        ])

        // LLM call 1: context has grown past the min limit → nudge fires.
        await runTurn(handler, [...history, u1])
        assert.notEqual(
            state.nudges.lastNudgeShownTokens,
            undefined,
            "precondition: nudge must fire before the attempt for the scenario to be meaningful",
        )
        const baselineAfterNudge = state.nudges.lastPerMessageNudgeTokens
        assert.equal(state.nudges.compressBaselineSet, false)

        // LLM call 2: the plain response lands, no compress yet.
        await runTurn(handler, [...history, u1, a1])
        assert.equal(state.nudges.compressBaselineSet, false)

        // LLM call 3: the failed compress attempt is in the current turn.
        await runTurn(handler, [...history, u1, a1, u2, a2])

        // Failed-attempt handling preserved: pending-nudge state cleared so a
        // later turn can nudge again.
        assert.equal(state.nudges.turnNudgeAnchors.size, 0)
        assert.equal(state.nudges.iterationNudgeAnchors.size, 0)
        assert.equal(state.nudges.lastNudgeShownTokens, undefined)
        assert.equal(state.nudges.shouldInjectThisTurn, false)
        // Success baseline NOT advanced by the failure.
        assert.equal(state.nudges.lastPerMessageNudgeTokens, baselineAfterNudge)
        assert.equal(state.nudges.compressBaselineSet, false)
    })

    it("successful compress advances the success baseline (control)", async () => {
        const { state, handler } = setupNudgePipeline()
        // Same established-baseline precondition as the failure scenario above.
        state.nudges.lastPerMessageNudgeTokens = 0
        const history = buildHistory(26, 12000)
        const u1 = nudgeUserMessage("u-turn1", "keep going")
        const a1 = nudgeAssistantMessage("a-turn1", "working")
        const u2 = nudgeUserMessage("u-turn2", "context is huge, please compress")
        const a2 = nudgeAssistantMessage("a-turn2", "compressing now", [
            successfulCompressPart("c-ok-warm", NUDGE_SID, "a-turn2"),
        ])

        await runTurn(handler, [...history, u1])
        assert.notEqual(
            state.nudges.lastNudgeShownTokens,
            undefined,
            "precondition: nudge fires before the attempt",
        )

        await runTurn(handler, [...history, u1, a1])

        await runTurn(handler, [...history, u1, a1, u2, a2])

        assert.equal(state.nudges.shouldInjectThisTurn, false)
        assert.equal(state.nudges.compressBaselineSet, true)
        assert.notEqual(state.nudges.lastPerMessageNudgeTokens, undefined)
    })
})
