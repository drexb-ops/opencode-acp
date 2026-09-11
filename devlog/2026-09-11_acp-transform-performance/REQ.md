# REQ - ACP Transform Performance

- Task ID: `2026-09-11_acp-transform-performance`
- Home Repo: `opencode-acp`
- Created: 2026-09-11
- Status: InProgress
- Priority: P1
- Owner: drexb-ops
- References: performance investigation for long, heavily compressed OpenCode sessions

## 1. Background & Problem Statement

- **Context**: ACP's message-transform hook runs before every model request. Sessions with many messages and historical compression blocks become visibly slow even though ACP must retain block lineage for decompression and fork recovery.
- **Current behavior**: candidate planning takes about 3.2 ms with 100 messages, 34 ms with 500 messages, and 105 ms with 1,000 messages in a local isolated probe. Stable transforms also sort and replay all blocks, including inactive history.
- **Expected behavior**: normal transforms should avoid work that cannot affect the current output. Candidate planning must keep exact execution semantics when a nudge is emitted.
- **Impact**: slow OpenCode interaction after repeated compression reduces usability and undermines the value of ACP.

## 2. Reproduction

- **Environment**:
  - Node: project-supported Node runtime
  - OS/Arch: linux
- **Minimal reproduction steps**:
  1. Create a session with 500-1,000 messages and a large number of historical compression blocks.
  2. Continue normal conversation after multiple compression and decompression operations.
  3. Observe delayed message-transform completion before model requests.
- **Relevant configuration**: default ACP compression behavior with adaptive candidates enabled; no debug context snapshots for CPU-only measurements.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state schema, message references, block lineage, decompression, and fork recovery must remain compatible.
  - Performance requirements: candidate planning at 1,000 messages should improve from about 105 ms to at most 20 ms; adding 1,000 inactive blocks should add no more than 20% or 5 ms to stable transforms.
  - Resource limits: caches must be request-scoped or bounded/transient and must not retain complete message arrays across turns.
- **Non-Goals**:
  - Replacing ACP's compression model, prompt content, or candidate-selection policy.
  - Deleting inactive blocks or changing persisted JSON format.
  - Worker threads, a database, new dependencies, or configuration flags unless profiling proves the smaller changes insufficient.

## 4. Acceptance Criteria

- **Correctness**:
  - [ ] Candidate output remains deterministic, pair-safe, protected-content-safe, non-overlapping, and capped at 12.
  - [ ] Every emitted candidate still passes the existing range executor validation.
  - [ ] Compression, decompression, nested blocks, fork recovery, and persisted sessions continue to work.
- **Performance / Stability**:
  - [ ] Candidate validation avoids rebuilding global boundary indexes for every draft.
  - [ ] Ordinary no-nudge transforms skip T1 range and candidate analysis.
  - [ ] Stable transforms avoid replaying inactive block history when indexes are verified.
  - [ ] State writes are ordered and cannot let older snapshots overwrite newer snapshots.
- **Regression**:
  - [ ] New/modified tests cover cache invalidation, nudge behavior, boundary resolution, and persistence ordering.
  - [ ] Benchmark harness reports median and p95 for representative fresh, long-history, and compressed-history fixtures.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/compress/search.ts`, `lib/compress/types.ts`, and `lib/messages/inject/candidates.ts` for request-scoped indexes.
  - `lib/messages/inject/inject.ts` for lazy no-nudge execution.
  - `lib/messages/sync.ts` and compression/decompression mutators for verified-state fast paths.
  - `lib/compress/hide-consumed.ts` for transient immutable call indexes.
  - `lib/state/persistence.ts` for ordered, coalesced saves.
- **Risks**: stale indexes could hide or revive the wrong block; lazy nudge analysis could alter visible text; save coalescing could lose state if ordering is wrong.
- **Rollback strategy**: each phase is independently reversible. Revert the corresponding commit(s); the persisted state format stays unchanged.
