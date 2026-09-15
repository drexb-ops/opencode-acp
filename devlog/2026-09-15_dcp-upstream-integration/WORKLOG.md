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

The ACP merge is ready to commit. The DCP unrelated-history merge has not
started.
