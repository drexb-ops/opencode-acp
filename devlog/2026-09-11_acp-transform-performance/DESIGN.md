# DESIGN - ACP Transform Performance

- Task ID: `2026-09-11_acp-transform-performance`
- Home Repo: `opencode-acp`
- Created: 2026-09-11
- Status: Accepted

## 1. Problem Statement

ACP must keep historical compression blocks for nested decompression, status, and fork recovery, but per-request work should depend on visible context and active state rather than every block ever created. Candidate planning currently repeats global boundary lookup and active-block selection per draft. Nudge analysis computes full range statistics even when no nudge can be emitted.

## 2. Goals & Non-Goals

- **Goals**:
  - Preserve all compression semantics while making common transforms fast after many compressions.
  - Use exact executor validation for candidates, but share request-local indexes.
  - Make stable state cheap without losing repair capability after external mutation or decompression.
  - Prevent asynchronous state saves from racing.
- **Non-Goals**:
  - Persisting caches, changing the state file schema, or adding a user-facing setting.
  - Weakening validation, pruning protections, or candidate quality to gain speed.

## 3. Current Architecture

```text
messages.transform
  -> assign refs / sync blocks / hide consumed calls
  -> prune messages
  -> inject nudge and adaptive candidates
  -> truncate / budget guard / inject IDs

candidate planner
  -> build search context
  -> validate many draft ranges
  -> each draft rebuilds boundary lookup and scans active summaries
```

Pain points:

- `resolveBoundaryIds()` rebuilds a visible-reference and active-block lookup for every candidate draft.
- `resolveSelection()` scans and sorts all active summaries for each draft.
- `injectCompressNudges()` calculates composition, protections, and ranges when a T1 nudge cannot be emitted.
- `syncCompressionBlocks()` replays all historical blocks, including inactive blocks, on a verified stable turn.
- consumed compression-call hiding rebuilds immutable all-history IDs every turn.

## 4. Proposed Architecture

```text
transform
  -> cheap eligibility decision
  -> no T1/T2/T3 output: stop nudge analysis
  -> nudge output: one request-scoped search index
       -> exact candidate validation through existing executor

block mutation
  -> invalidate verified derived indexes
  -> next sync repairs once
  -> later turns use verified indexes

save request
  -> one in-flight write per state path
  -> newest pending snapshot replaces older pending snapshot
```

### Request-scoped compression indexes

`SearchContext` gains a boundary lookup and summaries grouped by anchor message ID. `buildSearchContext()` builds them once from the current raw messages and active blocks. Boundary resolution, clamping, reversed-boundary handling, and tool-pair expansion retain their existing code paths; only the source of their lookup changes. Selection iterates selected messages and their anchored summaries rather than sorting every active block.

### Lazy nudge analysis

The cheap nudge decision remains first. T1 composition, protected-reference calculation, compressible-range construction, and candidate planning run only when T1 may emit. T2/T3 keep their existing cadence checks. Context composition runs only when an emitted nudge or notice needs its breakdown. This changes work scheduling, not nudge thresholds or text.

### Verified state fast path

`membershipsVerified` represents that active block indexes and per-message memberships already reflect the current graph. Compression and GC merge already maintain those indexes. Decompression and external-repair paths explicitly invalidate verification. `syncCompressionBlocks()` then fully rebuilds once, marks verified, and becomes a cheap stable path thereafter. Historical blocks remain stored unchanged.

### Transient consumed-call index

A module-local `WeakMap<PruneMessagesState, ...>` stores immutable historical call IDs keyed by block count. It rebuilds only when a new block is allocated. Live range data derives from active block IDs each call, so decompression takes effect immediately. The cache is never persisted.

### Ordered persistence

State saves use a per-path single-flight coordinator. One write may run; requests received during it replace a pending snapshot with the newest snapshot. An awaited call completes only after its snapshot or a newer snapshot is durable. Existing JSON data and atomic-write behavior remain intact.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Candidate validation | Skip exact validation, cache globally, request-local index | Request-local index | Eliminates repeated scans without stale cross-turn state or quality loss. |
| Stable block handling | Delete inactive blocks, replay always, verified fast path | Verified fast path | Keeps lineage and recovery while removing stable historical work. |
| Nudge work | Always calculate, change cadence, lazy calculation | Lazy calculation | Preserves decisions and visible output. |
| Persistence | Fire-and-forget writes, synchronous writes, ordered coalescing | Ordered coalescing | Preserves latest state without blocking transform or allowing stale overwrite. |

## 6. Impact Analysis

- **Backward compatibility**: no persisted state fields or public tool schema change; transient indexes are rebuilt in memory.
- **Performance**: expected major reduction in candidate planning and removal of inactive-block replay on stable turns. Benchmark results, rather than assumptions, determine whether later phases are necessary.
- **Security**: protected-content checks remain on the exact executor path.
- **Dependencies**: none.

## 7. Implementation and Validation Plan

1. Add a deterministic benchmark harness and baseline results.
2. Implement and test request-scoped boundary/summary indexes.
3. Make T1 nudge analysis lazy and verify no-nudge, T1, T2, T3, and emergency behavior across turns.
4. Add verified-state synchronization and explicit invalidation in every block mutator.
5. Cache immutable consumed-call IDs with active state derived on demand.
6. Add ordered save coalescing and concurrency tests.
7. Run typecheck, full tests, format check, build, E2E scenarios, performance probes, dual review, and local deployment.

## 8. Explicitly Set Aside

- Worker-thread offloading, state-file compaction, a new database, and cross-turn message caches are deferred. They add complexity and potential correctness risk before the confirmed hot paths are fixed.
