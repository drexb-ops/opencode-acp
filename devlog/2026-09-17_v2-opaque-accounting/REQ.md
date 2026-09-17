# REQ - Stop Reporting Savings for Non-Removable Opaque V2 Sources

- Task ID: `2026-09-17_v2-opaque-accounting`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- References: https://github.com/ranxianglei/opencode-acp/issues/420 (follow-up to #418)

## 1. Background & Problem Statement

- **Context**: After the #418 fix, ACP restores provider-owned opaque V2
  sources (e.g. completed native compaction records) verbatim before strict
  patching, so the wire is safe. But the compress tool still _plans and
  accounts_ for those sources: they enter selections and saved token/block
  accounting even though every later request restores them unchanged.
- **Current behavior (symptom)**: Running the real V2 `compress` definition on
  a range whose only target is a long completed local compaction (`providerState`,
  no `providerContext`) reports `Compressed 1 messages ...`, creates one block,
  marks the source consumed — while the next request still carries the original
  checkpoint byte-for-byte. Reported savings are false.
- **Root cause**: `lib/compress/range-utils.ts` `prepareExecutableRangePlans`
  applies protected-tool / last-user / recent-message soft filters but has no
  notion of host-level source removability. The V2 adapter never tells the
  planner which normalized messages can actually be removed from outgoing
  context (`opaque && !allowSourceRemoval`).
- **Expected behavior**:
    - Opaque-only selections fail with a clear explanation; no block, no
      savings are reported.
    - Mixed removable/non-removable selections count and store only the
      removable content, and the tool output explicitly reports what was
      excluded and not compressed.
    - The next request's bytes/content are validated in tests, not just block
      counts.
- **Impact**: False savings corrupt token stats, block coverage, quality-gate
  input, and model-visible compression feedback for every V2 session that has
  native compaction or other provider-owned records.

## 2. Reproduction

- **Environment**: OpenCode V2 `2.0.3`, Linux, dual-runtime fork at `1fe36e0`.
- **Minimal reproduction steps**:
    1. Session history: user message, completed local compaction record
       (`providerState`, `summary`, `recent`, no `providerContext`), then more
       user messages outside recent protection.
    2. Run the real V2 `compress` definition targeting only the compaction ref
       with a short summary.
    3. Observe success + one block, then run shared pruning, opaque restoration,
       and strict V2 patching against the original lowered history: the
       checkpoint is still on the wire unchanged while savings were reported.
- **Relevant configuration**: defaults; `preserveRecentMessages` large enough
  that only the explicit target matters.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Preserve V1 behavior exactly: hosts without provenance capability keep
      today's planning/accounting unchanged.
    - Never weaken opaque protection (#418 restoration/patching stays as-is);
      do not make counters agree by allowing removal.
    - Fail closed: if source removability cannot be established, reject the
      compression instead of proceeding unfiltered.
    - No new dependencies; public V2 APIs only; internal `dcp-*` naming and
      persisted state schema untouched.
- **Non-Goals** (explicitly out of scope):
    - Marking opaque sources as BLOCKED candidates in nudge/range listings
      (transform-time candidate guidance; follow-up).
    - Changing how prune/restoration interact with blocks that already contain
      legacy opaque IDs from pre-fix sessions.
    - Releasing/publishing; PR merge remains human-only.

## 4. Acceptance Criteria

- **Correctness**:
    - [ ] Opaque-only selection: tool rejects with an actionable explanation;
          zero blocks created; zero tokens counted; state unchanged.
    - [ ] Mixed selection: block covers exactly the removable messages;
          reported compressed message count and token accounting exclude the
          non-removable ones; success output names the exclusion.
    - [ ] Next-request verification: after a mixed compression, running the
          real V2 context handler over the original lowered history yields an
          accepted patch where the original checkpoint message is present and
          byte-identical, and the compressed messages are replaced by the
          summary block.
    - [ ] Fail-closed: a host whose removability lookup throws causes the
          compress call to fail with an actionable error and no state mutation.
    - [ ] V1 hosts (no capability) behave exactly as before.
- **Performance / Stability**:
    - [ ] No extra per-transform work; the removability lookup happens once per
          compress tool execution (same cost profile as the existing history
          fetch).
- **Regression**:
    - [ ] New test file added under `tests/`; full suite, typecheck, build, and
          format checks pass.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/host/types.ts` — optional `nonRemovableSourceIds?` capability on
      `HostServices`.
    - `lib/v2/host.ts` — implement it by normalizing the projected history and
      collecting `opaque && !allowSourceRemoval` entries (mirroring the
      restore.ts protected-entry predicate, excluding ACP-owned synthetics).
    - `lib/compress/range-utils.ts` — new soft filter step in
      `prepareExecutableRangePlans` (option `nonRemovableMessageIds`),
      dedicated error for opaque-only ranges, return excluded/skipped info.
    - `lib/compress/range.ts` — resolve the set after `prepareSession`
      (fail-closed), pass it into planning, append an exclusion note to the
      success output.
    - Tests: new `tests/v2-opaque-accounting.test.ts`.
- **Risks**:
    - Double normalization per compress call (messages() + removability) —
      acceptable: compress is rare vs. per-request transforms.
    - Stale set if the session changes between the two fetches — harmless: new
      messages are outside the model's ref space.
- **Rollback strategy**: revert the branch; capability is optional, so V1/V2
  both revert to prior behavior cleanly.
