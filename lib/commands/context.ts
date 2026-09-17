/**
 * DCP Context Command
 * Shows a visual breakdown of token usage in the current session.
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * We minimize tokenizer estimation by leveraging API-reported values wherever possible.
 *
 * WHAT WE GET FROM THE API (exact):
 *   - tokens.input    : Input tokens for each assistant response
 *   - tokens.output   : Output tokens generated (includes text + tool calls)
 *   - tokens.reasoning: Reasoning tokens used
 *   - tokens.cache    : Cache read/write tokens
 *
 * HOW WE CALCULATE EACH CATEGORY:
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write - tokenizer(firstUserMessage)
 *            The first response's total input (input + cache.read + cache.write)
 *            contains system + first user message. On the first request of a
 *            session, the system prompt appears in cache.write (cache creation),
 *            not cache.read.
 *
 *   TOOLS  = tokenizer(toolInputs + toolOutputs) - prunedTokens
 *            We must tokenize tools anyway for pruning decisions.
 *
 *   USER   = tokenizer(all user messages)
 *            User messages are typically small, so estimation is acceptable.
 *
 *   ASSISTANT = total - system - user - tools
 *               Calculated as residual. This absorbs:
 *               - Assistant text output tokens
 *               - Reasoning tokens (if persisted by the model)
 *               - Any estimation errors
 *
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 *            Matches opencode's UI display.
 *
 * WHY ASSISTANT IS THE RESIDUAL:
 *   If reasoning tokens persist in context (model-dependent), they semantically
 *   belong with "Assistant" since reasoning IS assistant-generated content.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { NoticeSink } from "../host"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { isIgnoredUserMessage } from "../messages/query"
import {
    hasV2NativePrefix,
    isAcpNonRemovableMessage,
    isV2ProjectedMessage,
} from "../messages/opaque"
import { isMessageCompacted } from "../state/utils"
import { countTokens, extractCompletedToolOutput, getCurrentParams } from "../token-utils"
import type { AssistantMessage, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

export interface ContextCommandContext {
    notices: NoticeSink
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

interface TokenBreakdown {
    v2Estimate?: boolean
    overheadKnown?: boolean
    nativePrefixOutsideView?: boolean
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
    total: number
}

function analyzeTokens(state: SessionState, messages: WithParts[]): TokenBreakdown {
    const v2Estimate = messages.some(isV2ProjectedMessage)
    const breakdown: TokenBreakdown = {
        ...(v2Estimate
            ? {
                  v2Estimate: true,
                  overheadKnown: state.systemPromptTokens !== undefined,
                  nativePrefixOutsideView: hasV2NativePrefix(messages),
              }
            : {}),
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens: state.stats.totalPruneTokens,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
    }

    let firstAssistant: AssistantMessage | undefined
    for (const msg of messages) {
        if (msg.info.role === "assistant") {
            const assistantInfo = msg.info as AssistantMessage
            if (
                assistantInfo.tokens?.input > 0 ||
                assistantInfo.tokens?.cache?.read > 0 ||
                assistantInfo.tokens?.cache?.write > 0
            ) {
                firstAssistant = assistantInfo
                break
            }
        }
    }

    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant") {
            const assistantInfo = msg.info as AssistantMessage
            if (assistantInfo.tokens?.output > 0) {
                lastAssistant = assistantInfo
                break
            }
        }
    }

    const apiInput = lastAssistant?.tokens?.input || 0
    const apiOutput = lastAssistant?.tokens?.output || 0
    const apiReasoning = lastAssistant?.tokens?.reasoning || 0
    const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0
    const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0
    breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite

    const userTextParts: string[] = []
    const assistantTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    let firstUserText = ""
    let foundFirstUser = false
    const allToolIds = new Set<string>()
    const activeToolIds = new Set<string>()
    const prunedToolIds = new Set<string>()
    const allMessageIds = new Set<string>()

    for (const msg of messages) {
        allMessageIds.add(msg.info.id)
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        const isMessagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0
        const isCompacted = v2Estimate
            ? isMessagePruned && !isAcpNonRemovableMessage(msg)
            : isMessageCompacted(state, msg)
        const isIgnoredUser = isIgnoredUserMessage(msg)

        for (const part of parts) {
            if (
                v2Estimate &&
                !isCompacted &&
                msg.info.role === "assistant" &&
                (part.type === "text" || part.type === "reasoning")
            ) {
                assistantTextParts.push(part.text)
            }
            if (part.type === "tool") {
                const toolPart = part as ToolPart
                if (toolPart.callID) {
                    allToolIds.add(toolPart.callID)
                    if (!isCompacted) {
                        activeToolIds.add(toolPart.callID)
                    }
                    if (isMessagePruned) {
                        prunedToolIds.add(toolPart.callID)
                    }
                }

                if (!isCompacted) {
                    if (toolPart.state?.input) {
                        const inputStr =
                            typeof toolPart.state.input === "string"
                                ? toolPart.state.input
                                : JSON.stringify(toolPart.state.input)
                        toolInputParts.push(inputStr)
                    }

                    const outputStr = extractCompletedToolOutput(toolPart)
                    if (outputStr !== undefined) {
                        toolOutputParts.push(outputStr)
                    }
                }
            } else if (
                part.type === "text" &&
                msg.info.role === "user" &&
                !isCompacted &&
                !isIgnoredUser
            ) {
                const textPart = part as TextPart
                const text = textPart.text || ""
                userTextParts.push(text)
                if (!foundFirstUser) {
                    firstUserText += text
                }
            }
        }

        if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    const toolsInContextCount = [...activeToolIds].filter((id) => !prunedToolIds.has(id)).length

    let prunedMessageCount = 0
    for (const [id, entry] of state.prune.messages.byMessageId) {
        if (allMessageIds.has(id) && entry.activeBlockIds.length > 0) {
            prunedMessageCount++
        }
    }

    breakdown.toolCount = allToolIds.size
    breakdown.toolsInContextCount = toolsInContextCount
    breakdown.prunedToolCount = prunedToolIds.size
    breakdown.prunedMessageCount = prunedMessageCount

    const firstUserTokens = countTokens(firstUserText)
    breakdown.user = countTokens(userTextParts.join("\n"))
    const toolInputTokens = countTokens(toolInputParts.join("\n"))
    const toolOutputTokens = countTokens(toolOutputParts.join("\n"))

    if (v2Estimate) {
        breakdown.system = state.systemPromptTokens ?? 0
    } else if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) +
            (firstAssistant.tokens?.cache?.read || 0) +
            (firstAssistant.tokens?.cache?.write || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    breakdown.assistant = v2Estimate
        ? countTokens(assistantTextParts.join("\n"))
        : Math.max(0, breakdown.total - breakdown.system - breakdown.user - breakdown.tools)
    if (v2Estimate) {
        breakdown.total = breakdown.system + breakdown.user + breakdown.assistant + breakdown.tools
    }

    return breakdown
}

function createBar(value: number, maxValue: number, width: number, char: string = "█"): string {
    if (maxValue === 0) return ""
    const filled = Math.round((value / maxValue) * width)
    const bar = char.repeat(Math.max(0, filled))
    return bar
}

function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30

    const toolsLabel = `Tools (${breakdown.toolsInContextCount})`

    const categories = [
        { label: "System", value: breakdown.system, char: "█" },
        { label: "User", value: breakdown.user, char: "▓" },
        { label: "Assistant", value: breakdown.assistant, char: "▒" },
        { label: toolsLabel, value: breakdown.tools, char: "░" },
    ] as const

    const maxLabelLen = Math.max(...categories.map((c) => c.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                  ACP Context Analysis                     │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session Context Breakdown:")
    if (breakdown.v2Estimate) {
        lines.push("Projected context estimate; system includes cached tool-schema overhead.")
        if (breakdown.nativePrefixOutsideView)
            lines.push(
                "Partial history: the native checkpoint prefix is preserved but is outside this breakdown.",
            )
        if (!breakdown.overheadKnown)
            lines.push("System/tool overhead unavailable until an accepted V2 context request.")
    }
    lines.push("─".repeat(60))
    lines.push("")

    for (const cat of categories) {
        const bar = createBar(cat.value, breakdown.total, barWidth, cat.char)
        const percentage =
            breakdown.total > 0 ? ((cat.value / breakdown.total) * 100).toFixed(1) : "0.0"
        const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
        const valueStr = formatTokenCount(cat.value).padStart(13)
        lines.push(`${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`)
    }

    lines.push("")
    lines.push("─".repeat(60))
    lines.push("")

    lines.push("Summary:")

    if (breakdown.v2Estimate) {
        lines.push(`  Projected context: ~${formatTokenCount(breakdown.total)}`)
        if (breakdown.prunedTokens > 0) {
            lines.push(
                `  Recorded historical compression: ~${formatTokenCount(breakdown.prunedTokens)} (not current wire savings)`,
            )
        }
    } else if (breakdown.prunedTokens > 0) {
        const withoutPruning = breakdown.total + breakdown.prunedTokens
        const pruned = []
        if (breakdown.prunedToolCount > 0) pruned.push(`${breakdown.prunedToolCount} tools`)
        if (breakdown.prunedMessageCount > 0)
            pruned.push(`${breakdown.prunedMessageCount} messages`)
        lines.push(
            `  Pruned:          ${pruned.join(", ")} (~${formatTokenCount(breakdown.prunedTokens)})`,
        )
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
        lines.push(`  Without ACP:     ~${formatTokenCount(withoutPruning)}`)
    } else {
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
    }

    lines.push("")

    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { state, logger, sessionId, messages } = ctx

    const breakdown = analyzeTokens(state, messages)

    const message = formatContextMessage(breakdown)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(ctx.notices, sessionId, message, params, logger)
}
