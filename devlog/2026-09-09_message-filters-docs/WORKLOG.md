# WORKLOG - Document messageFilters config (EN + ZH)

- Task ID: `2026-09-09_message-filters-docs`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-09 20:40

## 1. Summary

- **What was done** (1–3 sentences): Added the missing `messageFilters` documentation — a full parameter reference section with per-filter table and config examples in CONFIGURATION.md / CONFIGURATION.zh-CN.md, plus a `messageFilters` entry in the default-config blocks of README.md / README.zh-CN.md.
- **Why** (1–3 sentences): Issue #369 showed the default-on OMO message filters are undiscoverable; the owner asked for config examples in both EN and ZH.
- **Behavior / compatibility changes**: No (docs only).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | docs: add messageFilters config reference + examples (EN/ZH) |

### Key Files

- `CONFIGURATION.md` — new `### messageFilters` section (enabled, filters, builtin filter table, example) + recipe in Common Config Recipes
- `CONFIGURATION.zh-CN.md` — same, translated
- `README.md` — `messageFilters` entry in Default Configuration block
- `README.zh-CN.md` — same, translated

## 3. Design & Implementation Notes

- **Entry point / key function**: N/A (docs only)
- **Key configuration items**: `messageFilters.enabled` (default `true`), `messageFilters.filters.<name>.enabled`, `messageFilters.filters.<name>.keepLast`
- **Key logic explanation** (if non-trivial): Filters run before `assignMessageRefs` (lib/hooks.ts:237) — filtered content never gets message refs and is never counted toward context usage. `keepLast` is read at lib/messages/filter/apply.ts:115-116 as `Math.max(1, configValue ?? filterDefault ?? 1)`.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm run build
node --import tsx --test tests/*.test.ts
```

### Test Coverage

- New/modified test files: none (docs only)
- Test count: 1112 total, 1112 pass, 0 fail
- Key scenarios verified: documented defaults cross-checked against `lib/config.ts:285-294` and `lib/messages/filter/builtin/*.ts`

### Results

- **PASS/FAIL**: PASS (typecheck, build, full test suite)
- **Key logs/data** (optional): `# pass 1112 / # fail 0`; tsup build success

## 5. Risk Assessment & Rollback

- **Risk points**: documenting wrong defaults (mitigated: verified against source)
- **Rollback method**:
  - Revert commit(s): `<sha>`
  - Rollback impact: docs revert only
- **Compatibility notes** (data format, config schema): No

## 6. Lessons Learned (optional)

- Default-on features must ship with docs in the same release — #369 shows the discovery gap.

## 7. Follow-ups (optional)

- [ ] Pre-existing inconsistency: `qualityGate.algorithms.rouge-recall-v1.layer1MinRetentionPct` documented as 5.0 in CONFIGURATION.md table but 1.0 in README default block — needs a separate fix.
