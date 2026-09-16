#!/usr/bin/env node

/**
 * Import every public export from a privately installed ACP package.
 *
 * The probe is deliberately written and executed inside the private npm
 * prefix. Its bare-specifier imports therefore cannot resolve the repository's
 * workspace node_modules or source tree.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import {
    assertMinimalProbeEnv,
    buildMinimalProbeEnv,
    captureOwnedDirectory,
} from "./verification-guards.mjs"

const [prefixArg, packageDirArg] = process.argv.slice(2)
if (!prefixArg || !packageDirArg) {
    process.stderr.write("Usage: verify-installed-package.mjs <private-prefix> <package-dir>\n")
    process.exit(2)
}

function fail(message) {
    throw new Error(message)
}

function isStrictDescendant(parent, candidate) {
    const relative = path.relative(parent, candidate)
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const prefixIdentity = captureOwnedDirectory(prefixArg, { label: "private plugin prefix" })
const prefix = prefixIdentity.realPath
const packageIdentity = captureOwnedDirectory(packageDirArg, {
    label: "installed package directory",
    parent: prefix,
    prefix: "opencode-acp",
})
const packageDir = packageIdentity.realPath
if (!isStrictDescendant(prefix, packageDir)) {
    fail("installed package directory is not inside the private plugin prefix")
}

let manifest
try {
    manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"))
} catch {
    fail("installed package manifest could not be read")
}
if (manifest.name !== "opencode-acp") fail("private installed package has the wrong name")

const probePath = path.join(prefix, `.acp-export-probe-${process.pid}.mjs`)
const probeSource = `
import { fileURLToPath } from "node:url"
import path from "node:path"
import root from "opencode-acp"
import server from "opencode-acp/server"
import tui from "opencode-acp/tui"
import * as rpc from "opencode-acp/rpc"

const expectedPrefix = ${JSON.stringify(prefix)}
const expectedPackage = ${JSON.stringify(packageDir)}
const rootResolved = fileURLToPath(import.meta.resolve("opencode-acp"))
const resolvedPackage = path.dirname(path.dirname(rootResolved))
const relative = path.relative(expectedPrefix, resolvedPackage)
if (
    relative === "" ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    resolvedPackage !== expectedPackage
) {
    throw new Error("bare package import resolved outside the expected private package directory")
}
if (!root || typeof root !== "object" || root.id !== "opencode-acp") {
    throw new Error("installed root export has no opencode-acp definition")
}
if (typeof root.setup !== "function" || typeof root.server !== "function") {
    throw new Error("installed root export is missing setup() or server()")
}
if (server !== root) throw new Error("installed ./server export is not the dual root definition")
if (!tui || tui.id !== "opencode-acp-tui" || typeof tui.setup !== "function") {
    throw new Error("installed ./tui export has the wrong definition shape")
}
if (
    rpc.AcpRpc?.id !== "opencode-acp" ||
    !rpc.AcpRpc?.events?.notification?.schema ||
    !Array.isArray(rpc.AcpRpc.events.notification.schema.required) ||
    !["title", "message", "variant"].every((field) =>
        rpc.AcpRpc.events.notification.schema.required.includes(field),
    )
) {
    throw new Error("installed ./rpc export has the wrong notification schema")
}
`

try {
    writeFileSync(probePath, probeSource, "utf8")
    const probeHome = path.join(prefix, "probe-home")
    const probeTmp = path.join(prefix, "probe-tmp")
    mkdirSync(probeHome, { recursive: true })
    mkdirSync(probeTmp, { recursive: true })
    const probeEnv = buildMinimalProbeEnv({ home: probeHome, tmpdir: probeTmp, npm: false })
    assertMinimalProbeEnv(probeEnv, false)
    execFileSync(process.execPath, [probePath], {
        cwd: prefix,
        env: probeEnv,
        stdio: ["ignore", "pipe", "pipe"],
    })
} catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "unknown probe error"
    fail(`installed package export probe failed: ${detail}`)
} finally {
    rmSync(probePath, { force: true })
}

console.log(`installed package exports verified from ${packageDir}`)
