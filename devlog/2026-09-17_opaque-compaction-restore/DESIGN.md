# DESIGN - Preserve Opaque V2 Compaction Sources

- Task ID: `2026-09-17_opaque-compaction-restore`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: Accepted

## 1. Problem Statement

V2 request patching intentionally rejects removal of provider-owned opaque
records. The shared ACP transform can nevertheless omit the normalized form of
a completed native compaction record, making the later strict patch fail and
rolling back first-session initialization.

## 2. Goals & Non-Goals

- **Goals**:
    - Retain opaque non-removable sources without weakening patch validation.
    - Commit safe independent ACP edits and state only after a valid patch.
    - Preserve native provider message object identity in the final request.
- **Non-Goals**:
    - Rewrite native compaction/provider state.
    - Restore ACP-owned notices to model context.
    - Change V1 or OpenCode configuration semantics.

## 3. Current Architecture

```text
V2 projected history → normalization/provenance → shared ACP transform
  → ACP notice removal → strict V2 patch → atomic event/state commit
```

The gap is between shared transform and strict patch: a missing opaque source
looks like an attempted provider-owned deletion.

## 4. Proposed Architecture

```text
V2 projected history → normalization/provenance → shared ACP transform
  → remove ACP notices → restore missing protected opaque normalized sources
  → strict V2 patch → atomic event/state commit
```

`restoreMissingV2OpaqueSources()` receives projection entries and transformed
internal messages. It:

1. Identifies only `opaque && !allowSourceRemoval` entries with stable normalized
   IDs, excluding ACP-owned notice/synthetic entries.
2. Validates unique IDs and monotonic source order.
3. Clones only missing normalized sources and inserts them before the next known
   higher source index; appends remaining sources after the final source.
4. Rejects on missing normalized source, missing exact lowered correlation,
   duplicate IDs/indexes, or ordering ambiguity.

The existing patcher remains responsible for retaining actual V2 outgoing
provider objects. Restoration changes internal algorithm input only.

## 5. Decisions & Rationale

| Decision                        | Alternatives                     | Chosen                    | Why                                                           |
| ------------------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Handle omission before patching | Permit opaque removal in patcher | Restore normalized source | Preserves fail-closed provider-data protection.               |
| Clone restored internal values  | Reuse projection message objects | Clone                     | Prevents transform/state aliasing.                            |
| Fail closed on ambiguity        | Guess by array position          | Reject                    | A wrong provider patch is worse than a skipped ACP transform. |

## 6. Impact Analysis

- **Backward compatibility**: No state or config migration; V1 untouched.
- **Performance**: One linear pass over projection entries/transformed messages.
- **Security**: Provider-owned content remains opaque and identity-preserved.
- **Dependencies**: None.

## 7. Verification

- Pure restoration tests cover ordering, duplicate prevention, correlation loss,
  empty transformed input, and deep clone isolation.
- V2 context test recreates a fresh session with native compaction/provider data,
  verifies persistence and outgoing object identity, and exercises subsequent
  direct tool state acquisition.
- Two independent reviewers inspect every changed source and test file before
  commit.
