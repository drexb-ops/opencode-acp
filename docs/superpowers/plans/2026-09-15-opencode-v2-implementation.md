# OpenCode V2 Compatibility Implementation Plan

## Objective

Make the published `opencode-acp` package load and operate on OpenCode V2 2.0.3
while retaining OpenCode V1 support from 1.18.29 onward. Preserve the existing
compression engine and persisted state. Implement only the two approved V2
fallbacks: fail closed for `ask`, and sanitize completed text before it re-enters
model context.

The lead owns integration, deviations from this plan, and final verification.
Coding work may be delegated to bounded `general` subagents, but no subagent may
change the architecture, publish, merge a PR, or declare the migration complete.

## Baseline and invariants

- Branch: `2026-09-15_opencode-v2`
- Planning baseline: `7224ab9`
- Primary issue: `#395`
- Concurrency issue: `#404`
- Package version stays `1.18.1` on this feature branch.
- V1 minimum becomes 1.18.29.
- V2 compile/runtime baseline is exactly 2.0.3.
- No state schema/path/tag/ID migration is permitted.
- Existing algorithm behavior remains authoritative unless a V2 adapter cannot
  safely represent it; such cases must fail without altering outbound context.

Before source changes, record a clean status and run:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify:package
```

If the integrated baseline fails, record the failure in the worklog before
attributing any later failure to the V2 work.

## Phase 1 — Dual entrypoint and dependency foundation

### Goal

Make the package shape valid for both hosts without changing runtime behavior on
V1 and without yet claiming functional V2 support.

### Changes

1. Add exact V2 runtime dependencies used directly by ACP:
   - `@opencode/plugin` 2.0.3
   - `@opencode/ai` 2.0.3 when V2 message constructors/schemas are imported
2. Raise the V1 peer minimum for `@opencode-ai/plugin` to 1.18.29 and align the
   V1 SDK range. Keep a compatible V1 dev dependency for tests.
3. Regenerate `package-lock.json` without changing the ACP package version and
   correct its stale root metadata.
4. Move the current `index.ts` factory into `lib/v1/plugin.ts` with behavior
   unchanged.
5. Replace `index.ts` with a composition-only dual default object:
   - stable `id: "opencode-acp"`
   - lazy V2 `setup(ctx)`
   - lazy V1 `server(input, options)`
6. Create the initial `lib/v2/plugin.ts` setup boundary. It may begin with only
   lifecycle-safe registration scaffolding, but must not advertise unfinished
   tools or commands.
7. Update `tsup.config.ts` entry declarations in preparation for root, TUI, and
   RPC builds without publishing incomplete subpaths.

### Tests

- Add `tests/plugin-entrypoint.test.ts` that imports the source default export and
  asserts `id`, `setup`, and `server` without invoking the wrong runtime.
- Update `tests/bili-proxy-integration.test.ts` to invoke `.server()` and retain
  all V1 assertions.
- Build and dynamically import the built root entrypoint.

### Verification checkpoint

```sh
node --import tsx --test tests/plugin-entrypoint.test.ts tests/bili-proxy-integration.test.ts
npm run typecheck
npm run build
```

## Phase 2 — Host-neutral services and tool definitions

### Goal

Remove direct V1 host assumptions from shared execution logic while preserving
the V1 adapter's observable behavior.

### Changes

1. Add a focused host contract under `lib/host/` for:
   - session get and projected history
   - parent history for fork recovery
   - model inventory/context limits
   - ACP-owned non-resuming notices
   - notification emission
2. Change `getConfig()` to accept the minimal directory/notification inputs it
   uses rather than the entire V1 `PluginInput`.
3. Route config warnings, compression notifications, command notices, debug
   notices, and update notices through a notification/notice sink.
4. Change model-limit hydration to consume a host-neutral model inventory. Keep
   the V1 `client.config.providers()` translation in `lib/v1/`.
5. Define a shared ACP tool contract with a complete Zod object schema, name,
   description, and host-neutral execution context.
6. Replace `tool.schema` usage with direct `zod` schemas. Export shared
   definitions from all five tool modules.
7. Add `lib/v1/tools.ts` to convert a shared object schema back to the V1 raw
   argument shape and map V1 `ask()`/`metadata()` behavior.
8. Keep tool results and permission behavior identical on V1.

### Tests

- Preserve the existing tool factory tests by exercising the V1 wrapper.
- Add contract tests that invoke shared tool definitions with a fake host-neutral
  context.
- Add model inventory and notification sink tests.
- Avoid `instanceof` assertions across V1/V2 Zod or Effect package copies.

### Verification checkpoint

```sh
node --import tsx --test tests/compress-range.test.ts tests/inactive-block-decompress.test.ts tests/search-context.test.ts tests/acp-status.test.ts tests/recap.test.ts tests/update.test.ts
npm run typecheck
```

## Phase 3 — Session serialization and speculative transform transactions

### Goal

Fix issue #404 and create a safe transaction boundary before V2 executes the
existing mutation-heavy pipeline speculatively.

### Changes

1. Add per-session serialization owned by `SessionStateRegistry`:
   - one in-flight initialization promise per session
   - one mutation queue/mutex shared by context transforms and compression tools
   - eviction must not remove a session with active guarded work
2. Add full runtime state clone/commit helpers. Clone every mutable field,
   including transient caches and derived versions, but preserve the shared
   `compressionTiming` object identity.
3. Extract the mutation body of `createChatMessageTransformHandler` into a
   state-explicit shared function, for example `runMessageTransform()`.
4. Define injected transform effects for persistence, notification, prompt
   reload, filter registration, and debug snapshots.
5. Remove direct speculative saves from `injectCompressNudges()` and
   `updatePerTurnState()`. Report required effects to the wrapper instead.
6. Keep V1 semantics by running the shared transform under the registry guard and
   committing its deferred effects immediately after successful transformation.
7. Make compression tool preparation/finalization use the same session guard so
   a tool cannot race a context transaction.

### Tests

- Add concurrent `getOrCreate()` initialization tests that block the first load
  and prove a second caller cannot observe partial state.
- Add concurrent context/tool mutation tests that prove ordered commits.
- Add full clone/commit coverage for prune state, nudges, stats, refs, tool caches,
  compaction/turn fields, model data, permissions, and transient flags.
- Add a failure after several mutations and prove no persistence/notification
  effect ran and no runtime field leaked.
- Re-run existing registry, persistence, transform, nudge, and compression
  rollback tests.

### Verification checkpoint

```sh
node --import tsx --test tests/registry.test.ts tests/persistence.test.ts tests/compress-rollback.test.ts tests/e2e-message-transform.test.ts tests/e2e-blocks-nudges.test.ts tests/inject.test.ts
npm run typecheck
```

## Phase 4 — V2 projection, provenance, and validated patching

### Goal

Run ACP's shared transform against V2 projected history while preserving all
host-owned provider-ready message content.

### Changes

1. Add V2 projection types under `lib/v2/`:
   - normalized ACP messages used by current algorithms
   - provenance entries for each projected message and content part
   - opaque markers for content that cannot be losslessly represented
   - a projection fingerprint over stable message/order/tool-call identities
2. Normalize every OpenCode 2.0.3 `SessionMessage.Info` category:
   - user, assistant, synthetic, system, skill, shell, and location
   - running/completed/failed compaction
   - streaming/running/completed/error and provider-executed tools
   - control messages omitted by OpenCode lowering
3. Add internal-only turn markers derived from projected assistant steps so
   existing turn accounting remains meaningful without V1 `step-start` parts.
4. Preserve tool file/structured output and provider checkpoint messages as
   opaque sidecar data. Do not tag, truncate, or rebuild them unless a specific
   safe origin mapping exists.
5. Derive a patch from original/transformed normalized copies:
   - retained/removed source message IDs
   - text/reasoning edits by exact part origin
   - tool input/result changes by call ID
   - ACP-owned synthetic insertions
6. Apply the patch to a replacement copy of `event.messages`, preserving original
   top-level fields, cache/provider metadata, native state, media, files, and
   uncorrelated host messages.
7. Validate unique IDs, monotonic ordering, call/result atomicity, anchor
   validity, opaque boundaries, ACP-owned insertion IDs, final message schemas,
   and projection fingerprint before one final array replacement.
8. On any mismatch, keep the original request and discard the working state and
   deferred effects.

### Tests

Add focused V2 projection/patch tests covering:

- all projected message categories and compaction states
- text/image/PDF/directory attachments
- same-model/different-model provider metadata
- every tool state and result representation
- provider-executed and separate role-`tool` result messages
- multiple calls, duplicate IDs, orphan results, unknown origins
- opaque provider checkpoints and system messages
- invalid fingerprints and extra uncorrelated host messages
- atomic tool-pair removal and idempotent repeated patching
- full state/effect rollback after patch rejection

### Verification checkpoint

```sh
node --import tsx --test tests/v2-message-projection.test.ts tests/v2-context-patch.test.ts tests/tool-pair-integrity.test.ts tests/reasoning-strip.test.ts tests/truncate-tools.test.ts tests/enforce-budget.test.ts
npm run typecheck
```

## Phase 5 — Functional V2 context hook and model behavior

### Goal

Connect the transaction and patch layers to the V2 primary request lifecycle.

### Changes

1. Implement the V2 `session.context` hook in `lib/v2/plugin.ts` or a focused
   `lib/v2/context.ts` module.
2. Resolve `event.model` from `ctx.catalog.model.list()` and update the current
   model/context limit before message transformation.
3. Read `ctx.session.context({ sessionID })`, normalize it, run the transaction,
   validate the patch, and render the system prompt from the working state before
   changing the hook event.
4. Replace `event.messages`, append the rendered prompt to `event.system`, commit
   state/effects, and release the session guard as one non-throwing finalization
   path.
5. Do not register compaction, generate, or title hooks.
6. Map V2 completed compaction boundaries to existing ACP reset semantics while
   preserving active blocks and stats.
7. Adapt V2 session get/context calls used by fork-state recovery.
8. Apply completed-text sanitation to outbound assistant text only. Do not mutate
   persisted history or HTTP responses.

### Tests

- V2 primary hook changes messages and system in the required order.
- Compaction/generate/title hooks are absent.
- Same-request model switches use the new context limit.
- Completed compaction resets only transient ACP fields.
- Fork recovery maps parent/child projected IDs correctly.
- Sanitized historical text cannot leak stale ACP/DCP refs into a new request.

### Verification checkpoint

```sh
node --import tsx --test tests/v2-context.test.ts tests/model-switch-limits.test.ts tests/rebuild.test.ts tests/fork-rebuild.test.ts tests/reasoning-strip.test.ts
npm run typecheck
```

## Phase 6 — V2 tools, permissions, commands, and proxy state

### Goal

Expose ACP's interactive surface through supported V2 domain APIs.

### Changes

1. Register all five shared tools with `ctx.tool.transform` and
   `options.codemode: false`.
2. Map V2 session/message/agent/call IDs and `progress()` into the shared tool
   context. Return `{ content: string }`.
3. Set `options.permission: "compress"` and inspect the active agent's effective
   rules before execution:
   - deny: omit/block the tools
   - allow: execute
   - ask: return an actionable structured error before acquiring/mutating state
4. Register tool execute-before/after hooks for ACP call timing.
5. Register `acp` and `dcp` through one replayable command transform. Parse
   `prompt.text`, invoke shared dispatch, and write an ACP-owned synthetic notice
   with `resume: false`.
6. Strip only those ACP-owned synthetic notice IDs in the context adapter.
7. Add a V2 provider settings extractor for exact `/bili/` route detection.
8. Initialize mutable proxy state from the catalog. Register one event loop for
   `catalog.updated`; refresh state then call tool/command reload. Never add a new
   transform per event. Preserve the last valid state after a refresh failure.
9. The environment proxy guard skips all V2 registrations at setup.

### Tests

- Five tools register exactly once and are direct rather than Code Mode-only.
- Inputs are decoded and string output becomes V2 structured content.
- Allow/deny/ask behavior, including no state mutation on ask.
- Tool timing is recorded for success and error.
- `/acp` and `/dcp` dispatch without prompting the model.
- Synthetic notices remain user-visible in projection but absent from outbound
  model context.
- Proxy state disables/re-enables tools, commands, and hooks after catalog reload
  without duplicate registrations.

### Verification checkpoint

```sh
node --import tsx --test tests/v2-tools.test.ts tests/v2-commands.test.ts tests/v2-proxy.test.ts tests/host-permissions.test.ts tests/bili-proxy.test.ts tests/bili-proxy-integration.test.ts
npm run typecheck
```

## Phase 7 — RPC/TUI notifications and cancellable lifecycle

### Goal

Restore V2 TUI notifications and guarantee clean unload/reload behavior.

### Changes

1. Add `rpc.ts` with a typed ACP notification event schema containing only the
   toast fields the TUI needs.
2. Register the RPC in V2 server setup and expose a non-blocking notification
   sink backed by `registration.events.emit()`.
3. Add `tui.ts` using `@opencode/plugin/tui`; subscribe through
   `context.client.rpc(AcpRpc)` and return the unsubscribe cleanup.
4. Route compression/config/debug/update notices through the shared sink.
5. Refactor `startAutoUpdate()` to return idempotent cleanup that aborts its
   registry fetch, clears the fetch timeout and delayed notification timer, and
   suppresses post-unload callbacks.
6. Track setup resources in reverse-disposal order so partial registration
   failure cleans up deterministically.
7. Do not promise force-cancellation of an already-running V2 tool; V2.0.3 does
   not expose a tool abort signal.

### Tests

- RPC payload validation and server emit behavior.
- TUI subscriber maps notifications to native toast options and unsubscribes.
- No-listener/headless emission is non-fatal.
- Update cleanup cancels fetch/timers and prevents late toasts.
- Partial setup and normal unload leave no listener, timer, transform, or hook.

### Verification checkpoint

```sh
node --import tsx --test tests/v2-notifications.test.ts tests/v2-lifecycle.test.ts tests/update.test.ts tests/config-validation.test.ts
npm run typecheck
npm run build
```

## Phase 8 — Package exports and artifact verification

### Goal

Make the tarball—not only workspace source—the compatibility unit.

### Changes

1. Add package exports for `./tui` and `./rpc`; keep `.` and `./server` pointed at
   the dual server entrypoint.
2. Build root/server, TUI, and RPC declaration/JavaScript entrypoints.
3. Update `tsconfig.json` includes so declarations are emitted for `tui.ts` and
   `rpc.ts` as well as the server and shared modules.
4. Extend `scripts/verify-package.mjs` to:
   - require all four entrypoint files and declarations
   - traverse import graphs for every entrypoint
   - install/import the packed root and assert `id`, `setup`, and `server`
   - resolve `./server`, `./tui`, and `./rpc`
   - check manifest/lock root version consistency
   - reject credential-like tarball file names and existing forbidden paths
5. Keep sources, tests, scripts, lockfile, CI, and build config outside the
   published package.

### Tests and verification checkpoint

```sh
npm run build
npm run verify:package
npm pack --dry-run --json --ignore-scripts
```

Inspect the resulting file list without printing file contents that could contain
credentials.

## Phase 9 — Installed-artifact V1/V2 E2E

### Goal

Prove the packed package works on both claimed host versions without real
credentials.

### Changes

1. Split or extend `scripts/e2e/` with explicit V1 and V2 harnesses.
2. Pack ACP once and install that tarball into temporary isolated environments.
3. Set isolated `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`.
4. Unset provider/service credentials and set ACP `autoUpdate: false`.
5. Run a local fake OpenAI-compatible provider.
6. V1 smoke: use an OpenCode release >= 1.18.29 and V1 configuration to verify
   dual `.server()` discovery and a representative compression path.
7. V2 full path: pin OpenCode 2.0.3 and use native `plugins`, `providers`,
   `agents`, and `permissions` configuration.
8. Assert:
   - plugin active with ID `opencode-acp`
   - five tools available and compression changes later context
   - `/acp` and `/dcp` notices do not reach the fake model
   - state survives server restart
   - allow/deny/ask fallbacks behave as documented
   - manual proxy disable/re-enable works
   - reload/unload creates no duplicate behavior
9. Unit-test TUI RPC wiring separately if terminal rendering cannot be made
   deterministic in headless CI.

### Verification checkpoint

Run the new V1 and V2 installed-artifact scripts and record exact host/package
versions and pass counts in the worklog.

## Phase 10 — Documentation, review, and final gate

### Documentation

Update:

- `README.md` and `README.zh-CN.md`
- `CONFIGURATION.md` and `CONFIGURATION.zh-CN.md`
- `TESTING.md`
- `scripts/e2e/README.md`

Document installation on both host generations, V2-native `plugins`
configuration, the V1/V2 minimums, direct tools, RPC/TUI notifications, the
fail-closed V2 `ask` limitation, outbound-only text sanitation, state
compatibility, and local verification.

### Mandatory independent reviews

After implementation stabilizes, use at least two independent `explore`
subagents. Each receives the complete changed-file list and must review:

- correctness and missing cases
- V1 compatibility
- V2 API correctness
- message/provider metadata integrity
- state transaction/concurrency safety
- cleanup/resource ownership
- test validity and anti-tautology requirements
- package/privacy/release constraints

Resolve every finding centrally. Re-run targeted tests after each fix.

### Final gate

```sh
git diff --check
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify:package
```

Then run both installed-artifact E2E suites, inspect the final diff and tarball
file list, update `WORKLOG.md` with commits/results/reviews, and prepare a PR that
references `#395` and `#404`. Do not merge the PR.

## Delegation sequence

Use sequential or non-overlapping `general` subagents so shared files are never
edited concurrently:

1. **Foundation builder** — Phases 1–3: dual entrypoint, host contracts, shared
   tool schemas, state serialization, and transform effect extraction.
2. **V2 context builder** — Phases 4–5: projection/provenance/patching and primary
   context integration, after foundation interfaces stabilize.
3. **V2 runtime builder** — Phases 6–8: tools, commands, proxy, RPC/TUI, lifecycle,
   package exports, and verifier, after context interfaces stabilize.
4. **E2E/documentation builder** — Phases 9–10 documentation and harness changes
   after the packed runtime works locally.

The lead inspects each result, runs its checkpoint, amends defects, and commits a
coherent slice before starting the next builder. Review agents run only after all
slices are integrated.
