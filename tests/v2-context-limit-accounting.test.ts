import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message, SystemPart } from "@opencode/ai"
import { getConfig } from "../lib/config"
import { providerReportedWireUsage } from "../lib/messages/enforce-budget"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { assignMessageRefs } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"
import {
    createV2RequestTokenAccounting,
    createV2TokenBudget,
    estimateV2WireTokens,
} from "../lib/v2/token-budget"
import { Logger } from "../lib/logger"

const model = { providerID: "openai", modelID: "gpt-test" }

function textMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
    created: number,
    tokens?: { input: number; output: number },
    summary = false,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "v2-accounting",
            time: { created },
            agent: "build",
            providerID: model.providerID,
            modelID: model.modelID,
            ...(tokens
                ? {
                      tokens: {
                          ...tokens,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }
                : {}),
            ...(summary ? { summary: true } : {}),
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-text`,
                type: "text",
                messageID: id,
                sessionID: "v2-accounting",
                text,
            },
        ] as WithParts["parts"],
    }
}

function criticalTextAt(tokens: number): string {
    const config = getConfig({
        directory: "/tmp/acp-v2-accounting",
        notifications: { notify() {} },
    })
    config.autoUpdate = false
    config.compress.maxContextLimit = "75%"
    config.compress.minContextLimit = "60%"
    config.compress.emergencyThresholdPercent = "85%"
    config.compress.candidates = true
    config.compress.preserveRecentMessages = 10
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = true
    const state = createSessionState()
    state.sessionId = "v2-accounting"
    state.modelContextLimit = 400_000
    state.nudges.lastPerMessageNudgeTokens = tokens
    const messages = [textMessage("recent", "user", "active user intent", 20)]
    assignMessageRefs(state, messages)
    injectCompressNudges(
        state,
        config,
        new Logger(false, "silent"),
        messages,
        {} as never,
        undefined,
        undefined,
        undefined,
        messages.slice(),
        undefined,
        tokens,
    )
    return messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
}

test("historical compaction usage cannot calibrate a short current V2 request", () => {
    const state = createSessionState()
    state.lastCompaction = 10
    const messages = [
        textMessage(
            "checkpoint",
            "assistant",
            "short checkpoint",
            10,
            { input: 653_137, output: 955 },
            true,
        ),
        textMessage("continue", "user", "continue", 11),
    ]
    assert.equal(providerReportedWireUsage(state, messages, model), undefined)
    const budget = createV2TokenBudget({
        system: [SystemPart.make("current system")],
        messages: [Message.make({ id: "continue", role: "user", content: "continue" })],
        normalizedMessages: messages,
        outgoingNormalizedMessageIds: ["continue"],
    })
    const accounting = createV2RequestTokenAccounting(budget, messages, undefined)
    assert.equal(accounting.source, "semantic-estimate")
    assert.ok(accounting.estimateMessages(messages) < 10_000)
    assert.ok(accounting.overheadTokens < 10_000)
})

test("provider calibration corrects semantic variance and still falls after compression", () => {
    const old = textMessage("old", "assistant", "completed old context ".repeat(5_000), 2)
    const recent = textMessage("recent", "user", "continue", 3)
    const baseline = [old, recent]
    const budget = createV2TokenBudget({
        system: [SystemPart.make("system")],
        messages: [
            Message.make({
                id: "old",
                role: "assistant",
                content: "completed old context ".repeat(5_000),
            }),
            Message.make({ id: "recent", role: "user", content: "continue" }),
        ],
        normalizedMessages: baseline,
        outgoingNormalizedMessageIds: ["old", "recent"],
    })
    const providerTokens = 10_000
    const accounting = createV2RequestTokenAccounting(budget, baseline, providerTokens)
    assert.equal(accounting.source, "provider-calibrated")
    assert.ok(
        accounting.safetyEstimate(baseline) > providerTokens,
        "the conservative semantic estimate must remain distinct from provider usage",
    )
    assert.equal(accounting.nudgeEstimate(baseline), providerTokens)
    assert.equal(accounting.estimateMessages(baseline), providerTokens)
    assert.ok(accounting.nudgeEstimate([recent]) < providerTokens)
    assert.ok(accounting.safetyEstimate([recent]) < accounting.safetyEstimate(baseline))
})

test("V2 tool accounting excludes runtime executors and internal options", () => {
    const providerShape = {
        shell: {
            description: "Execute a command",
            input: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
            },
        },
    }
    const runtimeShape = {
        shell: {
            ...providerShape.shell,
            execute: () => "runtime-only",
            options: { internal: "x".repeat(200_000), codemode: false },
            id: "runtime-tool-id",
        },
    }
    const request = {
        system: [SystemPart.make("system")],
        messages: [Message.make({ id: "u", role: "user", content: "request" })],
    }
    assert.equal(
        estimateV2WireTokens({ ...request, tools: runtimeShape }).toolTokens,
        estimateV2WireTokens({ ...request, tools: providerShape }).toolTokens,
    )
})

test("provider-calibrated nudge avoids turning a conservative 90 percent estimate into critical text", () => {
    const old = textMessage("old", "assistant", "completed old context ".repeat(120_000), 2)
    const recent = textMessage("recent", "user", "continue", 3)
    const baseline = [old, recent]
    const budget = createV2TokenBudget({
        system: [SystemPart.make("system")],
        messages: [
            Message.make({
                id: "old",
                role: "assistant",
                content: "completed old context ".repeat(120_000),
            }),
            Message.make({ id: "recent", role: "user", content: "continue" }),
        ],
        normalizedMessages: baseline,
        outgoingNormalizedMessageIds: ["old", "recent"],
    })
    const accounting = createV2RequestTokenAccounting(budget, baseline, 240_000)
    assert.ok(accounting.safetyEstimate(baseline) >= 360_000)
    assert.equal(accounting.nudgeEstimate(baseline), 240_000)
    assert.match(
        criticalTextAt(accounting.safetyEstimate(baseline)),
        /critically full/i,
        "negative proof: the conservative estimate alone would emit a false critical notice",
    )

    const config = getConfig({
        directory: "/tmp/acp-v2-accounting",
        notifications: { notify() {} },
    })
    config.autoUpdate = false
    config.compress.maxContextLimit = "75%"
    config.compress.minContextLimit = "60%"
    config.compress.emergencyThresholdPercent = "85%"
    config.compress.candidates = true
    config.compress.preserveRecentMessages = 10
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = true
    const state = createSessionState()
    state.sessionId = "v2-accounting"
    state.modelContextLimit = 400_000
    assignMessageRefs(state, baseline)

    injectCompressNudges(
        state,
        config,
        new Logger(false, "silent"),
        baseline,
        {} as never,
        undefined,
        undefined,
        accounting.growthEstimate(baseline),
        baseline.slice(),
        undefined,
        accounting.nudgeEstimate(baseline),
        accounting.growthEstimate(baseline),
    )

    const semanticBaseline = accounting.growthEstimate(baseline)
    const text = baseline
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, semanticBaseline)
    assert.doesNotMatch(text, /critically full/i)

    const next = [textMessage("next", "user", "next turn", 4)]
    assignMessageRefs(state, next)
    injectCompressNudges(
        state,
        config,
        new Logger(false, "silent"),
        next,
        {} as never,
        undefined,
        undefined,
        semanticBaseline + 1_000,
        next.slice(),
        undefined,
        241_000,
        semanticBaseline + 1_000,
    )
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        semanticBaseline,
        "provider calibration must not change the units of the persisted growth baseline",
    )
})

test("provider usage from another selected model is not a calibration point", () => {
    const state = createSessionState()
    const messages = [textMessage("a", "assistant", "answer", 2, { input: 200_000, output: 1_000 })]
    assert.equal(
        providerReportedWireUsage(state, messages, {
            providerID: "openai",
            modelID: "different-model",
        }),
        undefined,
    )
})

test("V2 provider calibration fails closed without exact source provenance", () => {
    const state = createSessionState()
    const messages = [textMessage("a", "assistant", "answer", 2, { input: 200_000, output: 1_000 })]
    const selectedModel = { providerID: "openai", modelID: "gpt-test" }

    assert.equal(
        providerReportedWireUsage(state, messages, selectedModel, {
            requireSourceProvenance: true,
        }),
        undefined,
    )

    Object.assign(messages[0]!.info, {
        __acpProviderUsageProvenance: {
            providerID: selectedModel.providerID,
            modelID: selectedModel.modelID,
            created: messages[0]!.info.time.created,
        },
    })
    assert.equal(
        providerReportedWireUsage(state, messages, selectedModel, {
            requireSourceProvenance: true,
        })?.tokens,
        201_000,
    )

    Object.assign(messages[0]!.info, {
        __acpProviderUsageProvenance: {
            providerID: selectedModel.providerID,
            modelID: "stale-model",
            created: messages[0]!.info.time.created,
        },
    })
    assert.equal(
        providerReportedWireUsage(state, messages, selectedModel, {
            requireSourceProvenance: true,
        }),
        undefined,
    )
})

test("critical no-target notice begins at configured 85 percent, not before", () => {
    assert.doesNotMatch(criticalTextAt(339_999), /critically full/i)
    assert.match(criticalTextAt(340_000), /critically full \(85% of limit\)/i)
})

test("configured 60/75/85 boundaries use the request-scoped nudge metric", () => {
    const config = getConfig({
        directory: "/tmp/acp-v2-accounting",
        notifications: { notify() {} },
    })
    config.autoUpdate = false
    config.compress.maxContextLimit = "75%"
    config.compress.minContextLimit = "60%"
    config.compress.emergencyThresholdPercent = "85%"
    const state = createSessionState()
    state.modelContextLimit = 400_000
    const messages = [textMessage("current", "user", "current", 20)]
    assignMessageRefs(state, messages)

    const at599 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        239_999,
    )
    const at60 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        240_000,
    )
    const at75 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        300_000,
    )
    const over75 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        300_001,
    )
    const at849 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        339_999,
    )
    const at85 = isContextOverLimits(
        config,
        state,
        model.providerID,
        model.modelID,
        messages,
        340_000,
    )

    assert.equal(at599.overMinLimit, false)
    assert.equal(at60.overMinLimit, true)
    assert.equal(at75.overMaxLimit, false)
    assert.equal(over75.overMaxLimit, true)
    assert.equal(at849.currentTokens, 339_999)
    assert.equal(at85.currentTokens, 340_000)
})

test("strong normal alert starts above max without using critical no-target wording", () => {
    const config = getConfig({
        directory: "/tmp/acp-v2-accounting",
        notifications: { notify() {} },
    })
    config.autoUpdate = false
    config.compress.maxContextLimit = "75%"
    config.compress.minContextLimit = "60%"
    config.compress.emergencyThresholdPercent = "85%"
    config.compress.candidates = true
    config.compress.minCompressRange = 1
    config.compress.nudgeGrowthTokens = 1
    config.compress.minNudgeGrowthFloor = 1
    config.compress.minNudgeGrowthRatio = 0
    config.compress.preserveRecentMessages = 1
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = true
    const state = createSessionState()
    state.sessionId = "v2-accounting"
    state.modelContextLimit = 400_000
    state.nudges.lastPerMessageNudgeTokens = 0
    const messages = [
        textMessage("first", "user", "original task", 1),
        textMessage("old", "assistant", "completed work ".repeat(500), 2),
        textMessage("recent", "user", "active user intent", 3),
    ]
    assignMessageRefs(state, messages)

    injectCompressNudges(
        state,
        config,
        new Logger(false, "silent"),
        messages,
        {} as never,
        undefined,
        undefined,
        300_001,
        messages.slice(),
        undefined,
        300_001,
    )

    const text = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.match(text, /⚠️ Context limit reached — compress now/)
    assert.doesNotMatch(text, /critically full/i)
})
