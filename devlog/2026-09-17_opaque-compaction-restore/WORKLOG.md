# WORKLOG - Preserve Opaque V2 Compaction Sources

- Task ID: `2026-09-17_opaque-compaction-restore`
- Home Repo: `opencode-acp`
- Status: ReadyForLocalActivation
- Updated: 2026-09-17
- References: #418, #395

## 1. Summary

- Added a V2 provenance-based restoration step for opaque, non-removable native
  sources omitted by the shared ACP transform.
- This fixes the real V2.0.3 failure in which a completed native compaction
  record rejected context patching and left the direct `compress` tool without
  initialized session state.

## 2. Change Log

### Commits

| Commit  | Description                                         |
| ------- | --------------------------------------------------- |
| Pending | Restore missing opaque V2 compaction sources safely |

### Key Files

- `lib/v2/projection/restore.ts` — source-order, cloned restoration with
  ambiguity rejection.
- `lib/v2/context.ts` — restoration before strict V2 patching.
- `tests/v2-context-patch.test.ts` — pure ordering/correlation/clone coverage.
- `tests/v2-context.test.ts` — fresh native compaction and direct-tool
  initialization regression.

## 3. Verification

- `npm test`: 1,418/1,418 passed.
- `npm run typecheck`, `npm run build`, `npm run verify:package`, targeted
  Prettier, and `git diff --check`: passed.
- Reviewer A (`ses_f5369cf97ffeHaNhycQ56NWOMp`) and Reviewer B
  (`ses_f5369ce49ffeM4Oq4CqbUgKYFQ`) completed independent read-only review of
  the current source/test/worklog diff with no residual P0–P2 findings.

## 4. Activation Follow-up

- Commit and restart the local OpenCode service once.
- Verify the real session initializes and its manual ACP compression completes.
- Push the branch and open a human-reviewed PR referencing `Fixes #418`.
