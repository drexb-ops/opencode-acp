/**
 * Benchmark harness for issue #384 — perf: avoid transform work that scales
 * with compression history.
 *
 * Measures the per-transform hot paths against synthetic long sessions:
 *   A. Candidate planning: buildSearchContext + resolveRanges (D draft ranges)
 *   B. Steady-state sync:  syncCompressionBlocks (no structural change)
 *   C. Hide consumed:      hideConsumedCompressCalls (block index rebuild)
 *
 * Workload model: N visible messages with realistic tool outputs; H ≈ N/2
 * historical compressions producing a block chain where only the newest ~20
 * blocks are active (the rest consumed/inactive); full byMessageId / byRef
 * history retained (refs are never reclaimed between compactions).
 *
 * Usage:
 *   node --import tsx scripts/bench-candidate-planning.ts [N ...]
 * (defaults: 100 500 1000)
 */
import { buildSearchContext } from "../lib/compress/search"
import { resolveRanges } from "../lib/compress/range-utils"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { hideConsumedCompressCalls } from "../lib/compress/hide-consumed"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib/state/types"

const SID = "bench-session-384"
const NOOP_LOGGER = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

const DRAFTS = 10 // number of candidate ranges planned per compress call

function makeMessage(id: string, role: "user" | "assistant", toolPart?: any): WithParts {
    const parts: any[] = [
        {
            type: "text",
            text:
                role === "user"
                    ? "Please investigate the failing pipeline and summarize the root cause."
                    : "The failure originates in the retry loop; here is the relevant excerpt and analysis of the stack trace.",
        },
    ]
    if (toolPart) parts.push(toolPart)
    return {
        info: {
            id,
            sessionID: SID,
            role,
            time: { created: 1_700_000_000_000 },
            ...(role === "assistant"
                ? {
                      parentID: "parent-1",
                      modelID: "test-model",
                      providerID: "test-provider",
                      mode: "normal",
                      agent: "test",
                      path: { cwd: "/", root: "/" },
                      summary: false,
                      cost: 0,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  }
                : {
                      agent: "test",
                      model: { providerID: "test-provider", modelID: "test-model" },
                  }),
        } as any,
        parts,
    } as WithParts
}

function makeToolPart(callID: string): any {
    return {
        type: "tool",
        callID,
        tool: "bash",
        state: {
            status: "completed",
            input: { command: "npm test" },
            output: { stdout: "x".repeat(600), stderr: "" },
        },
    }
}

function makeCompressToolPart(callID: string, startId: string, endId: string): any {
    return {
        type: "tool",
        callID,
        tool: "compress",
        state: {
            status: "completed",
            input: { content: [{ startId, endId, summary: "s" }] },
            output: { title: "compressed" },
        },
    }
}

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 120,
        durationMs: 0,
        topic: "bench",
        batchTopic: "bench",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "raw-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A summary of the compressed range.",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

interface Workload {
    messages: WithParts[]
    state: SessionState
    drafts: Array<{ startId: string; endId: string }>
}

function ref(i: number): string {
    return `m${String(i + 1).padStart(5, "0")}`
}

function buildWorkload(n: number): Workload {
    const messages: WithParts[] = []
    const byRef = new Map<string, string>()
    const byRawId = new Map<string, string>()

    let compressCallCounter = 0
    for (let i = 0; i < n; i++) {
        const rawId = `raw-${i + 1}`
        const r = ref(i)
        byRef.set(r, rawId)
        byRawId.set(rawId, r)
        const role: "user" | "assistant" = i % 4 === 0 ? "user" : "assistant"
        const parts: any[] = []
        if (role === "assistant") {
            // one ordinary tool call per assistant message
            parts.push(makeToolPart(`call-${i + 1}`))
            // every 5th assistant message carries a finished compress call
            if ((i - 1) % 5 === 0 && i >= 1) {
                const k = ++compressCallCounter
                parts.push(makeCompressToolPart(`comp-call-${k}`, ref(Math.max(0, i - 4)), ref(i - 1)))
            }
        }
        messages.push(makeMessage(rawId, role, parts.length ? parts[0] : undefined))
        if (parts.length > 1) {
            // attach extra parts (compress call) to the same message
            messages[i]!.parts.push(...parts.slice(1))
        }
    }

    // Historical compression chain: H ≈ n/2 blocks; only newest ACTIVE_FRONTIER active.
    const h = Math.floor(n / 2)
    const activeFrontier = Math.min(20, h)
    const blocksById = new Map<number, CompressionBlock>()
    const byMessageId = new Map<string, PrunedMessageEntry>()
    const activeBlockIds = new Set<number>()
    const activeByAnchorMessageId = new Map<string, number>()

    for (let b = 0; b < h; b++) {
        const startIdx = b * 2
        const endIdx = Math.min(n - 1, b * 2 + 1)
        if (startIdx >= n) break
        const isActive = b >= h - activeFrontier
        const block = makeBlock({
            blockId: b + 1,
            runId: b + 1,
            active: isActive,
            startId: ref(startIdx),
            endId: ref(endIdx),
            anchorMessageId: `raw-${endIdx + 1}`,
            compressMessageId: `comp-msg-${b + 1}`,
            compressCallId: `comp-call-${b + 1}`,
            createdAt: 1000 + b,
            consumedBlockIds: [b > 0 ? b : 0].filter((x) => x > 0),
            effectiveMessageIds: [`raw-${startIdx + 1}`, `raw-${endIdx + 1}`],
            generation: isActive ? "young" : "old",
            survivedCount: isActive ? 0 : 99,
        })
        if (!isActive) {
            block.deactivatedAt = 2000 + b
            block.deactivatedByBlockId = b + 2
        }
        blocksById.set(b + 1, block)
        if (isActive) {
            activeBlockIds.add(b + 1)
            activeByAnchorMessageId.set(block.anchorMessageId, b + 1)
        }
        for (const mid of [`raw-${startIdx + 1}`, `raw-${endIdx + 1}`]) {
            const entry = byMessageId.get(mid) ?? {
                allBlockIds: [],
                activeBlockIds: [],
                lastCompressedAt: 0,
            }
            entry.allBlockIds = entry.allBlockIds.filter((id) => id !== b + 1)
            entry.allBlockIds.push(b + 1)
            if (isActive) {
                entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== b + 1)
                entry.activeBlockIds.push(b + 1)
            }
            byMessageId.set(mid, entry)
        }
    }

    // Candidate drafts: D ranges spread across visible history.
    const drafts: Array<{ startId: string; endId: string }> = []
    for (let d = 0; d < DRAFTS; d++) {
        const span = Math.max(2, Math.floor(n / DRAFTS / 2))
        const start = Math.min(n - 2, d * (Math.floor(n / DRAFTS) || 1))
        drafts.push({ startId: ref(start), endId: ref(Math.min(n - 1, start + span)) })
    }

    const state: SessionState = {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        prune: {
            messages: {
                byMessageId,
                blocksById,
                activeBlockIds,
                activeByAnchorMessageId,
                nextBlockId: h + 1,
                nextRunId: h + 1,
                markedForCleanup: new Set<number>(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
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
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        toolIdList: [],
        messageIds: { byRawId, byRef, nextRef: n + 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }

    return { messages, state, drafts }
}

function cloneMessages(messages: WithParts[]): WithParts[] {
    return messages.map((m) => ({ ...m, parts: Array.isArray(m.parts) ? [...m.parts] : m.parts }))
}

function medianMs(fn: () => void, reps = 7): number {
    const samples: number[] = []
    for (let i = 0; i < reps; i++) {
        const t0 = process.hrtime.bigint()
        fn()
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    samples.sort((a, b) => a - b)
    return samples[Math.floor(samples.length / 2)]!
}

async function main() {
    const args = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)
    const sizes = args.length ? args : [100, 500, 1000]

    console.log(`# issue #384 benchmark — candidate planning & steady-state transform`)
    console.log(`# drafts per compress call: ${DRAFTS}; reps: 7 (median)` )
    console.log("#")
    console.log(
        "msgs   history(blocks)  active   A: candidate planning(ms)  B: sync(ms)  C: hide-consumed(ms)  B+C steady-state(ms)",
    )

    for (const n of sizes) {
        const { messages, state, drafts } = buildWorkload(n)
        const blocksTotal = state.prune.messages.blocksById.size
        const active = state.prune.messages.activeBlockIds.size

        // Warm-up (also establishes steady state for sync).
        syncCompressionBlocks(state, NOOP_LOGGER, cloneMessages(messages))

        const planOnce = () => {
            const context = buildSearchContext(state, messages)
            resolveRanges({ content: drafts } as any, context, state, NOOP_LOGGER)
        }
        const syncOnce = () => syncCompressionBlocks(state, NOOP_LOGGER, cloneMessages(messages))
        const hideOnce = () => hideConsumedCompressCalls(state, cloneMessages(messages))

        const planMs = medianMs(planOnce)
        const syncMs = medianMs(syncOnce)
        const hideMs = medianMs(hideOnce)

        console.log(
            `${String(n).padStart(4)}   ${String(blocksTotal).padStart(15)}  ${String(active).padStart(6)}   ${planMs.toFixed(2).padStart(24)}  ${syncMs.toFixed(2).padStart(11)}  ${hideMs.toFixed(2).padStart(21)}  ${(syncMs + hideMs).toFixed(2)}`,
        )
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
