# ACP Transform Performance Design

Status: approved by user on 2026-09-11.

## Goal

Make OpenCode interaction remain smooth in long ACP sessions without weakening compression quality, protection rules, decompression, fork recovery, or persisted-state compatibility.

## Evidence

An isolated local probe measured adaptive candidate planning at about 3.2 ms for 100 messages, 34 ms for 500, and 105 ms for 1,000. The candidate planner repeatedly constructs boundary indexes and scans active summaries for each candidate draft. Stable transforms also replay historical compression blocks and rebuild immutable consumed-call indexes.

## Chosen Design

1. Build boundary and summary indexes once per candidate-planning request. Reuse them for all candidate drafts, while retaining the existing exact range executor validation.
2. Do not compute T1 composition, protection, range, or candidate data on a transform that cannot emit a T1 nudge. Preserve T2/T3 cadence and calculate breakdown data only when it will be displayed.
3. Treat the existing `membershipsVerified` property as a real stable-state invariant. Rebuild active indexes only after invalidating mutations, including decompression and external repair.
4. Cache immutable historical consumed-call IDs in a transient `WeakMap`; derive live ranges from active blocks each time.
5. Coalesce asynchronous state writes per storage path so only the newest pending snapshot is written after the active write.

## Correctness Rules

- Candidate contents and ordering must remain deterministic, safe for tool pairs, protected-content safe, non-overlapping, and capped at 12.
- A suggested candidate must still pass the range executor's normal validation and filters.
- Inactive blocks stay in persisted history; no migration or new dependency is added.
- Caches retain no complete message history across transforms and never enter persisted state.

## Validation

Benchmark fresh, 1,000-message, and 1,000-block scenarios. Target candidate planning at 1,000 messages of 20 ms or less and stable-turn block-history overhead no greater than 20% or 5 ms. Add correctness tests for indexed boundary resolution, no-nudge laziness, graph-index invalidation, consumed-call cache invalidation, and ordered save behavior. Run full project validation and relevant E2E scenarios before local deployment.

## Explicitly Deferred

Worker threads, databases, persisted cache formats, state compaction, and cross-turn message-array caching are deliberately excluded. They are not necessary until the confirmed repeated CPU work is removed and measured.
