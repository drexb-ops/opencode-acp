# REQ — Release v1.17.0

## Goal

Ship the six reviewed/verified PRs merged to master on 2026-09-10 as v1.17.0.

## Bundled PRs

| PR | Fixes | Summary | Local verification at review time |
|---|---|---|---|
| #349 | #346 | Context-limit safety net for spawn+resume: persist learned limit, lazy catalog hydration, `resolveEffectiveContextLimit` + `compress.contextLimitFallback` (128000), OUTPUT_RESERVE_TOKENS, post-transform hard-guard ERROR | 1050/1050 + typecheck |
| #350 | #347 | Context budget guard: `enforceContextBudget` truncate-then-clear, `compress.completionReserveTokens` (32768), one-time no-window WARN; model-window-only by design | 19/19 (enforce-budget) + full suite on stacked head |
| #360 | #359 | Recommend-side counter aligned to `countMessageCharacters` | 1070/1070 |
| #365 | #364 | `isCaptureOnlyCompress`: T1 captures no longer reset T2/T3 cadence baselines | 1091/1091 |
| #374 | #371 | Reasoning tokens as own category in status/breakdown estimates | 1086/1086 → post-master-sync 1207/1207 |
| #297 | #296 | `__DCP_CONTEXT_HANDLED__` throw → plain return | 9/9 file |

## Decisions

- Version: **1.17.0** (minor) — two new config keys (`compress.contextLimitFallback`, `compress.completionReserveTokens`) and two new subsystems, not just fixes.
- #348 closed in favor of #350 (absolute-config window chain over-prunes; e2e-blocks-nudges regression).
- #374 branch updated with master before merge (strict branch protection); final master suite 1207/1207.

## Acceptance

- [x] package.json bumped to 1.17.0
- [x] CHANGELOG.md + CHANGELOG.zh-CN.md entries with `### v1.17.0`
- [ ] check-pr.sh passes for this branch
- [ ] typecheck + build + full test suite green on release branch
- [ ] PR created; CI green
- [ ] Human merges (per AGENTS §5.1.1.2); release.yml auto-tags v1.17.0 and publishes to npm `latest`
