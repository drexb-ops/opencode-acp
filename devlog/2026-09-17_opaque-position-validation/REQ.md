# REQ - Opaque V2 Position Validation

- Task ID: `2026-09-17_opaque-position-validation`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- References: https://github.com/ranxianglei/opencode-acp/issues/423

## 1. Background & Problem Statement

- **Context**: ACP normalizes V2 projected history, runs the shared transform,
  and applies a provenance-validated patch to the provider request. Tool calls
  whose results are not representable as plain text (multi-item content such as
  a completed `shell` tool returning `[stdout, notice]`, or error results) are
  marked opaque; their provider-owned parts must survive the patch object-identical.
- **Current behavior**: When an assistant message has no writable text or
  tool-result target, ACP inserts its message-ID text part before the first
  tool call. The post-replacement opaque validation compares each original
  opaque part against the new content at its OLD numeric position. The ID
  insertion shifts every later index by one, so ACP's own safe insertion is
  rejected with `A replacement changed provider-owned content`. The whole
  transaction rolls back and no ACP edits (IDs, nudges, compression) reach the
  provider request in any session containing such a tool result.
- **Expected behavior**: Retained opaque parts are validated by stable identity
  plus relative order through ACP insertions. Genuinely replaced, deleted, or
  reordered provider-owned content is still rejected.
- **Impact**: Every V2 session that ran a multi-part output tool or hit a tool
  error loses all ACP context management from that point on (IDs never
  injected, nudges never fire, compression unusable) — a silent functional
  outage of the plugin on the host.

## 2. Reproduction

- **Environment**: OpenCode V2 `2.0.3`, audited at `drexb-ops/opencode-acp@1fe36e0`.
- **Minimal reproduction** (all steps use the real host lowering):
    1. Lower an assistant message containing a completed `shell` tool whose
       result has two text items (`[stdout, notice]`) with the real OpenCode
       v2.0.3 `toLLMMessages`.
    2. Run ACP normalization, reference assignment, and the real
       `injectMessageIds` path over it.
    3. Apply the V2 context patch.
    4. Observe rejection `A replacement changed provider-owned content`.
- **Controls observed during triage**: single-text result + ID injection is
  accepted; two-text result without any edit is accepted; two-text result with
  ID injection is rejected; error tool result + ID insertion is rejected;
  replaying the settled public context snapshot reproduces.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Preserve V1 behavior, persistent-state schema, and internal `dcp-*` tags.
    - Never weaken the guarantee that provider-owned opaque parts remain
      object-identical and present in relative order in the outgoing request.
    - Keep failing closed for genuine replacement, deletion, mutation, and
      provider-owned reordering.
    - Use only public OpenCode V2.0.3 APIs; the real lowering code is vendored
      verbatim into `tests/fixtures/opencode-core-2.0.3/` (provenance header,
      MIT) instead of adding `@opencode/core` as a dependency — its native
      module tree (`bun-pty`, `@parcel/watcher`, `photon-node`, `fff-bun`)
      would put CI `npm ci` at risk. No runtime dependency is added.
- **Non-Goals**:
    - Changing how tools are lowered by the host.
    - Permitting removal or rewriting of provider-owned opaque content.
    - Touching the #418 restoration path except where its snapshot interacts
      with repeated patching.

## 4. Acceptance Criteria

- **Correctness**:
    - [ ] Multi-item completed tool results (real host lowering) accept ACP ID
          insertion; the inserted part lands before the tool call while both
          opaque parts (ToolCallPart, ToolResultPart) survive object-identical
          and in original relative order.
    - [ ] Error tool results accept ACP ID insertion under the same guarantees.
    - [ ] Mixed messages (editable text part + opaque tool part) still validate
          text edits alongside opaque retention.
    - [ ] Repeated patching over a settled public snapshot (second request
          cycle) accepts without rejecting its own previous insertions.
    - [ ] Genuine replacement/deletion/mutation/reorder of provider-owned
          opaque content is still rejected with `opaque-origin`.
- **Regression**:
    - [ ] New test file drives the full handler with vendored real lowering +
          real ID injection (no hand-built outgoing messages for the bug case).
    - [ ] Existing suite, typecheck, build, and formatting pass.

## 5. Proposed Approach

- **Affected modules**: `lib/v2/projection/patch.ts` (post-replacement opaque
  validation), `tests/v2-opaque-position.test.ts` (new),
  `tests/fixtures/opencode-core-2.0.3/` (new, vendored lowering).
- **Approach**: Replace the fixed numeric-position comparison in the
  post-replacement loop with an identity + relative-order validation: walk the
  new message content once and match every original opaque part (in original
  order) to the same object at a later-or-equal index. Any original part that
  is missing, mutated (different object), or out of order rejects with
  `opaque-origin`. The whole-message `opaqueMessage` identity check stays.
  Pre-patch baseline checks keep their positional form because they compare
  the fresh host lowering against the projection snapshot taken from the same
  lowering.
- **Risks**: Subsequence matching could in theory accept a duplicated opaque
  part inserted between originals; mitigation is that duplicates of
  provider-owned objects cannot be produced by ACP transforms (ACP parts carry
  deterministic `prt_dcp_*` IDs and are filtered before this check) plus a
  dedicated rejection test for reordered/duplicated content.
- **Rollback**: Revert this branch's fix commit; no migration is required.
