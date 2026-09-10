# REQ - Count reasoning tokens in context-usage display estimates

- Task ID: `2026-09-08_reasoning-in-context-estimate`
- Home Repo: `opencode-acp`
- Created: 2026-09-08
- Status: InProgress
- Priority: P1
- Owner: ework-daemon
- References: https://github.com/ranxianglei/opencode-acp/issues/371 (source: #368 secondary finding A), related PR #370

## 1. Background & Problem Statement

- **Context**: ACP displays context-usage percentages in two places derived from message *content*: the nudge breakdown (`Breakdown: ...` line appended to nudges) and the `acp_status` overview (`CONTEXT BREAKDOWN` line). The decision path (when to nudge) uses API-reported tokens, which include reasoning.
- **Current behavior (symptom)**: Both content-based estimators count only `text` + `tool` parts and skip `reasoning` parts entirely:
  - `estimateContextComposition` (`lib/messages/inject/utils.ts:586`, per-part loop :623-665) — powers the nudge breakdown.
  - `collectVisibleMessages` + `renderOverview` (`lib/compress/status.ts:125/:185`) — powers the `acp_status` overview. (Note: `acp_status` does NOT call `estimateContextComposition`; the import at `status.ts:9` is dead.)
  - Real usage formula includes reasoning: `lib/token-utils.ts:44` (`input + cacheRead + cacheWrite + output + reasoning`).
  - Result: displayed percentages systematically undercount real usage, and the largest residual component (reasoning — see #368) is invisible in the display.
  - Not affected: `/acp context` command (`lib/commands/context.ts:119`) — its TOTAL comes from API-reported tokens and already includes reasoning.
- **Expected behavior**: Both display estimators count `reasoning` parts (same `len/4` heuristic as text parts) and show reasoning as its own breakdown category, so displayed totals align with the real-usage formula.
- **Impact**: Users cannot perceive the reasoning floor; displayed % disagrees with billing/limit accounting.

## 2. Reproduction (if applicable)

- **Environment**: any session with a thinking/reasoning model (assistant messages carry `reasoning` parts).
- **Minimal reproduction steps**:
  1) Run a session with a reasoning model until context usage crosses the nudge threshold.
  2) Compare the `Breakdown:` line total (and `/acp status` overview total) against the API-reported usage — the display total is lower by roughly the reasoning token count.
- **Relevant configuration**: none (display-only paths).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: display-only change; no persisted-state, internal-tag, config, or API changes. Breakdown lines gain a category (tests assert only `includes("Breakdown:")` / `includes("CONTEXT BREAKDOWN")` — verified safe).
  - Performance: one extra branch in two existing per-part loops; negligible.
  - Keep the `len/4` heuristic consistent with existing parts (no tokenizer introduction).
- **Non-Goals** (explicitly out of scope):
  - Stripping reasoning at request time (that is PR #370).
  - Changing `buildCompressibleRanges` range-token semantics (ranges = compressible amounts; reasoning on protected messages is the incompressible floor).
  - Changing the decision path (`getCurrentTokenUsage` already includes reasoning).
  - Making `acp_status` aware of PR #370's request-time stripping (known interaction, noted in PR description).
  - `countAllMessageTokens` fallback (first-turn only; no reasoning present at that point).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `estimateContextComposition` returns a `reasoningTokens` field; `total` = system + tool + summary + message + reasoning.
  - [ ] Reasoning on protected messages is included in `protectedTokens`.
  - [ ] Nudge breakdown line shows a `reasoning (Q%)` category.
  - [ ] `acp_status` overview `CONTEXT BREAKDOWN` line shows a `reasoning (Q%)` category and includes it in the total.
  - [ ] Per-message drilldown token counts include reasoning (consistent with overview total).
- **Performance / Stability**:
  - [ ] No change to nudge decision behavior (decision path untouched).
- **Regression**:
  - [ ] New/modified test cases added to test suite and passing (unit tests for both estimators + overview rendering; full suite green).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/messages/inject/utils.ts` — `ContextComposition` interface + `estimateContextComposition` per-part loop + total.
  - `lib/messages/inject/inject.ts` — nudge breakdown line.
  - `lib/compress/status.ts` — `VisibleMessageInfo` (+`reasoning` field), `collectVisibleMessages`, `renderOverview` (total + breakdown line), drilldown totals.
  - `lib/prompts/system.ts` — CONTEXT BREAKDOWN example line + category bullets.
  - `tests/inject-utils-pure.test.ts`, `tests/acp-status.test.ts` (+ possibly `tests/protection-aware-stats.test.ts`).
- **Risks**: low — additive field + display line; verified no exact-format test assertions.
- **Rollback strategy**: revert the single commit.
