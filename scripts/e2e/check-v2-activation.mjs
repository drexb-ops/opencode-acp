#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { classifyV2FallbackAttempt } from "./verification-guards.mjs"

const [statusArg, activationPath, ...logPaths] = process.argv.slice(2)
if (!statusArg || !activationPath || logPaths.length === 0) {
    process.stderr.write(
        "Usage: check-v2-activation.mjs <status> <activation-json> <fresh-log> [...fresh-log]\n",
    )
    process.exit(2)
}

let activation
try {
    activation = JSON.parse(readFileSync(activationPath, "utf8"))
} catch {
    process.stderr.write("activation observation is missing or invalid\n")
    process.exit(1)
}

const freshLogs = logPaths.map((file) => {
    if (!existsSync(file)) return []
    try {
        return readFileSync(file, "utf8").split(/\r?\n/)
    } catch {
        return []
    }
})
const lines = freshLogs.flat()
const result = classifyV2FallbackAttempt({
    status: Number(statusArg),
    inventoryActive: activation.active === true,
    freshLines: lines,
})
const sourceIndex = freshLogs.findIndex((items) =>
    items.some((line) => line.includes("configured plugin path must be a directory")),
)
const output = {
    accepted: result.accepted,
    statusMatches: result.statusMatches,
    inventoryInactive: result.inventoryInactive,
    exactDiagnosticMatched: result.exactDiagnosticMatched,
    freshLineCount: result.freshLineCount,
    exactLineCount: result.exactLineCount,
    unexpectedDiagnostics: result.unexpectedDiagnostics,
    sourceIndex,
}
process.stdout.write(`${JSON.stringify(output)}\n`)
if (!result.accepted) process.exitCode = 1
