# WORKLOG - Avoid transform work that scales with compression history

- Task ID: `2026-09-11_perf-transform-history`
- Branch: `2026-09-11_perf-transform-history`
- Issue: https://github.com/ranxianglei/opencode-acp/issues/384
- Status: Complete (pending review)

## Root causes verified in code

| # | Claim | Verified at | Fix |
|---|-------|-------------|-----|
| RC1 | Candidate validation rebuilds boundary lookup per draft | `lib/compress/search.ts` — `resolveBoundaryIds()` called `buildBoundaryLookup(context, state)` on **every** call; `buildBoundaryLookup` iterates the entire unbounded `messageIds.byRef` map | Request-scoped memo: `SearchContext.boundaryLookup?: BoundaryLookup` populated by `buildSearchContext()`, lazily filled via `??=` in `resolveBoundaryIds()` — built once per compress call regardless of draft count |
| RC1b | Token estimation used the real Anthropic BPE tokenizer per message in `resolveSelection` | `lib/compress/search.ts` — `countAllMessageTokens(rawMessage)` per selected message; micro-bench: BPE ≈ 27 ms per ~1 KB of text | New `estimateAllMessageTokensFast()` in `lib/token-utils.ts` = `Math.round(chars / 4)` using the existing `countMessageCharacters()` convention (same estimator family used across the codebase for estimates); exact BPE retained only where correctness requires it (`getCurrentTokenUsage` rare fallback) |
| RC2 | T1 nudge analysis computed full context/range data even when no nudge can fire | `lib/messages/inject/inject.ts` — `estimateContextComposition`, `computeProtectedRefs`, `buildCompressibleRanges` ran unconditionally every transform; each stringifies tool outputs over ALL messages | Gate: `const needsNudgeAnalysis = nudgeAllowed \|\| emergencyOverride \|\| tierTriggerPossible` — heavy analysis runs only when a nudge, tier trigger, or emergency notice could actually be emitted; downstream consumers null-guarded |
| RC3 | Stable transforms replayed historical inactive blocks and rebuilt immutable consumed-call indexes | `lib/messages/sync.ts` — `syncCompressionBlocks()` sorted + replayed **all** blocks (active and inactive) every transform; `lib/compress/hide-consumed.ts` — rebuilt `allBlockCallIds`/`liveRangeKeysByCallId`/`activeCallIds` from all blocks every transform | Transient derived indexes with structural invalidation: new `PruneMessagesState.structureVersion: number` bumped at every block-mutation site (`compress/state.ts:applyCompressionState`, `gc/merge.ts:mergeMarkedBlocks`, `decompress-logic.ts:deactivateCompressionTarget`) via `bumpPruneStructureVersion()` in `state/utils.ts`; sync keeps `lastSyncedStructureVersion` + anchor bookkeeping and skips full replay when unchanged; hide-consumed caches its index in `PruneMessagesState.hideConsumedIndex` keyed by version |
| RC4 | Fire-and-forget saves raced and produced redundant whole-file writes | `lib/state/persistence.ts` — every caller did `saveSessionState(...).catch(() => {})` independently; overlapping writes could settle out of order (stale overwrite) and bursts wrote the file N times | Ordered, coalescing per-session queue inside `saveSessionState`: snapshot serialized synchronously at enqueue time (no stale reads), batches drain on `setImmediate`, each batch writes ONLY the latest snapshot, FIFO across batches, waiters of a failed batch reject without poisoning subsequent saves. Key = `sessionId \u0000 storageDir` so custom-storage sessions isolate correctly |

## Key files

- `lib/compress/search.ts` — boundary lookup memoization (RC1), fast token estimate in `resolveSelection` (RC1b)
- `lib/compress/types.ts` — `SearchContext.boundaryLookup` optional field (backward compatible: hand-built contexts still work via lazy fill)
- `lib/token-utils.ts` — `estimateAllMessageTokensFast()`
- `lib/messages/inject/inject.ts` — `needsNudgeAnalysis` gate + null guards (RC2)
- `lib/messages/sync.ts` — incremental steady-state path (RC3)
- `lib/compress/hide-consumed.ts` — derived-index cache (RC3)
- `lib/state/types.ts` — `structureVersion`, `hideConsumedIndex`, `lastSyncedStructureVersion` fields (transient; NOT serialized by `serializePruneMessagesState`, so persisted-state format unchanged)
- `lib/state/utils.ts` — `bumpPruneStructureVersion()`
- `lib/compress/state.ts`, `lib/gc/merge.ts`, `lib/compress/decompress-logic.ts` — version bumps at mutation sites
- `lib/state/persistence.ts` — ordered coalescing save queue (RC4)
- `scripts/bench-candidate-planning.ts` — new benchmark harness (workload: N visible messages, H ≈ N/2 historical blocks, only newest 20 active, full ref history)
- Tests: `tests/sync.test.ts` (+4), `tests/hide-consumed.test.ts` (+3), `tests/compress-search.test.ts` (+4), `tests/token-counting.test.ts` (+3), `tests/persistence.test.ts` (+4), `tests/inject.test.ts` (+2, §5.7 multi-turn production-config cycle + emergency-path preservation)

## Benchmark evidence

Same machine, same harness, median of 7 reps. Baseline = pristine master (`5135dfd`) run in a throwaway worktree the day of the fix.

```
Baseline (master):                          Fixed (this branch):
msgs  hist  A(ms)     B(ms)  C(ms)   msgs  hist  A(ms)  B(ms) C(ms)
 100    50   1608.62   0.06   0.04    100    50   0.40   0.01  0.03
 500   250   6798.66   0.40   0.18    500   250   1.09   0.06  0.14
1000   500  13618.01   0.66   0.10   1000   500   1.16   0.07  0.07
```

- A = candidate planning (`buildSearchContext` + `resolveRanges` × 10 drafts)
- B = steady-state `syncCompressionBlocks`; C = `hideConsumedCompressCalls`
- **A @1000: 13618 ms → 1.16 ms (≈11,700×)** — acceptance target ≤ 20 ms met with ~17× headroom
- A @500: 6798.7 → 1.09 ms (≈6,200×); A @100: 1608.6 → 0.40 ms (≈4,000×)
- B+C steady-state flat vs history size (0.76 → 0.14 ms @1000); both now bounded by ACTIVE block count, not total history

Note: absolute baseline numbers differ from the isolated probe in the issue (3.2/34/105 ms) because this harness models a denser workload (realistic tool-output sizes, 10 drafts per call, full un-reclaimed ref history); before/after are measured on the identical harness.

## Test results

- Full suite: **1151 tests, 0 failures** (`node --import tsx --test tests/*.test.ts`), up from 1131 pre-change
- `npm run typecheck`: clean
- New tests specifically guard the regression modes: sync full-replay-vs-incremental equivalence + shared-anchor ordering, hide-consumed cache reuse/invalidation identity, boundary-lookup memoization + lazy backward-compat, fast-estimator exactness, save-queue burst coalescing / no-stale-overwrite / failure isolation / storageDir isolation, §5.7 multi-turn growth cycle with `preserveRecentMessages > 0` asserting both `shouldInjectThisTurn` AND `lastPerMessageNudgeTokens`/`lastNudgeShownTokens` after each turn

## Lessons learned

- The dominant cost was not the "obvious" O(blocks) loops but per-draft rebuilds of O(ref-history) structures plus a real tokenizer call inside a hot loop — profile before optimizing.
- Derived indexes must be invalidated at EVERY mutation site; the three block-mutation sites (compress apply, batch merge, decompress deactivation) were found by grepping `.active =` / `deactivatedByUser*` assignments and `blocksById.set/delete`.
- Save-ordering bugs are invisible to single-save tests; behavioral coverage must burst saves synchronously and assert which snapshot won.
- Transient state fields must stay OUT of `serializePruneMessagesState` to keep persisted-state compatibility; load-time reconstruction defaults them safely (version 0 forces one full replay after restart — correct by construction).
