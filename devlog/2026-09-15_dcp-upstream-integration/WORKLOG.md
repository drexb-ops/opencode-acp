# WORKLOG: Integrate Current Official DCP

## 2026-09-15 — Design approved

- Confirmed official DCP `master` is already current locally at v3.1.15
  (`11f6517`).
- Confirmed ACP's remote `origin/master` has advanced to `c6066c4` beyond its
  locally known tracking ref.
- Confirmed the repositories share no Git commit ancestry.
- Created dedicated branch `2026-09-15_dcp-upstream-integration` from the
  existing ACP performance branch.
- Recorded the approved two-stage, preservation-first merge design.

## Conflict Ledger

### ACP `origin/master` → `c6066c4` (v1.18.1)

- Resolved compression-index conflicts by adopting the upstream transient
  `structureVersion` cache while retaining ACP's per-transform live-call
  projection. This preserves immediate decompress visibility instead of
  treating an active-call cache as authoritative.
- Kept ACP's active-summary anchor index and combined it with the upstream
  request-scoped boundary cache.
- Retained ACP's snapshot-at-enqueue persistence queue. It provides the same
  ordered/coalesced write guarantee as upstream while preventing later state
  mutation from changing a queued snapshot.
- Adopted upstream's candidate opt-in behavior, lazy nudge analysis, and
  verified-state synchronization path; retained ACP's membership verification
  invariant and its regression coverage.
- Retained both persistence test sets and updated the historical-call cache
  tests to use the shared structure-version invalidation API.

Validation:

- `npm run typecheck` passed.
- `npm test` passed: 1,278 tests.
- `npm run build` passed.
- `npm run verify:package` passed: 183 tarball entries.
- Targeted Prettier verification for resolved files passed. Repository-wide
  `npm run format:check` still reports pre-existing formatting violations in
  hundreds of unrelated tracked files, so it is not a clean baseline.

The ACP merge was committed as `fcfe072`.

### Official DCP `master` → `11f6517` (v3.1.15)

- Added `dcp-upstream` pointing to the official repository and fetched its
  current `master` commit.
- Started the required unrelated-history merge with `--no-commit`. Every shared
  path was an add/add conflict because the repositories have no common commit.
- Kept ACP's implementation for shared paths; ACP is newer and carries the
  multi-tier, registry-based architecture that DCP's V1 implementations cannot
  replace safely.

#### Imported DCP fixes

| DCP change                                | ACP resolution                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `5f8f33b` Windows protected-file patterns | Ported the one-backslash normalization fix and its full regression test suite.                                             |
| `34ad193` trailing JSONC commas           | ACP runtime already accepted them; added the schema hint too.                                                              |
| `e2047e2` internal agent detection        | Restricted ACP's signature check to the primary system prompt and added a regression test for bundled internal prompts.    |
| `acb1fdc`, `f236e0d` tag artifacts        | Ported suffix removal for 4/5-digit ACP/DCP refs with tests, preserving ACP's dual tag formats and attribute-bearing tags. |
| `25417d2` brace-expansion update          | Not applicable: ACP's dependency lock has no `brace-expansion` package.                                                    |

#### Omitted incompatible DCP-only paths

| Incoming paths                                                               | Reason                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/publish.yml`                                              | ACP already owns a different release workflow.                                                                                |
| `lib/commands/{decompress,help,manual,recompress,sweep}.ts`                  | Depend on DCP manual mode and removed `prune.tools` state. ACP exposes its supported commands and decompression tool instead. |
| `lib/compress/{message,message-utils}.ts`, `lib/prompts/compress-message.ts` | Implement the retired DCP message-compression mode; ACP is range-only and multi-tier.                                         |
| `lib/{strategies,subagents}/**`, `lib/messages/inject/subagent-results.ts`   | Depend on removed strategy/manual state and conflict with ACP's current subagent behavior.                                    |
| `lib/tui/**`, `tui.tsx`                                                      | Depend on the V1 TUI, manual-mode state, and unavailable OpenTUI runtime dependencies.                                        |
| Tests for omitted subsystems                                                 | Exercise those incompatible V1 paths; the portable protected-pattern regression suite was retained.                           |

Review and validation:

- One independent source review found no blocker.
- Two independent final test reviews validated the imported regression coverage.
  Their findings strengthened test fixture completeness, persistence isolation,
  primary/secondary system-prompt assertions, 4/5-digit ACP/DCP suffix coverage,
  unknown-limit behavior, and partial-write polling.
- `npm run typecheck` passed.
- `npm test` passed: 1,289 tests.
- `npm run build` passed.
- `npm run verify:package` passed: 183 tarball entries.
- Repository-wide Prettier remains non-green because pre-existing style
  violations span hundreds of unrelated files. `dcp.schema.json` itself already
  had a non-Prettier layout; the trailing-comma hint was added without
  reformatting unrelated schema content.

Issue trace: [#402](https://github.com/ranxianglei/opencode-acp/issues/402)
records the Windows protected-file-pattern defect and its fix.

The DCP merge is ready to commit.
