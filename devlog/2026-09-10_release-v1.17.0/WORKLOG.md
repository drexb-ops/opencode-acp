# WORKLOG — Release v1.17.0

## Steps

1. Confirmed all six PRs merged to master (3a4ac99 = merge of #374, the last one).
2. Branched `2026-09-10_release-v1.17.0` from `github/master`.
3. `package.json` 1.16.0 → 1.17.0.
4. Changelog entries added to `CHANGELOG.md` and `CHANGELOG.zh-CN.md` (six-PR breakdown, EN + zh).
5. Devlog REQ/WORKLOG (this file).
6. Local verification (see below), commit, push, PR.

## Local verification

- `./scripts/ci/check-pr.sh 2026-09-10_release-v1.17.0 github/master` — branch name / devlog / changelog checks
- `npm run typecheck` — 0 errors
- `npm run test` — full suite
- `npm run build` — success

(fill in numbers from the actual run)

## Follow-ups (not in this release)

- Remove `tmp/nested-fork-probe.mts` tracked on master (leaked via #350's implementation commit ce0aca3) — separate cleanup PR.
- Delete 4 orphan remote branches from the conflict-resolution session (pending human confirmation): `2026-09-03_counter-alignment`, `2026-09-04_tier2-cadence`, `2026-09-08_reasoning-in-estimate`, `2026-08-13_remove-dcp-context-handled-throw`.
- PR #376 (fork state transfer) still on hold pending issue #375 author's reply.
