import { handleContextCommand } from "./context"
import { handleExportCommand } from "./export"
import { handleStatsCommand } from "./stats"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { NoticeSink } from "../host"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"

export interface AcpCommandContext {
    notices: NoticeSink
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    workingDirectory: string
}

export function buildAcpHelpText(): string {
    return [
        "[ACP] Available commands:",
        "",
        "  /acp              Show compression status (same as /acp stats)",
        "  /acp context      Token usage breakdown (system, user, assistant, tools)",
        "  /acp stats        Compression status: blocks, context usage, ranges",
        "  /acp export       Export active compression blocks to markdown",
        "                   Options: --output <path>, --tier t1,t2,t3, --stdout, --append",
        "  /acp help         Show this help",
        "",
        "Also accepts /dcp for backward compatibility.",
    ].join("\n")
}

/** Dispatch command arguments without deciding how the host aborts execution. */
export async function dispatchAcpCommand(ctx: AcpCommandContext, rawArguments: string) {
    const argumentsText = rawArguments ?? ""
    const sub = argumentsText.trim().toLowerCase()
    if (sub === "stats" || sub === "status" || sub === "") {
        await handleStatsCommand(ctx)
        return
    }

    if (sub === "export" || sub.startsWith("export ")) {
        const exportArgs = argumentsText.trim().slice("export".length).trim()
        await handleExportCommand(ctx, exportArgs)
        return
    }

    if (sub === "help") {
        await sendIgnoredMessage(ctx.notices, ctx.sessionId, buildAcpHelpText(), {}, ctx.logger)
        return
    }

    await handleContextCommand(ctx)
}
