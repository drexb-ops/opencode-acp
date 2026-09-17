import "./test-env"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Message, SystemPart } from "@opencode/ai"

import { getConfig } from "../lib/config"
import {
    enforceContextBudget,
    resolveCompletionReserveTokens,
} from "../lib/messages/enforce-budget"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { truncateLargeToolOutputs } from "../lib/messages/truncate-tools"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"
import { cacheSystemPromptTokens } from "../lib/ui/utils"
import {
    createV2TokenBudget,
    estimateV2ProjectedMessageTokens,
    estimateV2WireTokens,
    type V2WireTokenInput,
} from "../lib/v2/token-budget"
import { normalizeV2ProjectedHistory } from "../lib/v2/projection"

function projectedMessage(id: string, parts: unknown[], tokens?: number): WithParts {
    return {
        info: {
            id,
            role: tokens === undefined ? "user" : "assistant",
            time: { created: 1 },
            ...(tokens === undefined
                ? {}
                : {
                      summary: true,
                      tokens: {
                          input: tokens,
                          output: 1,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }),
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function isolatedDefaultConfig() {
    const directory = mkdtempSync(join(tmpdir(), "acp-v2-budget-config-"))
    const config = getConfig({
        directory,
        notifications: { notify: () => {} },
    })
    return { directory, config }
}

function textMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
    tokens?: number,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "v2-budget",
            agent: "code",
            time: { created: 1 },
            ...(tokens === undefined
                ? {}
                : {
                      summary: true,
                      tokens: {
                          input: tokens,
                          output: 1,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }),
        } as WithParts["info"],
        parts: [
            { id: `${id}-text`, messageID: id, sessionID: "v2-budget", type: "text", text },
        ] as WithParts["parts"],
    }
}

function completedToolMessage(id: string, output: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "v2-budget",
            agent: "code",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-tool`,
                messageID: id,
                sessionID: "v2-budget",
                type: "tool",
                tool: "shell",
                callID: `${id}-call`,
                state: { status: "completed", input: { command: "build" }, output },
            },
        ] as WithParts["parts"],
    }
}

test("V2 budget ignores historical compaction usage and retains current system/tool overhead", () => {
    const { directory, config } = isolatedDefaultConfig()
    try {
        const checkpoint = "<conversation-checkpoint>short checkpoint</conversation-checkpoint>"
        const normalized = [
            projectedMessage("checkpoint", [{ type: "text", text: checkpoint }], 653_137),
            projectedMessage("continue", [{ type: "text", text: "continue" }]),
        ]
        const input: V2WireTokenInput = {
            system: [SystemPart.make("Current system instruction.")],
            messages: [
                Message.make({ id: "checkpoint", role: "user", content: checkpoint }),
                Message.make({ id: "continue", role: "user", content: "continue" }),
            ],
            tools: {
                read: {
                    description: "Read one file.",
                    input: { type: "object", properties: { path: { type: "string" } } },
                },
            },
        }

        const budget = createV2TokenBudget({ ...input, normalizedMessages: normalized })
        const state = createSessionState()
        cacheSystemPromptTokens(state, normalized, {
            authoritativeOverheadTokens: budget.overheadTokens,
        })

        assert.ok(
            budget.totalTokens < 10_000,
            `unexpected V2 request estimate ${budget.totalTokens}`,
        )
        assert.ok(
            budget.totalTokens < 400_000 - resolveCompletionReserveTokens(config),
            "a short current checkpoint must fit the 400k input budget",
        )
        assert.equal(state.systemPromptTokens, budget.overheadTokens)
        assert.notEqual(state.systemPromptTokens, 653_136)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("V2 wire estimate counts current system, messages, and tool schemas exactly once", () => {
    const input: V2WireTokenInput = {
        system: [SystemPart.make("System rules ".repeat(600))],
        messages: [Message.make({ id: "u1", role: "user", content: "current request" })],
        tools: {
            shell: {
                description: "Execute a command with a fully described input schema.",
                input: {
                    type: "object",
                    properties: { command: { type: "string", description: "Command to execute" } },
                },
            },
        },
    }

    const estimate = estimateV2WireTokens(input)
    const withoutTools = estimateV2WireTokens({ ...input, tools: undefined })

    assert.ok(estimate.systemTokens > 1_000, "large current system text must remain accounted")
    assert.ok(estimate.toolTokens > 0, "current tool schemas must remain accounted")
    assert.equal(
        estimate.totalTokens,
        estimate.systemTokens + estimate.messageTokens + estimate.toolTokens,
    )
    assert.equal(
        estimate.totalTokens - withoutTools.totalTokens,
        estimate.toolTokens,
        "tool definitions contribute once, not as historical message usage",
    )
})

test("V2 projected budget falls after pruning an old tool result", () => {
    const oldOutput = "Build output line with useful diagnostics. ".repeat(1_500)
    const rawToolResult = {
        type: "tool-result",
        id: "call-1",
        result: { type: "text", value: oldOutput },
    }
    const before = [
        projectedMessage("old-tool", [
            {
                type: "tool",
                tool: "shell",
                state: { status: "completed", input: { command: "build" }, output: oldOutput },
            },
        ]),
        projectedMessage("recent", [{ type: "text", text: "continue" }]),
    ]
    const after = [
        projectedMessage("old-tool", [
            {
                type: "tool",
                tool: "shell",
                state: {
                    status: "completed",
                    input: { command: "build" },
                    output: "[Old tool result content cleared]",
                },
            },
        ]),
        projectedMessage("recent", [{ type: "text", text: "continue" }]),
    ]
    const budget = createV2TokenBudget({
        system: [SystemPart.make("current rules")],
        messages: [
            { id: "old-tool", role: "user", content: [rawToolResult] },
            Message.make({ id: "recent", role: "user", content: "continue" }),
        ],
        tools: {},
        normalizedMessages: before,
    })

    assert.ok(
        budget.estimateMessages(after) < budget.estimateMessages(before),
        "post-prune V2 estimation must reflect the removed tool content",
    )
})

test("V2 semantic estimates ignore source and ACP part identities", () => {
    const makeInput = (sourceID: string, callID: string, sessionID: string): V2WireTokenInput => ({
        system: [SystemPart.make("current rules")],
        messages: [
            {
                id: sourceID,
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: callID,
                        name: "shell",
                        input: { command: "git status" },
                        providerExecuted: false,
                    },
                ],
            },
            {
                id: `${sourceID}-result`,
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: callID,
                        name: "shell",
                        providerExecuted: false,
                        result: { type: "text", value: "clean working tree" },
                    },
                ],
            },
        ],
        tools: {},
    })
    const makeProjection = (
        sourceID: string,
        partID: string,
        sessionID: string,
        callID: string,
    ): WithParts[] => [
        {
            info: {
                id: sourceID,
                role: "assistant",
                sessionID,
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: partID,
                    messageID: sourceID,
                    sessionID,
                    callID,
                    type: "tool",
                    tool: "shell",
                    state: {
                        status: "completed",
                        input: { command: "git status" },
                        output: "clean working tree",
                    },
                    __acpOrigin: `${sourceID}:${partID}`,
                },
            ] as WithParts["parts"],
        },
    ]

    const leftInput = makeInput("source-a", "call-a", "session-a")
    const rightInput = makeInput("source-b", "call-b", "session-b")
    const left = createV2TokenBudget({
        ...leftInput,
        normalizedMessages: makeProjection("source-a", "part-a", "session-a", "call-a"),
    })
    const right = createV2TokenBudget({
        ...rightInput,
        normalizedMessages: makeProjection("source-b", "part-b", "session-b", "call-b"),
    })

    assert.deepEqual(estimateV2WireTokens(leftInput), estimateV2WireTokens(rightInput))
    assert.equal(left.totalTokens, right.totalTokens)
    assert.equal(
        left.estimateMessages(makeProjection("source-a", "part-a", "session-a", "call-a")),
        right.estimateMessages(makeProjection("source-b", "part-b", "session-b", "call-b")),
    )
})

test("V2 semantic estimates change for real text, tool output, multipart, and native payloads", () => {
    const textOnly = estimateV2WireTokens({
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "short" }] }],
    })
    const longerText = estimateV2WireTokens({
        system: [],
        messages: [
            { role: "user", content: [{ type: "text", text: "long actual text ".repeat(500) }] },
        ],
    })
    const oneResultPart = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "call-1",
                        name: "shell",
                        result: { type: "content", value: [{ type: "text", text: "stdout" }] },
                    },
                ],
            },
        ],
    })
    const multipartResult = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "different-call-id",
                        name: "shell",
                        result: {
                            type: "content",
                            value: [
                                { type: "text", text: "stdout" },
                                { type: "text", text: "second result payload ".repeat(500) },
                            ],
                        },
                    },
                ],
            },
        ],
    })
    const nativeSmall = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "user",
                content: [{ type: "provider-native", id: "native-a", native: { data: "small" } }],
            },
        ],
    })
    const nativeLarge = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "provider-native",
                        id: "native-b",
                        native: { data: "provider payload ".repeat(500) },
                    },
                ],
            },
        ],
    })
    const nativeCheckpoint = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "short checkpoint" }],
                native: { provider: { checkpoint: "provider state ".repeat(500) } },
            },
        ],
    })

    assert.ok(longerText.totalTokens > textOnly.totalTokens)
    assert.ok(multipartResult.totalTokens > oneResultPart.totalTokens)
    assert.ok(nativeSmall.totalTokens > 0)
    assert.ok(nativeLarge.totalTokens > nativeSmall.totalTokens)
    assert.ok(nativeCheckpoint.totalTokens > textOnly.totalTokens)
})

test("V2 immutable opaque prefix remains after mutable suffix compression", () => {
    const opaquePayload = "native opaque payload ".repeat(1_000)
    const rawOpaque = {
        id: "opaque-source",
        role: "user",
        content: [
            { type: "media", id: "media-random", mediaType: "image/png", data: opaquePayload },
        ],
    }
    const rawSuffix = {
        id: "mutable-source",
        role: "assistant",
        content: [{ type: "text", text: "mutable suffix ".repeat(500) }],
    }
    const opaqueProjection = projectedMessage("opaque-source", [
        {
            type: "text",
            text: "[opaque media attachment]",
            id: "opaque-part-random",
            messageID: "opaque-source",
            sessionID: "random-session",
            __acpOpaque: true,
            __acpOrigin: "opaque-origin",
        },
    ])
    const mutableProjection = projectedMessage("mutable-source", [
        {
            type: "text",
            text: "mutable suffix ".repeat(500),
            // The old full-part estimate made this bookkeeping dominate the
            // aggregate delta and accidentally erase the immutable prefix.
            id: "random-id-".repeat(5_000),
            messageID: "mutable-source",
            sessionID: "random-session",
            __acpOrigin: "mutable-origin",
        },
    ])
    const budget = createV2TokenBudget({
        system: [],
        messages: [rawOpaque, rawSuffix],
        tools: {},
        normalizedMessages: [opaqueProjection, mutableProjection],
    })
    const opaqueWire = estimateV2WireTokens({ system: [], messages: [rawOpaque], tools: {} })

    assert.ok(
        budget.estimateMessages([opaqueProjection]) >= opaqueWire.messageTokens,
        "removing a mutable suffix must not subtract opaque prefix accounting",
    )
    assert.ok(
        budget.estimateMessages([opaqueProjection]) <
            budget.estimateMessages([opaqueProjection, mutableProjection]),
        "post-compression estimate must fall when visible mutable content is removed",
    )
})

test("V2 accounting recalibrates after compaction/reload and model changes", () => {
    const state = createSessionState()
    const history = [
        projectedMessage("summary", [{ type: "text", text: "short summary" }], 900_000),
    ]
    const before = createV2TokenBudget({
        system: [SystemPart.make("old model instructions")],
        messages: [Message.make({ id: "summary", role: "user", content: "short summary" })],
        tools: { read: { description: "read", input: {} } },
        normalizedMessages: history,
    })
    cacheSystemPromptTokens(state, history, {
        authoritativeOverheadTokens: before.overheadTokens,
    })

    const after = createV2TokenBudget({
        system: [SystemPart.make("new model instructions ".repeat(300))],
        messages: [Message.make({ id: "summary", role: "user", content: "short summary" })],
        tools: { search: { description: "search", input: { type: "object", properties: {} } } },
        normalizedMessages: history,
    })
    cacheSystemPromptTokens(state, history, {
        authoritativeOverheadTokens: after.overheadTokens,
    })

    assert.notEqual(after.overheadTokens, before.overheadTokens)
    assert.equal(state.systemPromptTokens, after.overheadTokens)
    assert.ok(
        after.totalTokens < 10_000,
        "historical assistant usage must not survive recalibration",
    )
})

test("V2 opaque media has a non-zero conservative token estimate", () => {
    const estimate = estimateV2WireTokens({
        system: [],
        messages: [
            {
                id: "image",
                role: "user",
                content: [
                    {
                        type: "media",
                        mediaType: "image/png",
                        data: new Uint8Array(4_096),
                    },
                ],
            },
        ],
    })

    assert.ok(estimate.messageTokens > 0)
})

test("V2 large opaque payload accounting is bounded without binary conversion or deep traversal", () => {
    const bytes = new Uint8Array(16 * 1024 * 1024)
    const entries = new Array(1_000).fill("provider payload entry")
    let highestReadIndex = -1
    const guardedEntries = new Proxy(entries, {
        get(target, property, receiver) {
            const index = typeof property === "string" ? Number(property) : Number.NaN
            if (Number.isInteger(index) && index >= 0)
                highestReadIndex = Math.max(highestReadIndex, index)
            return Reflect.get(target, property, receiver)
        },
    })
    const mutableBuffer = Buffer as unknown as {
        from: (...args: unknown[]) => Buffer
    }
    const originalFrom = mutableBuffer.from
    let attemptedBinaryConversion = false
    mutableBuffer.from = (...args: unknown[]) => {
        if (args[0] === bytes) attemptedBinaryConversion = true
        return Reflect.apply(originalFrom, Buffer, args) as Buffer
    }

    try {
        const estimate = estimateV2WireTokens({
            system: [],
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "media", mediaType: "image/png", data: bytes },
                        { type: "provider-native", payload: guardedEntries },
                    ],
                },
            ],
        })

        assert.equal(
            attemptedBinaryConversion,
            false,
            "binary media must not be base64 materialized",
        )
        assert.ok(highestReadIndex < 64, `bounded traversal read entry ${highestReadIndex}`)
        assert.ok(
            estimate.messageTokens > bytes.byteLength / 4,
            "binary size must retain a non-zero residual",
        )
    } finally {
        mutableBuffer.from = originalFrom
    }
})

test("V2 opaque branching traversal has one global node budget", () => {
    let nested: unknown = "leaf payload"
    let indexedReads = 0
    for (let depth = 0; depth < 8; depth++) {
        const entries = new Array(64).fill(nested)
        nested = new Proxy(entries, {
            get(target, property, receiver) {
                const index = typeof property === "string" ? Number(property) : Number.NaN
                if (Number.isInteger(index) && index >= 0) indexedReads++
                return Reflect.get(target, property, receiver)
            },
        })
    }

    const estimate = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "user",
                content: [{ type: "provider-native", payload: nested }],
            },
        ],
    })

    assert.ok(estimate.messageTokens > 0)
    assert.ok(indexedReads <= 1_024, `expected global traversal cap, read ${indexedReads} entries`)
})

test("V2 source residual releases an atomically removed multipart source but keeps uncorrelated native cost", () => {
    const nativePayload = "independent native prefix ".repeat(1_000)
    const multipartPayload = "multipart tool result ".repeat(1_500)
    const nativePrefix = {
        role: "user",
        content: [{ type: "media", mediaType: "image/png", data: nativePayload }],
        native: { checkpoint: { opaque: nativePayload } },
    }
    const toolCall = {
        id: "removable-source",
        role: "assistant",
        content: [
            {
                type: "tool-call",
                id: "multipart-call",
                name: "shell",
                input: { command: "build" },
            },
        ],
    }
    const toolResult = {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: "multipart-call",
                name: "shell",
                result: {
                    type: "content",
                    value: [
                        { type: "text", text: multipartPayload },
                        { type: "text", text: multipartPayload },
                    ],
                },
            },
        ],
    }
    const prefixProjection = projectedMessage("prefix-placeholder", [
        { type: "text", text: "[native provider checkpoint]", __acpOpaque: true },
    ])
    const removableProjection = projectedMessage("removable-source", [
        {
            type: "tool",
            tool: "shell",
            callID: "multipart-call",
            state: {
                status: "completed",
                input: { command: "build" },
                output: "[multipart result represented here]",
            },
        },
    ])
    const budget = createV2TokenBudget({
        system: [],
        messages: [nativePrefix, toolCall, toolResult],
        tools: {},
        normalizedMessages: [prefixProjection, removableProjection],
    })
    const prefixOnly = estimateV2WireTokens({ system: [], messages: [nativePrefix], tools: {} })
    const before = budget.estimateMessages([prefixProjection, removableProjection])
    const after = budget.estimateMessages([prefixProjection])

    assert.ok(after < before, "removing the known multipart source must release its raw residual")
    assert.ok(
        after >= prefixOnly.messageTokens,
        "uncorrelated native request content must remain after source removal",
    )
})

test("V2 provenance sidecar owns repeated ID-less systems exactly once", () => {
    const model = { providerID: "provider", id: "model" }
    const prefix = Message.make({
        id: "unowned-prefix",
        role: "user",
        content: "provider-native prefix that has no public source owner",
        native: { provider: { checkpoint: "opaque prefix" } },
    })
    const firstSystem = Message.system("Repeated host instruction")
    const secondSystem = Message.system("Repeated host instruction")
    const suffix = Message.make({ id: "suffix", role: "user", content: "compressible suffix" })
    const outgoing = [prefix, firstSystem, secondSystem, suffix]
    const projection = normalizeV2ProjectedHistory(
        [
            {
                type: "system",
                id: "sys-1",
                time: { created: 1 },
                text: "Repeated host instruction",
            },
            {
                type: "system",
                id: "sys-2",
                time: { created: 2 },
                text: "Repeated host instruction",
            },
            { type: "user", id: "suffix", time: { created: 3 }, text: "compressible suffix" },
        ],
        outgoing,
        { sessionID: "token-budget", currentModel: model },
    )
    assert.equal(projection.valid, true)
    const owners = projection.outgoing.map((entry) => entry.normalizedMessageId)
    const input = {
        system: [],
        messages: outgoing,
        tools: {},
        normalizedMessages: projection.messages,
    }
    const sidecarBudget = createV2TokenBudget({
        ...input,
        outgoingNormalizedMessageIds: owners,
    })
    const fallbackBudget = createV2TokenBudget(input)
    const sidecarInitial = sidecarBudget.estimateMessages(projection.messages)
    const fallbackInitial = fallbackBudget.estimateMessages(projection.messages)
    const systemRaw = estimateV2WireTokens({
        system: [],
        messages: [firstSystem, secondSystem],
        tools: {},
    }).messageTokens
    const projectedSystems = estimateV2ProjectedMessageTokens(
        projection.messages.filter(
            (message) => message.info.id === "sys-1" || message.info.id === "sys-2",
        ),
    )
    const withoutSuffix = projection.messages.filter((message) => message.info.id !== "suffix")
    const prefixRaw = estimateV2WireTokens({ system: [], messages: [prefix], tools: {} })

    assert.equal(fallbackInitial - sidecarInitial, Math.min(systemRaw, projectedSystems))
    assert.ok(
        sidecarBudget.estimateMessages(withoutSuffix) < sidecarInitial,
        "known suffix removal must lower the estimate",
    )
    assert.ok(
        sidecarBudget.estimateMessages(withoutSuffix) >= prefixRaw.messageTokens,
        "the explicitly unowned prefix remains conservative",
    )
})

test("V2 oversized common-prefix property keys use bounded descriptors and raw lookup", () => {
    const prefix = "very-long-common-provider-key-".repeat(2_000)
    const makePayload = (suffixes: readonly string[]) => {
        const payload: Record<string, unknown> = {}
        const accessed = new Set<string>()
        suffixes.forEach((suffix) => {
            const key = `${prefix}${suffix}`
            Object.defineProperty(payload, key, {
                enumerable: true,
                get() {
                    accessed.add(key)
                    return "provider value"
                },
            })
        })
        return { payload, accessed }
    }
    const left = makePayload(["AAAA", "BBBB", "CCCC", "DDDD"])
    const right = makePayload(["1111", "2222", "3333", "4444"])
    const small = estimateV2WireTokens({
        system: [],
        messages: [
            {
                role: "user",
                content: [{ type: "provider-native", payload: { short: "provider value" } }],
            },
        ],
    })
    const leftEstimate = estimateV2WireTokens({
        system: [],
        messages: [{ role: "user", content: [{ type: "provider-native", payload: left.payload }] }],
    })
    const rightEstimate = estimateV2WireTokens({
        system: [],
        messages: [
            { role: "user", content: [{ type: "provider-native", payload: right.payload }] },
        ],
    })

    assert.equal(left.accessed.size, 4, "bounded descriptors retain raw keys for value lookup")
    assert.equal(right.accessed.size, 4)
    assert.equal(leftEstimate.totalTokens, rightEstimate.totalTokens)
    assert.ok(
        leftEstimate.totalTokens > small.totalTokens,
        "omitted key length contributes residual",
    )
})

test("V2 keeps encrypted per-part provider payloads without counting transport identities", () => {
    const encryptedReasoning = (sourceID: string, partID: string) => ({
        id: sourceID,
        role: "assistant",
        content: [
            {
                type: "reasoning",
                id: partID,
                text: "short reasoning",
                providerMetadata: {
                    encrypted: { ciphertext: "encrypted reasoning payload ".repeat(500) },
                },
            },
        ],
    })
    const plain = estimateV2WireTokens({
        system: [],
        messages: [
            {
                id: "plain-source",
                role: "assistant",
                content: [{ type: "reasoning", id: "plain-part", text: "short reasoning" }],
            },
        ],
    })
    const left = estimateV2WireTokens({
        system: [],
        messages: [encryptedReasoning("source-a", "part-a")],
    })
    const right = estimateV2WireTokens({
        system: [],
        messages: [encryptedReasoning("source-b", "part-b")],
    })

    assert.ok(left.totalTokens > plain.totalTokens)
    assert.deepEqual(left, right)
})

test("V2 zero overhead remains authoritative instead of falling back to historical usage", () => {
    const state = createSessionState()
    const compaction = [
        projectedMessage("checkpoint", [{ type: "text", text: "short checkpoint" }], 653_137),
    ]

    cacheSystemPromptTokens(state, compaction, { authoritativeOverheadTokens: 0 })
    cacheSystemPromptTokens(state, compaction)

    assert.equal(state.systemPromptTokens, 0)
})

test("V2 nudge accounting survives compaction and completes a production-recent growth cycle", () => {
    const { directory, config } = isolatedDefaultConfig()
    try {
        const logger = new Logger(false, "silent")
        const state = createSessionState()
        state.sessionId = "v2-budget"
        state.modelContextLimit = 10_000
        config.compress.maxContextLimit = 5_000
        config.compress.minContextLimit = 4_000
        config.compress.nudgeGrowthTokens = 1_000
        config.compress.minNudgeGrowthFloor = 1_000
        config.compress.minNudgeGrowthRatio = 0
        config.compress.minCompressRange = 1
        config.compress.preserveRecentMessages = 1
        config.compress.preserveRecentTokens = 0
        config.compress.preserveLastUserMessage = true

        const historicalSummary = textMessage(
            "checkpoint",
            "assistant",
            "short checkpoint",
            653_137,
        )
        const firstTurn = [historicalSummary, textMessage("u1", "user", "continue")]
        assignMessageRefs(state, firstTurn)
        const stale = isContextOverLimits(config, state, "provider", "model", firstTurn)
        const current = isContextOverLimits(config, state, "provider", "model", firstTurn, 1_000)
        assert.equal(
            stale.overMaxLimit,
            true,
            "negative proof: historical usage would trigger a phantom nudge",
        )
        assert.equal(current.overMaxLimit, false)

        injectCompressNudges(
            state,
            config,
            logger,
            firstTurn,
            {} as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            1_000,
        )
        assert.equal(state.nudges.shouldInjectThisTurn, false)
        assert.equal(state.nudges.lastPerMessageNudgeTokens, 1_000)

        const growingTurn = [
            textMessage("old", "assistant", "completed work ".repeat(1_000)),
            textMessage("u2", "user", "continue"),
        ]
        assignMessageRefs(state, growingTurn)
        injectCompressNudges(
            state,
            config,
            logger,
            growingTurn,
            {} as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            2_500,
        )
        assert.equal(
            state.nudges.shouldInjectThisTurn,
            true,
            "growth should nudge with recent protection enabled",
        )
        assert.equal(state.nudges.lastPerMessageNudgeTokens, 1_000)
        assert.equal(state.nudges.lastNudgeShownTokens, 2_500)

        const compressionTurn = [
            textMessage("u3", "user", "compress now"),
            {
                ...completedToolMessage("compress", "summary"),
                parts: [
                    {
                        id: "compress-tool",
                        messageID: "compress",
                        sessionID: "v2-budget",
                        type: "tool",
                        tool: "compress",
                        callID: "compress-call",
                        state: { status: "completed", input: {}, output: "summary" },
                    },
                ] as WithParts["parts"],
            },
        ]
        assignMessageRefs(state, compressionTurn)
        injectCompressNudges(
            state,
            config,
            logger,
            compressionTurn,
            {} as never,
            undefined,
            undefined,
            2_500,
            undefined,
            undefined,
            1_200,
        )
        assert.equal(state.nudges.shouldInjectThisTurn, false)
        assert.equal(state.nudges.lastPerMessageNudgeTokens, 1_200)
        assert.equal(state.nudges.lastNudgeShownTokens, undefined)

        const regrowingTurn = [
            textMessage("old-2", "assistant", "new completed work ".repeat(1_000)),
            textMessage("u4", "user", "continue"),
        ]
        assignMessageRefs(state, regrowingTurn)
        injectCompressNudges(
            state,
            config,
            logger,
            regrowingTurn,
            {} as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            2_400,
        )
        assert.equal(
            state.nudges.shouldInjectThisTurn,
            true,
            "new growth after compression should nudge again",
        )
        assert.equal(state.nudges.lastPerMessageNudgeTokens, 1_200)
        assert.equal(state.nudges.lastNudgeShownTokens, 2_400)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("V2 current accounting prevents phantom emergency tool truncation", () => {
    const { directory, config } = isolatedDefaultConfig()
    try {
        const logger = new Logger(false, "silent")
        const state = createSessionState()
        state.sessionId = "v2-truncate"
        state.modelContextLimit = 100_000
        const output = "Build output line with details. ".repeat(2_000)
        const summary = textMessage("checkpoint", "assistant", "short checkpoint", 653_137)
        const tool = completedToolMessage("old-tool", output)
        const messages = [summary, tool, textMessage("u", "user", "continue")]

        truncateLargeToolOutputs(state, config, logger, messages, { currentTokens: 1_000 })

        assert.equal((tool.parts[0] as { state: { output: string } }).state.output, output)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test("V2 budget guard reconciles current estimates without one full scan per candidate", () => {
    const { directory, config } = isolatedDefaultConfig()
    try {
        const logger = new Logger(false, "silent")
        const state = createSessionState()
        state.modelContextLimit = 20_000
        config.compress.completionReserveTokens = 1_000
        const output = "Build output line with details. ".repeat(1_000)
        const tools = Array.from({ length: 12 }, (_, index) =>
            completedToolMessage(`tool-${index}`, output),
        )
        const messages = [
            textMessage("first", "user", "request"),
            ...tools,
            textMessage("recent-1", "assistant", "recent"),
            textMessage("recent-2", "user", "continue"),
            textMessage("recent-3", "assistant", "working"),
        ]
        let calls = 0
        const estimate = (current: WithParts[]) => {
            calls++
            return current.reduce(
                (total, message) =>
                    total +
                    message.parts.reduce(
                        (messageTotal, part) =>
                            messageTotal +
                            (part.type === "tool"
                                ? String(
                                      (part as { state?: { output?: unknown } }).state?.output ??
                                          "",
                                  ).length / 4
                                : ((part as { text?: string }).text?.length ?? 0)),
                        0,
                    ),
                0,
            )
        }

        const result = enforceContextBudget(state, config, logger, messages, estimate)

        assert.ok(result?.applied)
        assert.ok(result.finalEstimate <= result.budget)
        assert.ok(calls <= 3, `expected bounded full estimates, received ${calls}`)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
