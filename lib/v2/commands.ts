import type { Plugin as V2Api } from "@opencode/plugin"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { PluginConfig } from "../config"
import { dispatchAcpCommand } from "../commands"
import { syncCompressPermissionState } from "../compress-permission"
import type { HostPermissionSnapshot } from "../host-permissions"
import type { Logger } from "../logger"
import { sendIgnoredMessage } from "../ui/notification"
import type { SessionState, SessionStateRegistry, WithParts } from "../state"
import type { V2HostAdapter } from "./host"
import type { V2OperationTracker } from "./lifecycle"
import type { NoticeSink } from "../host"
import {
    cloneSessionState,
    cloneRuntimeValue,
    commitSessionState,
    DeferredMutationEffects,
} from "../state/transaction"
import { saveSessionState } from "../state/persistence"

type V2Context = Parameters<V2Api.Plugin["setup"]>[0]
export type V2CommandEditor = Parameters<Parameters<V2Context["command"]["transform"]>[0]>[0]

function argumentsForCommand(text: string, name: string): string {
    const trimmed = text.trim()
    for (const prefix of [`/${name}`, name]) {
        if (trimmed.toLowerCase() === prefix) return ""
        if (trimmed.toLowerCase().startsWith(`${prefix} `)) {
            return trimmed.slice(prefix.length).trim()
        }
    }
    return trimmed
}

async function runCommandTransaction(
    state: SessionState,
    messages: WithParts[],
    input: CommandInvocation,
    name: string,
    host: V2HostAdapter,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    workingDirectory: string,
    isActive: () => boolean,
    effects: DeferredMutationEffects,
): Promise<void> {
    if (!isActive()) return

    const workingState = cloneSessionState(state)
    const workingMessages = cloneRuntimeValue(messages) as WithParts[]
    const notices: NoticeSink = {
        send(notice) {
            effects.defer(async () => {
                if (!isActive()) return
                await host.notices.send(notice)
            })
            return Promise.resolve()
        },
    }

    syncCompressPermissionState(workingState, config, hostPermissions, workingMessages)
    if (!isActive()) return

    await dispatchAcpCommand(
        {
            notices,
            state: workingState,
            config,
            logger,
            sessionId: input.sessionID,
            messages: workingMessages,
            workingDirectory,
            defer: (effect) => effects.defer(effect),
            isActive,
        },
        argumentsForCommand(input.prompt.text, name),
    )

    if (!isActive()) return
    commitSessionState(state, workingState)
    if (!isActive()) return
    if (effects.persistenceRequested) {
        if (!isActive()) return
        await saveSessionState(state, logger)
    }
    if (!isActive()) return
    await effects.run(isActive)
}

async function executeCommand(
    input: CommandInvocation,
    name: string,
    host: V2HostAdapter,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    workingDirectory: string,
    isEnabled: () => boolean,
    operations?: V2OperationTracker,
    isActive: () => boolean = () => true,
): Promise<void> {
    if (operations) {
        await operations.run("command", (lease) =>
            executeCommand(
                input,
                name,
                host,
                registry,
                logger,
                config,
                hostPermissions,
                workingDirectory,
                isEnabled,
                undefined,
                lease.isActive,
            ),
        )
        return
    }
    if (!isEnabled() || !config.commands.enabled) return
    if (!isActive()) return
    try {
        if (config.allowSubAgents === false) {
            const session = await host.sessions.get(input.sessionID)
            if (!session || (session.parentID !== undefined && session.parentID !== null)) {
                throw new Error(
                    "ACP commands are disabled for child sessions when `allowSubAgents` is false.",
                )
            }
        }
        if (!isActive()) return
        let agent: string | undefined
        try {
            agent = host.sessionAgent ? await host.sessionAgent(input.sessionID) : undefined
        } catch (error) {
            logger.warn("V2 command session agent lookup failed", {
                sessionId: input.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
        if (agent && host.agentPermissions) {
            try {
                const rules = await host.agentPermissions(agent)
                if (!isActive()) return
                hostPermissions.v2Agents = {
                    ...(hostPermissions.v2Agents ?? {}),
                    [agent]: rules,
                }
            } catch (error) {
                if (!isActive()) return
                logger.warn("V2 command agent permission lookup failed closed", {
                    sessionId: input.sessionID,
                    agent,
                    error: error instanceof Error ? error.message : String(error),
                })
                hostPermissions.v2Agents = {
                    ...(hostPermissions.v2Agents ?? {}),
                    [agent]: [{ action: "*", resource: "*", effect: "deny" }],
                }
            }
        }
        if (!isActive()) return
        const effects = new DeferredMutationEffects()
        const run = async (guardedState: SessionState, messages: WithParts[]) =>
            runCommandTransaction(
                guardedState,
                messages,
                input,
                name,
                host,
                logger,
                config,
                hostPermissions,
                workingDirectory,
                isActive,
                effects,
            )
        if (registry.withSessionMutationAndInitialize) {
            await registry.withSessionMutationAndInitialize(
                host.sessions,
                input.sessionID,
                () => host.sessions.messages(input.sessionID),
                (history) => history,
                config,
                run,
                { effects, isActive },
            )
        } else {
            const messages = await host.sessions.messages(input.sessionID)
            if (!isActive()) return
            const state = await registry.getOrCreate(
                host.sessions,
                input.sessionID,
                messages,
                config,
            )
            if (registry.withSessionMutation) {
                await registry.withSessionMutation(input.sessionID, (guardedState) =>
                    run(guardedState, messages),
                )
            } else await run(state, messages)
        }
    } catch (error) {
        logger.warn("V2 ACP command failed", {
            command: name,
            sessionId: input.sessionID,
            error: error instanceof Error ? error.message : String(error),
        })
        if (!isActive()) return
        await sendIgnoredMessage(
            host.notices,
            input.sessionID,
            `[ACP] /${name} failed: ${error instanceof Error ? error.message : String(error)}`,
            {},
            logger,
        )
    }
}

/** Add both command aliases to one replayable V2 command transform. */
export function createV2CommandTransform(
    host: V2HostAdapter,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    workingDirectory: string,
    isEnabled: () => boolean = () => true,
    operations?: V2OperationTracker,
): (editor: V2CommandEditor) => void {
    return (editor) => {
        if (!isEnabled() || !config.commands.enabled || config.compress.permission === "deny")
            return
        for (const name of ["acp", "dcp"] as const) {
            const definition: CommandDefinition = {
                name,
                description: "Show available ACP commands",
                execute: (input) =>
                    executeCommand(
                        input,
                        name,
                        host,
                        registry,
                        logger,
                        config,
                        hostPermissions,
                        workingDirectory,
                        isEnabled,
                        operations,
                    ),
            }
            editor.add(definition)
        }
    }
}
