import { existsSync } from "fs"
import { join } from "path"
import { cwd } from "process"
import type { ModelInventory, SessionService } from "../host"
import { resolveModelInventory, resolveSessionService } from "../host/legacy"
import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import {
    applyPendingCompressionDurations,
    type CompressionTimingState,
    type PendingCompressionDuration,
} from "../compress/timing"
import {
    getDefaultStorageDir,
    loadSessionState,
    resolveStorageDir,
    saveSessionState,
} from "./persistence"
import type { DeferredMutationEffects } from "./transaction"
import { createModelLimitCatalog } from "./model-limits"
import { rebuildCompressionState, restoreForkCompressionState } from "./rebuild"
import {
    getSessionParentId,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    collectTurnNudgeAnchors,
} from "./utils"
import { parseMessageRef, formatMessageRef } from "../message-ids"

/**
 * Per-turn state update (compaction detection + turn count). Extracted from the
 * old `checkSession`; session-switch + init now live in SessionStateRegistry.
 */
export async function updatePerTurnState(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    effects?: DeferredMutationEffects,
): Promise<void> {
    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        effects?.requestPersistence()
    }

    state.currentTurn = countTurns(state, messages)
}

// Soft cap on held sessions — guards a long-lived plugin process (daemon mode)
// from unbounded growth. Evicted sessions reload from persisted JSON on next
// access; modelContextLimit and all persisted fields survive eviction.
const REGISTRY_SOFT_CAP = 32

// [FIX #33] Per-session state. Replaces the single shared SessionState singleton
// whose resetSessionState-on-switch wiped modelContextLimit (set only by
// system.transform, which fires AFTER messages.transform) and flipped
// isSubAgent across interleaved sessions. Each session now keeps its
// own state for its lifetime — no reset-on-switch.
//
// compressionTiming is SHARED (hoisted here) rather than per-session: the `event`
// hook carries no sessionID, and a per-session map would let the event hook
// delete start entries in the wrong session (leaving the owning session
// dangling). One shared map = correct record/consume; the apply step
// iterates all sessions and only the owner matches (applied > 0).
export class SessionStateRegistry {
    private readonly states = new Map<string, SessionState>()
    private readonly initializations = new Map<string, Promise<SessionState>>()
    private readonly mutationTails = new Map<string, Promise<void>>()
    /** Includes queued work, not just the callback currently executing. */
    private readonly guardedWork = new Map<string, number>()
    readonly compressionTiming: CompressionTimingState = {
        startsByCallId: new Map<string, number>(),
        pendingByCallId: new Map<string, PendingCompressionDuration>(),
    }

    // [FIX #312] Model-limit catalog (full rationale in ./model-limits.ts):
    // lets the messages hook reconcile state.modelContextLimit against the
    // model named on the request's user message instead of waiting one turn
    // for the system hook. Shared implementation — the test registry stub
    // composes the same factory.
    private readonly catalog = createModelLimitCatalog()

    constructor(
        private readonly logger: Logger,
        private readonly projectDir?: string,
    ) {}

    recordModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void {
        this.catalog.record(providerId, modelId, limit)
    }

    resolveModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
    ): number | undefined {
        return this.catalog.resolve(providerId, modelId)
    }

    /** Best-effort one-time seed from a host-neutral model inventory. */
    hydrateModelLimits(inventory: ModelInventory): Promise<number> {
        return this.catalog.hydrate(inventory)
    }

    /** @deprecated Use hydrateModelLimits() with a host model inventory. */
    hydrateModelLimitsFromClient(client: unknown): Promise<number> {
        return this.catalog.hydrateFromClient(client)
    }

    // [FIX #346] The init-time seed (above) is fire-and-forget and races
    // server readiness: in headless spawn+resume mode the provider-config
    // call can fail before the server is up, leaving the catalog empty for
    // the process's lifetime. During a request the server is guaranteed up
    // (we are inside its pipeline), so on a catalog miss we retry hydration
    // once per process before giving up (the fallback limit then applies).
    // The in-flight promise (not a boolean) lets concurrent callers await the
    // same hydration instead of skipping it.
    private lazyHydration: Promise<number> | undefined

    async hydrateAndResolve(
        inventory: ModelInventory,
        providerId: string,
        modelId: string,
    ): Promise<number | undefined> {
        const existing = this.catalog.resolve(providerId, modelId)
        if (existing !== undefined) {
            return existing
        }
        this.lazyHydration ??= this.catalog.hydrate(resolveModelInventory(inventory))
        await this.lazyHydration
        return this.catalog.resolve(providerId, modelId)
    }

    get(sessionId: string): SessionState | undefined {
        // A state object is inserted before async initialization can begin, but
        // it is deliberately invisible until that initialization has completed.
        if (this.initializations.has(sessionId)) return undefined
        return this.states.get(sessionId)
    }

    all(): SessionState[] {
        return Array.from(this.states.keys())
            .map((sessionId) => this.get(sessionId))
            .filter((state): state is SessionState => state !== undefined)
    }

    get size(): number {
        return this.states.size
    }

    // Idempotent: ensureSessionInitialized returns immediately once
    // state.sessionId === sessionId (assigned synchronously before any await),
    // so repeat calls for the same session never re-reset.
    async getOrCreate(
        sessions: SessionService,
        sessionId: string,
        messages: WithParts[],
        config?: PluginConfig,
    ): Promise<SessionState> {
        let state = this.states.get(sessionId)
        let initialization = this.initializations.get(sessionId)
        if (!state) {
            state = createSessionState()
            // Assign shared compressionTiming BEFORE ensureSessionInitialized so
            // its init-time applyPendingCompressionDurations reads the shared map.
            state.compressionTiming = this.compressionTiming
            this.states.set(sessionId, state)
            initialization = this.initializeState(sessions, state, sessionId, messages, config)
            this.initializations.set(sessionId, initialization)
            this.enforceSoftCap()
            void initialization.then(
                () => this.finishInitialization(sessionId, initialization!),
                (error) => {
                    if (this.states.get(sessionId)?.sessionId === sessionId) {
                        this.states.delete(sessionId)
                    }
                    this.logger.error("Failed to initialize session state", {
                        sessionId,
                        error: error instanceof Error ? error.message : String(error),
                    })
                    this.finishInitialization(sessionId, initialization!)
                },
            )
        }
        if (initialization) {
            await initialization
        } else {
            // Existing, fully initialized states remain idempotent. Keep this
            // call for callers that seeded a registry state directly in tests.
            await ensureSessionInitialized(
                resolveSessionService(sessions),
                state,
                sessionId,
                this.logger,
                messages,
                config,
                this.projectDir,
            )
        }
        return state
    }

    /**
     * Serialize all state-sensitive work for one session. Different sessions
     * use independent tails and therefore remain concurrent.
     */
    async withSessionMutation<T>(
        sessionId: string,
        operation: (state: SessionState) => Promise<T> | T,
    ): Promise<T> {
        const initialization = this.initializations.get(sessionId)
        if (initialization) {
            await initialization
        }

        if (!this.states.has(sessionId)) {
            throw new Error(`ACP: session ${sessionId} has no initialized state`)
        }

        const previous = this.mutationTails.get(sessionId) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => {
            release = resolve
        })
        this.mutationTails.set(sessionId, current)
        this.guardedWork.set(sessionId, (this.guardedWork.get(sessionId) ?? 0) + 1)

        await previous
        try {
            const state = this.states.get(sessionId)
            if (!state || this.initializations.has(sessionId)) {
                throw new Error(`ACP: session ${sessionId} is not initialized`)
            }
            return await operation(state)
        } finally {
            const count = (this.guardedWork.get(sessionId) ?? 1) - 1
            if (count > 0) this.guardedWork.set(sessionId, count)
            else this.guardedWork.delete(sessionId)
            release()
            if (this.mutationTails.get(sessionId) === current) {
                this.mutationTails.delete(sessionId)
            }
            this.enforceSoftCap()
        }
    }

    private initializeState(
        sessions: SessionService,
        state: SessionState,
        sessionId: string,
        messages: WithParts[],
        config?: PluginConfig,
    ): Promise<SessionState> {
        return ensureSessionInitialized(
            resolveSessionService(sessions),
            state,
            sessionId,
            this.logger,
            messages,
            config,
            this.projectDir,
        ).then(() => state)
    }

    private finishInitialization(sessionId: string, initialization: Promise<SessionState>): void {
        if (this.initializations.get(sessionId) === initialization) {
            this.initializations.delete(sessionId)
        }
        // Do not evict here: the getOrCreate caller is about to receive this
        // state, and no guarded-work reservation exists until it enters the
        // mutation queue. Subsequent insertions/guard releases enforce the cap.
    }

    private enforceSoftCap(): void {
        if (this.states.size <= REGISTRY_SOFT_CAP) return
        let oldest: string | undefined
        for (const sessionId of this.states.keys()) {
            if (!this.initializations.has(sessionId) && !this.guardedWork.has(sessionId)) {
                oldest = sessionId
                break
            }
        }
        if (oldest !== undefined) {
            this.states.delete(oldest as string)
            this.logger.info("SessionStateRegistry evicted session (soft cap)", {
                sessionId: oldest,
                remaining: this.states.size,
            })
        }
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        compressPermission: undefined,
        prune: {
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            compressBaselineSet: false,
            lastProcessedCompressMessageId: undefined,
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        modelProviderID: undefined,
        modelID: undefined,
        systemPromptTokens: undefined,
        storageDir: undefined,
        qualityGateRetryPending: false,
        noContextLimitWarned: false,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.compressPermission = undefined
    state.prune = {
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
        lastPerMessageNudgeTurn: 0,
        lastPerMessageNudgeTokens: undefined,
        lastNudgeShownTokens: undefined,
        lastToolOutputNudgeTokens: undefined,
        lastTier2NudgeTokens: undefined,
        lastTier3NudgeTokens: undefined,
        shouldInjectThisTurn: undefined,
        compressBaselineSet: false,
        lastProcessedCompressMessageId: undefined,
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.modelProviderID = undefined
    state.modelID = undefined
    state.systemPromptTokens = undefined
    state.storageDir = undefined
    state.qualityGateRetryPending = false
    state.noContextLimitWarned = false
}

export async function ensureSessionInitialized(
    sessions: SessionService,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    config?: PluginConfig,
    projectDir?: string,
): Promise<void> {
    const sessionService = resolveSessionService(sessions)
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.sessionId = sessionId
    // Resolve the configured storage location once per session (transient).
    // Relative paths resolve against projectDir (opencode's directory),
    // falling back to process.cwd() when the caller has no directory context.
    state.storageDir = config?.storagePath
        ? resolveStorageDir(config.storagePath, projectDir ?? cwd())
        : undefined

    const parentSessionId = await getSessionParentId(sessionService, sessionId)
    const isChildSession = parentSessionId !== undefined
    state.isSubAgent = isChildSession

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger, state.storageDir)
    if (persisted === null) {
        // Fork recovery: a fork gets new raw IDs and may omit historical
        // compress inputs. Prefer translating the parent state; replay remains
        // the cross-machine and legacy fallback.
        // The parent state transfer below is preferred for forks; replay remains
        // the cross-machine and legacy fallback.
        // storagePath points elsewhere but the session file still sits at the
        // default location (e.g. the user just configured storagePath). No
        // auto-migration — warn once (this init path runs once per session).
        const defaultPath = join(getDefaultStorageDir(), `${sessionId}.json`)
        if (state.storageDir && existsSync(defaultPath)) {
            logger.warn(
                "storagePath is set but no valid state was found there; a state file exists at the default location — move it manually to keep history",
                { sessionId, storageDir: state.storageDir, defaultPath },
            )
        }
        // Fork recovery: no persisted state for this session. If config is
        // available, replay historical compress tool invocations to rebuild
        // pruning state using the current session's message IDs.
        if (config) {
            let restored = 0
            if (parentSessionId) {
                try {
                    const parent = await loadSessionState(parentSessionId, logger)
                    const parentMessages = parent
                        ? await sessionService.parentMessages(parentSessionId)
                        : []
                    if (parent && parentMessages.length > 0) {
                        // Standard subagents skip their first user prompt when
                        // assigning refs. A copied fork needs that prompt to
                        // match the parent state, but only for this transfer.
                        state.isSubAgent = false
                        try {
                            restored = restoreForkCompressionState(
                                state,
                                messages,
                                parent,
                                parentMessages,
                                logger,
                            )
                        } finally {
                            state.isSubAgent = isChildSession
                        }
                    }
                } catch (error: any) {
                    logger.warn("fork: parent state transfer unavailable, replaying history", {
                        parentSessionId,
                        error: error?.message,
                    })
                }
            }

            const rebuilt =
                restored > 0 ? 0 : rebuildCompressionState(state, messages, config, logger)
            if (restored > 0 || rebuilt > 0) {
                await saveSessionState(state, logger)
            }
        }
        state.isSubAgent = isChildSession
        return
    }

    state.isSubAgent = isChildSession
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.nudges.lastPerMessageNudgeTurn = persisted.nudges.lastPerMessageNudgeTurn ?? 0
    state.nudges.lastPerMessageNudgeTokens = persisted.nudges.lastPerMessageNudgeTokens
    state.nudges.lastNudgeShownTokens = persisted.nudges.lastNudgeShownTokens
    state.nudges.lastToolOutputNudgeTokens = persisted.nudges.lastToolOutputNudgeTokens
    state.nudges.lastTier2NudgeTokens =
        persisted.nudges.lastTier2NudgeTokens ?? persisted.nudges.lastTierNudgeTokens
    state.nudges.lastTier3NudgeTokens = persisted.nudges.lastTier3NudgeTokens
    state.nudges.compressBaselineSet = persisted.nudges.compressBaselineSet ?? false
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const persistedAny = persisted as any
    if (persistedAny._persistedMessageIds) {
        state.messageIds = {
            byRawId: new Map(Object.entries(persistedAny._persistedMessageIds.byRawId || {})),
            byRef: new Map(Object.entries(persistedAny._persistedMessageIds.byRef || {})),
            nextRef: persistedAny._persistedMessageIds.nextRef || 1,
        }
        // [FIX Bug 29] Auto-cleanup stale synthetic message refs from persistence
        for (const [rawId, ref] of state.messageIds.byRawId) {
            if (rawId.startsWith("msg_dcp_summary_") || rawId.startsWith("msg_dcp_text_")) {
                state.messageIds.byRawId.delete(rawId)
                state.messageIds.byRef.delete(ref)
            }
        }
        // Migrate 4-digit refs (m0001) to 5-digit (m00001) for msgid expansion
        for (const [rawId, oldRef] of state.messageIds.byRawId) {
            const parsed = parseMessageRef(oldRef)
            if (parsed !== null) {
                const newRef = formatMessageRef(parsed)
                if (newRef !== oldRef) {
                    state.messageIds.byRawId.set(rawId, newRef)
                    state.messageIds.byRef.delete(oldRef)
                    state.messageIds.byRef.set(newRef, rawId)
                }
            }
        }
    }
    if (persistedAny._persistedLastCompaction !== undefined) {
        state.lastCompaction = Math.max(state.lastCompaction, persistedAny._persistedLastCompaction)
    }
    if (typeof persisted.modelContextLimit === "number" && persisted.modelContextLimit > 0) {
        state.modelContextLimit = persisted.modelContextLimit
        // Restore the identity pair together with the limit (persisted as a
        // pair in saveSessionState) so the messages-hook staleness check
        // survives restarts. Invalid/absent limit → fresh undefined pair.
        state.modelProviderID = persisted.modelProviderID
        state.modelID = persisted.modelID
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
    // [FIX Bug 1] Always save after initialization to persist messageIds + lastCompaction
    await saveSessionState(state, logger)
}
