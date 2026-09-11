# REQ - Avoid transform work that scales with compression history

- Task ID: `2026-09-11_perf-transform-history`
- Home Repo: `opencode-acp`
- Created: 2026-09-11
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/384

## 1. Background & Problem Statement

- **Context**: Long ACP sessions accumulate many compression blocks, byMessageId
  entries, and message-ref history. Several per-transform (every LLM call) code
  paths rebuild global lookup structures or replay all historical blocks, so
  cost grows with *total compression history* instead of staying bounded by
  visible context.
- **Current behavior (symptom)**: OpenCode becomes slow in long ACP sessions,
  especially after many compressions. Isolated probe measured adaptive candidate
  planning at ~3.2 ms for 100 messages, ~34 ms for 500, ~105 ms for 1,000.
- **Expected behavior**: Per-transform work bounded by visible message count +
  active block count; candidate planning ≤ 20 ms at 1,000 messages.
- **Impact**: Latency on every LLM call in long sessions; user-visible stalls.

## 2. Reproduction (if applicable)

- **Environment**: Node 22/24, linux
- **Minimal reproduction steps**:
  1) Run a session with many compressions (large `blocksById` / `byMessageId` /
     `messageIds.byRef`).
  2) Observe per-transform time in `logs/acp/context/<session>/<ts>.json`
     timestamps growing with history size.
  3) Benchmark harness: `node --import tsx scripts/bench-candidate-planning.ts`
     (added in this task) reproduces the scaling at N=100/500/1000.
- **Relevant configuration**: defaults; scales regardless of mode.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state format unchanged (new fields are
    transient, not serialized — serialization is explicit-field).
  - Preserve: candidate executor validation, protection semantics, decompression,
    fork recovery, Bug 34 auto-swap, #247 tool-pair adjustment, [PATCH Bug 3]
    anchor-survival semantics, [FIX #60]/[FIX Bug 6] save semantics.
  - Performance requirement: candidate planning at 1,000 messages ≤ 20 ms.
- **Non-Goals**:
  - No changes to nudge thresholds/floors or prompt text.
  - No changes to quality-gate, gc merge policy, or truncation limits.
  - No new dependencies.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] Full existing test suite passes (no behavioral regressions).
  - [ ] syncCompressionBlocks incremental path produces identical state to full
    replay for unchanged structure (property/equivalence tests).
  - [ ] hideConsumedCompressCalls index cache invalidates on every block
    mutation site (version bump coverage).
  - [ ] saveSessionState writes are ordered per session; latest snapshot wins;
    awaited callers observe durability; errors still propagate ([FIX Bug 6]).
- **Performance / Stability**:
  - [ ] Candidate planning benchmark at 1,000 messages ≤ 20 ms (median), with
    before/after evidence recorded in WORKLOG.md.
  - [ ] Steady-state transform (sync + hide-consumed) no longer iterates
    inactive blocks when structure is unchanged.
- **Regression**:
  - [ ] New/modified test cases added to test suite and passing.
  - [ ] Dual-agent review of lib/ changes + test review (AGENTS.md §5.3/§5.6).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/compress/types.ts`, `lib/compress/search.ts` — request-scoped
    boundary lookup (RC1): memoize `buildBoundaryLookup` on `SearchContext`.
  - `lib/messages/inject/inject.ts` — lazy no-nudge analysis (RC2): skip
    composition/protected/range computation when no T1/T2/T3 nudge can fire.
  - `lib/state/types.ts`, `lib/state/utils.ts`, `lib/messages/sync.ts`,
    `lib/compress/hide-consumed.ts`, `lib/compress/state.ts`,
    `lib/gc/merge.ts`, `lib/compress/decompress-logic.ts`, `lib/state/rebuild.ts`
    — verified-state synchronization + transient derived indexes (RC3):
    transient `structureVersion` counter bumped at block-mutation sites; sync
    and hide-consumed skip full replay / reuse cached index when unchanged.
  - `lib/state/persistence.ts` — ordered state-save coalescing (RC4):
    per-session FIFO queue, snapshot captured at enqueue, coalesced writes.
- **Risks**:
  - Version-counter omission at a mutation site → stale cache/skip. Mitigated
    by grepping all liveness mutators (done) + equivalence tests.
  - Save-queue timing changes vs tests that mutate XDG dirs mid-flight.
    Mitigated by capturing file path at enqueue time.
- **Rollback strategy**: revert the PR commits; no persisted-format change to migrate.
