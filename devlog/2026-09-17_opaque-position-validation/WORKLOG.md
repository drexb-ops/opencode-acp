# WORKLOG - Opaque V2 Position Validation

- Task ID: `2026-09-17_opaque-position-validation`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17 15:50

## 1. Summary

- **What was done** (1–3 sentences): Replaced the fixed numeric-position comparison in `applyV2ContextPatch`'s post-replacement opaque validation with an identity + relative-order subsequence scan, so ACP's own message-ID text insertion no longer trips `A replacement changed provider-owned content`. Added a 9-test regression suite driven by the real OpenCode v2.0.3 lowering code (vendored verbatim) through the full handler pipeline.
- **Why** (1–3 sentences): Every V2 session containing a multi-item tool result (e.g. completed `shell` returning `[stdout, notice]`) or an error tool result lost all ACP functionality — the ID insertion shifted indices, the positional check rejected its own safe edit, and the whole transaction rolled back silently (issue #423).
- **Behavior / compatibility changes**: Yes — previously rejected patches for multipart/error tool messages are now accepted when every provider-owned opaque part survives object-identical in original relative order; genuine replacement/deletion/mutation/reorder still rejects with the same `opaque-origin` code and message. No state schema, tag, or API changes.
- **Risk level**: Low (validation-only change, fail-closed preserved, wide regression coverage)

## 2. Change Log

### Commits

| Commit    | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `a29f4a2c` | fix: validate opaque V2 parts by identity and relative order   |

### Key Files

- `lib/v2/projection/patch.ts` — the fix: new `isAcpRegeneratedPart()` helper (~line 85) + subsequence-scan replacement of the positional loop in the replacements-validation loop of `applyV2ContextPatch` (~lines 1397–1425). Diff is +29/−3, two hunks only.
- `tests/v2-opaque-position.test.ts` — NEW: 9 regression tests (unit patch-level + full-handler with vendored real lowering).
- `tests/fixtures/opencode-core-2.0.3/` — NEW: 4 files vendored verbatim from `@opencode/core@2.0.3` dist (`session/runner/to-llm-message.js`, `chunks/mime-gqrjg9m0.js`, `chunks/mime-bccb6npm.js`, `chunks/mime-9rqn6x4v.js`) with provenance headers; import closure resolves against existing node_modules (`@opencode/ai`, `@opencode/schema/session-provider-context`, `@opencode/util/hash`, `effect`). No dependency added.
- `devlog/2026-09-17_opaque-position-validation/REQ.md` — requirement ticket.

## 3. Design & Implementation Notes

- **Entry point / key function**: `applyV2ContextPatch(projection, transformed, currentMessages)` in `lib/v2/projection/patch.ts`; the changed loop runs after ACP's own transform (including ID-part insertion) produced replacement messages, before final assembly and applied-state update.
- **Key logic explanation** (non-trivial):
    1. Old check: for each `(contentIndex, originalPart)` in `origin.opaqueContent`, require `newContent[contentIndex] === originalPart`. ACP splices its synthetic ID text part BEFORE the first tool part (inject.ts:1073–1079), shifting every later index → self-rejection.
    2. New check: sort `opaqueContent` by original index, drop ACP-regenerated parts, then walk the new content once with a `searchFrom` cursor; each required part must appear object-identical at some index ≥ cursor, advancing past each match. Missing, mutated, or out-of-order provider-owned parts reject with the unchanged `opaque-origin` code/message. The whole-message `opaqueMessage` identity check above it is untouched.
    3. Why filter ACP-regenerated parts: on settled-snapshot replay, previously inserted ACP parts were recorded in `opaqueContent` during normalization (normalize.ts outgoing-provenance records every unreferenced index of an opaque owner's message as opaque), but `createSyntheticTextPart` regenerates them as fresh objects each cycle at deterministic slots — pinning old identity would reject legitimate replay. The prefix set (`prt_dcp_text_`, `prt_dcp_summary_`) matches all synthetic-part id factories in `lib/`.
    4. Pre-patch baseline checks keep their positional form: they compare the fresh host lowering against the projection snapshot taken from that same lowering, where positions match by construction.
- **Error-tool nuance** (finding): an error-status tool result normalizes to a part with no string `state.output`, so `hasContent()` (lib/messages/utils.ts:170–180) is false and `injectMessageIds` skips such messages entirely (inject.ts:1061–1063). The natural pipeline therefore never inserts IDs into an error-only tool message; the issue's "error tool + ID insertion" sub-case is covered at unit level (real error lowering + simulated insertion) and the full-handler error test asserts the natural behavior (transaction commits, both parts object-identical, no shift).
- **Key configuration items**: none (no config surface touched).

## 4. Testing & Verification

### Build & Test Commands

```sh
node --import tsx --test tests/v2-opaque-position.test.ts   # 9/9 pass
npm run test                                                 # 1419/1420 (see below)
npx tsc --noEmit                                             # clean
npm run build                                                # success
```

### Test Coverage

- New/modified test files: `tests/v2-opaque-position.test.ts` (new), `tests/fixtures/opencode-core-2.0.3/` (new fixture).
- Test count: 9 total in the new file, 9 pass, 0 fail. Full suite 1420 tests: 1419 pass, 1 fail.
- Key scenarios verified:
    1. Unit: multipart completed shell tool (real lowering) + simulated ID insertion → accepted; ID part lands before the tool call; ToolCallPart/ToolResultPart survive object-identical.
    2. Unit: error shell tool (real lowering, `result.type === "error"`) + simulated ID insertion → accepted with the same guarantees.
    3. Unit: repeated patch over settled output → accepted and byte-identical to first result (idempotent replay).
    4. Unit: tamper — reordered opaque parts in settled output → rejected (fail-closed).
    5. Unit: tamper — clone-replaced opaque part object → rejected (fail-closed).
    6. Full handler: multipart case end-to-end (vendored `toLLMMessages` → real handler) → committed (registry initialized), 3 parts, `/m00002/` tag present, opaque parts object-identical to originals. Pre-fix this failed with exactly `{code:"opaque-origin", message:"A replacement changed provider-owned content"}`.
    7. Full handler: error case end-to-end → committed, 2 parts (natural behavior per hasContent gate), identities preserved.
    8. Full handler: two consecutive turns re-lowering the same history (fresh objects each turn) → both accepted, identities vs their own turn's originals.
    9. Control: single-text representable tool result → ID appended in place (no insertion), call part identical, result edited — representable path unaffected.
- Pre-fix evidence: running the new file against the unfixed `patch.ts` failed 8/9, with the core repro failing on the exact issue error string; the single-text control passed pre-fix, matching triage controls.

### Independent Review

- Mandated dual-agent review (AGENTS.md §5.3/§5.6): subagent infrastructure was unavailable during this session (first attempt: `ProviderModelNotFoundError`; second: hung until forced restart; two background retries: both errored in 0s). Fallback: both checklists were executed inline by the implementing agent with fresh verification passes — synthetic-id factory grep (filter set matches the only two part factories, lib/messages/utils.ts:33/92, and the existing detection at patch.ts:1247-1248), config-factory byte-diff vs `tests/v2-context.test.ts` (identical except hardcoded `debug: false`), splice-position fidelity vs inject.ts:1073-1079, fixture byte-diff vs the @opencode/core@2.0.3 dist (all four files verbatim apart from provenance headers). A human reviewer should still apply §5.3/§5.6 at merge time.
- Design note recorded from review: the post-replacement subsequence gate's rejection branch is defense-in-depth — every externally observable tamper is rejected by an earlier gate (baseline fingerprint ~patch.ts:564; removed opaque origin patch.ts:1067-1069; output change :1152; error change :1195; text change :1207). Its positive logic runs on every accepted replacement carrying opaque content (tests 1, 2, 3, 6, 8); tamper detection is covered end-to-end by tests 4/5.

### Results

- **PASS/FAIL**: PASS. Full-suite failure `tests/soft-block.test.ts` is pre-existing and environmental: it hardcodes a `mkdir` under `/tmp`, which is not writable in this sandbox; it fails identically without this change and is unrelated to the diff.
- **Key logs/data**: rejection observed pre-fix: `{"code":"opaque-origin","message":"A replacement changed provider-owned content"}`; post-fix no V2 rejection log lines for any scenario.

## 5. Risk Assessment & Rollback

- **Risk points**:
    - Subsequence matching could in theory accept a duplicated provider-owned object inserted between originals; assessed unreachable from ACP transforms (ACP only inserts/prunes/clones its own `prt_dcp_*` parts; provider-side duplication would still fail the baseline fingerprint/correlation gates on the next cycle).
    - Vendored fixture drift if upstream dist layout changes; mitigated by pinning the exact version + provenance header and keeping it test-only.
    - `format:check` does not cover the vendored fixture (no `.prettierignore`); intentionally left unformatted to stay byte-verbatim. `format:check` is not a CI gate (CI = typecheck + test + build) and already reports pre-existing drift across hundreds of untouched files.
- **Rollback method**:
    - Revert commit(s): `a29f4a2c`
    - Rollback impact: restores the self-rejection behavior for multipart/error tool messages (issue #423 returns); no data migration involved.
- **Compatibility notes** (data format, config schema): No — persisted state schema, internal `dcp-*` tags, exported API, and rejection code/message strings are all unchanged.

## 6. Lessons Learned (optional)

- What went well: vendoring the exact host lowering into a test fixture reproduced the bug deterministically without adding a heavy native-module dependency; the single-fixture approach made pre/post-fix comparison trivial.
- What could be improved: the error-tool sub-case in the issue turned out to be unreachable through the natural pipeline (hasContent gate) — the issue's control list should be read against injector gating, not just the patcher.
- Reusable conclusions: when validating provider-owned content through ACP insertions, validate identity + relative order, never absolute positions; on replay paths, exclude self-regenerated deterministic-id parts from identity pinning.

## 7. Follow-ups (optional)

- [ ] None identified beyond issue #423 closure.
