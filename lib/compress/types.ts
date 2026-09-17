import type { PluginConfig } from "../config"
import type { HostServices } from "../host"
import { createLegacyHostServices } from "../host/legacy"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type {
    CompressionBlock,
    CompressionMode,
    SessionMutationOptions,
    SessionState,
    WithParts,
} from "../state"
import {
    cloneSessionState,
    commitSessionState,
    DeferredMutationEffects,
} from "../state/transaction"
import { saveSessionState } from "../state/persistence"
import { filterMessages } from "../messages/shape"
import type { PendingCompressionDuration } from "./timing"
import { QualityGateRejectionError } from "./quality-gate/rejection"
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
    /** V2-only speculative effects, committed after the working state is accepted. */
    effects?: DeferredMutationEffects
    /** V2 lifecycle authorization checked before state/effect commits. */
    isActive?: () => boolean
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
    /** Real registries serialize the complete tool execution per session. */
    withSessionMutation?<T>(
        sessionID: string,
        operation: (state: SessionState) => Promise<T> | T,
    ): Promise<T>
    /**
     * V2 direct tools must reserve, hydrate, and execute as one transaction.
     * Optional so lightweight and V1-compatible registry fixtures retain their
     * historical interface.
     */
    withSessionMutationAndInitialize?<T>(
        sessions: HostServices["sessions"],
        sessionID: string,
        loadHistory: () => WithParts[] | Promise<WithParts[]>,
        historyToMessages: (history: WithParts[]) => WithParts[] | undefined,
        config: PluginConfig | undefined,
        operation: (state: SessionState, history: WithParts[]) => Promise<T> | T,
        options?: SessionMutationOptions<T>,
    ): Promise<T | undefined>
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
    /** V2 lifecycle fence. V1 leaves this undefined to preserve direct behavior. */
    isActive?: () => boolean
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

interface ToolTransaction {
    effects: DeferredMutationEffects
    isActive: () => boolean
    /** A V2 reservation's fixed, filtered history for its target session. */
    reservedHistory?: WithParts[]
}

function withReservedSessionHistory(
    host: HostServices,
    sessionID: string,
    reservedHistory: WithParts[] | undefined,
): HostServices {
    if (!reservedHistory) return host

    // Scope the snapshot to one ToolContext.  Other sessions and parent-history
    // reads stay delegated to the real host; no process-wide cache is involved.
    return {
        ...host,
        sessions: {
            get: (requestedSessionID) => host.sessions.get(requestedSessionID),
            messages: (requestedSessionID) =>
                requestedSessionID === sessionID
                    ? Promise.resolve(reservedHistory)
                    : host.sessions.messages(requestedSessionID),
            parentMessages: (requestedSessionID) =>
                host.sessions.parentMessages(requestedSessionID),
        },
    }
}

// [FIX #33] Resolve the caller's per-session state at tool-call time and build a
// ToolContext bound to it. A compress tool can only run after messages.transform
// initialized the session, so the state is guaranteed present.
export function resolveToolContext(
    factoryCtx: ToolFactoryContext,
    sessionID: string,
    stateOverride?: SessionState,
    transaction?: ToolTransaction,
): ToolContext {
    const host = withReservedSessionHistory(
        resolveFactoryHost(factoryCtx),
        sessionID,
        transaction?.reservedHistory,
    )
    const state = stateOverride ?? factoryCtx.registry.get(sessionID)
    if (!state) {
        throw new Error(
            `ACP: session ${sessionID} has no initialized state. ` +
                "messages.transform must run before a compress tool call.",
        )
    }
    const notices = transaction
        ? {
              send: async (input: Parameters<HostServices["notices"]["send"]>[0]) => {
                  if (!transaction.isActive()) return
                  await host.notices.send(input)
              },
          }
        : host.notices
    const notifications = transaction
        ? {
              notify: (input: Parameters<HostServices["notifications"]["notify"]>[0]) => {
                  if (!transaction.isActive()) return
                  return host.notifications.notify(input)
              },
          }
        : host.notifications
    return {
        host,
        sessions: host.sessions,
        models: host.models,
        notices,
        notifications,
        state,
        logger: factoryCtx.logger,
        config: factoryCtx.config,
        prompts: factoryCtx.prompts,
        effects: transaction?.effects,
        isActive: transaction?.isActive,
    }
}

/**
 * Run one complete tool execution under the registry's session guard.
 *
 * The fallback keeps small isolated unit-test registries source-compatible;
 * production registries always provide withSessionMutation and therefore wait
 * for initialization before resolving a state.
 */
export async function withToolSessionMutation<T>(
    factoryCtx: ToolFactoryContext,
    toolCtx: ToolExecutionContext,
    operation: (ctx: ToolContext) => Promise<T> | T,
): Promise<T> {
    const active = toolCtx.isActive
    type TimingSnapshot = {
        pending: Map<
            string,
            { entry: PendingCompressionDuration; snapshot: PendingCompressionDuration }
        >
        starts: Map<string, number>
    }
    type V2MutationAttempt = {
        result: T
        working: SessionState
        effects: DeferredMutationEffects
        timing: TimingSnapshot
        accepted: boolean
    }

    const runV2Attempt = async (
        state: SessionState,
        inheritedEffects?: DeferredMutationEffects,
        reservedHistory?: WithParts[],
    ): Promise<V2MutationAttempt> => {
        if (!active || !active()) throw new Error("ACP tool operation is no longer active")

        const working = cloneSessionState(state)
        const timing: TimingSnapshot = {
            pending: new Map(
                [...state.compressionTiming.pendingByCallId].map(([key, entry]) => [
                    key,
                    { entry, snapshot: { ...entry } },
                ]),
            ),
            starts: new Map(state.compressionTiming.startsByCallId),
        }
        const effects = inheritedEffects ?? new DeferredMutationEffects()
        const context = resolveToolContext(factoryCtx, toolCtx.sessionID, working, {
            effects,
            isActive: active,
            reservedHistory,
        })
        try {
            const result = await operation(context)
            const accepted = active()
            if (!accepted) restoreSharedTiming(state, timing.pending, timing.starts)
            return { result, working, effects, timing, accepted }
        } catch (error) {
            restoreSharedTiming(state, timing.pending, timing.starts)
            throw error
        }
    }

    const flushAcceptedV2Attempt = async (
        state: SessionState,
        attempt: V2MutationAttempt,
    ): Promise<void> => {
        if (!active || !active()) return
        if (attempt.effects.persistenceRequested) {
            if (!active()) return
            await saveSessionState(state, factoryCtx.logger)
        }
        if (!active()) return
        await attempt.effects.run(active)
    }

    const run = async (state: SessionState): Promise<T> => {
        // V1 does not provide a lifecycle fence. Keep its historical live-state
        // behavior and avoid introducing a transaction boundary into that path.
        if (!active) return operation(resolveToolContext(factoryCtx, toolCtx.sessionID, state))
        try {
            const attempt = await runV2Attempt(state)
            if (!attempt.accepted) return attempt.result

            commitSessionState(state, attempt.working)
            await flushAcceptedV2Attempt(state, attempt)
            return attempt.result
        } catch (error) {
            // A quality rejection is deliberately retryable.  Keep only its
            // retry marker on the live V2 state; all other working-state,
            // timing, persistence, and host effects stay speculative.  V1 has
            // no lifecycle fence and therefore retains its historical behavior.
            if (error instanceof QualityGateRejectionError && active()) {
                state.qualityGateRetryPending = true
            }
            throw error
        }
    }

    if (active && factoryCtx.registry.withSessionMutationAndInitialize) {
        const host = resolveFactoryHost(factoryCtx)
        // Initialization can request persistence when it restores persisted
        // state. Share one deferred collector with the tool operation so even
        // that write waits for the operation's accepted commit.
        const effects = new DeferredMutationEffects()
        const attempt = await factoryCtx.registry.withSessionMutationAndInitialize(
            host.sessions,
            toolCtx.sessionID,
            async () => filterMessages(await host.sessions.messages(toolCtx.sessionID)),
            (history) => history,
            factoryCtx.config,
            async (state, history) => runV2Attempt(state, effects, history),
            {
                effects,
                isActive: active,
                commitResult: (result) => result.accepted,
                commit: (state, result) => commitSessionState(state, result.working),
                postCommit: (state, result) => flushAcceptedV2Attempt(state, result),
                retainQualityGateRetry: (error) =>
                    error instanceof QualityGateRejectionError && active(),
            },
        )
        if (!attempt) throw new Error("ACP tool operation is no longer active")
        return attempt.result
    }
    if (factoryCtx.registry.withSessionMutation) {
        return factoryCtx.registry.withSessionMutation(toolCtx.sessionID, run)
    }
    return run(resolveToolContext(factoryCtx, toolCtx.sessionID).state)
}

/** Restore only entries removed while a fenced transaction was speculative. */
function restoreSharedTiming(
    state: SessionState,
    pendingBefore: ReadonlyMap<
        string,
        { entry: PendingCompressionDuration; snapshot: PendingCompressionDuration }
    >,
    startsBefore: ReadonlyMap<string, number>,
): void {
    const pending = state.compressionTiming.pendingByCallId
    pending.clear()
    for (const [key, value] of pendingBefore) {
        Object.assign(value.entry, value.snapshot)
        pending.set(key, value.entry)
    }
    const starts = state.compressionTiming.startsByCallId
    starts.clear()
    for (const [key, startedAt] of startsBefore) {
        starts.set(key, startedAt)
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
