import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import {
    getDefaultStorageDir,
    loadAllSessionStats,
    loadSessionState,
    resolveStorageDir,
    saveSessionState,
} from "../lib/state/persistence"
import { createSessionState, ensureSessionInitialized } from "../lib/state"

const logger = new Logger(false)

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "info",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        experimental: {
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: false,
            maxContextLimit: "80%",
            minContextLimit: "80%",
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            nudgeGrowthTokens: 50000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5000,
            preserveLastUserMessage: true,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5.0,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.2,
                },
            },
        },
        messageFilters: {
            enabled: true,
            filters: {},
        },
        ...overrides,
    }
}

function makeCustomDir(): string {
    return mkdtempSync(join(tmpdir(), "acp-storage-test-"))
}

function makeSpyLogger(warnings: string[]): Logger {
    return {
        info: () => {},
        warn: (msg: string) => {
            warnings.push(msg)
        },
        error: () => {},
        debug: () => {},
    } as unknown as Logger
}

test("resolveStorageDir: unset/empty falls back to the default XDG location", () => {
    assert.equal(resolveStorageDir(undefined, "/some/project"), getDefaultStorageDir())
    assert.equal(resolveStorageDir("", "/some/project"), getDefaultStorageDir())
    assert.equal(resolveStorageDir("   ", "/some/project"), getDefaultStorageDir())
})

test("resolveStorageDir: absolute paths are used as-is", () => {
    const abs = join(tmpdir(), "acp-custom-abs")
    assert.equal(resolveStorageDir(abs, "/some/project"), abs)
})

test("resolveStorageDir: ~ and ~/... expand against the home directory", () => {
    assert.equal(resolveStorageDir("~", "/some/project"), homedir())
    assert.equal(resolveStorageDir("~/acp-data", "/some/project"), join(homedir(), "acp-data"))
})

test("resolveStorageDir: relative paths resolve against the project directory", () => {
    assert.equal(resolveStorageDir("data/acp", "/some/project"), "/some/project/data/acp")
    assert.equal(resolveStorageDir("acp", "/some/project"), "/some/project/acp")
})

test("saveSessionState writes to the configured storageDir, not the default", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        state.sessionId = "sp-save-custom"
        state.storageDir = customDir
        state.stats.totalPruneTokens = 123

        await saveSessionState(state, logger)

        assert.ok(
            existsSync(join(customDir, "sp-save-custom.json")),
            "file should be in custom dir",
        )
        assert.ok(
            !existsSync(join(getDefaultStorageDir(), "sp-save-custom.json")),
            "file should NOT be in default dir",
        )
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("loadSessionState reads from the configured storageDir", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        state.sessionId = "sp-load-custom"
        state.storageDir = customDir
        state.stats.totalPruneTokens = 456
        await saveSessionState(state, logger)

        const loaded = await loadSessionState("sp-load-custom", logger, customDir)
        assert.ok(loaded, "should load from custom dir")
        assert.equal(loaded!.stats.totalPruneTokens, 456)

        // Without the storageDir argument the default location is probed → null
        assert.equal(await loadSessionState("sp-load-custom", logger), null)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("save/load without storagePath still use the default location (regression)", async () => {
    const state = createSessionState()
    state.sessionId = "sp-default-loc"
    state.stats.totalPruneTokens = 789

    await saveSessionState(state, logger)

    const filePath = join(getDefaultStorageDir(), "sp-default-loc.json")
    assert.ok(existsSync(filePath), "file should be in default dir")
    const loaded = await loadSessionState("sp-default-loc", logger)
    assert.ok(loaded, "should load from default dir")
    assert.equal(loaded!.stats.totalPruneTokens, 789)
    await fs.unlink(filePath)
})

test("loadAllSessionStats aggregates from the configured storageDir", async () => {
    const customDir = makeCustomDir()
    try {
        for (const id of ["sp-stats-a", "sp-stats-b"]) {
            const state = createSessionState()
            state.sessionId = id
            state.storageDir = customDir
            state.stats.totalPruneTokens = 100
            await saveSessionState(state, logger)
        }

        const stats = await loadAllSessionStats(logger, customDir)
        assert.equal(stats.sessionCount, 2)
        assert.equal(stats.totalTokens, 200)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized resolves storageDir from config.storagePath", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        const config = buildConfig({ storagePath: customDir })

        await ensureSessionInitialized(
            null,
            state,
            "sp-init-resolve",
            logger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, customDir)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized resolves relative storagePath against projectDir", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "acp-proj-"))
    try {
        const state = createSessionState()
        const config = buildConfig({ storagePath: "data/acp-state" })

        await ensureSessionInitialized(
            null,
            state,
            "sp-init-relative",
            logger,
            [],
            config,
            projectDir,
        )

        assert.equal(state.storageDir, join(projectDir, "data/acp-state"))
    } finally {
        rmSync(projectDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized warns when state file exists only at the default location", async () => {
    const customDir = makeCustomDir()
    const warnings: string[] = []
    const spyLogger = makeSpyLogger(warnings)
    try {
        // Pre-seed a valid state file at the default location
        const seeded = createSessionState()
        seeded.sessionId = "sp-migrate-warn"
        seeded.stats.totalPruneTokens = 42
        await saveSessionState(seeded, logger)

        const state = createSessionState()
        const config = buildConfig({ storagePath: customDir })
        await ensureSessionInitialized(
            null,
            state,
            "sp-migrate-warn",
            spyLogger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, customDir)
        assert.ok(
            warnings.some((w) => w.includes("storagePath")),
            `expected a storagePath warning, got: ${JSON.stringify(warnings)}`,
        )
    } finally {
        rmSync(customDir, { recursive: true, force: true })
        await fs.unlink(join(getDefaultStorageDir(), "sp-migrate-warn.json")).catch(() => {})
    }
})

test("ensureSessionInitialized does not warn when storagePath is unset", async () => {
    const warnings: string[] = []
    const spyLogger = makeSpyLogger(warnings)
    try {
        const seeded = createSessionState()
        seeded.sessionId = "sp-no-warn"
        seeded.stats.totalPruneTokens = 7
        await saveSessionState(seeded, logger)

        const state = createSessionState()
        const config = buildConfig()
        await ensureSessionInitialized(
            null,
            state,
            "sp-no-warn",
            spyLogger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, undefined)
        assert.ok(
            !warnings.some((w) => w.includes("storagePath")),
            `unexpected storagePath warning: ${JSON.stringify(warnings)}`,
        )
    } finally {
        await fs.unlink(join(getDefaultStorageDir(), "sp-no-warn.json")).catch(() => {})
    }
})
