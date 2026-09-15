import type { PluginConfig } from "../config"
import type { HostServices } from "../host"
import { createLegacyHostServices } from "../host/legacy"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type { CompressionBlock, CompressionMode, SessionState, WithParts } from "../state"
import type { z } from "zod"

export interface ToolContext {
    /** Host-neutral services; V1/V2 adapters own concrete client access. */
    host: HostServices
    sessions: HostServices["sessions"]
    models: HostServices["models"]
    notices: HostServices["notices"]
    notifications: HostServices["notifications"]
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export interface ToolFactoryContext {
    /** Preferred host-neutral service bundle. */
    host?: HostServices
    /** Legacy structural client accepted only by V1 compatibility factories. */
    client?: unknown
    registry: ToolStateRegistry
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

/** The only registry operation needed while resolving a tool call. */
export interface ToolStateRegistry {
    get(sessionID: string): SessionState | undefined
}

export interface ToolAskInput {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
}

export interface ToolExecutionContext {
    sessionID: string
    messageID?: string
    callID?: string
    agent?: string
    directory?: string
    abort?: AbortSignal
    permission?: "allow" | "ask" | "deny"
    ask(input: ToolAskInput): Promise<void>
    metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
    progress?(input: { title?: string; status?: string }): Promise<void> | void
}

export type SharedToolResult =
    | string
    | {
          title?: string
          output: string
          metadata?: Record<string, unknown>
          attachments?: Array<{
              type: "file"
              mime: string
              url: string
              filename?: string
          }>
      }

export type AnyToolSchema = z.ZodObject<z.ZodRawShape>

/** A host-neutral model tool definition shared by both runtime adapters. */
export interface SharedToolDefinition<Schema extends AnyToolSchema = AnyToolSchema> {
    name: string
    description: string
    schema: Schema
    /** Alias used by hosts that call the field `inputSchema`. */
    inputSchema: Schema
    execute(input: z.infer<Schema>, context: ToolExecutionContext): Promise<SharedToolResult>
}

/** Resolve a factory's host without exposing a V1 client to shared execution. */
export function resolveFactoryHost(factoryCtx: ToolFactoryContext): HostServices {
    return factoryCtx.host ?? createLegacyHostServices(factoryCtx.client)
}

export function resolveToolHost(ctx: ToolContext): HostServices {
    const legacyClient = (ctx as ToolContext & { client?: unknown }).client
    return ctx.host ?? createLegacyHostServices(legacyClient)
}

// [FIX #33] Resolve the caller's per-session state at tool-call time and build a
// ToolContext bound to it. A compress tool can only run after messages.transform
// initialized the session, so the state is guaranteed present.
export function resolveToolContext(factoryCtx: ToolFactoryContext, sessionID: string): ToolContext {
    const host = resolveFactoryHost(factoryCtx)
    const state = factoryCtx.registry.get(sessionID)
    if (!state) {
        throw new Error(
            `ACP: session ${sessionID} has no initialized state. ` +
                "messages.transform must run before a compress tool call.",
        )
    }
    return {
        host,
        sessions: host.sessions,
        models: host.models,
        notices: host.notices,
        notifications: host.notifications,
        state,
        logger: factoryCtx.logger,
        config: factoryCtx.config,
        prompts: factoryCtx.prompts,
    }
}

export interface CompressRangeEntry {
    /** Per-entry topic for batch compression. Falls back to top-level `topic`. */
    topic?: string
    startId: string
    endId: string
    summary: string
}

export interface CompressRangeToolArgs {
    /** Fallback topic for entries without their own. Optional if every entry has one. */
    topic?: string
    content: CompressRangeEntry[]
    summaryMaxChars?: number
    dangerous?: boolean
    acknowledgeRisk?: boolean
}

export interface CompressMessageEntry {
    messageId: string
    topic: string
    summary: string
}

export interface CompressMessageToolArgs {
    topic: string
    content: CompressMessageEntry[]
    summaryMaxChars?: number
    dangerous?: boolean
    acknowledgeRisk?: boolean
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
    summaryByBlockId: Map<number, CompressionBlock>
    /**
     * [Issue #384] Request-scoped boundary lookup (mNNNNN/bN → BoundaryReference),
     * built once per SearchContext instead of once per boundary pair. Optional so
     * hand-built contexts (tests) keep working; resolveBoundaryIds memoizes it lazily.
     */
    boundaryLookup?: Map<string, BoundaryReference>
    /** Active blocks grouped by their raw anchor message for range selection. */
    summariesByAnchorMessageId?: Map<string, CompressionBlock[]>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface ResolvedMessageCompression {
    entry: CompressMessageEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedRangeCompression {
    index: number
    entry: CompressRangeEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedMessageCompressionsResult {
    plans: ResolvedMessageCompression[]
    skippedIssues: string[]
    skippedCount: number
}

export interface ParsedBlockPlaceholder {
    raw: string
    blockId: number
    startIndex: number
    endIndex: number
}

export interface InjectedSummaryResult {
    expandedSummary: string
    consumedBlockIds: number[]
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string | undefined
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}
