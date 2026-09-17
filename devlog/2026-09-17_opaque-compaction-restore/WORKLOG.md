# WORKLOG - Preserve Opaque V2 Compaction Sources

- Task ID: `2026-09-17_opaque-compaction-restore`
- Home Repo: `opencode-acp`
- Status: ReadyForPR
- Updated: 2026-09-17 00:22 UTC
- References: #418, #395

## 1. Summary

- Added a V2 provenance-based restoration step for opaque, non-removable native
  sources omitted by the shared ACP transform.
- This fixes the real V2.0.3 failure in which a completed native compaction
  record rejected context patching and left the direct `compress` tool without
  initialized session state.

## 2. Change Log

### Commits

| Commit    | Description                                         |
| --------- | --------------------------------------------------- |
| `820f340` | Restore missing opaque V2 compaction sources safely |

### Key Files

- `lib/v2/projection/restore.ts` — source-order, cloned restoration with
  ambiguity rejection.
- `lib/v2/context.ts` — restoration before strict V2 patching.
- `tests/v2-context-patch.test.ts` — pure ordering/correlation/clone coverage.
- `tests/v2-context.test.ts` — fresh native compaction and direct-tool
  initialization regression.

## 3. Verification

- `npm test`: 1,418/1,418 passed.
- `npm run typecheck`, `npm run build`, `npm run verify:package` (255 tarball
  entries), targeted Prettier, and `git diff --check`: passed.
- Installed-artifact V1/V2 E2E passed in 103 seconds on V1 `1.18.29` and V2
  `2.0.3`, including package entrypoints, tools, commands, permissions, proxy
  reload, restart persistence, and nudge regression paths.
- Reviewer A (`ses_f5369cf97ffeHaNhycQ56NWOMp`) and Reviewer B
  (`ses_f5369ce49ffeM4Oq4CqbUgKYFQ`) completed independent read-only review of
  the current source/test/worklog diff with no residual P0–P2 findings.

## 4. Activation Follow-up

- **PASS**: Built and restarted the local OpenCode V2.0.3 service. ACP server,
  TUI, and RPC features are active from the local checkout; `/acp` and `/dcp`
  commands are present.
- **PASS**: The affected long-lived native-compaction session initialized through
  `/acp context`; a previous consumed range was correctly rejected as already
  compressed, and ACP then compressed the oldest visible uncompressed range into
  a new active block. The old `no initialized state` failure did not recur.
- Push the branch and open a human-reviewed PR referencing `Fixes #418`.
