# WORKLOG - Count reasoning tokens in context-usage display estimates

- Task ID: `2026-09-08_reasoning-in-context-estimate`
- Branch: `2026-09-08_reasoning-in-context-estimate`
- Base: `origin/master` @ `9b7adfd` (v1.14.27)

## Changes

### `lib/messages/inject/utils.ts`
- `ContextComposition`: added `reasoningTokens: number`.
- `estimateContextComposition` per-part loop: new `part.type === "reasoning"` branch — `Math.round(text.length / 4)` (same heuristic as text parts), added to `msgTotal` and `reasoningTokens` (NOT to `messageTokens`, so text/code classification stays clean).
- `total` now = `systemTokens + toolTokens + summaryTokens + messageTokens + reasoningTokens`.
- Consequences (intended): reasoning on protected messages flows into `protectedTokens`; reasoning-only / reasoning-heavy messages appear in `largestRanges` with full footprint.

### `lib/messages/inject/inject.ts`
- Nudge breakdown line (:604): added `| N reasoning (Q%)` category (always shown, consistent with other zero-capable categories).

### `lib/compress/status.ts`
- `VisibleMessageInfo`: added `reasoning: number` (tracked separately from `tokens` = text+tool to avoid double counting in the overview total).
- `collectVisibleMessages`: counts reasoning parts per message; inclusion gate widened to `tokens > 0 || reasoning > 0` (reasoning-only messages now appear in the visible listing).
- `renderOverview`: `totalReasoning` aggregate; `total` includes it; `CONTEXT BREAKDOWN` line gains `| N reasoning (Q%)`.
- `renderUncompressedDrilldown`: `sizeOf(m) = m.tokens + m.reasoning` used for size/tool sorting, header totals, and per-message line tokens (full footprint).

### `lib/prompts/system.ts`
- CONTEXT BREAKDOWN example line + category bullets: added reasoning.

### Tests
- `tests/inject-utils-pure.test.ts`: +4 — reasoning counted in `reasoningTokens`/`total`; total formula includes reasoning; mixed message (msgTotal vs messageTokens + largestRanges footprint); no-reasoning regression guard.
- `tests/protection-aware-stats.test.ts`: +1 — reasoning on a protected message counted in `protectedTokens`.
- `tests/acp-status.test.ts`: +3 — overview reasoning category (100 text/33% + 200 reasoning/67% of 300); reasoning-only message visible (overview 100% + drilldown line); drilldown per-message footprint includes reasoning.

## Verification

- `npm run typecheck` — clean.
- `npm run test` — **1085/1085 pass** (was 1077 on master; +8 new).
- `npm run build` — clean.
- `npm run format:check` — repo-wide pre-existing Prettier drift (423 files fail on clean master, incl. all 7 touched files); CI does not run format checks; no reformat to keep the diff minimal.
- Test-input fidelity note: `filterMessages` (`lib/messages/shape.ts:14-24`) drops messages lacking `info.sessionID`/`info.time.created` — the new acp_status tests use complete mocks. (Pre-existing tests at `tests/acp-status.test.ts:286/:307` use partial mocks and only assert section headers, so they pass with zero visible messages — flagged for the review, not fixed here.)

## Open items / known interactions

- PR #370 (`stripProtectedReasoning`, open): its pass runs BEFORE `injectCompressNudges` in `lib/hooks.ts`, so post-merge the nudge-path estimator naturally matches sent content. `acp_status` reads raw DB messages and will still show request-time-stripped reasoning — #370-side concern, noted in PR description only.
- `buildCompressibleRanges` range tokens still exclude reasoning (ranges = compressible amounts; protected-msg reasoning is the incompressible floor per #368) — intentional non-goal.
- `countAllMessageTokens` fallback (token-utils.ts) still excludes reasoning — first-turn only, no reasoning present at that point — intentional non-goal.
