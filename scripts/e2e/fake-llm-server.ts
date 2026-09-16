#!/usr/bin/env bun
/**
 * Fake OpenAI-compatible LLM server for ACP E2E tests.
 *
 * Drives real `opencode run` sessions through a stub LLM that emits
 * scripted responses — either text or `compress` tool_use calls —
 * based on a JSON scenario file. This exercises the full ACP pipeline:
 * opencode → message transform hooks → compress tool → state persistence.
 *
 * Architecture:
 *   - Listens on PORT (default 8400), responds to any path ending in /v1/chat/completions
 *   - Reads scenario from SCENARIO env var (JSON file path)
 *   - Tracks turns by counting user messages in each request
 *   - At compress turns: parses <dcp-message-id> tags for mNNNNN refs,
 *     emits compress tool_use with startId/endId/summary from scenario
 *   - After tool result: emits text acknowledgment
 *   - SSE streaming (opencode defaults to stream=true)
 *
 * Usage:
 *   PORT=8400 SCENARIO=scenarios/01-basic-compress.json bun run fake-llm-server.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs"

declare const Bun: {
    serve(options: {
        port: number
        hostname: string
        fetch(request: Request): Response | Promise<Response>
    }): unknown
}

const PORT = parseInt(process.env.PORT ?? "8400", 10)
const HOST = process.env.HOST ?? "127.0.0.1"
const SCENARIO_PATH = process.env.SCENARIO
const TURN_COUNTER = process.env.TURN_COUNTER ?? "/tmp/acp-e2e-turn-counter"
const OBSERVATIONS_FILE = process.env.OBSERVATIONS ?? "/tmp/acp-e2e-observations.json"

if (!SCENARIO_PATH) {
    process.stderr.write("[fake-llm] FATAL: SCENARIO env var not set\n")
    process.exit(1)
}

interface ScenarioStep {
    respond: "text" | "compress" | "task" | "tool" | "nudge-compress" | "autonomous-nudge"
    text?: string
    summary?: string
    topic?: string
    acknowledgeRisk?: boolean
    auto?: boolean
    retryOnReject?: {
        summary: string
        topic?: string
        acknowledgeRisk?: boolean
    }
    /** For compress: "all" to compress everything, or explicit [startIdx, endIdx] of mNNNNN refs */
    range?: "all" | [number, number]
    /** For batch compress: multiple ranges */
    ranges?: Array<{ summary: string; topic?: string; range?: "all" | [number, number] }>
    /** For task: subagent spawn parameters */
    description?: string
    prompt?: string
    subagent_type?: string
    /** For task: turns the spawned subagent session will execute */
    subagent_turns?: ScenarioStep[]
    /** For tool: arbitrary tool_use call */
    tool?: string
    toolArgs?: Record<string, unknown>
    /** For nudge-compress: text to emit when no nudge detected (grows context) */
    growthText?: string
    /** Repeat growthText so installed scenarios can request a deterministic token-sized turn. */
    growthRepeat?: number
    /** For autonomous-nudge: stop after this many total compressions emitted (default: 2) */
    maxCompressCount?: number
    /** Prefer an advertised candidate category when responding to a nudge. */
    candidateKind?: "micro" | "episode"
}

interface ToolSequenceStep {
    /** Tool name to emit after the warm-up requests. */
    tool: string
    /** Fully formed arguments for tools whose arguments do not contain message refs. */
    args?: Record<string, unknown>
    /** Compression helpers for a dynamic `compress` call. */
    summary?: string
    topic?: string
    range?: "all" | [number, number]
    acknowledgeRisk?: boolean
}

interface Scenario {
    name: string
    description: string
    turns: ScenarioStep[]
    /** Optional installed-artifact flow. Existing turn scenarios remain unchanged. */
    toolSequence?: ToolSequenceStep[]
    /** Number of ACP-enabled model requests that should receive text first. */
    warmupTurns?: number
    warmupText?: string
}

const scenario: Scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"))

process.stderr.write(`[fake-llm] scenario: ${scenario.name} (${scenario.turns.length} turns)\n`)

export interface RequestObservation {
    /** 0-based scenario turn index */
    turn: number
    inputTokens: number
    messageCount: number
    /** Count of `compress` tool_use calls visible to the LLM in this request */
    compressCallCount: number
    nudgeDetected: boolean
    nudgeSystemTokens?: number
    scenarioPhase?: string
    blockedRefCount: number
    protectedRefCount: number
    compressibleRefCount: number
    messageRefCount: number
    blockRefCount: number
    candidateOrRangeText: boolean
    calledCompress: boolean
    emittedCompressCount: number
    candidateSelected?: boolean
    candidateStartId?: string
    candidateEndId?: string
    isChild: boolean
    isAuxiliary: boolean
    /** URL path used by the provider request (including any /bili/ prefix). */
    requestPath: string
    /** Normalized provider tool names advertised in this request. */
    advertisedToolNames: string[]
    /** The five ACP names found in the advertised catalog, in request order. */
    acpToolNames: string[]
    /** ACP system prompt/metadata was present in this model request. */
    systemPromptPresent: boolean
    /** Message refs observed in dcp-message-id tags (payloads are never recorded). */
    dcpMessageIdRefs: string[]
    /** A compressed summary marker was visible in this request. */
    summaryMarkerPresent: boolean
    /** Command sentinels or raw command arguments reached this model request. */
    commandSentinelLeakage: boolean
    /** An ACP-owned synthetic notice reached this model request. */
    acpOwnedNoticePresent: boolean
    /** Tool calls already present in the incoming conversation. */
    calledToolNames: string[]
    /** Redacted tool-call shape; argument payloads are never recorded. */
    toolParameterObservations: ToolParameterObservation[]
    /** Statuses of tool results present in the incoming conversation. */
    toolResultStatuses: ToolResultObservation[]
}

export interface ToolResultObservation {
    name?: string
    status: "completed" | "error"
    actionable?: boolean
}

export interface ToolParameterObservation {
    name?: string
    argumentLength: number
    argumentKeys: string[]
}

export interface Observations {
    requests: RequestObservation[]
    emittedTools: string[]
    toolResults: ToolResultObservation[]
    activation?: {
        exactStatus: number
        exactDiagnosticMatched: boolean
        fallbackUsed: boolean
    }
    nudgeCheckpoints?: unknown[]
}

const observations: Observations = { requests: [], emittedTools: [], toolResults: [] }

const ACP_TOOL_NAMES = new Set([
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_context_recap",
])

let totalCompressionsEmitted = 0

function recordObservation(
    requestPath: string,
    body: any,
    turn: number,
    inputTokens: number,
    messageCount: number,
    compressCallCount: number,
    nudgeDetected: boolean,
    nudgeSystemTokens: number | undefined,
    scenarioPhase: string | undefined,
    isChild: boolean,
    isAuxiliary: boolean,
): void {
    const messages = messagesFromBody(body)
    const advertisedToolNames = advertisedNames(toolsFromBody(body))
    const toolResultStatuses = inspectToolResults(messages)
    const toolParameterObservations = inspectToolParameters(messages)
    const calledNames = calledToolNames(messages)
    const refEvidence = inspectRefEvidence(messages)
    observations.requests.push({
        turn,
        inputTokens,
        messageCount,
        compressCallCount,
        nudgeDetected,
        nudgeSystemTokens,
        ...(scenarioPhase ? { scenarioPhase } : {}),
        blockedRefCount: refEvidence.blockedRefCount,
        protectedRefCount: refEvidence.protectedRefCount,
        compressibleRefCount: refEvidence.compressibleRefCount,
        messageRefCount: refEvidence.messageRefCount,
        blockRefCount: refEvidence.blockRefCount,
        candidateOrRangeText: refEvidence.candidateOrRangeText,
        calledCompress: calledNames.includes("compress"),
        emittedCompressCount: observations.emittedTools.filter((name) => name === "compress")
            .length,
        isChild,
        isAuxiliary,
        requestPath,
        advertisedToolNames,
        acpToolNames: advertisedToolNames.filter((name) => ACP_TOOL_NAMES.has(name)),
        systemPromptPresent: hasAcpSystemPrompt(body),
        dcpMessageIdRefs: parseDcpMessageRefs(messages),
        summaryMarkerPresent: hasSummaryMarker(messages),
        commandSentinelLeakage: hasCommandSentinel(body),
        acpOwnedNoticePresent: hasAcpOwnedNotice(messages),
        calledToolNames: calledNames,
        toolParameterObservations,
        toolResultStatuses,
    })
    for (const result of toolResultStatuses) {
        observations.toolResults.push(result)
    }
    writeObservations()
}

function writeObservations(): void {
    try {
        let preserved: Pick<Observations, "activation" | "nudgeCheckpoints"> = {}
        try {
            const existing = JSON.parse(readFileSync(OBSERVATIONS_FILE, "utf-8"))
            preserved = {
                ...(existing?.activation ? { activation: existing.activation } : {}),
                ...(Array.isArray(existing?.nudgeCheckpoints)
                    ? { nudgeCheckpoints: existing.nudgeCheckpoints }
                    : {}),
            }
        } catch {
            // The first fake-provider write creates the observations file.
        }
        writeFileSync(OBSERVATIONS_FILE, JSON.stringify({ ...observations, ...preserved }, null, 2))
    } catch {
        // best-effort — verify.ts treats missing file as "no constraints"
    }
}

function recordEmittedTool(name: string): void {
    observations.emittedTools.push(name)
    writeObservations()
}

function markLastObservationCandidateSelected(startId: string, endId: string): void {
    const last = observations.requests[observations.requests.length - 1]
    if (!last) return
    last.candidateSelected = true
    last.candidateStartId = startId
    last.candidateEndId = endId
    writeObservations()
}

const CHILD_TURN_COUNTER = TURN_COUNTER + "-child"

function readChildTurnCounter(): number {
    if (existsSync(CHILD_TURN_COUNTER)) {
        return parseInt(readFileSync(CHILD_TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    return 0
}

function incrementChildTurnCounter(): number {
    const current = readChildTurnCounter()
    writeFileSync(CHILD_TURN_COUNTER, String(current + 1))
    return current
}

// --- HTTP server ---

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch(req: Request) {
        const url = new URL(req.url)

        if (req.method === "GET" && url.pathname === "/v1/models") {
            return jsonResponse({
                object: "list",
                data: [
                    {
                        id: "fake-model",
                        object: "model",
                        created: 1_700_000_000_000,
                        owned_by: "acp-e2e",
                    },
                ],
            })
        }

        if (req.method === "POST" && url.pathname.endsWith("/v1/chat/completions")) {
            return handleChatCompletion(req)
        }

        return jsonResponse({ error: `not found: ${req.method} ${url.pathname}` }, 404)
    },
})

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23)
    process.stderr.write(`[fake-llm ${ts}] ${msg}\n`)
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    })
}

// --- Chat completion handler ---

async function handleChatCompletion(req: Request): Promise<Response> {
    let body: any
    try {
        body = await req.json()
    } catch (err) {
        return jsonResponse({ error: `invalid JSON: ${(err as Error).message}` }, 400)
    }

    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const tools: any[] = Array.isArray(body?.tools) ? body.tools : []
    const isStream: boolean = body?.stream === true
    const model: string = body?.model ?? "fake-model"

    const parentSessionId = req.headers.get("x-parent-session-id")
    const sessionId = req.headers.get("x-session-id") ?? "unknown"
    const isChild = !!parentSessionId

    const lastMsg = messages[messages.length - 1]
    const lastRole = lastMsg?.role

    const inputTokens = computeInputTokens(messages)
    const nudgeDetected = detectNudge(messages)
    const compressCallCount = countCompressCalls(messages)

    const isAuxiliary = tools.length === 0

    recordObservation(
        new URL(req.url).pathname,
        body,
        readTurnCounter(),
        inputTokens,
        messages.length,
        compressCallCount,
        nudgeDetected,
        extractNudgeSystemTokens(messages),
        hasProtectedNoTargetPhase(body) ? "protected-no-target" : undefined,
        isChild,
        isAuxiliary,
    )

    log(
        `  body: stream=${isStream} msgs=${messages.length} ` +
            `lastRole=${lastRole} tools=${tools.length} inputTok=${inputTokens}${isChild ? " [CHILD]" : ""}`,
    )

    if (tools.length === 0) {
        log("  → auxiliary call (tools=0), emitting generic text")
        return textResponse(model, "Session summary.", isStream, inputTokens)
    }

    if (isChild) {
        return handleChildRequest(model, messages, lastRole, lastMsg, isStream, inputTokens)
    }

    const sequenceResponse = handleToolSequenceRequest(
        model,
        body,
        messages,
        lastRole,
        isStream,
        inputTokens,
    )
    if (sequenceResponse) return sequenceResponse

    if (lastRole === "tool" || lastRole === "function") {
        const toolText = extractMessageText(lastMsg)
        if (
            toolText.includes("QUALITY GATE FAILURE") ||
            toolText.includes("COMPRESSION REJECTED")
        ) {
            const currentIdx = readTurnCounter() - 1
            const currentStep = scenario.turns[currentIdx]
            if (currentStep?.retryOnReject) {
                const refs = parseMessageRefs(messages)
                const [startId, endId] = resolveRange(refs, currentStep.range ?? "all")
                log(`  → retrying compress with acknowledgeRisk after rejection`)
                return compressResponse(
                    model,
                    {
                        content: [
                            {
                                topic: currentStep.retryOnReject.topic ?? "Retry",
                                startId,
                                endId,
                                summary: currentStep.retryOnReject.summary,
                            },
                        ],
                    },
                    currentStep.retryOnReject.acknowledgeRisk ?? true,
                    isStream,
                    inputTokens,
                )
            }
        }

        const currentIdx = readTurnCounter() - 1
        const currentStep = scenario.turns[currentIdx]
        if (currentStep?.respond === "autonomous-nudge") {
            log("  → autonomous-nudge: continuing autonomous work cycle")
            return handleAutonomousNudgeStep(model, messages, currentStep, isStream, inputTokens)
        }
        if (currentStep?.respond === "nudge-compress" && toolText.includes("Compressed")) {
            log("  → nudge-compress: compress succeeded, emitting acknowledgment")
            return textResponse(model, "Compression complete.", isStream, inputTokens)
        }

        log("  → tool result received, emitting text acknowledgment")
        return textResponse(model, "Understood, continuing.", isStream, inputTokens)
    }

    if (lastRole === "user") {
        const preIdx = readTurnCounter() - 1
        const preStep = scenario.turns[preIdx]
        if (preStep?.respond === "autonomous-nudge" && detectNudge(messages)) {
            log("  → autonomous-nudge: ACP nudge suffix detected (not a new turn)")
            return handleAutonomousNudgeStep(model, messages, preStep, isStream, inputTokens)
        }
    }

    const turnIdx = incrementTurnCounter()
    const step = scenario.turns[turnIdx]

    if (!step) {
        if (scenario.name === "acp-installed-artifact-nudge-growth-refire") {
            return handleNudgeCompressStep(
                model,
                messages,
                {
                    respond: "nudge-compress",
                    growthRepeat: 15,
                    growthText:
                        "The installed artifact growth record covers authentication boundaries, provider routing, session ownership, request validation, persistence ordering, and context retention. The service validates incoming input before selecting a provider, records a durable session reference, preserves tool call and result pairing, and keeps recent user intent visible while older completed discussion remains eligible for compression.",
                    topic: "Installed nudge growth cycle",
                    summary:
                        "Installed nudge compression summary: The completed context growth record covers authentication boundaries, provider routing, session ownership, request validation, persistence ordering, context retention, protected recent messages, and exact nudge baseline transitions. The service validates incoming input before selecting a provider, records durable session references, preserves tool call and result pairing, keeps recent user intent visible, and makes older completed discussion eligible for compression. This summary captures the completed provider route, the protected recent intent, the nudge-triggered compression decision, and the persisted baseline transition so the installed artifact quality gate can verify the real compression.",
                },
                isStream,
                inputTokens,
            )
        }
        log(`  → no scenario step for turn ${turnIdx + 1}, emitting default text`)
        return textResponse(model, "Done.", isStream, inputTokens)
    }

    log(`  → turn ${turnIdx + 1}: respond=${step.respond}`)

    if (step.respond === "task") {
        return handleTaskStep(model, step, isStream, inputTokens)
    }

    if (step.respond === "compress") {
        return handleCompressStep(model, messages, step, isStream, inputTokens)
    }

    if (step.respond === "nudge-compress") {
        return handleNudgeCompressStep(model, messages, step, isStream, inputTokens)
    }

    if (step.respond === "autonomous-nudge") {
        return handleAutonomousNudgeStep(model, messages, step, isStream, inputTokens)
    }

    if (step.respond === "tool") {
        return handleToolStep(model, step, isStream, inputTokens)
    }

    // Text response
    const text = step.text ?? "(empty)"
    return textResponse(model, text, isStream, inputTokens)
}

function incrementTurnCounter(): number {
    let current = 0
    if (existsSync(TURN_COUNTER)) {
        current = parseInt(readFileSync(TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    const next = current + 1
    writeFileSync(TURN_COUNTER, String(next))
    return current
}

function readTurnCounter(): number {
    if (existsSync(TURN_COUNTER)) {
        return parseInt(readFileSync(TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    return 0
}

// --- Compress tool_use emission ---

function handleCompressStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    // Parse all mNNNNN refs from the conversation.
    // ACP injects <dcp-message-id tokens="..." type="...">mNNNNN</dcp-message-id> tags.
    const refs = parseMessageRefs(messages)

    if (refs.length === 0) {
        log("  ⚠ no mNNNNN refs found — emitting fallback text")
        return textResponse(model, "No messages to compress.", isStream, inputTokens)
    }

    log(`  → found ${refs.length} mNNNNN refs: ${refs[0]}..${refs[refs.length - 1]}`)

    if (step.ranges && step.ranges.length > 0) {
        const content = step.ranges.map((r) => {
            const [startId, endId] = resolveRange(refs, r.range ?? "all")
            return {
                topic: r.topic ?? "Batch range",
                startId,
                endId,
                summary: r.summary,
            }
        })

        log(`  → batch compress: ${content.length} ranges`)
        return compressResponse(
            model,
            { topic: "Batch compression", content },
            step.acknowledgeRisk ?? false,
            isStream,
            inputTokens,
        )
    }

    const [startId, endId] = resolveRange(refs, step.range ?? "all")
    const content = [
        {
            topic: step.topic ?? "Compression",
            startId,
            endId,
            summary: step.summary ?? "Summary not provided.",
        },
    ]

    log(
        `  → compress: ${startId}..${endId}, summary=${(step.summary ?? "").length} chars, ack=${step.acknowledgeRisk ?? false}`,
    )
    return compressResponse(
        model,
        { content },
        step.acknowledgeRisk ?? false,
        isStream,
        inputTokens,
    )
}

function detectNudge(messages: any[]): boolean {
    const nudgePhrases = [
        "efficiency nudge to compress early",
        "Context limit reached — compress now",
        "since last nudge)",
    ]
    for (const msg of messages) {
        if (msg?.role === "user") {
            const text = extractMessageText(msg)
            if (nudgePhrases.some((p) => text.includes(p))) return true
        }
    }
    return false
}

function extractNudgeSystemTokens(messages: any[]): number | undefined {
    const breakdownRe = /Breakdown: ([0-9.]+)K? system/
    for (const msg of messages) {
        if (msg?.role === "user") {
            const text = extractMessageText(msg)
            const match = text.match(breakdownRe)
            if (match) {
                const value = parseFloat(match[1])
                const kilo = text.includes(`${match[1]}K system`)
                return kilo ? Math.round(value * 1000) : Math.round(value)
            }
        }
    }
    return undefined
}

function handleNudgeCompressStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const nudgeDetected = detectNudge(messages)

    if (!nudgeDetected) {
        const growthText =
            step.growthText ??
            "Working on the task. Generating content to fill the context window with meaningful discussion about software architecture and implementation details."
        log(
            `  → nudge-compress: no nudge detected, emitting ${growthText.length} chars of growth text`,
        )
        const repeat = Math.max(1, Math.floor(step.growthRepeat ?? 1))
        const expandedGrowth = Array.from({ length: repeat }, () => growthText).join("\n")
        return textResponse(model, expandedGrowth, isStream, inputTokens)
    }

    log(`  → nudge-compress: nudge DETECTED, emitting compress call`)
    const refs = parseMessageRefs(messages)
    if (refs.length === 0) {
        log("  ⚠ no mNNNNN refs found — emitting fallback text")
        return textResponse(model, "No messages to compress.", isStream, inputTokens)
    }

    const advertised = parseCompressionCandidate(messages, refs, step.candidateKind)
    if (advertised) markLastObservationCandidateSelected(advertised[0], advertised[1])
    const [startId, endId] = advertised ?? resolveRange(refs, step.range ?? "all")
    const content = [
        {
            topic: step.topic ?? "Nudge-triggered compression",
            startId,
            endId,
            summary:
                step.summary ??
                "Summary of compressed content generated during nudge-triggered E2E test.",
        },
    ]

    log(
        `  → compress: ${startId}..${endId}, summary=${(step.summary ?? "").length} chars${advertised ? " (advertised candidate)" : ""}`,
    )
    return compressResponse(model, { content }, false, isStream, inputTokens)
}

function messagesFromBody(body: any): any[] {
    return Array.isArray(body?.messages) ? body.messages : []
}

function toolsFromBody(body: any): any[] {
    return Array.isArray(body?.tools) ? body.tools : []
}

function normalizeToolName(value: unknown): string | undefined {
    if (typeof value !== "string" || value.trim().length === 0) return undefined
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
}

function advertisedNames(tools: any[]): string[] {
    const names: string[] = []
    for (const tool of tools) {
        const name = normalizeToolName(
            tool?.function?.name ?? tool?.name ?? tool?.tool?.name ?? tool?.id,
        )
        if (name) names.push(name)
    }
    return names
}

function calledToolNames(messages: any[]): string[] {
    const names: string[] = []
    for (const message of messages) {
        if (!Array.isArray(message?.tool_calls)) continue
        for (const call of message.tool_calls) {
            const name = normalizeToolName(call?.function?.name ?? call?.name)
            if (name) names.push(name)
        }
    }
    return names
}

function inspectToolParameters(messages: any[]): ToolParameterObservation[] {
    const results: ToolParameterObservation[] = []
    for (const message of messages) {
        if (!Array.isArray(message?.tool_calls)) continue
        for (const call of message.tool_calls) {
            const rawArguments = call?.function?.arguments
            const argumentText = typeof rawArguments === "string" ? rawArguments : ""
            let argumentKeys: string[] = []
            try {
                const parsed = JSON.parse(argumentText)
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    argumentKeys = Object.keys(parsed).sort()
                }
            } catch {
                // Keep the structural observation payload-free when arguments are
                // streamed in a host-specific format.
            }
            const name = normalizeToolName(call?.function?.name ?? call?.name)
            results.push({
                ...(name ? { name } : {}),
                argumentLength: argumentText.length,
                argumentKeys,
            })
        }
    }
    return results
}

function inspectToolResults(messages: any[]): ToolResultObservation[] {
    const results: ToolResultObservation[] = []
    const namesByCallId = new Map<string, string>()
    for (const message of messages) {
        if (!Array.isArray(message?.tool_calls)) continue
        for (const call of message.tool_calls) {
            const id = typeof call?.id === "string" ? call.id : undefined
            const name = normalizeToolName(call?.function?.name ?? call?.name)
            if (id && name) namesByCallId.set(id, name)
        }
    }
    for (const message of messages) {
        if (message?.role !== "tool" && message?.role !== "function") continue
        const text = extractMessageText(message)
        const id = typeof message?.tool_call_id === "string" ? message.tool_call_id : undefined
        const name = normalizeToolName(message?.name) ?? (id ? namesByCallId.get(id) : undefined)
        const status =
            /(?:^|\n)\s*(?:error:|ACP cannot request|ACP tool execution is disabled|ACP .* execution failed|permission .* blocked|invalid .* input|COMPRESSION REJECTED|QUALITY GATE FAILURE)/i.test(
                text,
            )
                ? "error"
                : "completed"
        const actionable = /permission|allow|deny/i.test(text)
        results.push({ ...(name ? { name } : {}), status, actionable })
    }
    return results
}

function hasProtectedNoTargetPhase(body: any): boolean {
    const serialized = JSON.stringify(body)
    return serialized.includes("PROTECTED_NO_TARGET_PHASE")
}

function systemText(body: any): string {
    const parts: string[] = []
    if (typeof body?.system === "string") parts.push(body.system)
    if (Array.isArray(body?.system)) {
        for (const part of body.system) {
            if (typeof part === "string") parts.push(part)
            else if (part?.text) parts.push(String(part.text))
            else if (part?.content) parts.push(String(part.content))
        }
    }
    for (const message of messagesFromBody(body)) {
        if (message?.role === "system") parts.push(extractMessageText(message))
    }
    return parts.join("\n")
}

function hasAcpSystemPrompt(body: any): boolean {
    const text = systemText(body)
    return text.includes("ACP TAGS") || text.includes("five context-management tools")
}

function parseDcpMessageRefs(messages: any[]): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const tagRegex = /<dcp-message-id[^>]*>([^<]+)<\/dcp-message-id>/g
    for (const message of messages) {
        const text = extractMessageText(message)
        let match: RegExpExecArray | null
        while ((match = tagRegex.exec(text)) !== null) {
            const ref = match[1]
            if (ref && !seen.has(ref)) {
                seen.add(ref)
                refs.push(ref)
            }
        }
    }
    return refs
}

function inspectRefEvidence(messages: any[]): {
    blockedRefCount: number
    protectedRefCount: number
    compressibleRefCount: number
    messageRefCount: number
    blockRefCount: number
    candidateOrRangeText: boolean
} {
    const text = messages.map(extractMessageText).join("\n")
    const blockedRefCount = (text.match(/<dcp-message-id[^>]*>BLOCKED<\/dcp-message-id>/g) ?? [])
        .length
    const messageRefs = new Set(text.match(/<dcp-message-id[^>]*>m\d+<\/dcp-message-id>/g) ?? [])
    const blockRefs = new Set(text.match(/<dcp-message-id[^>]*>b\d+<\/dcp-message-id>/g) ?? [])
    const userVisibleText = messages
        .filter(
            (message) =>
                (message?.role === "user" || message?.role === "assistant") &&
                !extractMessageText(message).includes("PROTECTED_NO_TARGET_PHASE"),
        )
        .map(extractMessageText)
        .join("\n")
    const candidateOrRangeText =
        /\b(?:MICRO|EPISODE)\b|\bcandidates?\b|\bcompressible\s+ranges?\b|\bm\d+\s*[–-]\s*m\d+\b/i.test(
            userVisibleText,
        )
    // Only literal BLOCKED tags are counted as explicitly protected here.
    // OpenCode 2.0.3 keeps m-ref tags in the preserveRecentMessages window, so
    // the driver combines the observed ref count with its pinned window size
    // instead of relabeling ordinary m-refs as protected.
    const protectedRefCount = blockedRefCount
    return {
        blockedRefCount,
        protectedRefCount,
        compressibleRefCount: Math.max(0, messageRefs.size - blockedRefCount),
        messageRefCount: messageRefs.size,
        blockRefCount: blockRefs.size,
        candidateOrRangeText,
    }
}

function hasSummaryMarker(messages: any[]): boolean {
    return messages.some((message) => {
        const text = extractMessageText(message)
        return (
            text.includes("[Compressed conversation section]") ||
            /<dcp-message-id[^>]*>b\d+/.test(text)
        )
    })
}

function hasCommandSentinel(body: any): boolean {
    return /(?:COMMAND_SENTINEL|ACP_E2E_SENTINEL|DCP_E2E_SENTINEL)/i.test(JSON.stringify(body))
}

function hasAcpOwnedNotice(messages: any[]): boolean {
    return messages.some((message) => {
        const metadata = JSON.stringify(message?.metadata ?? {})
        return message?.id?.startsWith("msg_acp_notice_") || metadata.includes('"acpOwned":true')
    })
}

function hasAdvertisedAcpTools(body: any): boolean {
    return advertisedNames(toolsFromBody(body)).some((name) => ACP_TOOL_NAMES.has(name))
}

let installedActionIndex = 0
let installedWarmupCount = 0

function handleToolSequenceRequest(
    model: string,
    body: any,
    messages: any[],
    lastRole: string | undefined,
    isStream: boolean,
    inputTokens: number,
): Response | undefined {
    const sequence = scenario.toolSequence
    if (!sequence || sequence.length === 0) return undefined

    // A proxy-disabled request deliberately has no ACP tools. Keep the request
    // useful but do not advance the scripted ACP action sequence.
    if (!hasAdvertisedAcpTools(body)) {
        return textResponse(
            model,
            scenario.warmupText ?? "ACP-disabled provider request completed.",
            isStream,
            inputTokens,
        )
    }

    const warmupTurns = scenario.warmupTurns ?? 1
    if (lastRole !== "tool" && lastRole !== "function" && installedWarmupCount < warmupTurns) {
        installedWarmupCount++
        return textResponse(
            model,
            scenario.warmupText ?? "Initial context captured before scripted ACP actions.",
            isStream,
            inputTokens,
        )
    }

    if (installedActionIndex >= sequence.length) {
        return textResponse(model, "Installed-artifact flow complete.", isStream, inputTokens)
    }

    const step = sequence[installedActionIndex++]
    if (!step)
        return textResponse(model, "Installed-artifact flow complete.", isStream, inputTokens)

    if (step.tool === "compress") {
        const refs = parseMessageRefs(messages)
        if (refs.length === 0) {
            return textResponse(model, "No messages to compress.", isStream, inputTokens)
        }
        const [startId, endId] = resolveRange(refs, step.range ?? "all")
        const content = [
            {
                topic: step.topic ?? "Installed ACP compression",
                startId,
                endId,
                summary:
                    step.summary ??
                    "Installed-artifact compression summary with enough detail for the quality gate.",
            },
        ]
        return compressResponse(
            model,
            { content },
            step.acknowledgeRisk ?? false,
            isStream,
            inputTokens,
        )
    }

    return toolUseResponse(model, step.tool, step.args ?? {}, isStream, inputTokens)
}

function handleToolStep(
    model: string,
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const toolName = step.tool ?? "bash"
    return toolUseResponse(model, toolName, step.toolArgs ?? {}, isStream, inputTokens)
}

function countCompressCalls(messages: any[]): number {
    let count = 0
    for (const msg of messages) {
        if (Array.isArray(msg?.tool_calls)) {
            for (const tc of msg.tool_calls) {
                if (tc?.function?.name === "compress") count++
            }
        }
    }
    return count
}

function handleAutonomousNudgeStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const visibleCompressCount = countCompressCalls(messages)
    const nudgeDetected = detectNudge(messages)
    const maxCompress = step.maxCompressCount ?? 2
    const growthText =
        step.growthText ??
        "Autonomous work generating output to fill the context window with meaningful discussion about software architecture patterns dependency injection inversion of control and SOLID principles applied to the authentication module service layer and data access layer with proper separation of concerns and testability through mockable interfaces and dependency injection containers."

    if (totalCompressionsEmitted >= maxCompress) {
        log(
            `  → autonomous-nudge: totalCompressions=${totalCompressionsEmitted} ≥ ${maxCompress}, task complete (visible=${visibleCompressCount})`,
        )
        return textResponse(model, "Task complete.", isStream, inputTokens)
    }

    if (nudgeDetected) {
        log(
            `  → autonomous-nudge: nudge DETECTED (total=${totalCompressionsEmitted}, visible=${visibleCompressCount}), emitting compress call`,
        )
        const refs = parseMessageRefs(messages)
        if (refs.length === 0) {
            log("  ⚠ no mNNNNN refs found — emitting fallback text")
            return textResponse(model, "No messages to compress.", isStream, inputTokens)
        }
        const [startId, endId] = resolveRange(refs, step.range ?? "all")
        return compressResponse(
            model,
            {
                content: [
                    {
                        topic: step.topic ?? "Autonomous compression",
                        startId,
                        endId,
                        summary: step.summary ?? "Compressed autonomous work output.",
                    },
                ],
            },
            false,
            isStream,
            inputTokens,
        )
    }

    log(
        `  → autonomous-nudge: no nudge yet (total=${totalCompressionsEmitted}, visible=${visibleCompressCount}), emitting growth bash call`,
    )
    return toolUseResponse(
        model,
        "bash",
        {
            command: `echo '${growthText.replace(/'/g, "'\\''")}'`,
            description: "Generate autonomous work output",
        },
        isStream,
        inputTokens,
    )
}

function handleChildRequest(
    model: string,
    messages: any[],
    lastRole: string | undefined,
    lastMsg: any,
    isStream: boolean,
    inputTokens: number,
): Response {
    const taskStep = scenario.turns.find((t) => t.respond === "task")
    const childTurns = taskStep?.subagent_turns ?? []

    if (lastRole === "tool" || lastRole === "function") {
        const toolText = extractMessageText(lastMsg)
        if (
            toolText.includes("QUALITY GATE FAILURE") ||
            toolText.includes("COMPRESSION REJECTED")
        ) {
            const idx = readChildTurnCounter() - 1
            const step = childTurns[idx]
            if (step?.retryOnReject) {
                const refs = parseMessageRefs(messages)
                const [startId, endId] = resolveRange(refs, step.range ?? "all")
                log(`  → [CHILD] retrying compress with acknowledgeRisk`)
                return compressResponse(
                    model,
                    {
                        content: [
                            {
                                topic: step.retryOnReject.topic ?? "Retry",
                                startId,
                                endId,
                                summary: step.retryOnReject.summary,
                            },
                        ],
                    },
                    step.retryOnReject.acknowledgeRisk ?? true,
                    isStream,
                    inputTokens,
                )
            }
        }
    }

    const turnIdx = incrementChildTurnCounter()
    const step = childTurns[turnIdx]

    if (!step) {
        log(`  → [CHILD] turn ${turnIdx + 1}: no step, emitting default text`)
        return textResponse(model, "Task complete.", isStream, inputTokens)
    }

    log(`  → [CHILD] turn ${turnIdx + 1}: respond=${step.respond}`)

    if (step.respond === "compress") {
        return handleCompressStep(model, messages, step, isStream, inputTokens)
    }

    if (step.respond === "tool") {
        const toolName = step.tool ?? "bash"
        log(`  → [CHILD] emitting ${toolName} tool call`)
        return toolUseResponse(model, toolName, step.toolArgs ?? {}, isStream, inputTokens)
    }

    return textResponse(model, step.text ?? "Done.", isStream, inputTokens)
}

function handleTaskStep(
    model: string,
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const args: Record<string, unknown> = {
        description: step.description ?? "E2E subagent task",
        prompt: step.prompt ?? "Complete the assigned task.",
        subagent_type: step.subagent_type ?? "general",
    }

    log(`  → emitting task tool call (subagent_type=${args.subagent_type})`)
    return toolUseResponse(model, "task", args, isStream, inputTokens)
}

/**
 * Parse <dcp-message-id ...>mNNNNN</dcp-message-id> tags from all messages.
 * Returns an ordered list of unique refs (m00001, m00002, ...).
 */
function parseMessageRefs(messages: any[]): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const tagRegex = /<dcp-message-id[^>]*>(m\d+)<\/dcp-message-id>/g

    for (const msg of messages) {
        if (msg?.role === "system") continue
        const text = extractMessageText(msg)
        let match: RegExpExecArray | null
        while ((match = tagRegex.exec(text)) !== null) {
            const ref = match[1]
            if (!seen.has(ref)) {
                seen.add(ref)
                refs.push(ref)
            }
        }
    }

    return refs
}

function parseCompressionCandidate(
    messages: any[],
    refs: string[],
    preferredKind?: "micro" | "episode",
): [string, string] | null {
    const refSet = new Set(refs)
    const candidateRegex = /\b(MICRO|EPISODE)\s+(m\d+)[–-](m\d+)\b/g
    for (const message of messages) {
        if (message?.role !== "user") continue
        const text = extractMessageText(message)
        let match: RegExpExecArray | null
        while ((match = candidateRegex.exec(text)) !== null) {
            const kind = match[1]!.toLowerCase()
            if (preferredKind && kind !== preferredKind) continue
            const start = match[2]!
            const end = match[3]!
            if (refSet.has(start) && refSet.has(end)) return [start, end]
        }
    }
    return null
}

function extractMessageText(msg: any): string {
    const parts: string[] = []
    if (typeof msg?.content === "string") {
        parts.push(msg.content)
    } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
            if (typeof part === "string") parts.push(part)
            else if (part?.text) parts.push(part.text)
            else if (part?.content) parts.push(part.content)
        }
    }
    // ACP injects <dcp-message-id> tags into tool_calls arguments for
    // assistant messages that contain tool calls (no text content).
    if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc?.function?.arguments) parts.push(String(tc.function.arguments))
        }
    }
    return parts.join("")
}

/**
 * Resolve a range specification to [startId, endId].
 * - "all": first and last ref
 * - [n, m]: nth and mth ref (0-indexed)
 */
function resolveRange(refs: string[], range: "all" | [number, number]): [string, string] {
    if (range === "all") {
        return [refs[0], refs[refs.length - 1]]
    }
    const [startIdx, endIdx] = range
    const start = refs[Math.min(startIdx, refs.length - 1)]
    const end = refs[Math.min(endIdx, refs.length - 1)]
    return [start, end]
}

// --- Response builders ---

function computeInputTokens(messages: any[]): number {
    const inputText = messages.map((m) => extractMessageText(m)).join("")
    return Math.max(1, Math.ceil(inputText.length / 4))
}

function textResponse(model: string, text: string, isStream: boolean, inputTokens = 0): Response {
    const outputTokens = Math.max(1, Math.ceil(text.length / 4))
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                },
            ],
            usage,
        })
    }

    return sseStream(model, [{ type: "text", content: text }], usage)
}

function compressResponse(
    model: string,
    args: Record<string, unknown>,
    acknowledgeRisk: boolean,
    isStream: boolean,
    inputTokens = 0,
): Response {
    totalCompressionsEmitted++
    recordEmittedTool("compress")
    const fullArgs = { ...args }
    if (acknowledgeRisk) {
        ;(fullArgs as any).acknowledgeRisk = true
    }

    const argsJson = JSON.stringify(fullArgs)
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const outputTokens = Math.max(1, Math.ceil(argsJson.length / 4))
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: callId,
                                type: "function",
                                function: { name: "compress", arguments: argsJson },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage,
        })
    }

    return sseStream(
        model,
        [{ type: "tool_use", toolName: "compress", callId, args: argsJson }],
        usage,
    )
}

function toolUseResponse(
    model: string,
    toolName: string,
    args: Record<string, unknown>,
    isStream: boolean,
    inputTokens = 0,
): Response {
    recordEmittedTool(toolName)
    const argsJson = JSON.stringify(args)
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const outputTokens = Math.max(1, Math.ceil(argsJson.length / 4))
    const usage = {
        prompt_tokens: inputTokens || outputTokens,
        completion_tokens: outputTokens,
        total_tokens: (inputTokens || outputTokens) + outputTokens,
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: callId,
                                type: "function",
                                function: { name: toolName, arguments: argsJson },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage,
        })
    }

    return sseStream(model, [{ type: "tool_use", toolName, callId, args: argsJson }], usage)
}

// --- SSE streaming ---

type StreamChunk =
    | { type: "text"; content: string }
    | { type: "tool_use"; toolName: string; callId: string; args: string }

function sseStream(model: string, chunks_data: StreamChunk[], usage: any): Response {
    const id = `chatcmpl-fake-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
        start(controller) {
            for (const chunk of chunks_data) {
                if (chunk.type === "tool_use") {
                    // Tool call: declare in first chunk, args in second
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            role: "assistant",
                                            content: null,
                                            tool_calls: [
                                                {
                                                    index: 0,
                                                    id: chunk.callId,
                                                    type: "function",
                                                    function: {
                                                        name: chunk.toolName,
                                                        arguments: "",
                                                    },
                                                },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            tool_calls: [
                                                { index: 0, function: { arguments: chunk.args } },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                                usage,
                            }),
                        ),
                    )
                } else {
                    // Text response: split into ~10 word-chunks for realistic streaming
                    const words = chunk.content.split(/(\s+)/)
                    const perChunk = Math.max(1, Math.ceil(words.length / 10))
                    const textChunks: string[] = []
                    for (let i = 0; i < words.length; i += perChunk) {
                        textChunks.push(words.slice(i, i + perChunk).join(""))
                    }

                    // First chunk: role + opening content
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: { role: "assistant", content: textChunks[0] ?? "" },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    // Subsequent chunks: content deltas
                    for (let i = 1; i < textChunks.length; i++) {
                        controller.enqueue(
                            encoder.encode(
                                sseLine({
                                    id,
                                    object: "chat.completion.chunk",
                                    created,
                                    model,
                                    choices: [
                                        {
                                            index: 0,
                                            delta: { content: textChunks[i] },
                                            finish_reason: null,
                                        },
                                    ],
                                }),
                            ),
                        )
                    }
                    // Final chunk: finish_reason + usage
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                                usage,
                            }),
                        ),
                    )
                }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
        },
    })

    return new Response(readable, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
        },
    })
}

function sseLine(obj: any): string {
    return `data: ${JSON.stringify(obj)}\n\n`
}

// --- Startup ---

process.stderr.write(
    `[fake-llm] listening on http://${HOST}:${PORT}\n` +
        `[fake-llm] scenario loaded\n` +
        `[fake-llm] ready (pid ${process.pid})\n`,
)
