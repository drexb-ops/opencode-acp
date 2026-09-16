#!/usr/bin/env node

/** Assertions for the exact OpenCode 1.18.29 installed-artifact smoke run. */

import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const statePath = required("E2E_STATE_FILE")
const pluginEntry = required("E2E_PLUGIN_ENTRY")
const observationsPath = required("E2E_OBSERVATIONS")
const runOutput = required("E2E_RUN_OUTPUT")
let assertions = 0

function required(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`missing required environment variable ${name}`)
    return value
}

function check(name: string, condition: boolean, detail?: string): void {
    assertions++
    if (!condition) throw new Error(`${name}${detail ? ` (${detail})` : ""}`)
    console.log(`  PASS ${name}`)
}

function json(path: string): any {
    return JSON.parse(readFileSync(path, "utf8"))
}

async function run(): Promise<void> {
    check("V1 ACP state file exists", existsSync(statePath), statePath)
    const state = json(statePath)
    const blocks = state?.prune?.messages?.blocksById ?? {}
    check("V1 scripted compression creates exactly one ACP block", Object.keys(blocks).length === 1)

    const module = await import(pathToFileURL(pluginEntry).href)
    const plugin = module.default
    check("packed V1 entrypoint exports opencode-acp id", plugin?.id === "opencode-acp")
    check("packed dual entrypoint exposes V1 server function", typeof plugin?.server === "function")

    const output = readFileSync(runOutput, "utf8")
    check("V1 one-shot output contains the fake response", output.includes("Compressed"))

    const observations = json(observationsPath)
    const requests = Array.isArray(observations?.requests) ? observations.requests : []
    const emitted = Array.isArray(observations?.emittedTools) ? observations.emittedTools : []
    check("V1 fake provider recorded requests", requests.length > 0)
    check(
        "V1 fake provider saw one scripted compression emission",
        emitted.filter((name: unknown) => name === "compress").length === 1,
    )
    check(
        "V1 fake provider used the direct local route",
        requests.some((item: any) => item?.requestPath?.endsWith("/v1/chat/completions")),
    )
    console.log(`  PASS installed V1 artifact checks completed (${assertions} assertions)`)
}

run().catch((error) => {
    console.error(`FAIL installed V1: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
