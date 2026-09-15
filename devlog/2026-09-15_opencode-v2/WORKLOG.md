# WORKLOG - OpenCode V2 Compatibility

- Task ID: `2026-09-15_opencode-v2`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-15 21:47 UTC

## 1. Summary

- **What was done**: Investigated the production plugin failure, mapped ACP's V1
  host dependencies, verified the exact published OpenCode 2.0.3 plugin API,
  recorded the approved V1/V2 compatibility design, and implemented Phase 2's
  host-neutral services and shared tool contracts.
- **Why**: ACP currently fails before initialization on OpenCode V2 because its
  default export and all host integrations use the V1 plugin API.
- **Behavior / compatibility changes**: No intentional V1 behavior changes;
  existing V1 factories now run through the shared definitions and adapters.
- **Risk level**: High

## 2. Change Log

### Commits

| Commit      | Description                                                   |
| ----------- | ------------------------------------------------------------- |
| `7224ab9`   | Record the approved OpenCode V2 compatibility design          |
| `3c00b9a`   | Refine concurrency boundaries and add the implementation plan |
| `b42d827`   | Record the integrated pre-change verification baseline        |
| `b569ccd`   | Add the dual V1/V2 entrypoint and dependency foundation       |
| This commit | Add shared host services and host-neutral tool definitions    |

### Phase 1

- Moved the unchanged V1 factory to `lib/v1/plugin.ts` and exposed it through a
  lazy `server()` adapter on the dual default export.
- Added the exact `@opencode/plugin@2.0.3` V2 type boundary in
  `lib/v2/plugin.ts`; setup intentionally registers no unfinished APIs.
- Kept `.` and `./server` pointed at the root dual entrypoint. No `./tui` or
  `./rpc` export was added before those files exist.
- Raised the V1 compatibility floor to `@opencode-ai/plugin >=1.18.29` and
  aligned the V1 SDK/dev ranges to `^1.18.29`. The package version remains
  `1.18.1`.
- Added source and built-entrypoint shape tests and updated the direct V1
  integration test to invoke `.server()`.

### Key Files

- `devlog/2026-09-15_opencode-v2/REQ.md` — testable requirements and constraints.
- `devlog/2026-09-15_opencode-v2/DESIGN.md` — approved dual-runtime architecture.
- `devlog/2026-09-15_opencode-v2/WORKLOG.md` — investigation and implementation record.

## 3. Design and Implementation Notes

- **Entry point / key function**: Planned dual default export with V2 `setup`
  and V1 `server()`.
- **Key configuration items**: Existing `acp.json(c)` layering remains unchanged.
- **Key logic explanation**: V2 projected history is normalized for ACP's shared
  engine, but changes are applied as validated patches to OpenCode's original
  provider-ready messages rather than rebuilding the transcript.

## 4. Testing and Verification

### Investigation performed

- Matched server reference `err_09398993` to the original default-export schema
  failure.
- Verified `opencode-acp` 1.14.26, 1.18.1, and the current checkout all use the
  V1 function export.
- Inspected official V2 plugin/migration/RPC documentation.
- Inspected the exact published `@opencode/plugin@2.0.3`, `@opencode/client@2.0.3`,
  `@opencode/schema@2.0.3`, `@opencode/ai@2.0.3`, and `@opencode/core@2.0.3`
  contracts and runtime lowering behavior.
- Used three read-only subagents to independently map ACP behavior, V2 APIs, and
  test/package/release constraints.
- Used two additional read-only subagents to trace message mutations,
  persistence boundaries, runtime adapter seams, and exact package entrypoint
  behavior before implementation planning.
- Filed issue #404 for the discovered same-session partial-initialization and
  concurrent-state race.

### Results

- **PASS**: Design approved by the user in four sections.
- **PASS**: Baseline `npm run typecheck`.
- **PASS**: Baseline `npm test` — 1,289/1,289 tests.
- **PASS**: Baseline `npm run build`.
- **PASS**: Baseline `npm run verify:package` — 183 tarball entries.
- **PRE-EXISTING FAIL**: Repository-wide `npm run format:check` reports 450
  files inherited from the integrated upstream tree. The migration will not
  mass-format unrelated history; every file changed by this work must pass a
  targeted Prettier check.

### Phase 1 verification

- **PASS**: `npm ci --ignore-scripts` — lockfile is installable.
- **PASS**: `npm run typecheck`.
- **PASS**: `node --import tsx --test tests/plugin-entrypoint.test.ts tests/bili-proxy-integration.test.ts` — 6/6.
- **PASS**: `npm test` — 1,291/1,291.
- **PASS**: `npm run build` — root plus lazy V1/V2 chunks and declarations.
- **PASS**: Built root and `opencode-acp/server` imports expose `id`, `setup`, and `server`.
- **PASS**: `npm run verify:package` — 191 tarball entries.
- **PASS**: Targeted Prettier check for every changed source, manifest, lockfile,
  and test file.
- **PRE-EXISTING FAIL**: `npm run format:check` still reports the same 450
  inherited formatting failures; no unrelated files were formatted.

### Phase 2

- Added focused host services for session/history access, parent fork history,
  model inventories, ACP-owned notices, and notifications under `lib/host/`.
- Refactored shared compression, command, config, hook, and update paths to use
  those services. `lib/v1/host.ts` is the V1 client translation and
  `lib/v1/tools.ts` adapts root-Zod shared definitions to the V1 tool contract.
- Converted `compress`, `decompress`, `search_context`, `acp_status`, and
  `acp_context_recap` to shared definitions with complete object schemas while
  retaining the existing V1 factory wrappers and observable ask/metadata/output
  behavior.
- Added `tests/host-tool-contract.test.ts` covering shared schemas, execution,
  V1 ID/context mapping, model inventory hydration, and V1 notice/notification
  translation.

### Phase 2 verification

- **PASS**: Targeted tool/contract/update tests — 72/72.
- **PASS**: Targeted host/config/model/state integration tests — 52/52.
- **PASS**: `npm test` — 1,294/1,294.
- **PASS**: Targeted Prettier check for every changed source and test file.
- **PASS**: `npm run typecheck`.
- **PASS**: `npm run build`.
- **PASS**: `npm run verify:package` — 201 tarball entries.
- **DEFERRED**: Phase 3 session serialization/speculative transactions and all
  V2 projection, tool registration, commands, proxy, RPC/TUI, lifecycle, and
  package-export work remain intentionally untouched.

### Lead review follow-up

- Consolidated structural client translation in `lib/host/legacy.ts`; the typed
  `lib/v1/host.ts` entrypoint now delegates to that single implementation.
- Removed the runtime V1 `tool()` dependency from `lib/v1/tools.ts`; the adapter
  now returns the equivalent `{ description, args, execute }` object using
  type-only V1 imports while retaining root-Zod parsing and context mapping.
- **PASS**: Focused review verification — five tool suites 58/58, host/tool
  contract 3/3, V1 integration 4/4, typecheck, build, and targeted formatting.

## 5. Risk Assessment and Rollback

- **Risk points**: Message projection fidelity, transactional state updates,
  tool-pair integrity, dual-runtime drift, and lifecycle cleanup.
- **Rollback method**: Revert V2 adapter commits. No persisted-format migration is
  planned, so existing state remains usable.
- **Compatibility notes**: V1 minimum rises to 1.18.29; V2 minimum is 2.0.3.

## 6. Follow-ups

- Implement the approved design in bounded, reviewable slices.
- Follow `docs/superpowers/plans/2026-09-15-opencode-v2-implementation.md`.
- Obtain at least two independent agent reviews for all changed source/tests.
- Run packed-artifact V1 and V2 E2E verification before PR readiness.
