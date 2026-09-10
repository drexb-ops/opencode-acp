# REQ - Document messageFilters config (EN + ZH)

- Task ID: `2026-09-09_message-filters-docs`
- Home Repo: `opencode-acp`
- Created: 2026-09-09
- Status: InProgress
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/369

## 1. Background & Problem Statement

- **Context**: ACP ships 5 built-in oh-my-opencode (OMO) message filters since v1.14.8 (PRs #239, #242, #268, #271), all enabled by default. Issue #369 asked how to safely remove OMO's redundant injected prompts — the answer is "already on by default, configurable via `messageFilters`".
- **Current behavior (symptom)**: The `messageFilters` config surface (master switch, per-filter `enabled`, per-filter `keepLast`) is completely undocumented — not in README.md, README.zh-CN.md, CONFIGURATION.md, or CONFIGURATION.zh-CN.md. A default-on feature is undiscoverable.
- **Expected behavior**: Users can find the `messageFilters` reference and copy-paste examples in both English and Chinese docs.
- **Impact**: Users of ACP + oh-my-opencode cannot discover/tune/disable the filters; support burden on issue tracker.

## 2. Reproduction (if applicable)

Not applicable — documentation gap, verified by grep: `messageFilters` appears in 0 of the 4 doc files.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: docs-only change, no code changes.
  - EN and ZH docs must stay in sync (same sections, same examples).
  - All documented defaults/behaviors must match the source (`lib/config.ts` defaults, `lib/messages/filter/builtin/*`).
- **Non-Goals** (explicitly out of scope):
  - No code changes, no new filters, no schema changes.
  - Not fixing the pre-existing `layer1MinRetentionPct` doc inconsistency (README says 1.0, CONFIGURATION.md table says 5.0) — out of scope, noted separately.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `CONFIGURATION.md` has a `### messageFilters` section with `messageFilters.enabled`, `messageFilters.filters` reference + per-filter table + example
  - [ ] `CONFIGURATION.zh-CN.md` has the same section translated
  - [ ] `README.md` default-config block includes `messageFilters`
  - [ ] `README.zh-CN.md` default-config block includes `messageFilters`
  - [ ] At least one "Common Config Recipes" example (EN + ZH) showing tuning/disabling
  - [ ] Documented defaults match source (enabled: true, 5 builtin filters, keepLast 2 for omo-system-reminder, 1 for the rest)
- **Performance / Stability**: N/A (docs only)
- **Regression**:
  - [ ] `npm run typecheck`, `npm run build`, `npm run test` still pass (no code touched, sanity check)

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` — new `### messageFilters` section after `qualityGate` + recipe in "Common Config Recipes"
  - `README.md`, `README.zh-CN.md` — `messageFilters` entry in the Default Configuration block
- **Risks**: None (docs only). Risk of documenting wrong defaults — mitigated by verifying against source before writing.
- **Rollback strategy**: Revert the single commit.
