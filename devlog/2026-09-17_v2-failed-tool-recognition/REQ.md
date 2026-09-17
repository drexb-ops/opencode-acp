# REQ - Recognize Failed V2 ACP Tool Results as Failures

- Task ID: `2026-09-17_v2-failed-tool-recognition`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- References: https://github.com/ranxianglei/opencode-acp/issues/426

## 1. Background & Problem Statement

- **Context**: On OpenCode V2 (pinned `@opencode/plugin` `2.0.3`), ACP's direct
  tools run through the Promise tool adapter (`@opencode/plugin/promise/tool`).
  That adapter's `execute` signature is `(input, context) => Promise<Tool.Result>`
  and has **no safe native error-return channel**: rejecting the promise turns a
  structured failure into an untyped Effect defect (losing metadata and risking
  turn-level failure), so `createV2Tool` returns _resolved_ results with error
  text in `content` for every caught execution failure.
- **Current behavior**: The host records those resolved error results as tool
  parts with `state.status === "completed"` even when the content says
  `ACP compress failed: ...`. ACP's internal V2 projection
  (`lib/v2/projection/shared.ts -> toolState`) preserves that `completed`
  status without inspecting ACP failure metadata or failure text. Downstream:
    - `messageHasCompress` (`lib/messages/query.ts`) treats the failed call as a
      successful compression;
    - nudge baseline logic (`lib/messages/inject/inject.ts`) advances
      `lastPerMessageNudgeTokens` / sets `compressBaselineSet` after a _failed_
      compression;
    - cold-start reconstruction (`lib/state/rebuild.ts ->
collectCompressInvocations`) replays the failed call and rebuilds a block
      that never existed;
    - `hideFailedCompressCalls` never hides the failed call because its status is
      not `error`.
- **Also affected**: the installed E2E fake provider
  (`scripts/e2e/fake-llm-server.ts -> inspectToolResults`) classifies tool
  result status by text pattern; its regex misses `ACP <tool> failed:` (it only
  matches `ACP .* execution failed`) plus several other deny/lifecycle texts,
  so E2E observations report `completed` for genuinely failed ACP calls.
- **Expected behavior**:
    - All resolved error results from `createV2Tool` carry explicit ACP failure
      metadata (`acpFailed: true`) alongside their existing specific flags.
    - The internal V2 projection recognizes explicit failure metadata — and
      compatible historical failure output from pre-fix host history — as an
      internally _failed_ tool (status `error`) **without rewriting the actual
      provider-owned outgoing output**.
    - Failed-attempt handling for nudges is retained (a failed attempt still
      resets pending-nudge state) but must NOT advance success baselines.
    - Cold/warm failed compression does not reconstruct a block.
    - Successful ACP tool outputs remain recognized as completed.
    - E2E observations require genuine compression success where success is
      expected.
    - V1 behavior is unchanged.

## 2. Reproduction

- **Environment**: OpenCode V2 `2.0.3`, Linux, local ACP checkout at fork tip
  `1fe36e09`.
- **Minimal reproduction**:
    1. Run a V2 session with ACP enabled and trigger any caught ACP tool
       failure (e.g. a `compress` call whose pipeline throws, producing
       `ACP compress failed: ...`).
    2. Inspect host session history: the tool part has
       `state.status === "completed"` with the error text in `content`.
    3. Observe ACP internals treating it as success: nudge baseline advanced,
       and on restart `collectCompressInvocations` replays the part and
       reconstructs a phantom block.
    4. In installed E2E, `inspectToolResults` reports the same result as
       `completed`, so scenario assertions pass despite the failure.
- **Relevant configuration**: V2 server plugin loaded through the normal
  `opencode.json` `plugins` array; pinned `@opencode/plugin` `2.0.3`.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Do NOT rewrite provider-owned outgoing/host message content — recognition
      happens in the internal projection only.
    - Keep existing per-reason metadata flags (`acpError`, `acpPermission`,
      `acpDisabled`, `acpSubAgent`) intact for compatibility; add, don't replace.
    - No new runtime dependencies. Pure-function module for the shared
      recognition logic so unit tests and the E2E fake provider can reuse it.
    - Do NOT change `version` in package.json (non-release branch).
    - Internal `dcp` naming / persisted state format compatibility preserved.
- **Non-goals**:
    - Changing the pinned `@opencode/plugin` adapter to use the native Effect
      error channel (out of scope; revisit if the pin moves).
    - Changing V1 tool result handling at all.
    - Adding new issue entries for this work (issue #426 is the ticket).

## 4. Acceptance Criteria

1. Every resolved error result produced by `createV2Tool` includes
   `acpFailed: true` in its metadata (verified by unit test over the helper).
2. `toolState` in `lib/v2/projection/shared.ts` maps a `completed` host state
   for one of the five ACP tools to an internal `status: "error"` state when
   either explicit failure metadata is present OR the normalized output starts
   with a known ACP failure prefix (historical compat). Successful ACP outputs
   stay `completed`; non-ACP tools are untouched.
3. Unit tests prove: failed cold compression does not advance
   `lastPerMessageNudgeTokens` / `compressBaselineSet` and does not rebuild a
   block; failed warm compression likewise; failed attempts still clear pending
   nudge anchors; successful compressions are recognized exactly as before.
4. `scripts/e2e/fake-llm-server.ts` classifies all ACP failure texts (explicit
   `ACP <tool> failed:`, lifecycle/deny/subagent/proxy messages) as `error`.
5. Installed E2E driver asserts genuine `completed` status for the
   nudge-growth compress results (success required, not just observed).
6. `npm run typecheck`, `npm run test`, `npm run build` all pass.
7. Devlog REQ/WORKLOG (+DESIGN, since projection data flow changes) committed
   with the code.
