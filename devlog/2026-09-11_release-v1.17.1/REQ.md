# REQ — Release v1.17.1

## Goal

Ship the three PRs merged to master on 2026-09-11 as v1.17.1 (patch: fixes + perf only, no new API/config/persistence surface).

## Bundled PRs

| PR | Fixes | Summary |
|---|---|---|
| #385 | #384 | perf: transform work bounded to visible context + active blocks (candidate planning 13.6 s → ~1.2 ms @ 1000 msgs). RC1 request-scoped boundary lookup, RC1b fast token estimate, RC2 gated T1 nudge analysis, RC3 structureVersion incremental sync, RC4 ordered coalescing save queue. Dual-agent reviewed (APPROVE-WITH-NITS, nits addressed). Persisted-state format unchanged. |
| #389 | #329 | fix: `qualityGate.algorithms` added to dynamic-key recursion skip-list — no more false "Unknown keys" warning on valid per-algorithm params. Dual-agent reviewed (both APPROVE, mutation-verified tests). |
| #390 | #366 | fix(ci): fork PRs skip `npm publish` (ENEEDAUTH), keep artifact + upload; comment step `continue-on-error`, fork-aware install repo. Review findings F1–F3 fixed pre-merge. CI-only. |

## Version decision

v1.17.1 — all changes are fixes/perf; no config keys, API, or persistence-format changes (RC3/RC4 fields are transient).

## Acceptance

- [x] package.json → 1.17.1
- [x] CHANGELOG.md + CHANGELOG.zh-CN.md `### v1.17.1` entries
- [ ] check-pr.sh + typecheck + full suite + build on release branch
- [ ] PR created; CI green
- [ ] Human merges → release.yml auto-tags v1.17.1 → npm latest
