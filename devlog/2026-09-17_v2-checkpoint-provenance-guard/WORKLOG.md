# WORKLOG - V2 provider-checkpoint provenance guard

- Task ID: `2026-09-17_v2-checkpoint-provenance-guard`
- Branch: `2026-09-17_v2-checkpoint-provenance-guard`
- Updated: 2026-09-17

## 1. Commits

| Commit | Description |
|--------|-------------|
| (this devlog's single commit) | fix: stop inferring V2 provider-checkpoint ownership from array position; render uncorrelated checkpoints from source data |

## 2. Key Files

| File | Change |
|------|--------|
| `lib/v2/projection/normalize.ts` | `claimCheckpointRanges`: collect unclaimed candidates in the window and claim only when exactly one exists (>1 = re-expanded originals after incompatible model switch; 0 = checkpoint absent from outgoing view). `buildProviderCheckpoint`: when `outgoingMessageIndices` is empty, render `lowerCompactionText(source)` under key `source:{i}:checkpoint:source` as an opaque origin/part so the direct-tool path keeps the checkpoint's summary + recent context. |
| `lib/v2/projection/types.ts` | Doc comment on `V2ProvenanceEntry.providerCheckpoint` documenting the unsupported-window disclosure semantics. |
| `tests/v2-message-projection.test.ts` | 3 new tests + `switchCheckpoint` / `stringValue` helpers. |

## 3. Test Results

- `npm run typecheck` — pass.
- `node --import tsx --test tests/v2-message-projection.test.ts tests/v2-context-patch.test.ts` — 32 pass / 0 fail (was 29 before this change).
- Full suite `npm test` — 1413/1414 pass; the single failure is `tests/soft-block.test.ts` with `EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-<pid>'` — environmental (`/tmp` read-only in this sandbox), pre-existing at HEAD, unrelated to this change. Passes on CI where `/tmp` is writable.
- Bug-catching verification (per §5.7.3 methodology): with the fix stashed, both `keeps re-expanded originals uncorrelated...` and `renders the provider checkpoint from source data...` FAIL at HEAD; with the fix applied they pass. The compatible-view test passes in both states by design (regression lock).
- `npm run build` — success.

## 4. Findings Recorded (issue #425 thread)

1. **Pre-existing**: the direct-tool view (`normalizeV2ProjectedHistory(projected, [], ...)`, `lib/v2/host.ts:45,52`) reports `valid: false` with rejection `Patchable origin source:N:part:M has no exact lowered outgoing match` for any plain user/assistant source, because patchable text origins get no lowered pointer when there is no outgoing message. Verified identical at HEAD without this diff. Functional impact today is nil (`host.ts` consumes `.messages`, which are fully built regardless of validity), but the invalid flag is misleading. Needs its own issue from a human.
2. **Environmental**: `tests/soft-block.test.ts:10` hardcodes `/tmp/opencode-dcp-dangerous-${process.pid}`; fails with EACCES wherever `/tmp` is read-only.

## 5. Lessons Learned

- Position-based ownership inference is unsafe whenever two histories can diverge (public vs model-aware). Exact identity only; ambiguity → keep everything opaque.
- Running repo-wide `npm run format` with a Prettier version that does not reproduce the committed style (local prettier 3.9.5 wraps at a different width than the committed tree) pollutes the working tree with hundreds of unrelated files. Verify `git status --porcelain` scope immediately after formatting; here the whole tree had to be reverted and the three intended files restored from backup.
- Always verify new bug-catching tests fail against the unfixed code before trusting them.
