#!/usr/bin/env node

/**
 * Small dependency-free writer used by the installed-artifact E2E harness.
 * Configuration is written through a sibling temporary file so a running V2
 * server observes either the old or new document, never a partial JSON file.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"

const [
    mode,
    outputPath,
    pluginTarget,
    baseURL,
    acpPermission,
    storagePath,
    workspace,
    hostPermission,
] = process.argv.slice(2)

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

if (mode === "wrapper") {
    const [wrapperDir, packageDir] = [outputPath, pluginTarget]
    if (!wrapperDir || !packageDir) {
        process.stderr.write(
            "Usage: installed-config.mjs wrapper <directory> <installed-package-directory>\n",
        )
        process.exit(2)
    }
    mkdirSync(wrapperDir, { recursive: true })
    writeAtomic(`${wrapperDir}/package.json`, {
        name: "opencode-acp-installed-e2e-wrapper",
        version: "1.0.0",
        private: true,
    })
    const packageURL = pathToFileURL(`${packageDir.replace(/\/$/, "")}/`)
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
    writeAtomic(outputPath, {
        $schema: "https://opencode.ai/config.json",
        update: "disable",
        share: "disabled",
        compaction: { auto: false },
        plugins: [{ package: pluginTarget }],
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
    writeAtomic(outputPath, {
        autoUpdate: false,
        storagePath,
        compress: {
            permission: acpPermission ?? "allow",
            minCompressRange: 0,
            maxSummaryLengthHard: 20000,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            maxContextLimit: 20000,
            minContextLimit: 10000,
            nudgeGrowthTokens: 6000,
        },
        qualityGate: { enabled: true, algorithm: "rouge-recall-v1" },
    })
    process.exit(0)
}

process.stderr.write(`Unknown configuration mode: ${mode}\n`)
process.exit(2)
