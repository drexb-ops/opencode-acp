# DESIGN - Recognize Failed V2 ACP Tool Results as Failures

- Task ID: `2026-09-17_v2-failed-tool-recognition`
- References: https://github.com/ranxianglei/opencode-acp/issues/426

## 1. Context & Root Cause

On OpenCode V2, ACP's five direct tools (`compress`, `decompress`,
`search_context`, `acp_status`, `acp_context_recap`) execute through the
pinned Promise adapter (`@opencode/plugin@2.0.3`,
`node_modules/@opencode/plugin/dist/promise/tool.d.ts`):

```ts
execute(input: Input, context: ToolContext): Promise<Tool.Result<Output>>
```

- The native Effect-based `Tool.Info` CAN return a typed error
  (`Effect<Result, Tool.Error>`), but the adapter lifts Promise tools via
  `Effect.promise(() => tool.execute(...))`, so a rejection becomes an untyped
  defect — structured metadata is lost and the turn risks failing outright.
- Therefore `createV2Tool` returns **resolved** results with error text in
  `content` for every caught failure (permission ask/deny, lifecycle deny,
  subagent deny, invalid input, execution exceptions).
- The host persists resolved results as tool parts with
  `state.status === "completed"`. ACP's internal projection
  (`lib/v2/projection/shared.ts -> toolState`) mapped that verbatim to an
  internal `completed` state, so every downstream consumer — which all treat
  `completed` as success — was wrong about failures:
    - `messageHasCompress` (`lib/messages/query.ts`) → nudge success-baseline
      advancement in `lib/messages/inject/inject.ts`;
    - `collectCompressInvocations` (`lib/state/rebuild.ts`) → cold-start block
      reconstruction;
    - `hideFailedCompressCalls` (`lib/compress/hide-failed.ts`) → never hides
      the failed call (it only matches `status === "error"`).

The fake-provider classifier used by installed E2E
(`scripts/e2e/fake-llm-server.ts -> inspectToolResults`) had the same blind
spot in its text regex (`ACP .* execution failed` does not match
`ACP compress failed:`), so E2E observations also reported `completed`.

## 2. Design Decisions

### D1 — Explicit failure metadata at the source (additive)

`errorResult()` in `lib/v2/tools.ts` is the single choke point through which
all resolved error results flow. It now merges
`acpFailed: true` into the result metadata, keeping every existing per-reason
flag (`acpError`, `acpPermission`, `acpDisabled`, `acpSubAgent`) intact:

```ts
return { content: message, metadata: { [ACP_FAILURE_METADATA_KEY]: true, ...metadata } }
```

Additive, never replacing: existing consumers of the specific flags are
unaffected, and any future error path added via `errorResult()` is covered
automatically.

### D2 — Recognition at projection time, not in the shared transform

The patcher (`lib/v2/projection/patch.ts`) rejects any shared transform that
changes a tool part's status relative to the original projection
(`ambiguous-origin` "changed state"). Hence the reclassification must happen
where the projection is built — `toolState()` — so both sides of every later
comparison already agree on `error`.

In `toolState()`, when host status is `completed` and the tool is one of the
five ACP tools:

```ts
if (isAcpFailedToolOutput(stringValue(tool.name), rawState, normalizedOutput)) {
    return {
        state: {
            status: "error",
            input,
            error: normalizedOutput,
            ...(metadata ? { metadata } : {}),
        },
        opaqueResult: output === undefined,
        error: normalizedOutput, // sets origin.normalizedError only
    }
}
```

Deliberately **no `output` field** on the returned record:
`normalize.ts` only sets `origin.normalizedOutput` when one exists, so the
origin keeps no output fingerprint of the provider-owned text, and the patcher
skips output comparison entirely (`loweredToolCorrelationIsExact` treats an
undefined origin output as "correlation by identity"). The lowered/host result
is therefore never rewritten — the issue's hard constraint.

### D3 — Two-tier recognition, metadata authoritative

`isAcpFailedToolOutput(toolName, rawState, neutralizedOutput)`:

1. `toolName` must be one of the five ACP names (allowlist — non-ACP tools
   with error-looking or even quoted ACP text are untouched, including
   metadata-carrying bash outputs).
2. Explicit `metadata.acpFailed === true` → failed (authoritative, covers any
   current/future message shape).
3. Else the anchored pattern against the normalized output covers
   **compatible historical failure output** from pre-fix host history.

`ACP_FAILURE_OUTPUT_PATTERN` is anchored at position zero and intentionally
lacks the multiline flag:

```
/^(?:ACP (?:[a-z][a-z_]* failed|is shutting down|is currently disabled|direct tools are disabled|could not verify the session parent|could not resolve the active agent permission|tool execution is disabled|cannot request an interactive permission)|Invalid [a-z][a-z_]* input:)/
```

Coverage: `ACP <tool> failed: …` (catch-all + quality-gate rejections, which
arrive wrapped in the catch-all form), all four deny/lifecycle constants, the
bili-proxy disable notice, and `Invalid <tool> input: …`. Verified non-matches:
every known success prefix (`Compressed N messages into …`,
`[Compressed conversation section]…`, `No active compression blocks.`,
`No matches found …`, recap restore text, acp_status usage lines) and any
failure text appearing after the first line (quoted history inside restored
or searched content).

### D4 — Shared pure module as the single definition

`lib/v2/projection/acp-failure.ts` is dependency-free and exports the name
list, metadata key, pattern, and predicates. Consumers:
`lib/v2/tools.ts` (re-exports the name list, preserving the existing public
import path used by `tests/v2-lifecycle.test.ts`),
`lib/v2/projection/shared.ts`, `scripts/e2e/fake-llm-server.ts`, and the unit
tests. One definition ⇒ the classifier and the projection cannot drift apart.

### D5 — Nudges: no code change needed

`messageHasCompressAttempt` is status-agnostic (any status counts as an
attempt) while `messageHasCompress` requires `completed`. Once the projection
emits `error` for failures:

- failed attempts still enter the attempt branch → pending-nudge anchors and
  `lastNudgeShownTokens` reset (the #216 feedback-loop protection is retained);
- the success sub-check (`messageHasCompress`) no longer fires →
  `lastPerMessageNudgeTokens` / `compressBaselineSet` are NOT advanced;
- `hideFailedCompressCalls` now works on V2 as on V1 (hides all but the most
  recent failed call so the model can retry).

This aligns V2 with V1 semantics exactly, where failures already arrive with
`status: "error"`.

### D6 — E2E observations require genuine success

- `inspectToolResults`: ACP-named results are classified with the shared
  anchored pattern first; the legacy loose regex remains for non-ACP tools
  (bash stderr `error:`, etc.).
- `installed-v2.ts` nudge-growth stage: beyond asserting a compress observation
  EXISTS, it now asserts its status is `"completed"` — a failed compression
  can no longer satisfy a success-expecting scenario.

## 3. Data Flow (after fix)

```
host history (V2)                     internal projection                downstream
─────────────────────                 ───────────────────                ──────────
tool part completed                   toolState():
  content: "ACP compress failed…"     name ∈ ACP list
  metadata: {acpFailed:true}  ──►     metadata.acpFailed → status:"error" ─► nudge attempt branch
                    or                  (no output exposed)                 rebuild: skipped
  pre-fix history:                        ▲                                  hide-failed: active
  no metadata, text match ──► pattern fallback                                messageHasCompress: false
```

## 4. Verified Invariants (why this is safe)

1. **Status-change rejection**: `patch.ts` rejects transforms that change a
   tool part's status vs the original projection. Reclassification happens at
   projection time ⇒ both sides identical ⇒ no `ambiguous-origin` rejection.
2. **Provider-owned output untouched**: reclassified branch exposes no
   `output` ⇒ `origin.normalizedOutput === undefined` ⇒ output comparison
   skipped in correlation and patching; error text is identical on both sides
   ⇒ the error-text change check cannot fire. Outgoing messages byte-identical.
3. **Removal path independent of status**: `hideFailedCompressCalls` removals
   operate on call/result pointers in the outgoing build, unaffected by the
   internal status value.
4. **Consumers tolerate missing output on error parts**: every
   `part.state.output` reader in `lib/` is guarded by `status === "completed"`
   or a typeof check (enforce-budget, truncate-tools, utils, rebuild,
   protected-content, quality-gate, token-utils, decompress logic).
5. **No persisted-format impact**: `fingerprintMessage` (fork matching) is
   computed on the fly from current messages, never persisted; block state
   files are unchanged in shape.

## 5. Alternatives Considered

- **Rewrite host/provider output to an error shape** — rejected: violates the
  issue constraint, breaks exact correlation with the lowered session, and the
  patcher would reject it anyway (invariant 1).
- **Reject the promise (native error channel)** — rejected for the pinned
  adapter: rejection becomes an untyped Effect defect (metadata loss, turn
  failure risk). Revisit if the pin moves (follow-up in WORKLOG §7).
- **Detect failures in each downstream consumer** — rejected: scatters the
  rule across query/rebuild/nudge/hide modules; a single projection-time
  recognition point gives V1-equivalent semantics everywhere at once.
- **Looser (multiline, case-insensitive) pattern** — rejected: risk of
  demoting genuine success outputs that quote historical failure text
  (decompress/recap/search_context restore exactly such content).

## 6. Known Limitations

The shared ACP tools report some soft failures as plain resolved text instead
of going through `errorResult`:

- `decompress` returns `resolved.error` as ordinary output
  (`lib/compress/decompress.ts:451`; error strings built around :230–:322, e.g.
  `Error: No active compression blocks overlap the range …` at :322).
- `search_context` returns `"Error: query is required."`
  (`lib/compress/search.ts:561`).
- `acp_context_recap` returns informational strings such as
  `"No active compression blocks."` (`lib/compress/recap.ts:44`).
- `acp_status` appends `"(unable to fetch messages)"` on fetch failure
  (`lib/compress/status.ts:701`).

These stay `completed` on both runtimes — identical classification to V1, where
plain results were never native errors either — so this is not a regression,
and there is zero functional impact today because the #426 logic keys only off
compress success/failure (nudge baselines, rebuild replay, hide-failed).
Extending the anchored position-0 pattern to a generic `Error:` prefix was
rejected as too broad for a shared recognition rule. If these tools ever need
failure semantics, they should gain explicit `errorResult`-style metadata like
the compress path has.
