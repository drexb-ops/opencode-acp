# WORKLOG - ACP Transform Performance

- Task ID: `2026-09-11_acp-transform-performance`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-11

## 1. Summary

- **What was done**: audited the transform path, documented the approved design, and implemented request-scoped candidate indexes, lazy nudge analysis, verified compression-state indexes, transient consumed-call indexes, and ordered state persistence.
- **Why**: OpenCode remains slow after repeated ACP compressions despite prior idle candidate-planning gating.
- **Behavior / compatibility changes**: Runtime output and persisted JSON schema remain compatible. Stable turns avoid repeated historical graph replay; candidate planning reuses request-local indexes; persistence saves are ordered and coalesced.
- **Risk level**: Medium. The optimized paths maintain compression graph and persistence correctness.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `d7a4f26` | Record approved performance design and devlog. |
| `126f5ef` | Coalesce persisted state saves with ordered per-path queue. |
| `050011c` | Reuse request-scoped candidate boundary and anchor indexes. |
| `3268a04` | Skip stable block replay and cache consumed calls. |
| `65c2a87` | Skip idle nudge analysis and add multi-turn regression. |
| `7d46424` | Preserve cold-state hide behavior and optional search indexes. |
| `02e4102` | Invalidate derived indexes on graph mutation and track block versions. |

### Key Files

- `lib/compress/search.ts` - request-scoped boundary and summary indexes.
- `lib/messages/inject/inject.ts` - lazy T1 analysis with preserved tier/emergency output.
- `lib/messages/sync.ts` - verified stable-state path with mutation invalidation.
- `lib/compress/hide-consumed.ts` - versioned historical call index and active-block fast path.
- `lib/state/persistence.ts` - ordered per-path save coordinator.

## 3. Design & Implementation Notes

- **Entry point / key function**: `createChatMessageTransformHandler` in `lib/hooks.ts`.
- **Key logic explanation**: the phases remove repeated work without relaxing range-executor validation. State-dependent indexes are transient, versioned, and invalidated by graph changes; unverified/cold calls retain the rebuild fallback.

## 4. Testing & Verification

### Baseline Measurements

- Isolated candidate planning with simple messages: approximately 3.2 ms at 100 messages, 34 ms at 500, and 105 ms at 1,000.
- Isolated `syncCompressionBlocks` with 500 messages: approximately 0.09 ms at 100 blocks, 0.30 ms at 500, 0.48 ms at 1,000, and 0.89 ms at 2,000. It still performs unnecessary historical work and can grow materially with realistic block data.
- Post-change candidate planning: approximately 1.62 ms at 100 messages, 3.90 ms at 500, 6.56 ms at 1,000, and 7.18 ms at 1,500 (median after warm-up).
- Post-change stable sync with 1,000 messages: approximately 0.06 ms at 100 inactive blocks, 0.05 ms at 1,000, 0.04 ms at 5,000, and 0.04 ms at 10,000 in the steady-state synthetic probe.

### Verification Commands

```sh
npm run typecheck
npm test
npm run format:check
npm run build
./scripts/dev-deploy.sh --check
```

- `npm test`: 1,243/1,243 passed after the final derived-index follow-up; focused sync/hide tests passed 31/31 and typecheck passed after it.
- `npm run typecheck`: passed after all source changes.
- `npm run build`: passed after the final derived-index follow-up.
- `npm run format:check`: repository baseline remains non-zero with 434 files reported; no broad formatting rewrite was applied.

## 5. Risk Assessment & Rollback

- **Risk points**: stale derived indexes, changed nudge timing/text, persistence save ordering.
- **Rollback method**: revert the scoped implementation commits. No persisted-state migration is introduced.
- **Compatibility notes**: no data-format or configuration changes planned.

## 6. Follow-ups

- [x] File official issue: `https://github.com/ranxianglei/opencode-acp/issues/384`.
- [x] Implement and measure each phase before proceeding to the next.
- [ ] Obtain two independent source and test reviews before PR creation.
