import assert from "node:assert/strict"
import test from "node:test"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { HostPermissionSnapshot } from "../lib/host-permissions"
import type { PluginConfig } from "../lib/config"
import { createV2Host, type V2Context, type V2HostAdapter } from "../lib/v2/host"
import { createV2CommandTransform, type V2CommandEditor } from "../lib/v2/commands"
import { Logger } from "../lib/logger"
import { SessionStateRegistry, type WithParts } from "../lib/state"

function config(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
            toolOutputNudgeThreshold: 5000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function message(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: "command-session",
            role: "user",
            agent: "code",
            time: { created: 1 },
            model: { providerID: "provider", modelID: "model" },
        } as WithParts["info"],
        parts: [
            { type: "text", id: `${id}-part`, sessionID: "command-session", messageID: id, text },
        ],
    }
}

function commandHost(notices: string[]): V2HostAdapter {
    return {
        sessions: {
            get: async () => ({ id: "command-session", agent: "code" }),
            messages: async () => [message("user-1", "request")],
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async ({ text }) => notices.push(text) },
        notifications: { notify: () => {} },
        projectedContext: async () => [],
        directory: "/tmp/v2-command",
        agentPermissions: async () => [],
    }
}

test("V2 command transform registers acp and dcp aliases once", () => {
    const logger = new Logger(false, "silent")
    const host = commandHost([])
    const registry = new SessionStateRegistry(logger, "/tmp/v2-command")
    const added: CommandDefinition[] = []
    const editor = {
        add: (definition: CommandDefinition) => added.push(definition),
    } as V2CommandEditor
    createV2CommandTransform(
        host,
        registry,
        logger,
        config(),
        { global: undefined, agents: {} } satisfies HostPermissionSnapshot,
        "/tmp/v2-command",
    )(editor)
    assert.deepEqual(
        added.map((definition) => definition.name),
        ["acp", "dcp"],
    )
})

test("both command aliases dispatch raw arguments without a model prompt", async () => {
    const notices: string[] = []
    const host = commandHost(notices)
    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/v2-command")
    const added: CommandDefinition[] = []
    const snapshot: HostPermissionSnapshot = { global: undefined, agents: {} }
    const editor = {
        add: (definition: CommandDefinition) => added.push(definition),
    } as V2CommandEditor
    createV2CommandTransform(host, registry, logger, config(), snapshot, "/tmp/v2-command")(editor)

    for (const name of ["acp", "dcp"]) {
        const definition = added.find((candidate) => candidate.name === name)
        assert.ok(definition)
        await definition.execute({
            sessionID: "command-session",
            prompt: { text: `${name} help` },
            delivery: "steer",
        })
    }

    assert.equal(notices.length, 2)
    assert.match(notices[0] ?? "", /Available commands/)
    assert.match(notices[1] ?? "", /Available commands/)
})

test("V2 default and unknown subcommands use the shared dispatcher", async () => {
    const notices: string[] = []
    const host = commandHost(notices)
    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/v2-command")
    const added: CommandDefinition[] = []
    const editor = {
        add: (definition: CommandDefinition) => added.push(definition),
    } as V2CommandEditor
    createV2CommandTransform(
        host,
        registry,
        logger,
        config(),
        { global: undefined, agents: {} },
        "/tmp/v2-command",
    )(editor)
    const acp = added.find((definition) => definition.name === "acp")!

    await acp.execute({ sessionID: "command-session", prompt: { text: "" }, delivery: "queue" })
    await acp.execute({
        sessionID: "command-session",
        prompt: { text: "unknown" },
        delivery: "queue",
    })
    assert.equal(notices.length, 2)
    assert.match(notices[0] ?? "", /ACP Status|COMPRESSION|COMPRESSED BLOCKS/i)
    assert.match(notices[1] ?? "", /ACP Context Analysis/)
})

test("V2 notices use unique ACP-owned non-resuming synthetic messages", async () => {
    const calls: unknown[] = []
    const context = {
        location: { directory: "/tmp/v2-notices" },
        agent: { get: async () => ({ data: { permissions: [] } }) },
        session: {
            get: async () => ({ id: "s" }),
            context: async () => [],
            synthetic: async (input: unknown) => {
                calls.push(input)
                return {}
            },
        },
    }
    const host = createV2Host(context as unknown as V2Context)
    await host.notices.send({ sessionID: "s", text: "one" })
    await host.notices.send({ sessionID: "s", text: "two" })
    assert.equal(calls.length, 2)
    const first = calls[0] as { id: string; metadata: { acpOwned: boolean }; resume: boolean }
    const second = calls[1] as { id: string; metadata: { acpOwned: boolean }; resume: boolean }
    assert.match(first.id, /^msg_acp_notice_[0-9a-f]{16}$/)
    assert.match(second.id, /^msg_acp_notice_[0-9a-f]{16}$/)
    assert.notEqual(first.id, second.id)
    assert.equal(first.metadata.acpOwned, true)
    assert.equal(second.metadata.acpOwned, true)
    assert.equal(first.resume, false)
    assert.equal(second.resume, false)
})
