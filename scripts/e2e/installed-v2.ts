#!/usr/bin/env node

/**
 * HTTP driver and assertions for the OpenCode 2.0.3 installed-artifact E2E.
 *
 * The driver intentionally uses only the public HTTP API. Response bodies are
 * parsed for assertions but are never included in failure diagnostics.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

type JsonRecord = Record<string, any>

interface ToolResultObservation {
    id?: string
    name?: string
    status: "completed" | "error"
    actionable?: boolean
}

interface RequestObservation {
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
    calledToolNames?: string[]
    toolResultStatuses?: ToolResultObservation[]
}

interface Observations {
    requests: RequestObservation[]
    emittedTools?: string[]
    toolResults?: ToolResultObservation[]
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

async function inventory(strict: boolean): Promise<JsonRecord | undefined> {
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
    const fallbackMarker = process.env.E2E_WRAPPER_DIR
        ? source.type === "local" &&
          String(source.path ?? "").startsWith(process.env.E2E_WRAPPER_DIR)
        : false
    if (!info) {
        writeJSON(`${root}/v2/activation.json`, { active: false, sourceType: source.type ?? null })
        return undefined
    }
    record("installed ACP plugin is active", active, `status ${String(pluginState.status)}`)
    record("installed ACP plugin has stable id", info.id === "opencode-acp")
    record("ACP server feature is present", asRecord(info.features).server === true)
    record("ACP TUI feature is present", asRecord(info.features).tui === true)
    record("ACP RPC feature is present", asRecord(info.features).rpc === true)
    if (strict) {
        record(
            "ACP source target is the packed file URL or documented wrapper fallback",
            sourceMatches || sourceLocalMatches || fallbackMarker,
            `source ${String(source.type)} ${String(source.target ?? source.path ?? "")}`,
        )
    }
    writeJSON(`${root}/v2/activation.json`, {
        active,
        id: info.id,
        sourceType: source.type ?? null,
        sourceTarget: source.target ?? source.path ?? null,
        sourceMatchesPackedURL: sourceMatches,
        wrapperFallback: fallbackMarker,
        features: info.features ?? {},
        state: info.state ?? {},
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
): Promise<{ observations: Observations; observation: RequestObservation }> {
    const before = realRequests(readObservations()).length
    await prompt(sessionID, text)
    const observations = await waitFor(
        "fake provider observation",
        async () => readObservations(),
        (value) => realRequests(value).length > before,
    )
    return { observations, observation: latestReal(observations, before) }
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
        summaries: stateBlocks(state).map((block) => block.summary),
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
    const summaries = stateBlocks(state).map((block) => String(block.summary))
    record(
        "compression summary survives V2 server restart",
        summaries.some((summary) => (baseline.summaries ?? []).includes(summary)),
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

async function stagePermission(): Promise<void> {
    const permission = process.env.E2E_PERMISSION
    if (permission !== "allow" && permission !== "deny" && permission !== "ask") {
        throw new Error("E2E_PERMISSION must be allow, deny, or ask")
    }
    await health()
    await inventory(true)
    const sessionID = await createSession()
    let result = await promptAndObserve(
        sessionID,
        `Permission ${permission} installed-artifact probe.`,
    )
    // The first request establishes a durable user/assistant pair. The second
    // request lets the allow case allocate a real range while ask still fails
    // before that range can mutate state.
    result = await promptAndObserve(
        sessionID,
        `Permission ${permission} execute the scripted check now.`,
    )
    const observations = result.observations
    const counts = emittedCounts(observations)
    if (permission === "deny") {
        assertAcpCatalog(result.observation, false)
        record(
            "deny emits no ACP tools",
            (observations.emittedTools ?? []).filter((name) => acpTools.includes(name)).length ===
                0,
        )
        const names = commandNames(await commands())
        record("deny removes ACP commands", !names.some((name) => name === "acp" || name === "dcp"))
        await verifyState(sessionID, 0)
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
        record(
            "permission ask leaves no compression block",
            countBlocks(await verifyState(sessionID)) === 0,
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
        await verifyState(sessionID, 1)
    }
}

async function run(): Promise<void> {
    if (!stage)
        throw new Error(
            "Usage: installed-v2.ts <activate|main|proxy-disabled|reenabled|toggle-disabled|toggle-restored|post-restart|permission>",
        )
    if (stage === "activate") {
        const info = await inventory(false)
        if (!info) {
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
