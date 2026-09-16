# WORKLOG - OpenCode V2 Compatibility

- Task ID: `2026-09-15_opencode-v2`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-16 04:47 UTC

## 1. Summary

- **What was done**: Investigated the production plugin failure, mapped ACP's V1
  host dependencies, verified the exact published OpenCode 2.0.3 plugin API,
  recorded the approved V1/V2 compatibility design, and implemented the shared
  host/tool contracts, transactional state, and V2 primary context adapter.
- **Why**: ACP currently fails before initialization on OpenCode V2 because its
  default export and all host integrations use the V1 plugin API.
- **Behavior / compatibility changes**: No intentional V1 behavior changes;
  existing V1 factories now run through the shared definitions and adapters.
- **Risk level**: High

## 2. Change Log

### Commits

| Commit      | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| `7224ab9`   | Record the approved OpenCode V2 compatibility design           |
| `3c00b9a`   | Refine concurrency boundaries and add the implementation plan  |
| `b42d827`   | Record the integrated pre-change verification baseline         |
| `b569ccd`   | Add the dual V1/V2 entrypoint and dependency foundation        |
| `5d21e10`   | Add shared host services and host-neutral tool definitions     |
| `9a349ec`   | Serialize session mutations and stage transform effects        |
| `42637b6`   | Add V2 projection, validated patching, and primary context     |
| `3a8c21e`   | Add V2 tools, commands, permissions, timing, and proxy state   |
| `6ef5085`   | Add typed notifications and managed runtime cleanup            |
| `ec3c7a7`   | Publish and verify server, TUI, and RPC package entrypoints    |
| `5eaafdb`   | Document OpenCode V1/V2 compatibility                          |
| `0cccee3`   | Resolve lifecycle, state recovery, and projection audit issues |
| This commit | Add and verify installed-artifact V1/V2 E2E                    |

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

## 7. Phase 3 — Session serialization and transform transactions

- Added per-session initialization coordination and FIFO guarded work. Registry
  reads hide initializing entries, guarded work protects sessions from eviction,
  and different session queues remain independent.
- Added complete runtime clone/commit helpers for `SessionState`, preserving the
  registry-wide `compressionTiming` object identity.
- Extracted the state-explicit `runMessageTransform` pipeline. V1 now transforms
  a cloned working state/message copy, commits only after success, and runs one
  deferred persistence/effect phase afterward. Nudge and per-turn persistence
  requests are staged during speculative work.
- Routed all five shared ACP tools, system/message/command state work, and event
  timing attachment through the same per-session guard where a session ID is
  available.
- **PASS**: `npm test` — 1,301/1,301; `npm run typecheck`; `npm run build`;
  targeted transform, registry, rollback, nudge, and tool tests.
- **DEFERRED to Phase 9**: Docker installed-artifact E2E coverage for the
  nudge-triggered compression path, nudge-state verification, and multi-turn
  growth accumulation. This follow-up is recorded, not claimed complete here.

## 8. Phase 4/5 — V2 projection and primary context hook

- Added a loss-aware V2 projected-history normalizer with source/content
  provenance, output spans, tool-call/result correlation, turn markers, opaque
  attachment/system/provider-checkpoint boundaries, and stable fingerprints.
- Added validated patching that edits the already-lowered `@opencode/ai`
  messages in place conceptually (one replacement array), preserving provider
  metadata/cache/native/structured/file content and uncorrelated host messages.
  Ambiguous or opaque mutations reject without changing the event or live state.
- Added the focused V2 session/catalog adapter and registered only the primary
  `session.context` hook. The hook resolves `event.model` limits, runs the
  shared transform under the Phase 3 guard, renders the system prompt from the
  working state, then commits event/state/deferred effects in order.
- V2 sanitation is limited to outbound historical assistant text; persisted
  history and provider streams are untouched. V2 notices remain explicit
  non-throwing placeholders until the later RPC/TUI phase.
- Split projection types, shared lowering helpers, normalization, and patching
  into focused modules after lead review. Opaque validation retains original
  object identity instead of hashing provider payloads.
- Added focused projection, patch, host/fork, rollback, and context tests.
  **PASS**: 16/16 focused V2 tests, typecheck, build, targeted formatting, and
  the final full suite at 1,318/1,318 tests.

## 9. Phase 6 — V2 runtime surface

- Registered all five shared ACP definitions as direct V2 tools with complete
  schemas, structured content/attachments, progress metadata, and the shared
  per-session state guard.
- Added ordered V2 agent permission evaluation. Deny and unresolved policy fail
  closed; OpenCode 2.0.3 `ask` returns a non-throwing actionable denial result
  before state acquisition because Promise tool errors cannot enter the native
  permission flow safely.
- Extracted shared command dispatch and registered `/acp` plus `/dcp` through a
  replayable V2 transform. Results use unique ACP-owned synthetic messages with
  `resume:false` and are removed from every later model request.
- Added session-aware V2 compression timing hooks. Identical message/call IDs in
  different sessions remain independent while sharing the registry timing map.
- Added V2 provider/model `/bili/` detection and one cleanup-safe catalog event
  monitor. Proxy transitions replay existing tool/command transforms without
  adding duplicate registrations and preserve the last valid state on errors.
- **PASS**: 61/61 lead-focused V1/V2 runtime tests, typecheck, build, targeted
  formatting, and diff checks. The coding subagent's full suite passed at
  1,337/1,337 before the final permission/timing-only refinements.
- **DEFERRED**: combined setup/unload registration accounting and notification
  transport are covered in Phase 7 lifecycle/RPC work.

## 10. Phase 7 — Notifications and lifecycle

- Added a typed `opencode-acp` RPC notification event and a V2 TUI entrypoint
  that maps it to native toasts and returns its unsubscribe cleanup.
- Added a managed notification sink. Immediate delivery is non-blocking;
  delayed config/update notices are tracked and cancelled on unload.
- Made auto-update return idempotent cleanup that aborts registry work, clears
  both timeouts, suppresses late callbacks, and performs no request when
  disabled.
- Added V1 `dispose` for notification/update ownership and refactored V2 setup
  to one reverse-order cleanup stack covering RPC, transforms, hooks, proxy
  monitoring, update work, and timers. Partial setup and individual disposer
  failures still attempt every remaining cleanup.
- Hardened proxy event shutdown by aborting and returning its async iterator.
- **PASS**: 97/97 lead-focused lifecycle/notification/runtime tests, typecheck,
  build, targeted formatting, and diff checks. The coding subagent's full suite
  passed at 1,351/1,351 tests.
- **DEFERRED**: publishing `./tui` and `./rpc`, multi-entry JavaScript builds,
  and packed-artifact verification remain Phase 8 work.

## 11. Phase 8 — Package entrypoints and verification

- Published exact condition exports for root, `./server`, `./tui`, and `./rpc`;
  root/server resolve the same dual definition.
- Configured tsup and declaration emission for all three source entrypoints with
  code-split runtime chunks and source/declaration maps.
- Extended package verification to check manifest/lock consistency, all built
  entrypoint shapes, source and packaged runtime import graphs, tarball
  exclusions, and filename-only credential/private-key patterns.
- Verification stages a temporary pack under `/tmp/opencode`, disables nested
  lifecycle builds, and always removes temporary files.
- **PASS**: `npm run check:package`, typecheck, targeted formatting, and diff
  checks. The verified tarball contains 249 entries including all twelve
  server/TUI/RPC JavaScript, declaration, and map files.
- **DEFERRED**: installing the tarball into isolated V1/V2 host environments is
  Phase 9.
- Lead-review follow-up: split the V2 projection API into a small barrel plus
  `projection/{types,shared,normalize,patch}.ts`; replaced opaque payload hashes
  with message/content reference checks; centralized `isAcpOpaquePart`; added
  direct Promise-shape host tests, cached-model-limit fallback/switch coverage,
  and an end-to-end rejected-context rollback test.

## 12. Phase 9 — Installed-artifact V1/V2 E2E

- Added `scripts/e2e/run-installed-e2e.sh`, `installed-v1.ts`,
  `installed-v2.ts`, `installed-config.mjs`, and deterministic fixtures under
  `scripts/e2e/installed-scenarios/`. The harness builds and packs ACP, then
  installs that tarball into private host/plugin prefixes under
  `/tmp/opencode/acp-e2e/hosts/{v1,v2}`.
- Host identities were verified from the installed executables: V1
  `opencode-ai@1.18.29` and V2 `@opencode/cli@2.0.3`. V1 used the one-shot
  `run --port 0` path and its installed package directory; V2 used the exact
  foreground `serve --hostname 127.0.0.1 --port <owned-port>` API path.
- The V2 2.0.3 release rejected the requested `file:///.../*.tgz` configured
  plugin path with its exact `configured plugin path must be a directory`
  diagnostic. The harness retains that server log and falls back to a local
  wrapper whose server/TUI/RPC files import the same installed tarball.
- **PASS**: `KEEP_E2E=1 ./scripts/e2e/run-installed-e2e.sh` completed in 104s.
  V1 passed default dual-entrypoint `.server()` discovery, fake response, and
  exactly one scripted ACP block. V2 passed active plugin ID/features, native
  plural config, fake model limits/tools, all five tools in the
  compress/status/search/recap/decompress sequence, ACP prompt/ID and summary
  observations, `/acp` and `/dcp` synthetic inbox output, command-sentinel and
  notice hiding, state persistence across an owned-server restart, two proxy
  disable/re-enable cycles, and duplicate-registration checks.
- **PASS**: V2 permission fixtures passed `allow` (compression block created),
  `deny` (tools/commands omitted), and `ask` (advertised tool returned an
  actionable fail-closed result with no state mutation). TUI rendering was not
  started; it remains unit-tested only.
- The successful run used `KEEP_E2E=1`, so diagnostics remain at
  `/tmp/opencode/acp-e2e` until a normal success run performs the harness's
  exact-root cleanup. No service-wide stop, global install, commit, push, or
  publish was used.
- **PRE-EXISTING FAIL**: repository-wide `npm run format:check` still reports
  427 inherited files; all modified package/E2E/config/fixture files pass the
  targeted Prettier check above.
- **PASS**: normal `./scripts/e2e/run-installed-e2e.sh` completed in 105s with
  the same matrix and removed only `/tmp/opencode/acp-e2e`; no diagnostics or
  owned host/server processes remained afterward.
- **PASS**: final repository checks included `npm run typecheck`,
  `npm test` (1,368/1,368; 117.2s), `npm run build`,
  `npm run verify:package` (253 tarball entries), targeted E2E unit helpers
  (34/34), strict TS checks for the new Node/Bun drivers, targeted Prettier,
  `bash -n`, and `git diff --check`. No changes were committed.
- **AUTHORITATIVE RERUN AFTER AUDIT FIXES**: `npm run e2e:installed` passed from
  commit `0cccee3` plus the uncommitted Phase 9 harness in 101s. It reverified
  exact V1 1.18.29 and V2 2.0.3, all five tools, command isolation,
  persistence/restart, proxy transitions, duplicate prevention, and the
  allow/deny/ask permission matrix, then removed `/tmp/opencode/acp-e2e` and
  every owned process.

## 13. Independent audit corrections

- Two independent read-only agents reviewed every Phase 1–8 source and test
  path. Their initial reports identified stale-history commit risk, lifecycle
  fencing, same-ID payload replacement, subagent enforcement, proxy retry,
  compaction/fork recovery, synthetic-ref cleanup, model override fallback,
  fixture isolation/fidelity, and runtime-clone coverage.
- Commit `0cccee3` resolves those findings with atomic history+state
  reservations, reference-validated patch origins, in-flight operation
  tracking, child-session fail-closed checks, retryable proxy state, restart
  compaction reconciliation, custom-storage/legacy-ref fork recovery,
  centralized synthetic IDs, state model fallback, isolated production-shaped
  fixtures, and binary/Error clone handling.
- **PASS**: corrective implementation full suite 1,371/1,371; lead-focused
  corrective suites 118/118; typecheck, build, package verification, targeted
  formatting, and diff checks.
- Because source/tests changed after the initial audits, final follow-up reviews
  of `ec3c7a7..0cccee3` remain required before PR readiness.
