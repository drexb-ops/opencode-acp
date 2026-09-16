import type { Plugin as V2Api } from "@opencode/plugin"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { PluginConfig } from "../config"
import { dispatchAcpCommand } from "../commands"
import { syncCompressPermissionState } from "../compress-permission"
import type { HostPermissionSnapshot } from "../host-permissions"
import type { Logger } from "../logger"
import { sendIgnoredMessage } from "../ui/notification"
import type { SessionStateRegistry } from "../state"
import type { V2HostAdapter } from "./host"

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
): Promise<void> {
    if (!isEnabled() || !config.commands.enabled) return
    try {
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
                hostPermissions.v2Agents = {
                    ...(hostPermissions.v2Agents ?? {}),
                    [agent]: rules,
                }
            } catch (error) {
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
        const messages = await host.sessions.messages(input.sessionID)
        const state = await registry.getOrCreate(host.sessions, input.sessionID, messages, config)
        const run = async (guardedState: typeof state) => {
            syncCompressPermissionState(guardedState, config, hostPermissions, messages)
            await dispatchAcpCommand(
                {
                    notices: host.notices,
                    state: guardedState,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    workingDirectory,
                },
                argumentsForCommand(input.prompt.text, name),
            )
        }
        if (registry.withSessionMutation) await registry.withSessionMutation(input.sessionID, run)
        else await run(state)
    } catch (error) {
        logger.warn("V2 ACP command failed", {
            command: name,
            sessionId: input.sessionID,
            error: error instanceof Error ? error.message : String(error),
        })
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
                    ),
            }
            editor.add(definition)
        }
    }
}
