# WORKLOG - V2 opaque-source accounting fix (#420)

- Task ID: `2026-09-17_v2-opaque-accounting`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17 16:00

## 1. Summary

- **What was done** (1–3 sentences):
  Planning for the V2 `compress` tool now excludes host-classified non-removable
  sources (provider-owned opaque records such as completed native compactions)
  from selections and token accounting, rejects opaque-only selections with an
  actionable error, and fails closed when removability cannot be verified.
- **Why** (1–3 sentences):
  Issue #420: `compress` reported savings for messages that
  `restoreMissingV2OpaqueSources` puts back byte-for-byte on every request, so
  the reported compression saved nothing on the wire while still consuming block
  IDs and mutating state.
- **Behavior / compatibility changes**: Yes — V2 hosts that expose the new
  optional `HostServices.nonRemovableSourceIds` capability get corrected
  accounting; hosts without it (V1, fixtures, legacy callers) keep the previous
  behavior exactly. No persisted-state or wire-format change.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| branch `2026-09-17_v2-opaque-accounting` | fix: exclude non-removable V2 sources from compress accounting (#420) |

### Key Files

- `lib/host/types.ts` — new optional `nonRemovableSourceIds?(sessionID)` on
  `HostServices`; absence means "all sources removable" (legacy contract).
- `lib/v2/host.ts` — implements the capability by re-normalizing the projected
  history and collecting `normalizedMessageId`s whose provenance flags say
  `opaque && !allowSourceRemoval` (same predicate
  `restoreMissingV2OpaqueSources` uses), excluding ACP-owned synthetics/notices.
- `lib/compress/range-utils.ts` — exported `filterNonRemovableSources()` plus a
  planning step (after the existing protected-tool/last-user/recent filters)
  that drops those IDs from `messageIds`/`messageTokenById` before char/token
  counting; all-plans-emptied case raises a specific provider-owned-sources
  error; result carries `excludedNonRemovableMessageIds` +
  `skippedNonRemovablePlanIndices`.
- `lib/compress/range.ts` — resolves the capability once per tool execution
  (fail closed on resolver error, no state mutation), passes the set into
  planning, and appends a `⚠️ N provider-owned message(s) excluded ... NO
  savings were counted` note to mixed-selection success output.
- `tests/v2-opaque-accounting.test.ts` — 7 tests: pure filter unit test, host
  classification unit test, resolver failure propagation, opaque-only rejection
  (no state stored), mixed selection with NEXT-REQUEST WIRE verification
  (checkpoint byte-identical, removable messages gone, real byte savings),
  fail-closed execution, legacy no-capability behavior.

## 3. Design & Implementation Notes

See `DESIGN.md` in this folder for the data-flow rationale, including why the
resolver classifies from projection entries even when normalization reports a
correlation rejection, and why summaries reach the model via the compress tool
call rather than injected messages.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm run build
node --import tsx --test tests/v2-opaque-accounting.test.ts
npm test
```

### Results

- `npm run typecheck`: clean.
- `npm run build`: success.
- `tests/v2-opaque-accounting.test.ts`: 7/7 pass.
- Full suite: 1417/1418 pass. The single failure is
  `tests/soft-block.test.ts`, which hardcodes
  `/tmp/opencode-dcp-dangerous-${pid}` at module load
  (`tests/soft-block.test.ts:10`) and cannot create that directory in this
  sandbox where `/tmp` is read-only (`EACCES`). Pre-existing environmental
  incompatibility, unrelated to this change (file untouched by this PR; the
  error occurs before any ACP code runs). CI runners have writable `/tmp`.

### Notes / incidents during development

- Running `npm run format` in this workspace reformatted 427 files: the
  installed Prettier resolves a different `printWidth` than the committed style,
  and CI does not run `format:check`. All formatting noise was reverted
  (`git checkout -- .`); only the four intended lib files carry changes. Do not
  commit repo-wide reformatting from this environment.
