# DESIGN - Avoid transform work that scales with compression history

- Task ID: `2026-09-11_perf-transform-history`
- Issue: https://github.com/ranxianglei/opencode-acp/issues/384

## Problem shape

The message-transform hook runs on **every LLM call**. Several of its steps —
and the compress tool's candidate validation — rebuilt lookup structures whose
size grows with *total compression history* (`messageIds.byRef` is never
reclaimed between compactions; `blocksById` keeps consumed blocks forever for
decompression/fork recovery). Cost therefore scaled O(history) per transform
instead of O(visible messages + active blocks).

## Design decisions

### 1. Request-scoped boundary lookup memo (RC1)

`buildBoundaryLookup()` maps every known ref/bid to a `BoundaryReference`. It
depends only on `(searchContext.rawIndexById, state.messageIds.byRef, active
blocks)` — all immutable **within one request** (a single compress tool call
or one transform). So it is built once per request:

- `SearchContext.boundaryLookup?: BoundaryLookup` (new OPTIONAL field,
  `lib/compress/types.ts`). `buildSearchContext()` fills it eagerly;
  `resolveBoundaryIds()` falls back to `context.boundaryLookup ??= buildBoundaryLookup(...)`
  so hand-built contexts (tests, `search_context` tool) keep working unchanged.
- No invalidation machinery needed: the context object is request-scoped by
  construction and never mutated after creation.

### 2. Fast token estimate in candidate selection (RC1b)

`resolveSelection()` only needs token counts to report range sizes and feed
quality-gate estimates — it does NOT need exact BPE counts. The codebase
already uses `chars/4` as its estimation convention everywhere else; the hot
path alone called the real Anthropic tokenizer (~27 ms per ~1 KB measured),
which at 500–1000 messages dominated candidate planning. New
`estimateAllMessageTokensFast()` = `Math.round(countMessageCharacters(msg) / 4)`.
Exact counting stays where correctness requires it (`getCurrentTokenUsage`'s
rare fallback path).

### 3. Lazy nudge analysis (RC2)

`injectCompressNudges()` computed `estimateContextComposition`,
`computeProtectedRefs`, and `buildCompressibleRanges` (each an O(all messages)
pass that stringifies tool outputs) on every transform even when nothing could
be emitted. Analysis now runs iff:

```
needsNudgeAnalysis = nudgeAllowed || emergencyOverride || tierTriggerPossible
```

- `nudgeAllowed` — growth/floor gate says a T1 nudge may fire
- `emergencyOverride` — opencode compaction happened; the "nothing to
  compress" check must run to decide between emergency notice vs silence
- `tierTriggerPossible` — tier-1/tier-2 summary usage crossed the growth
  threshold, so a T2/T3 trigger could emit

Downstream consumers of the now-possibly-null structures are null-guarded.
No behavior change when analysis WAS needed; quiet turns simply skip it.

### 4. Structure-version invalidation for derived indexes (RC3)

Two per-transform paths replayed ALL blocks (active + inactive):
`syncCompressionBlocks()` (sort + liveness recompute + anchor map rebuild) and
`hideConsumedCompressCalls()` (consumed-call index rebuild). Block liveness and
the consumed-call structure change ONLY at three mutation sites (found by grep
audit of `.active =`, `deactivatedByUser*` assignments, `blocksById.set/delete`):

1. `compress/state.ts` → `applyCompressionState()` (new block + consumption deactivations)
2. `gc/merge.ts` → `mergeMarkedBlocks()` (merged block + source deactivations)
3. `decompress-logic.ts` → `deactivateCompressionTarget()` (+ deep BFS deactivation)

Design: `PruneMessagesState.structureVersion: number` bumped via
`bumpPruneStructureVersion()` at exactly those sites.

- **sync**: steady-state fast path skips the full replay when
  `structureVersion === lastSyncedStructureVersion`; it still updates the
  anchor-presence bookkeeping cheaply. Any version mismatch (or first run /
  post-load) triggers the original full replay, which then records the version.
  Full replay remains the source of truth — the fast path only defers it.
- **hide-consumed**: its derived index (`allBlockCallIds`,
  `liveRangeKeysByCallId`, `activeCallIds`) is cached in
  `PruneMessagesState.hideConsumedIndex = { version, ... }`; rebuilt only when
  the version changed since the cache was built.

Correctness argument: both consumers derive exclusively from block fields that
only those three sites mutate, so version equality implies index validity.

### 5. Ordered, coalescing save queue (RC4)

`saveSessionState()` callers are fire-and-forget (`.catch(() => {})`) and fire
in bursts within one transform (sync deactivation, batch cleanup, nudge
anchors, compaction reset, tool finalize). Independent async whole-file writes
could settle out of request order (stale snapshot overwrites fresh) and bursts
produced N redundant serializations + writes.

Queue semantics (per key = `sessionId \u0000 storageDir`):

1. Snapshot serialized **synchronously at enqueue time** — a queued entry can
   never read mutated state later.
2. Synchronous bursts pile onto one batch; batch drains on `setImmediate`
   (macrotask boundary, so same-tick enqueues coalesce).
3. A batch writes **only the latest snapshot** (earlier ones are strictly
   stale); all waiters in the batch share the outcome.
4. FIFO across batches: entries arriving during a write form the next batch,
   so order is preserved end-to-end.
5. Failure isolation: a failed write rejects its batch's waiters (callers
   already swallow via `.catch`) but subsequent batches proceed normally.
6. Idle queues delete themselves (no unbounded Map growth).

## Persisted-state compatibility

All new state fields (`structureVersion`, `lastSyncedStructureVersion`,
`hideConsumedIndex`, `SearchContext.boundaryLookup`) are **transient**: they
are excluded from `serializePruneMessagesState()`, so on-disk format is
unchanged. On load, absent fields default safely — `structureVersion` starts
at 0 which forces one full sync replay and one hide-consumed rebuild, i.e.
first transform after restart behaves exactly like pre-change code. No
migration needed; old state files load unchanged.

## What deliberately did NOT change

- Candidate executor validation, protection semantics (Bug 39 hard-exclusion,
  protected recent window), decompression, fork recovery: untouched.
- `messageIds` ref allocation/reclamation policy: untouched (refs still grow
  until compaction — that's a separate concern).
- Exact-token accounting paths: untouched.
