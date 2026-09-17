# REQ - Preserve Opaque V2 Compaction Sources

- Task ID: `2026-09-17_opaque-compaction-restore`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- References: https://github.com/ranxianglei/opencode-acp/issues/418

## 1. Background & Problem Statement

- **Context**: ACP runs a shared transform over V2 projected history and then
  applies a provenance-validated patch to the provider request.
- **Current behavior**: A completed native `compaction` record with
  `providerState` but no `providerContext` is opaque and non-removable. The
  shared transform can omit its normalized representation; strict V2 patching
  then rejects the request rather than removing provider-owned data. The
  rejected transaction correctly rolls back state initialization, so a later
  manual `compress` call reports that the session is uninitialized.
- **Expected behavior**: ACP retains the opaque native source in the outgoing
  provider request, commits independent safe edits and initialized state, and
  allows the next direct ACP tool call to acquire that state.
- **Impact**: Long-running V2 sessions can become unable to use manual ACP
  compression when they are already over their model context budget.

## 2. Reproduction

- **Environment**: OpenCode V2 `2.0.3`, Linux, local ACP checkout.
- **Minimal reproduction**:
    1. Use a session containing a completed native compaction record with
       `providerState`, `summary`, and `recent`, but no `providerContext`.
    2. Let ACP process another primary context request where the shared transform
       omits that normalized opaque source.
    3. Observe `Cannot remove opaque source message ...`; then call `compress`
       and observe `ACP: session ... has no initialized state`.
- **Relevant configuration**: V2 server plugin is loaded through the normal
  `opencode.json` `plugins` array. `cli.json` terminal plugins do not replace
  that server configuration.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Preserve V1 behavior, persistent-state schema, and internal `dcp-*` tags.
    - Never remove, rewrite, or alias provider-owned opaque V2 records.
    - Fail closed when provenance cannot establish safe source order/correlation.
    - Use only public OpenCode V2.0.3 APIs and add no dependency.
- **Non-Goals**:
    - Changing OpenCode’s native compaction representation.
    - Permitting opaque source removal.
    - Changing CLI configuration or TUI-only plugin behavior.

## 4. Acceptance Criteria

- **Correctness**:
    - [x] Missing `opaque && !allowSourceRemoval` normalized sources are restored
          before V2 patch validation in deterministic source order.
    - [x] ACP notices remain excluded; provider-owned outgoing messages remain
          object-identical and content-identical.
    - [x] A fresh session with the real native compaction shape initializes,
          persists, and permits a subsequent direct ACP tool call.
    - [x] Ambiguous/missing provenance rejects without changing event, state, or
          deferred effects.
- **Regression**:
    - [x] Added unit and V2 context tests covering ordering, duplication,
          correlation loss, clone isolation, fresh initialization, persistence, and
          tool acquisition.
    - [x] Full test suite, typecheck, build, package verification, targeted
          formatting, and diff checks pass.

## 5. Proposed Approach

- **Affected modules**: `lib/v2/context.ts`, `lib/v2/projection/restore.ts`,
  `lib/v2/projection.ts`, and V2 context/projection tests.
- **Approach**: Restore only missing protected opaque normalized sources from
  validated projection provenance after ACP notice filtering and before patch
  application. Clone restored normalized messages, leave transformed patchable
  messages unchanged, and preserve strict patch rejection for ambiguity.
- **Risks**: Incorrect insertion order could invalidate a patch; mitigation is
  source-order validation plus fail-closed tests.
- **Rollback**: Revert this branch’s fix commit; no migration is required.
