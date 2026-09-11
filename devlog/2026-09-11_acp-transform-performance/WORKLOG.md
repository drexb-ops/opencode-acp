# WORKLOG - ACP Transform Performance

- Task ID: `2026-09-11_acp-transform-performance`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-11

## 1. Summary

- **What was done**: audited the transform path, measured isolated candidate planning, and documented an approved staged optimization design.
- **Why**: OpenCode remains slow after repeated ACP compressions despite prior idle candidate-planning gating.
- **Behavior / compatibility changes**: No runtime behavior changed yet.
- **Risk level**: Medium. The optimized paths maintain compression graph and persistence correctness.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| Pending | Record approved design and implement phased transform optimizations. |

### Key Files

- `lib/compress/search.ts` - planned request-scoped boundary and summary indexes.
- `lib/messages/inject/inject.ts` - planned lazy T1 analysis.
- `lib/messages/sync.ts` - planned verified stable-state path.
- `lib/compress/hide-consumed.ts` - planned transient immutable call index.
- `lib/state/persistence.ts` - planned ordered save coordinator.

## 3. Design & Implementation Notes

- **Entry point / key function**: `createChatMessageTransformHandler` in `lib/hooks.ts`.
- **Key logic explanation**: the first phases remove repeated work without relaxing the existing range executor validation. State-dependent caches are transient and invalidated by graph changes.

## 4. Testing & Verification

### Baseline Measurements

- Isolated candidate planning with simple messages: approximately 3.2 ms at 100 messages, 34 ms at 500, and 105 ms at 1,000.
- Isolated `syncCompressionBlocks` with 500 messages: approximately 0.09 ms at 100 blocks, 0.30 ms at 500, 0.48 ms at 1,000, and 0.89 ms at 2,000. It still performs unnecessary historical work and can grow materially with realistic block data.

### Pending Commands

```sh
npm run typecheck
npm test
npm run format:check
npm run build
./scripts/dev-deploy.sh --check
```

## 5. Risk Assessment & Rollback

- **Risk points**: stale derived indexes, changed nudge timing/text, persistence save ordering.
- **Rollback method**: revert the scoped implementation commits. No persisted-state migration is introduced.
- **Compatibility notes**: no data-format or configuration changes planned.

## 6. Follow-ups

- [ ] File official issue and link the feature PR.
- [ ] Implement and measure each phase before proceeding to the next.
- [ ] Obtain two independent source and test reviews before PR creation.
