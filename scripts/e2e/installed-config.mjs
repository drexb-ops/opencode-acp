#!/usr/bin/env node

/**
 * Small dependency-free writer used by the installed-artifact E2E harness.
 * Configuration is written through a sibling temporary file so a running V2
 * server observes either the old or new document, never a partial JSON file.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    realpathSync,
    writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative } from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const systemFixtureFlag = args.indexOf("--system-fixture")
let systemFixturePluginDir
if (systemFixtureFlag !== -1) {
    systemFixturePluginDir = args[systemFixtureFlag + 1]
    if (
        !systemFixturePluginDir ||
        systemFixturePluginDir.startsWith("-") ||
        args.indexOf("--system-fixture", systemFixtureFlag + 1) !== -1
    ) {
        process.stderr.write("--system-fixture requires one local plugin directory\n")
        process.exit(2)
    }
    args.splice(systemFixtureFlag, 2)
}

const [
    mode,
    outputPath,
    pluginTarget,
    baseURL,
    acpPermission,
    storagePath,
    workspace,
    hostPermission,
    preserveRecentMessagesArg,
    nudgeGrowthTokensArg,
    minNudgeGrowthFloorArg,
    qualityGateEnabledArg,
] = args

if (!mode || !outputPath) {
    process.stderr.write(
        "Usage: installed-config.mjs <v1|v2|acp|wrapper> <output> [plugin] [baseURL] [permission] [storagePath]\n",
    )
    process.exit(2)
}

function writeAtomic(path, value) {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
}

const NUDGE_SYSTEM_FIXTURE_MARKER = "ACP_E2E_FIXED_NUDGE_SYSTEM_FIXTURE"
const NUDGE_SYSTEM_FIXTURE_TEXT =
    `${NUDGE_SYSTEM_FIXTURE_MARKER}: This private installed-E2E instruction ` +
    "replaces host-generated system metadata only for deterministic ACP nudge baseline checks."

if (mode === "system-fixture") {
    if (!isAbsolute(outputPath)) {
        process.stderr.write("System fixture directory must be absolute\n")
        process.exit(2)
    }
    mkdirSync(outputPath, { recursive: true })
    writeAtomic(`${outputPath}/package.json`, {
        name: "acp-e2e-fixed-nudge-system",
        version: "1.0.0",
        private: true,
        type: "module",
    })
    writeFileSync(
        `${outputPath}/server.js`,
        `const text = ${JSON.stringify(NUDGE_SYSTEM_FIXTURE_TEXT)}\n` +
            `export default {\n` +
            `  id: "acp-e2e-fixed-nudge-system",\n` +
            `  setup: async (context) => {\n` +
            `    const registration = await context.session.hook("context", async (event) => {\n` +
            `      const first = event.system[0]\n` +
            `      if (!first) throw new Error("fixed-system fixture received no host system instruction")\n` +
            `      event.system.splice(0, event.system.length, { ...first, text })\n` +
            `    })\n` +
            `    return () => registration.dispose()\n` +
            `  },\n` +
            `}\n`,
        "utf8",
    )
    process.exit(0)
}

if (mode === "wrapper") {
    const [wrapperDir, packageDir, privatePrefix] = [outputPath, pluginTarget, baseURL]
    if (!wrapperDir || !packageDir || !privatePrefix) {
        process.stderr.write(
            "Usage: installed-config.mjs wrapper <directory> <installed-package-directory> <private-prefix>\n",
        )
        process.exit(2)
    }
    if (!existsSync(packageDir) || !existsSync(privatePrefix)) {
        process.stderr.write("Wrapper source package or private prefix is missing\n")
        process.exit(2)
    }
    const resolvedPackageDir = realpathSync(packageDir)
    const resolvedPrefix = realpathSync(privatePrefix)
    const packageRelative = relative(resolvedPrefix, resolvedPackageDir)
    if (packageRelative === "" || packageRelative.startsWith("..") || isAbsolute(packageRelative)) {
        process.stderr.write("Wrapper source package is outside the private plugin prefix\n")
        process.exit(2)
    }
    let packageManifest
    try {
        packageManifest = JSON.parse(readFileSync(`${resolvedPackageDir}/package.json`, "utf8"))
    } catch {
        process.stderr.write("Wrapper source package manifest is unreadable\n")
        process.exit(2)
    }
    if (packageManifest.name !== "opencode-acp") {
        process.stderr.write("Wrapper source package is not opencode-acp\n")
        process.exit(2)
    }
    mkdirSync(wrapperDir, { recursive: true })
    writeAtomic(`${wrapperDir}/package.json`, {
        name: "opencode-acp-installed-e2e-wrapper",
        version: "1.0.0",
        private: true,
    })
    const packageURL = pathToFileURL(`${resolvedPackageDir.replace(/\/$/, "")}/`)
    writeFileSync(
        `${wrapperDir}/server.js`,
        `export { default } from ${JSON.stringify(new URL("dist/index.js", packageURL).href)}\n`,
        "utf8",
    )
    writeFileSync(
        `${wrapperDir}/tui.js`,
        `export { default } from ${JSON.stringify(new URL("dist/tui.js", packageURL).href)}\n`,
        "utf8",
    )
    writeFileSync(
        `${wrapperDir}/rpc.js`,
        `export * from ${JSON.stringify(new URL("dist/rpc.js", packageURL).href)}\n`,
        "utf8",
    )
    process.exit(0)
}

if (mode === "v2") {
    const permission = hostPermission ?? "allow"
    if (systemFixturePluginDir && !isAbsolute(systemFixturePluginDir)) {
        process.stderr.write("System fixture plugin path must be a local absolute directory\n")
        process.exit(2)
    }
    writeAtomic(outputPath, {
        $schema: "https://opencode.ai/config.json",
        update: "disable",
        share: "disabled",
        compaction: { auto: false },
        plugins: [
            ...(systemFixturePluginDir ? [{ package: systemFixturePluginDir }] : []),
            { package: pluginTarget },
        ],
        providers: {
            fake: {
                name: "ACP installed-artifact fake provider",
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL, apiKey: "e2e-dummy" },
                models: {
                    "fake-model": {
                        name: "ACP installed-artifact fake model",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        limit: { context: 100000, output: 4096 },
                    },
                },
            },
        },
        agents: {},
        permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "compress", resource: "*", effect: permission },
        ],
        model: "fake/fake-model",
        default_agent: "build",
    })
    process.exit(0)
}

if (mode === "v1") {
    writeAtomic(outputPath, {
        plugin: [pluginTarget],
        provider: {
            fake: {
                npm: "@ai-sdk/openai-compatible",
                name: "ACP installed-artifact fake provider",
                options: { baseURL, apiKey: "e2e-dummy" },
                models: {
                    "fake-model": {
                        name: "ACP installed-artifact fake model",
                        limit: { context: 100000, output: 4096 },
                    },
                },
            },
        },
        agent: { general: { model: "fake/fake-model", prompt: "You are an ACP E2E assistant." } },
        model: "fake/fake-model",
        permission: { compress: "allow", bash: "allow", task: "allow" },
    })
    process.exit(0)
}

if (mode === "acp") {
    const preserveRecentMessages = Number(preserveRecentMessagesArg ?? 0)
    const nudgeGrowthTokens = Number(nudgeGrowthTokensArg ?? 6000)
    const minNudgeGrowthFloor = Number(minNudgeGrowthFloorArg ?? 5000)
    const qualityGateEnabled = qualityGateEnabledArg !== "false"
    if (
        !Number.isInteger(preserveRecentMessages) ||
        preserveRecentMessages < 0 ||
        !Number.isFinite(nudgeGrowthTokens) ||
        nudgeGrowthTokens <= 0 ||
        !Number.isFinite(minNudgeGrowthFloor) ||
        minNudgeGrowthFloor < 0
    ) {
        process.stderr.write("Invalid nudge/protection configuration\n")
        process.exit(2)
    }
    writeAtomic(outputPath, {
        autoUpdate: false,
        storagePath,
        compress: {
            permission: acpPermission ?? "allow",
            minCompressRange: 0,
            maxSummaryLengthHard: 20000,
            preserveRecentMessages,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            maxContextLimit: 20000,
            minContextLimit: 10000,
            minNudgeContextPercent: 0.01,
            minNudgeGrowthFloor,
            minNudgeGrowthRatio: 0.45,
            nudgeGrowthTokens,
        },
        qualityGate: { enabled: qualityGateEnabled, algorithm: "rouge-recall-v1" },
    })
    process.exit(0)
}

process.stderr.write(`Unknown configuration mode: ${mode}\n`)
process.exit(2)
