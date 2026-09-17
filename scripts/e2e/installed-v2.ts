#!/usr/bin/env node

/**
 * HTTP driver and assertions for the OpenCode 2.0.3 installed-artifact E2E.
 *
 * The driver intentionally uses only the public HTTP API. Response bodies are
 * parsed for assertions but are never included in failure diagnostics.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import {
    assertNudgeCheckpointSequence,
    comparePermissionProjections,
    projectAcpState,
    stableSerialize,
} from "./verification-guards.mjs"

type JsonRecord = Record<string, any>

// Exact black-box values for the pinned OpenCode 2.0.3 fake-provider fixture.
// Keeping them independent of ACP's implementation makes the installed test
// fail if baseline transition logic drifts or resets unexpectedly.
const EXPECTED_NUDGE_BASELINES = { initial: 11_062, first: 11_609, second: 15_226 }

interface ToolResultObservation {
    name?: string
    status: "completed" | "error"
    actionable?: boolean
}

interface ReliabilityObservation {
    targetedOriginalPresent: boolean
    compressionSummaryPresent: boolean
    protectedRecentPresent: boolean
    shellStdoutAndExitStatusPresent: boolean
    shellToolCallHasNoProse: boolean
    shellToolCallHasAcpIdBeforeOpaqueCall: boolean
}

interface RequestObservation {
    turn?: number
    inputTokens: number
    messageCount: number
    compressCallCount: number
    nudgeDetected: boolean
    nudgeSystemTokens?: number
    scenarioPhase?: string
    blockedRefCount?: number
    protectedRefCount?: number
    compressibleRefCount?: number
    messageRefCount?: number
    blockRefCount?: number
    candidateOrRangeText?: boolean
    calledCompress?: boolean
    emittedCompressCount?: number
    isChild?: boolean
    isAuxiliary?: boolean
    requestPath?: string
    advertisedToolNames?: string[]
    acpToolNames?: string[]
    systemPromptPresent?: boolean
    dcpMessageIdRefs?: string[]
    summaryMarkerPresent?: boolean
    commandSentinelLeakage?: boolean
    acpOwnedNoticePresent?: boolean
    fixedSystemFixturePresent?: boolean
    calledToolNames?: string[]
    toolParameterObservations?: Array<{
        name?: string
        argumentLength: number
        argumentKeys: string[]
    }>
    toolResultStatuses?: ToolResultObservation[]
    reliability?: ReliabilityObservation
}

interface Observations {
    requests: RequestObservation[]
    emittedTools?: string[]
    toolResults?: ToolResultObservation[]
    activation?: {
        exactStatus: number
        exactDiagnosticMatched: boolean
        fallbackUsed: boolean
    }
    nudgeCheckpoints?: Array<Record<string, any>>
}

const stage = process.argv[2]
const root = requiredEnv("E2E_ROOT")
const serverURL = requiredEnv("E2E_SERVER_URL").replace(/\/$/, "")
const workspace = requiredEnv("E2E_WORKSPACE")
const configFile = requiredEnv("E2E_CONFIG_FILE")
const pluginTgzURL = requiredEnv("E2E_PLUGIN_TGZ_URL")
const observationsPath = requiredEnv("E2E_OBSERVATIONS")
const stateDir = requiredEnv("E2E_STATE_DIR")
const sessionFile = `${root}/v2/session.json`
const baselineFile = `${root}/v2/restart-baseline.json`
const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(workspace)}`
const auth = `Basic ${Buffer.from("opencode:e2e-dummy", "utf8").toString("base64")}`
const acpTools = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]

let assertions = 0

function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`missing required environment variable ${name}`)
    return value
}

function record(name: string, condition: boolean, detail?: string): void {
    assertions++
    if (!condition) throw new Error(`${name}${detail ? ` (${detail})` : ""}`)
    console.log(`  PASS ${name}`)
}

function asRecord(value: unknown): JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {}
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : []
}

function readJSON(path: string): any {
    try {
        return JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
        throw new Error(
            `cannot read JSON artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

function writeJSON(path: string, value: unknown): void {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
}

function withLocation(path: string): string {
    return `${path}${path.includes("?") ? "&" : "?"}${locationQuery}`
}

async function request(
    method: string,
    path: string,
    body?: unknown,
    expected: number[] = [200],
): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
        const response = await fetch(`${serverURL}${path}`, {
            method,
            headers: {
                authorization: auth,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
        })
        const text = await response.text()
        if (!expected.includes(response.status)) {
            throw new Error(`${method} ${path} returned HTTP ${response.status}`)
        }
        if (!text) return undefined
        try {
            return JSON.parse(text)
        } catch {
            throw new Error(`${method} ${path} returned invalid JSON`)
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith(`${method} ${path}`)) throw error
        throw new Error(
            `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
    } finally {
        clearTimeout(timer)
    }
}

async function waitFor<T>(
    name: string,
    operation: () => Promise<T>,
    predicate: (value: T) => boolean,
): Promise<T> {
    let lastError = "not ready"
    for (let attempt = 0; attempt < 80; attempt++) {
        try {
            const value = await operation()
            if (predicate(value)) return value
            lastError = "predicate was false"
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`${name} did not settle within 20 seconds: ${lastError}`)
}

function data(value: unknown): any[] {
    return asArray(asRecord(value).data)
}

function readObservations(): Observations {
    if (!existsSync(observationsPath)) return { requests: [] }
    const value = asRecord(readJSON(observationsPath))
    return {
        requests: asArray(value.requests) as RequestObservation[],
        ...(Array.isArray(value.emittedTools)
            ? { emittedTools: value.emittedTools as string[] }
            : {}),
        ...(Array.isArray(value.toolResults)
            ? { toolResults: value.toolResults as ToolResultObservation[] }
            : {}),
        ...(value.activation && typeof value.activation === "object"
            ? { activation: value.activation }
            : {}),
        ...(Array.isArray(value.nudgeCheckpoints)
            ? { nudgeCheckpoints: value.nudgeCheckpoints as Array<Record<string, any>> }
            : {}),
    }
}

function realRequests(observations: Observations): RequestObservation[] {
    return observations.requests.filter(
        (item) => item.isChild !== true && item.isAuxiliary !== true,
    )
}

function latestReal(observations: Observations, after = 0): RequestObservation {
    const values = realRequests(observations).slice(after)
    const value = values.at(-1)
    if (!value) throw new Error("fake provider recorded no primary request")
    return value
}

function advertisedAcpNames(observation: RequestObservation): string[] {
    return Array.isArray(observation.acpToolNames) ? observation.acpToolNames : []
}

function assertAcpCatalog(observation: RequestObservation, expected: boolean): void {
    const names = advertisedAcpNames(observation)
    if (!expected) {
        record(
            "ACP tools omitted while proxy-disabled",
            names.length === 0,
            `got ${names.join(",")}`,
        )
        return
    }
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    record(
        "exactly five ACP direct tools advertised",
        names.length === acpTools.length,
        `got ${names.length}`,
    )
    for (const name of acpTools) {
        record(
            `ACP direct tool ${name} advertised once`,
            counts.get(name) === 1,
            `got ${counts.get(name) ?? 0}`,
        )
    }
    record(
        "no duplicate or unexpected ACP direct tool names",
        names.every((name) => acpTools.includes(name)) && new Set(names).size === acpTools.length,
        `got ${names.join(",")}`,
    )
}

function countNamed(values: readonly string[], name: string): number {
    return values.filter((value) => value === name).length
}

function countBlocks(state: JsonRecord): number {
    return Object.keys(asRecord(asRecord(state.prune).messages?.blocksById)).length
}

function stateBlocks(state: JsonRecord): JsonRecord[] {
    return Object.values(
        asRecord(asRecord(asRecord(state.prune).messages).blocksById),
    ) as JsonRecord[]
}

function protectedPermissionView(state: JsonRecord): JsonRecord {
    return projectAcpState(state)
}

function permissionToolObservationView(observations: Observations): unknown[] {
    return realRequests(observations).flatMap((item) => item.toolParameterObservations ?? [])
}

function persistedPermissionView(state: JsonRecord): JsonRecord {
    return projectAcpState(state)
}

function readPersistedState(sessionID: string): JsonRecord {
    return asRecord(readJSON(statePath(sessionID)))
}

function snapshotNudgeCheckpoint(
    checkpoint: string,
    sessionID: string,
    observation: RequestObservation,
    extra: JsonRecord = {},
): JsonRecord {
    const state = readPersistedState(sessionID)
    const snapshot = {
        checkpoint,
        request: {
            inputTokens: observation.inputTokens,
            messageCount: observation.messageCount,
            nudgeDetected: observation.nudgeDetected,
            nudgeSystemTokens: observation.nudgeSystemTokens ?? null,
            compressCallCount: observation.compressCallCount,
            scenarioPhase: observation.scenarioPhase ?? null,
            blockedRefCount: observation.blockedRefCount ?? 0,
            protectedRefCount: observation.protectedRefCount ?? 0,
            compressibleRefCount: observation.compressibleRefCount ?? 0,
            messageRefCount: observation.messageRefCount ?? 0,
            blockRefCount: observation.blockRefCount ?? 0,
            candidateOrRangeText: observation.candidateOrRangeText ?? false,
            calledCompress: observation.calledCompress === true,
            emittedCompressCount: observation.emittedCompressCount ?? 0,
        },
        persisted: {
            blockCount: countBlocks(state),
            lastPerMessageNudgeTokens: state.nudges?.lastPerMessageNudgeTokens ?? null,
            lastNudgeShownTokens: state.nudges?.lastNudgeShownTokens ?? null,
        },
        ...extra,
    }
    const observations = readObservations()
    observations.nudgeCheckpoints = [...(observations.nudgeCheckpoints ?? []), snapshot]
    writeJSON(observationsPath, observations)
    writeJSON(`${root}/v2/nudge-${checkpoint}.json`, snapshot)
    return snapshot
}

function statePath(sessionID: string): string {
    return `${stateDir}/${sessionID}.json`
}

async function health(): Promise<JsonRecord> {
    const value = asRecord(await request("GET", "/api/health"))
    record(
        "V2 server reports version 2.0.3",
        value.version === "2.0.3",
        `got ${String(value.version)}`,
    )
    record("V2 server health is healthy", value.healthy === true)
    return value
}

function pluginInfo(inventory: any[]): JsonRecord | undefined {
    return inventory.map(asRecord).find((item) => item.id === "opencode-acp")
}

async function inventory(strict: boolean, requireActive = true): Promise<JsonRecord | undefined> {
    await request("POST", withLocation("/api/plugin/await-activation"), undefined, [204])
    let value = await request("GET", withLocation("/api/plugin"))
    let info = pluginInfo(data(value))
    // Configured plugin reloads are asynchronous even after the initial
    // activation barrier has settled. Poll only the inventory endpoint so a
    // file-URL fallback is not made dependent on watcher scheduling.
    for (let attempt = 0; !info && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        value = await request("GET", withLocation("/api/plugin"))
        info = pluginInfo(data(value))
    }
    const source = asRecord(info?.source)
    const pluginState = asRecord(info?.state)
    const active = pluginState.status === "active"
    const sourceMatches = source.type === "package" && source.target === pluginTgzURL
    const sourceLocalMatches =
        source.type === "local" &&
        (() => {
            try {
                return (
                    decodeURIComponent(String(source.path ?? "")) === new URL(pluginTgzURL).pathname
                )
            } catch {
                return false
            }
        })()
    const wrapperDir = process.env.E2E_WRAPPER_DIR
    const wrapperPrefix = wrapperDir
        ? wrapperDir.endsWith("/")
            ? wrapperDir
            : `${wrapperDir}/`
        : ""
    const sourcePath = String(source.path ?? "")
    const fallbackMarker =
        wrapperDir !== undefined &&
        source.type === "local" &&
        (sourcePath === wrapperDir || sourcePath.startsWith(wrapperPrefix))
    if (!info) {
        writeJSON(`${root}/v2/activation.json`, { active: false, sourceType: source.type ?? null })
        return undefined
    }
    if (requireActive) {
        record("installed ACP plugin is active", active, `status ${String(pluginState.status)}`)
    }
    record("installed ACP plugin has stable id", info.id === "opencode-acp")
    record("ACP server feature is present", asRecord(info.features).server === true)
    record("ACP TUI feature is present", asRecord(info.features).tui === true)
    record("ACP RPC feature is present", asRecord(info.features).rpc === true)
    if (strict) {
        record(
            "ACP source target is the packed file URL or documented wrapper fallback",
            sourceMatches || sourceLocalMatches || fallbackMarker,
            `source type ${String(source.type)}; packed=${sourceMatches}; local=${sourceLocalMatches}; wrapper=${fallbackMarker}`,
        )
    }
    writeJSON(`${root}/v2/activation.json`, {
        active,
        id: info.id,
        sourceType: source.type ?? null,
        sourceMatchesPackedURL: sourceMatches,
        wrapperFallback: fallbackMarker,
        features: {
            server: asRecord(info.features).server === true,
            tui: asRecord(info.features).tui === true,
            rpc: asRecord(info.features).rpc === true,
        },
    })
    return info
}

async function commands(): Promise<JsonRecord[]> {
    return data(await request("GET", withLocation("/api/command"))).map(asRecord)
}

function commandNames(items: readonly JsonRecord[]): string[] {
    return items.map((item) => String(item.name ?? item.id ?? ""))
}

async function waitForCommands(expected: boolean): Promise<JsonRecord[]> {
    return waitFor(
        expected ? "ACP commands to reappear" : "ACP commands to disappear",
        commands,
        (items) => {
            const names = commandNames(items)
            const acp = names.filter((name) => name === "acp" || name === "dcp")
            return expected ? acp.length === 2 && acp[0] !== acp[1] : acp.length === 0
        },
    )
}

async function createSession(): Promise<string> {
    const value = asRecord(
        await request("POST", "/api/session", {
            agent: "build",
            model: { providerID: "fake", id: "fake-model" },
            location: { directory: workspace },
        }),
    )
    const session = asRecord(value.data)
    const id = typeof session.id === "string" ? session.id : ""
    record("V2 test session created", id.startsWith("ses"))
    writeJSON(sessionFile, { id })
    return id
}

function readSession(): string {
    const value = asRecord(readJSON(sessionFile))
    const id = typeof value.id === "string" ? value.id : ""
    if (!id) throw new Error("V2 session artifact has no session id")
    return id
}

async function prompt(sessionID: string, text: string): Promise<void> {
    await request("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { text }, [200])
    await request("POST", `/api/session/${encodeURIComponent(sessionID)}/wait`, undefined, [204])
}

async function promptAndObserve(
    sessionID: string,
    text: string,
): Promise<{
    observations: Observations
    observation: RequestObservation
    newObservations: RequestObservation[]
    nudgeObserved: boolean
    nudgeObservation?: RequestObservation
}> {
    const before = realRequests(readObservations()).length
    await prompt(sessionID, text)
    const observations = await waitFor(
        "fake provider observation",
        async () => readObservations(),
        (value) => realRequests(value).length > before,
    )
    const newObservations = realRequests(observations).slice(before)
    const nudgeObservation = newObservations.find((item) => item.nudgeDetected === true)
    return {
        observations,
        observation: latestReal(observations, before),
        newObservations,
        nudgeObserved: nudgeObservation !== undefined,
        ...(nudgeObservation ? { nudgeObservation } : {}),
    }
}

async function sessionInbox(sessionID: string): Promise<any[]> {
    return data(await request("GET", `/api/session/${encodeURIComponent(sessionID)}/inbox`))
}

async function verifyConfig(): Promise<void> {
    const entries = asArray(await request("GET", withLocation("/api/config")))
    const document = entries
        .map(asRecord)
        .find((entry) => entry.type === "document" && entry.path === configFile)
    const info = asRecord(document?.info)
    record("V2 config uses native plugins array", Array.isArray(info.plugins))
    record("V2 config uses native providers record", asRecord(info.providers).fake !== undefined)
    record(
        "V2 config uses native agents record",
        info.agents !== null && info.agents !== undefined && typeof info.agents === "object",
    )
    record("V2 config uses native permissions array", Array.isArray(info.permissions))
    record("V2 updates are disabled", info.update === "disable")
    record("V2 sharing is disabled", info.share === "disabled")
    record("V2 automatic compaction is disabled", asRecord(info.compaction).auto === false)
    const provider = asRecord(asRecord(info.providers).fake)
    record(
        "V2 fake provider package is native OpenCode AI provider",
        provider.package === "@opencode/ai/providers/openai-compatible",
    )
    record(
        "V2 fake provider has a local base URL",
        String(asRecord(provider.settings).baseURL).includes("127.0.0.1"),
    )
}

async function verifyModel(): Promise<void> {
    const models = data(await request("GET", withLocation("/api/model")))
    const model = models
        .map(asRecord)
        .find((item) => item.providerID === "fake" && item.id === "fake-model")
    const limit = asRecord(model?.limit)
    const capabilities = asRecord(model?.capabilities)
    record("V2 fake model is available", model !== undefined)
    record("V2 fake model advertises tool capability", capabilities.tools === true)
    record(
        "V2 fake model context limit is 100000",
        limit.context === 100000,
        `got ${String(limit.context)}`,
    )
    record(
        "V2 fake model output limit is 4096",
        limit.output === 4096,
        `got ${String(limit.output)}`,
    )
}

async function verifyState(sessionID: string, expectedBlocks?: number): Promise<JsonRecord> {
    const path = statePath(sessionID)
    await waitFor(
        "ACP state file",
        async () => existsSync(path),
        (value) => value,
    )
    const state = asRecord(readJSON(path))
    if (expectedBlocks !== undefined) {
        record(
            `ACP state has ${expectedBlocks} compression block(s)`,
            countBlocks(state) === expectedBlocks,
            `got ${countBlocks(state)}`,
        )
    }
    return state
}

async function waitForState(
    sessionID: string,
    name: string,
    predicate: (state: JsonRecord) => boolean,
): Promise<JsonRecord> {
    return waitFor(
        name,
        async () => readPersistedState(sessionID),
        (state) => Object.keys(state).length > 0 && predicate(state),
    )
}

async function stageMain(): Promise<void> {
    await health()
    const info = await inventory(true)
    record("V2 plugin inventory includes ACP", info !== undefined)
    await verifyConfig()
    await verifyModel()
    const listed = await waitForCommands(true)
    const names = commandNames(listed)
    record("ACP command is registered once", countNamed(names, "acp") === 1)
    record("DCP compatibility command is registered once", countNamed(names, "dcp") === 1)

    const sessionID = await createSession()
    const result = await promptAndObserve(
        sessionID,
        "Seed the installed ACP context with authentication and provider routing details.",
    )
    record(
        "direct fake provider route is used",
        result.observation.requestPath?.endsWith("/v1/chat/completions") === true,
    )
    assertAcpCatalog(result.observation, true)
    record("fake model receives ACP system prompt", result.observation.systemPromptPresent === true)
    record(
        "fake model receives dcp message-ID refs",
        (result.observation.dcpMessageIdRefs?.length ?? 0) > 0,
    )
    await verifyState(sessionID, 0)
}

async function stageProxyDisabled(): Promise<void> {
    const sessionID = readSession()
    await health()
    await inventory(true)
    const listed = await waitForCommands(false)
    record(
        "ACP commands disappear while /bili/ proxy is active",
        !commandNames(listed).some((name) => name === "acp" || name === "dcp"),
    )
    const result = await promptAndObserve(
        sessionID,
        "Proxy transition probe; preserve authentication and provider routing details.",
    )
    record(
        "fake accepts the /bili/ provider route",
        result.observation.requestPath?.includes("/bili/") === true,
    )
    assertAcpCatalog(result.observation, false)
    await verifyState(sessionID, 0)
}

function emittedCounts(observations: Observations): Map<string, number> {
    const counts = new Map<string, number>()
    for (const name of observations.emittedTools ?? [])
        counts.set(name, (counts.get(name) ?? 0) + 1)
    return counts
}

async function stageReenabled(): Promise<void> {
    const sessionID = readSession()
    await health()
    const listed = await waitForCommands(true)
    const names = commandNames(listed)
    record("ACP command reappears once after proxy removal", countNamed(names, "acp") === 1)
    record("DCP command reappears once after proxy removal", countNamed(names, "dcp") === 1)
    const result = await promptAndObserve(
        sessionID,
        "Continue the installed-artifact compression sequence.",
    )
    const observations = result.observations
    assertAcpCatalog(result.observation, true)
    const direct = realRequests(observations).filter((item) =>
        item.requestPath?.endsWith("/v1/chat/completions"),
    )
    record("direct route remains active after re-enable", direct.length > 0)
    record(
        "ACP system prompt and IDs remain present after re-enable",
        direct.some((item) => item.systemPromptPresent && (item.dcpMessageIdRefs?.length ?? 0) > 0),
    )
    record(
        "compressed summary marker reaches a later model request",
        direct.some((item) => item.summaryMarkerPresent === true),
    )

    const counts = emittedCounts(observations)
    const called = realRequests(observations).flatMap((item) => item.calledToolNames ?? [])
    for (const name of acpTools) {
        record(
            `scripted ACP tool ${name} was emitted once`,
            counts.get(name) === 1,
            `got ${counts.get(name) ?? 0}`,
        )
        record(`scripted ACP tool ${name} call was observed`, called.includes(name))
    }
    const results = observations.toolResults ?? []
    for (const name of acpTools) {
        const toolResult = results.find((item) => item.name === name)
        record(
            `scripted ACP tool ${name} returned a completed result`,
            toolResult?.status === "completed",
            `got ${toolResult?.status ?? "missing"}`,
        )
    }
    const state = await verifyState(sessionID, 1)
    record(
        "compression block contains the scripted installed summary",
        stateBlocks(state).some((block) => String(block.summary).includes("installed ACP context")),
    )

    for (const command of ["acp", "dcp"]) {
        await request(
            "POST",
            `/api/session/${encodeURIComponent(sessionID)}/command`,
            { command, text: `/${command} ACP_E2E_COMMAND_SENTINEL` },
            [204],
        )
    }
    const inbox = await sessionInbox(sessionID)
    const notices = inbox.filter((item) => {
        const value = asRecord(item)
        const payload = asRecord(value.payload)
        return (
            value.type === "synthetic" &&
            (asRecord(value.metadata).acpOwned === true || payload.metadata?.acpOwned === true)
        )
    })
    record(
        "/acp and /dcp synthetic output is visible",
        notices.length >= 2,
        `got ${notices.length}`,
    )
    record(
        "synthetic output has ACP notice text",
        notices.some((item) => {
            const value = asRecord(item)
            const payload = asRecord(value.payload)
            const text = String(payload.text ?? value.text ?? "")
            return text.includes("[ACP]") || text.includes("ACP Context Analysis")
        }),
    )

    const final = await promptAndObserve(
        sessionID,
        "After command output, answer briefly without repeating command arguments.",
    )
    record(
        "command sentinel does not reach a later model request",
        final.observation.commandSentinelLeakage === false,
    )
    record(
        "ACP-owned notice does not reach a later model request",
        final.observation.acpOwnedNoticePresent === false,
    )
    assertAcpCatalog(final.observation, true)

    writeJSON(baselineFile, {
        blockCount: countBlocks(state),
        projection: projectAcpState(state),
        blockSummaryFingerprints: projectAcpState(state).prune.messages.blocksById.map(
            (block: any) => ({
                blockId: block.blockId,
                summary: block.summary,
            }),
        ),
        compressedMessageCount: Object.keys(
            asRecord(asRecord(state.prune).messages).byMessageId ?? {},
        ).length,
    })
}

async function stageToggleDisabled(): Promise<void> {
    const sessionID = readSession()
    await health()
    await waitForCommands(false)
    const result = await promptAndObserve(sessionID, "Repeated proxy reload with ACP disabled.")
    record(
        "repeated reload uses /bili/ route",
        result.observation.requestPath?.includes("/bili/") === true,
    )
    assertAcpCatalog(result.observation, false)
}

async function stageToggleRestored(): Promise<void> {
    const sessionID = readSession()
    await health()
    const listed = await waitForCommands(true)
    const names = commandNames(listed)
    record("repeated reload leaves one ACP command", countNamed(names, "acp") === 1)
    record("repeated reload leaves one DCP command", countNamed(names, "dcp") === 1)
    const result = await promptAndObserve(sessionID, "Repeated catalog reload with ACP restored.")
    assertAcpCatalog(result.observation, true)
}

async function stagePostRestart(): Promise<void> {
    const sessionID = readSession()
    await health()
    await inventory(true)
    const state = await verifyState(sessionID, 1)
    const baseline = asRecord(readJSON(baselineFile))
    record(
        "compression block count survives V2 server restart",
        countBlocks(state) === baseline.blockCount,
    )
    const currentProjection = projectAcpState(state)
    const currentSummaryFingerprints = currentProjection.prune.messages.blocksById.map(
        (block: any) => ({ blockId: block.blockId, summary: block.summary }),
    )
    record(
        "compression summary survives V2 server restart",
        stableSerialize(currentSummaryFingerprints) ===
            stableSerialize(baseline.blockSummaryFingerprints),
    )
    const listed = await waitForCommands(true)
    const names = commandNames(listed)
    record("post-restart ACP command has no duplicate", countNamed(names, "acp") === 1)
    record("post-restart DCP command has no duplicate", countNamed(names, "dcp") === 1)
    const result = await promptAndObserve(
        sessionID,
        "Verify persisted ACP state after the owned server restart.",
    )
    assertAcpCatalog(result.observation, true)
    record(
        "post-restart request reaches direct fake route",
        result.observation.requestPath?.endsWith("/v1/chat/completions") === true,
    )
}

async function stageNudgeGrowth(): Promise<void> {
    await health()
    await inventory(true)
    const sessionID = await createSession()

    const baseline = await promptAndObserve(
        sessionID,
        "Establish the initial installed-artifact nudge baseline before context growth.",
    )
    record(
        "private fixed V2 system fixture reaches the nudge fake-provider request",
        baseline.observation.fixedSystemFixturePresent === true,
    )
    record("nudge cycle initial request has no nudge", baseline.observation.nudgeDetected === false)
    const baselineState = await waitForState(
        sessionID,
        "initial nudge baseline",
        (state) =>
            countBlocks(state) === 0 &&
            state.nudges?.lastPerMessageNudgeTokens !== undefined &&
            state.nudges?.lastNudgeShownTokens === undefined,
    )
    const initialBaseline = baselineState.nudges.lastPerMessageNudgeTokens
    const checkpoints: JsonRecord[] = []
    const capture = (name: string, observation: RequestObservation, extra: JsonRecord = {}) => {
        const snapshot = snapshotNudgeCheckpoint(name, sessionID, observation, extra)
        checkpoints.push(snapshot)
        return snapshot
    }

    capture("initial-baseline", baseline.observation)

    // With preserveRecentMessages=10, these turns cross the growth floor while
    // every candidate is still protected.  No compress call is emitted; the
    // persisted baseline must remain byte-for-byte the initial numeric value.
    let previousInputTokens = baseline.observation.inputTokens
    for (let index = 1; index <= 4; index++) {
        const growth = await promptAndObserve(
            sessionID,
            `PROTECTED_NO_TARGET_PHASE ${index}: grow context while every candidate remains protected.`,
        )
        record(
            `protected no-target turn ${index} has no nudge text`,
            growth.nudgeObserved === false,
        )
        record(
            `protected no-target turn ${index} grows actual input`,
            growth.observation.inputTokens > previousInputTokens,
            `got ${growth.observation.inputTokens} after ${previousInputTokens}`,
        )
        previousInputTokens = growth.observation.inputTokens
        const state = await waitForState(
            sessionID,
            `protected no-target state ${index}`,
            (value) => value.nudges?.lastPerMessageNudgeTokens !== undefined,
        )
        record(
            `protected no-target turn ${index} preserves the exact baseline`,
            state.nudges.lastPerMessageNudgeTokens === initialBaseline &&
                state.nudges.lastNudgeShownTokens === undefined,
            `baseline ${String(state.nudges.lastPerMessageNudgeTokens)}`,
        )
        capture(`protected-no-target-${index}`, growth.observation, {
            phase: "protected-no-target",
            protectedEvidence: {
                configuredPreserveRecentMessages: 10,
                blockedRefCount: growth.observation.blockedRefCount ?? 0,
                protectedRefCount: growth.observation.protectedRefCount ?? 0,
                compressibleRefCount: growth.observation.compressibleRefCount ?? 0,
                messageRefCount: growth.observation.messageRefCount ?? 0,
                blockRefCount: growth.observation.blockRefCount ?? 0,
                candidateOrRangeText: growth.observation.candidateOrRangeText === true,
                withinConfiguredWindow:
                    (growth.observation.messageRefCount ?? 0) > 0 &&
                    (growth.observation.messageRefCount ?? 0) <= 10,
                complete:
                    (((growth.observation.blockedRefCount ?? 0) >= 10 &&
                        (growth.observation.compressibleRefCount ?? 0) === 0) ||
                        ((growth.observation.messageRefCount ?? 0) > 0 &&
                            (growth.observation.messageRefCount ?? 0) <= 10)) &&
                    growth.observation.candidateOrRangeText !== true,
            },
            preToolCheckpoint: {
                hostStateObservable: false,
                providerNudgeObserved: false,
            },
        })
    }
    const protectedEvidence = checkpoints.filter((item) => item.phase === "protected-no-target")
    record(
        "protected no-target phase stays within the configured provider-visible ref window",
        protectedEvidence.some(
            (item) =>
                item.protectedEvidence?.complete === true &&
                item.protectedEvidence?.withinConfiguredWindow === true,
        ),
    )

    const findPostCompressionObservation = (
        result: Awaited<ReturnType<typeof promptAndObserve>>,
        nudge: RequestObservation,
    ) => {
        const index = result.newObservations.indexOf(nudge)
        return (
            result.newObservations
                .slice(index + 1)
                .find((item) =>
                    item.toolResultStatuses?.some((tool) => tool.name === "compress"),
                ) ?? result.newObservations.at(-1)
        )
    }

    let firstNudge: Awaited<ReturnType<typeof promptAndObserve>> | undefined
    for (let index = 1; index <= 14; index++) {
        const growth = await promptAndObserve(
            sessionID,
            `ELIGIBLE_GROWTH_PHASE ${index}: add completed context until a real nudge is actionable.`,
        )
        if (growth.nudgeObserved) {
            firstNudge = growth
            break
        }
        record(`eligible growth turn ${index} remains pre-nudge`, growth.nudgeObserved === false)
        const state = await waitForState(
            sessionID,
            `eligible growth state ${index}`,
            (value) => value.nudges?.lastPerMessageNudgeTokens !== undefined,
        )
        record(
            `eligible growth turn ${index} preserves the protected baseline`,
            state.nudges.lastPerMessageNudgeTokens === initialBaseline,
        )
        previousInputTokens = growth.observation.inputTokens
    }
    if (!firstNudge?.nudgeObservation)
        throw new Error("first actionable nudge was not observed in bounded growth")
    const firstNudgeObservation = firstNudge.nudgeObservation
    const firstPostObservation = findPostCompressionObservation(firstNudge, firstNudgeObservation)
    if (!firstPostObservation) throw new Error("first nudge produced no post-tool observation")
    record("first ACP nudge is observed by detectNudge", true)
    record(
        "first nudge carries an actual system-token observation",
        typeof firstNudgeObservation.nudgeSystemTokens === "number",
    )
    record(
        "first nudge has a real compress result observation",
        firstPostObservation.toolResultStatuses?.some((tool) => tool.name === "compress") === true,
    )
    const firstCompressed = await waitForState(
        sessionID,
        "first nudge compression commit",
        (state) => countBlocks(state) === 1,
    )
    const firstPostCompressionBaseline = firstCompressed.nudges?.lastPerMessageNudgeTokens
    const firstTransition = {
        baseline: initialBaseline,
        preCompressTokens: firstNudgeObservation.inputTokens,
        // OpenCode's persisted baseline is the authoritative post-tool token
        // observation. The fake provider's prompt_tokens intentionally excludes
        // host tool/schema accounting, so it is not substituted here.
        postCompressTokens: firstPostCompressionBaseline,
        postBaselineSource: "persisted-acp-state",
    }
    record(
        "first compression clears the pending shown-nudge snapshot",
        firstCompressed.nudges?.lastNudgeShownTokens === undefined,
    )
    capture("first-nudge-observed", firstNudgeObservation, {
        emittedCompressCount: (firstNudge.observations.emittedTools ?? []).filter(
            (name) => name === "compress",
        ).length,
        preToolCheckpoint: {
            hostStateObservable: false,
            providerNudgeObserved: firstNudgeObservation.nudgeDetected === true,
            observedSystemTokens: firstNudgeObservation.nudgeSystemTokens ?? null,
        },
    })
    capture("post-first-compression", firstPostObservation, {
        transition: firstTransition,
        emittedCompressCount: (firstNudge.observations.emittedTools ?? []).filter(
            (name) => name === "compress",
        ).length,
    })

    previousInputTokens = firstPostObservation.inputTokens
    let secondNudge: Awaited<ReturnType<typeof promptAndObserve>> | undefined
    for (let index = 1; index <= 20; index++) {
        const growth = await promptAndObserve(
            sessionID,
            `SECOND_ELIGIBLE_GROWTH_PHASE ${index}: grow after the first exact baseline transition.`,
        )
        if (growth.nudgeObserved) {
            secondNudge = growth
            break
        }
        record(
            `post-first growth turn ${index} remains pre-second-nudge`,
            growth.nudgeObserved === false,
        )
        record(
            `post-first growth turn ${index} increases actual input`,
            growth.observation.inputTokens > previousInputTokens,
            `got ${growth.observation.inputTokens} after ${previousInputTokens}`,
        )
        previousInputTokens = growth.observation.inputTokens
        const state = await waitForState(
            sessionID,
            `post-first growth state ${index}`,
            (value) => value.nudges?.lastPerMessageNudgeTokens !== undefined,
        )
        record(
            `post-first growth turn ${index} preserves its exact new baseline`,
            state.nudges.lastPerMessageNudgeTokens === firstPostCompressionBaseline &&
                state.nudges.lastNudgeShownTokens === undefined,
        )
    }
    if (!secondNudge?.nudgeObservation)
        throw new Error("second actionable nudge was not observed in bounded growth")
    const secondNudgeObservation = secondNudge.nudgeObservation
    const secondPostObservation = findPostCompressionObservation(
        secondNudge,
        secondNudgeObservation,
    )
    if (!secondPostObservation) throw new Error("second nudge produced no post-tool observation")
    const secondCompressed = await waitForState(
        sessionID,
        "second nudge compression commit",
        (state) => countBlocks(state) === 2,
    )
    const secondPostCompressionBaseline = secondCompressed.nudges?.lastPerMessageNudgeTokens
    const secondTransition = {
        baseline: firstPostCompressionBaseline,
        preCompressTokens: secondNudgeObservation.inputTokens,
        postCompressTokens: secondPostCompressionBaseline,
        postBaselineSource: "persisted-acp-state",
    }
    record("second ACP nudge is observed by detectNudge", true)
    record(
        "second compression clears the pending shown-nudge snapshot",
        secondCompressed.nudges?.lastNudgeShownTokens === undefined,
    )
    const emittedCompresses = (secondNudge.observations.emittedTools ?? []).filter(
        (name) => name === "compress",
    ).length
    record(
        "exactly two nudge-triggered compress emissions occurred",
        emittedCompresses === 2,
        `got ${emittedCompresses}`,
    )
    capture("second-nudge-observed", secondNudgeObservation, {
        emittedCompressCount: emittedCompresses,
        preToolCheckpoint: {
            hostStateObservable: false,
            providerNudgeObserved: secondNudgeObservation.nudgeDetected === true,
            observedSystemTokens: secondNudgeObservation.nudgeSystemTokens ?? null,
        },
    })
    capture("post-second-compression", secondPostObservation, {
        transition: secondTransition,
        emittedCompressCount: emittedCompresses,
    })

    // Capture the complete diagnostic sequence before asserting fixed goldens.
    // A mismatch still fails the stage; these observations never become its
    // expectations dynamically. This permits one bounded calibration run.
    const observedBaselines = {
        initial: initialBaseline,
        first: firstPostCompressionBaseline,
        second: secondPostCompressionBaseline,
    }
    writeJSON(`${root}/v2/nudge-baselines.json`, observedBaselines)
    console.log(`  Observed nudge baselines: ${JSON.stringify(observedBaselines)}`)
    record(
        "initial persisted per-message baseline matches the pinned fixture",
        initialBaseline === EXPECTED_NUDGE_BASELINES.initial,
        `expected ${EXPECTED_NUDGE_BASELINES.initial} got ${String(initialBaseline)}`,
    )
    record(
        "first compression persists the exact pinned baseline",
        firstPostCompressionBaseline === EXPECTED_NUDGE_BASELINES.first,
        `expected ${EXPECTED_NUDGE_BASELINES.first} got ${String(firstPostCompressionBaseline)}`,
    )
    record(
        "second compression persists the exact pinned baseline",
        secondPostCompressionBaseline === EXPECTED_NUDGE_BASELINES.second,
        `expected ${EXPECTED_NUDGE_BASELINES.second} got ${String(secondPostCompressionBaseline)}`,
    )

    assertNudgeCheckpointSequence(checkpoints, {
        expectedCompressEmissions: 2,
        expectedBaselines: EXPECTED_NUDGE_BASELINES,
    })
    record("nudge checkpoint verifier accepts the exact historical branch sequence", true)
    record(
        "nudge cycle ends with exactly two resulting blocks",
        countBlocks(secondCompressed) === 2,
    )
    const fixtureRequests = realRequests(readObservations())
    record(
        "private fixed V2 system fixture remains present throughout the nudge stage",
        fixtureRequests.length > 0 &&
            fixtureRequests.every((request) => request.fixedSystemFixturePresent === true),
    )
}

function reliabilityEvidence(observation: RequestObservation): ReliabilityObservation {
    if (!observation.reliability)
        throw new Error("fake provider did not record V2 reliability evidence for a model request")
    return observation.reliability
}

async function stageReliability(): Promise<void> {
    await health()
    await inventory(true)
    const sessionID = await createSession()

    await promptAndObserve(
        sessionID,
        "Establish the stable V2 reliability task before the older assistant record is compressed.",
    )
    const shell = await promptAndObserve(
        sessionID,
        "Run the deterministic V2 shell-output probe before compression.",
    )
    const shellResult = (shell.observations.toolResults ?? []).find((item) => item.name === "shell")
    record(
        "V2 shell probe completed rather than being treated as a successful tool error",
        shellResult?.status === "completed",
        `got ${shellResult?.status ?? "missing"}`,
    )
    record(
        "V2 shell result carries stdout and its native exit-status text",
        shell.newObservations.some(
            (observation) => reliabilityEvidence(observation).shellStdoutAndExitStatusPresent,
        ),
    )
    record(
        "ACP IDs the no-prose opaque shell call without inventing application prose",
        shell.newObservations.some((observation) => {
            const evidence = reliabilityEvidence(observation)
            return (
                evidence.shellToolCallHasNoProse && evidence.shellToolCallHasAcpIdBeforeOpaqueCall
            )
        }),
    )

    const older = await promptAndObserve(
        sessionID,
        "Add another completed older record so the reliability compression has more than one removable source.",
    )
    const shellContinuation = shell.newObservations.find((observation) =>
        observation.toolResultStatuses?.some((tool) => tool.name === "shell"),
    )
    record(
        "completed shell continuation does not consume the next scripted fixture turn",
        shellContinuation?.turn !== undefined && shellContinuation.turn === older.observation.turn,
        `shell continuation=${String(shellContinuation?.turn)} next prompt=${String(older.observation.turn)}`,
    )
    await promptAndObserve(
        sessionID,
        "V2_RELIABILITY_PROTECTED_RECENT_SENTINEL: this recent user intent must remain on the wire after compression.",
    )
    const compression = await promptAndObserve(
        sessionID,
        "Trigger the deterministic reliability compression now.",
    )
    const postCompression = compression.newObservations.find((observation) =>
        observation.toolResultStatuses?.some((tool) => tool.name === "compress"),
    )
    if (!postCompression)
        throw new Error("valid reliability compression produced no immediate next model request")
    const compressResult = postCompression.toolResultStatuses?.find(
        (tool) => tool.name === "compress",
    )
    record(
        "reliability compression returns a completed result, not a fake successful error",
        compressResult?.status === "completed",
        `got ${compressResult?.status ?? "missing"}`,
    )
    const state = await waitForState(
        sessionID,
        "reliability compression block",
        (value) => countBlocks(value) === 1,
    )
    record(
        "reliability block preserves the expected summary sentinel",
        stateBlocks(state).some((block) =>
            String(block.summary).includes("V2_RELIABILITY_COMPRESSION_SUMMARY_SENTINEL"),
        ),
    )

    const evidence = reliabilityEvidence(postCompression)
    record(
        "V2 context transform accepts the post-compression multipart projection",
        evidence.compressionSummaryPresent && postCompression.summaryMarkerPresent === true,
    )
    record(
        "targeted original content is absent from the immediate next model request",
        evidence.targetedOriginalPresent === false,
    )
    record(
        "expected compression summary is present in the immediate next model request",
        evidence.compressionSummaryPresent === true,
    )
    record(
        "preserved recent user content remains in the immediate next model request",
        evidence.protectedRecentPresent === true,
    )
    record(
        "unselected opaque V2 shell stdout and exit-status content remain in the immediate next model request",
        evidence.shellStdoutAndExitStatusPresent === true,
    )
}

async function stagePermission(): Promise<void> {
    const permission = process.env.E2E_PERMISSION
    if (permission !== "allow" && permission !== "deny" && permission !== "ask") {
        throw new Error("E2E_PERMISSION must be allow, deny, or ask")
    }
    await health()
    await inventory(true)
    const sessionID = await createSession()
    const warmup = await promptAndObserve(
        sessionID,
        `Permission ${permission} installed-artifact probe.`,
    )
    const beforeState = await verifyState(sessionID, 0)
    const beforePersisted = readPersistedState(sessionID)
    const beforeProtected = protectedPermissionView(beforeState)
    const beforePersistedProtected = persistedPermissionView(beforePersisted)
    const beforeToolParameters = permissionToolObservationView(warmup.observations)
    writeJSON(`${root}/v2/permission-${permission}-before.json`, {
        runtimeProjection: beforeProtected,
        persistedProjection: beforePersistedProtected,
        toolParameterObservations: beforeToolParameters,
    })

    // The first request establishes a durable user/assistant pair. The second
    // request lets the allow case allocate a real range while ask still fails
    // before that range can mutate state.
    const result = await promptAndObserve(
        sessionID,
        `Permission ${permission} execute the scripted check now.`,
    )
    const observations = result.observations
    const counts = emittedCounts(observations)
    const afterState = await waitForState(
        sessionID,
        `permission ${permission} state persistence`,
        (state) =>
            permission === "allow"
                ? countBlocks(state) >= 1
                : comparePermissionProjections(beforeState, state).toolOwned.equal,
    )
    const afterPersisted = readPersistedState(sessionID)
    const afterProtected = protectedPermissionView(afterState)
    const afterPersistedProtected = persistedPermissionView(afterPersisted)
    const afterToolParameters = permissionToolObservationView(observations)
    const runtimeComparison = comparePermissionProjections(beforeState, afterState)
    const persistedComparison = comparePermissionProjections(beforePersisted, afterPersisted)
    writeJSON(`${root}/v2/permission-${permission}-after.json`, {
        runtimeProjection: afterProtected,
        persistedProjection: afterPersistedProtected,
        comparison: {
            runtime: runtimeComparison,
            persisted: persistedComparison,
            separation:
                "message/ref/model/current-turn changes are host context; prune, nudge, stats, timing, cache, and request flags are ACP tool-owned",
        },
        toolParameterObservations: afterToolParameters,
    })

    if (permission === "deny") {
        assertAcpCatalog(result.observation, false)
        record(
            "deny emits no ACP tools",
            (observations.emittedTools ?? []).filter((name) => acpTools.includes(name)).length ===
                0,
        )
        const names = commandNames(await commands())
        record("deny removes ACP commands", !names.some((name) => name === "acp" || name === "dcp"))
        record(
            "deny leaves ACP prune, stats, and tool-parameter state unchanged",
            runtimeComparison.toolOwned.equal && runtimeComparison.unknownFields.equal,
        )
        record(
            "deny separates legitimate host context/ref changes",
            runtimeComparison.hostContext.changedFields.every((field: string) =>
                [
                    "sessionId",
                    "isSubAgent",
                    "compressPermission",
                    "messageIds",
                    "lastCompaction",
                    "currentTurn",
                    "modelContextLimit",
                    "modelProviderID",
                    "modelID",
                    "systemPromptTokens",
                    "storageDir",
                    "lastUpdated",
                    "sessionName",
                    "nudges",
                    "unknownFields",
                ].includes(field),
            ),
        )
        record(
            "deny persists only legitimate context/ref updates",
            persistedComparison.toolOwned.equal && persistedComparison.unknownFields.equal,
        )
        record(
            "deny records no ACP tool parameters",
            afterToolParameters.filter((item: any) => item.name && acpTools.includes(item.name))
                .length === 0,
        )
        return
    }

    assertAcpCatalog(result.observation, true)
    record(
        "permission allow/ask emits one compress call",
        counts.get("compress") === 1,
        `got ${counts.get("compress") ?? 0}`,
    )
    if (permission === "ask") {
        const toolResult = (observations.toolResults ?? []).find((item) => item.name === "compress")
        record(
            "permission ask returns a fail-closed tool result",
            toolResult?.status === "error",
            `got ${toolResult?.status ?? "missing"}`,
        )
        record("permission ask result is actionable", toolResult?.actionable === true)
        record("permission ask leaves no compression block", countBlocks(afterState) === 0)
        record(
            "permission ask does not mutate ACP prune, stats, or tool-parameter state",
            runtimeComparison.toolOwned.equal && runtimeComparison.unknownFields.equal,
        )
        record(
            "permission ask separates legitimate host context/ref changes",
            runtimeComparison.hostContext.changedFields.every((field: string) =>
                [
                    "sessionId",
                    "isSubAgent",
                    "compressPermission",
                    "messageIds",
                    "lastCompaction",
                    "currentTurn",
                    "modelContextLimit",
                    "modelProviderID",
                    "modelID",
                    "systemPromptTokens",
                    "storageDir",
                    "lastUpdated",
                    "sessionName",
                    "nudges",
                    "unknownFields",
                ].includes(field),
            ),
        )
        record(
            "permission ask persists no unauthorized compression mutation",
            persistedComparison.toolOwned.equal && persistedComparison.unknownFields.equal,
        )
        record(
            "permission ask tool parameter observation is redacted and actionable",
            afterToolParameters.every(
                (item: any) =>
                    !Object.prototype.hasOwnProperty.call(item, "arguments") &&
                    !Object.prototype.hasOwnProperty.call(item, "id") &&
                    Array.isArray(item.argumentKeys),
            ) && afterToolParameters.some((item: any) => item.name === "compress"),
        )
        const names = commandNames(await commands())
        record(
            "permission ask keeps direct ACP commands advertised",
            countNamed(names, "acp") === 1 && countNamed(names, "dcp") === 1,
        )
    } else {
        record(
            "permission allow returns a completed compression result",
            (observations.toolResults ?? []).some(
                (item) => item.name === "compress" && item.status === "completed",
            ),
        )
        record("permission allow allocates a compression block", countBlocks(afterState) === 1)
        record(
            "permission allow persists the expected compression mutation",
            comparePermissionProjections(beforePersisted, afterPersisted).toolOwned.equal === false,
        )
    }
}

async function run(): Promise<void> {
    if (!stage)
        throw new Error(
            "Usage: installed-v2.ts <activate|main|proxy-disabled|reenabled|toggle-disabled|toggle-restored|post-restart|nudge-growth|reliability|permission>",
        )
    if (stage === "activate") {
        const info = await inventory(false, false)
        const active = asRecord(asRecord(info).state).status === "active"
        if (!info || !active) {
            writeJSON(`${root}/v2/activation.json`, { active: false })
            process.exitCode = 10
            return
        }
        console.log("  PASS initial V2 plugin activation settled")
        return
    }
    if (stage === "main") await stageMain()
    else if (stage === "proxy-disabled") await stageProxyDisabled()
    else if (stage === "reenabled") await stageReenabled()
    else if (stage === "toggle-disabled") await stageToggleDisabled()
    else if (stage === "toggle-restored") await stageToggleRestored()
    else if (stage === "post-restart") await stagePostRestart()
    else if (stage === "nudge-growth") await stageNudgeGrowth()
    else if (stage === "reliability") await stageReliability()
    else if (stage === "permission") await stagePermission()
    else throw new Error(`unknown installed V2 stage ${stage}`)
    console.log(`  PASS ${stage} stage completed (${assertions} assertions)`)
}

run().catch((error) => {
    console.error(
        `FAIL installed V2 ${stage ?? "driver"}: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
})
