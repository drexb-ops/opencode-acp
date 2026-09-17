# WORKLOG - Recognize Failed V2 ACP Tool Results as Failures

- Task ID: `2026-09-17_v2-failed-tool-recognition`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17

## 1. Summary

- **What was done**: `createV2Tool` resolved error results now carry explicit
  `acpFailed: true` metadata; the internal V2 projection (`toolState`) maps a
  host-`completed` result for one of the five ACP tools to an internal
  `status: "error"` state when that metadata is present or the output matches
  the anchored ACP failure-text pattern (historical compat) — without exposing
  any provider-owned `output`, so outgoing messages are never rewritten. The
  installed E2E fake provider reuses the same pattern for its classifier, and
  the nudge-growth driver now asserts genuine `completed` status for compress
  results.
- **Why**: The pinned `@opencode/plugin@2.0.3` Promise adapter has no safe
  native error channel, so caught failures were recorded by the host as
  `completed` and downstream logic (nudge success baselines, cold-start block
  reconstruction, `messageHasCompress`) treated failures as successes.
- **Behavior / compatibility changes**: Yes — internal V2 projection only.
  Failed V2 ACP tool results are now visible to ACP internals as failed tools
  (same shape V1 already produces for real errors). Host/provider-owned output
  is byte-identical before and after. Successful ACP outputs, non-ACP tools,
  native host error states, and all V1 paths are unchanged. Existing per-reason
  metadata flags are preserved (`acpFailed` is additive).
- **Risk level**: Low — recognition is confined to the projection boundary;
  patcher invariants (status-change rejection, output correlation) verified in
  DESIGN.md §4.

## 2. Change Log

### Commits

| Commit  | Description                                                  |
| ------- | ------------------------------------------------------------ |
| `<sha>` | fix: recognize failed V2 ACP tool results as failures (#426) |

### Key Files

- `lib/v2/projection/acp-failure.ts` — NEW pure module: canonical ACP tool-name
  list, `ACP_FAILURE_METADATA_KEY`, anchored `ACP_FAILURE_OUTPUT_PATTERN`,
  `isAcpToolName`, `isAcpFailedToolOutput`. Dependency-free so the unit tests,
  the projection, and the E2E fake provider all share one definition.
- `lib/v2/tools.ts` — imports/re-exports `V2_ACP_TOOL_NAMES` from the new
  module; `errorResult()` merges `acpFailed: true` into every resolved error
  result's metadata (single choke point covering all current and future error
  paths).
- `lib/v2/projection/shared.ts` — `toolState()` completed branch: recognized
  ACP failure → internal `{status:"error", input, error, metadata}` with NO
  `output` field (load-bearing: keeps origin correlation exact and prevents
  the patcher from touching provider-owned output).
- `scripts/e2e/fake-llm-server.ts` — `inspectToolResults` classifies ACP-named
  tool results with the shared anchored pattern; legacy regex retained for
  non-ACP tools.
- `scripts/e2e/installed-v2.ts` — nudge-growth stage asserts the observed
  compress result status is genuinely `"completed"` after each nudge.
- `tests/v2-failed-tool-recognition.test.ts` — NEW: 18 tests across four
  sections (pure module, projection, cold rebuild, warm nudge baselines).
- `devlog/2026-09-17_v2-failed-tool-recognition/{REQ,WORKLOG,DESIGN}.md`.

## 3. Design & Implementation Notes

See `DESIGN.md` for the full data-flow analysis and invariants. Key points:

- Recognition happens at **projection time** (host history → internal parts),
  not in the shared transform: the patcher rejects transforms that change a
  tool part's status relative to the original projection, so both sides of the
  comparison must already agree on `error`.
- Explicit metadata is authoritative; the text pattern is only a fallback for
  pre-fix host history ("compatible historical failure output").
- The pattern is anchored at position zero with no multiline flag, so quoted
  historical failure text inside a larger success output can never
  misclassify it.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/*.test.ts
npm run build
```

### Test Coverage

- New test file: `tests/v2-failed-tool-recognition.test.ts` (18 tests):
    - acp-failure module: name list, all 9 failure shapes match at position 0,
      mid-output occurrences rejected, success outputs rejected, metadata
      precedence, non-ACP exclusion.
    - Projection: metadata-flagged → error; historical-text-only → error;
      successful ACP → completed; non-ACP error-looking text untouched;
      multi-line quoted failure stays completed; native error/running states
      unchanged; reclassified state exposes no `output`.
    - Cold rebuild: failed compress part → 0 blocks rebuilt; mixed failed +
      successful → exactly 1 block from the successful call.
    - Warm nudges (multi-turn, shared state, `preserveRecentMessages: 20` per
      AGENTS.md §5.7.1): failed attempt clears turn/iteration anchors and
      `lastNudgeShownTokens`, leaves `lastPerMessageNudgeTokens` unchanged and
      `compressBaselineSet` false; control proves a successful compress advances
      the baseline and sets the flag.
- Bug-detection check (AGENTS.md §5.7.3): with the `shared.ts` change reverted,
  the two recognition pinning tests fail; restored → all pass.
- Full suite: 1429 tests, 1428 pass, 1 fail — `tests/soft-block.test.ts`
  crashes at import in this sandbox because it hardcodes `mkdirSync('/tmp/...')`
  and `/tmp` is read-only here (environmental; passes in CI with a writable
  `/tmp`). Unrelated to this change.
- Typecheck: pass. Build: pass. Format: pass.

### Results

- **PASS** (modulo the environmental soft-block sandbox failure above).

## 5. Risk Assessment & Rollback

- **Risk points**:
    - False positives would demote successful ACP calls to errors. Mitigated by
      position-zero anchoring, the explicit allowlist of five tool names, and
      tests asserting every known success prefix stays completed.
    - Patcher correlation breakage. Mitigated: no `output` exposed on the
      reclassified branch ⇒ `origin.normalizedOutput` stays undefined ⇒ output
      comparison skipped; error text identical on both sides ⇒ no rejection.
- **Rollback method**:
    - Revert commit(s): `<sha>`
    - Rollback impact: restores pre-fix behavior (failures treated as completed);
      no persisted-state migration involved, so rollback is clean.
- **Compatibility notes** (data format, config schema): No persisted format or
  config changes. `acpFailed` metadata appears in host-recorded tool state for
  new sessions only; old history is covered by the text fallback.

## 6. Lessons Learned

- The Promise adapter's missing error channel makes "resolved but failed" a
  first-class input shape for the V2 surface — any future V2 tool must return
  through `errorResult()` (or otherwise set `acpFailed`) or it will be
  misread as success.
- Nudge unit tests need three harness details that are easy to get wrong:
  `state.modelContextLimit` set, an established baseline
  (`lastPerMessageNudgeTokens = 0`), and handler invocations ending on a user
  message (the pipeline runs before the assistant responds).
- `getCurrentTokenUsage` derives usage from the last assistant
  `info.tokens` (Bug 17), not raw content — fixtures must carry realistic token
  info or nudges silently never fire.

## 7. Follow-ups

- [ ] If the `@opencode/plugin` pin moves, revisit using the native Effect
      error channel (`Effect<Result, Tool.Error>`) instead of resolved
      error-results (non-goal of this iteration).
