# DESIGN - OpenCode V2 Compatibility

- Task ID: `2026-09-15_opencode-v2`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Accepted

## 1. Problem Statement

OpenCode V2 rejects ACP before setup because ACP default-exports a V1 async
plugin function. OpenCode 2.0.3 requires a default object with a stable `id` and
an `effect` or `setup` function. Renaming a configuration key or wrapping the
function without porting its behavior would only hide the first incompatibility:
V2 also replaces returned hooks, mutable configuration, tool registration,
commands, events, client methods, message projections, and TUI notifications.

The migration must make the existing `opencode-acp` package useful on V2 without
discarding its V1 users or rewriting the compression engine and persisted state
at the same time.

## 2. Goals and Non-Goals

### Goals

- Support OpenCode V1 >= 1.18.29 and V2 >= 2.0.3 from one package.
- Preserve ACP compression algorithms, state schema, prompts, config layering,
  commands, tool behavior, proxy self-disable, model-limit behavior, and cleanup.
- Keep V2 provider metadata, attachments, compaction checkpoints, and tool
  protocol state intact when ACP transforms model context.
- Verify installed tarballs against real V1 and V2 hosts with a local fake
  provider and isolated user directories.
- Use only supported public V2 APIs and fail safely where V2.0.3 lacks an
  equivalent V1 capability.

### Non-Goals

- A V2-native rewrite of all compression algorithms and data structures.
- Changes to persisted ACP state, IDs, internal `dcp-*` tags, or prompt formats.
- Compatibility with V1 hosts older than 1.18.29 after the dual export ships.
- Changes to OpenCode core or undocumented access to its permission/session
  internals.
- Protocol-specific rewriting of provider HTTP streams.
- New compression features or behavior unrelated to host compatibility.

## 3. Evidence and Compatibility Baseline

### Current ACP surface

`index.ts` currently returns these V1 hooks and tools:

```text
experimental.chat.system.transform
experimental.chat.messages.transform
experimental.text.complete
command.execute.before
event
config
tool:
  compress
  decompress
  search_context
  acp_status
  acp_context_recap
```

The message transform is load-bearing. It performs shape filtering, state
resolution, model-limit reconciliation, permission synchronization, hallucination
and reasoning removal, third-party filters, system-token caching, ref assignment,
block synchronization, tool caching, GC, pruning, consumed-call hiding, nudge
injection, output truncation, context-budget enforcement, failed-call hiding, and
debug snapshots in a deliberate order.

### Exact V2.0.3 capabilities

The design targets the published `@opencode/plugin@2.0.3` package rather than a
newer website example or an older checkout. It provides:

- Promise plugin definitions with `{ id, setup }` and cleanup.
- Separate `session.context`, `session.compaction`, `session.generate`, and
  `session.title` hooks.
- `session.context({ sessionID })` projected history.
- Tool, command, agent, catalog, and other domain transforms.
- Tool execute-before/after hooks.
- Catalog provider/model access, including model context limits.
- Session permission rules, but no permission-request creation method exposed to
  server plugins.
- TUI plugins and typed plugin RPC.

V2.0.3 does not provide a post-generation text mutation hook. These two gaps
define the safe fallbacks in Section 8.

## 4. Proposed Architecture

### 4.1 Component layout

```text
Package entrypoints
├── index/server: dual V2 definition + V1 server()
├── tui: V2 notification listener
└── rpc: shared typed notification contract

Shared ACP engine
├── config and prompt loading
├── compression/search/decompression/status/recap logic
├── state registry and persistence
├── context transformation pipeline
├── command dispatch and notification formatting
└── host-neutral service and tool contracts

Host adapters
├── V1
│   ├── legacy PluginInput/client facade
│   ├── returned V1 hooks
│   └── @opencode-ai/plugin tool wrappers
└── V2
    ├── setup and lifecycle
    ├── projected-history normalization
    ├── validated outgoing-context patching
    ├── @opencode/plugin tool and command transforms
    ├── catalog/proxy monitoring
    └── server notification RPC emission
```

`index.ts` remains composition-only. Runtime-specific initialization is lazy so
loading one host path does not execute the other adapter.

### 4.2 Dual default export

The default export combines the documented V2 definition with the V1 object
entrypoint supported by OpenCode 1.18.29 and newer:

```text
default:
  id: "opencode-acp"
  setup(ctx): V2 registrations and cleanup
  server(input, options): V1 hooks
```

Package exports include `.`, `./server`, `./tui`, and `./rpc`. The server and
default package paths resolve the same dual definition. The V2 TUI and RPC
entrypoints remain independently importable.

## 5. Host-Neutral Core Boundaries

### 5.1 Host service contract

Host-specific API calls are hidden behind a small contract that covers only what
ACP uses:

- get current or parent session information
- read projected session context/history
- resolve provider/model metadata and context limits
- write an ACP-owned, non-resuming session notice
- emit a formatted notification

The V1 implementation adapts the current `ctx.client` methods. The V2
implementation uses in-process plugin domains. The compression engine does not
know which host API served the data.

### 5.2 Tool definition contract

The five tools share one host-neutral definition containing:

- name and description
- Standard Schema-compatible input
- ACP execution callback
- ACP execution context with session, message, agent, call ID, progress metadata,
  effective permission, and optional host cancellation when that runtime exposes
  it

V1 wraps this contract with `@opencode-ai/plugin` `tool()`. V2 registers it with
`ctx.tool.transform`, sets `codemode: false`, and returns structured V2 tool
content. No compression behavior is duplicated in the wrappers.

### 5.3 Persistence boundary

ACP continues using its existing filesystem persistence instead of moving state
into V2 plugin key-value storage. This preserves:

- custom `storagePath`
- existing session state files
- current write serialization
- V1/V2 interoperability during the dual-support window

The state codec accepts only ACP's internal representation. Host message objects
must be normalized before state logic sees them.

## 6. V2 Context Data Flow

### 6.1 Request flow

ACP registers only `ctx.session.hook("context", ...)`, which V2.0.3 invokes for
primary agent requests. It deliberately does not register compaction, generate,
or title hooks.

For each primary request:

1. Resolve `event.model` in the V2 catalog and record its current context limit.
2. Read `ctx.session.context({ sessionID })` for projected, ID-bearing history.
3. Normalize projected messages into ACP's existing internal message envelope.
4. Snapshot request-mutated registry state.
5. Run the existing ACP message pipeline against a copy.
6. Derive a context patch by comparing original and transformed internal data.
7. Validate every patch correlation and structural invariant.
8. Apply the validated patch to V2's already-lowered `event.messages`.
9. Commit request state and persist it.
10. Render and append the ACP system prompt to `event.system`.

Combining message and system behavior in one V2 hook preserves the V1 ordering
assumption that message processing establishes the current model and state before
system-prompt injection.

### 6.2 Why patch instead of reconstruction

OpenCode V2 lowers projected session history into provider-ready
`@opencode/ai` messages before plugin context hooks. That lowering preserves
attachments, provider metadata, provider-executed tools, compaction checkpoints,
and protocol state. ACP must not duplicate it.

The V2 adapter therefore applies only ACP-owned changes:

- remove a message by stable session message ID
- replace or append text/reasoning belonging to a known message ID
- replace a tool result by stable tool-call ID
- insert an ACP summary or nudge with an ACP-owned ID
- remove ACP-owned model-invisible notices

All other fields and content parts remain the original V2 objects.

### 6.3 Projection categories

Normalization explicitly handles:

- user messages and attachment metadata
- assistant text and reasoning
- streaming, running, completed, and failed tool entries
- provider-executed tool entries
- completed, running, and failed compaction messages
- synthetic, system, skill, shell, and location messages
- agent/model/control messages that do not enter model context

A completed compaction maps to ACP's current boundary semantics: transient refs,
nudge baselines, and tool-parameter caches reset, while active ACP blocks and
statistics survive. Running or failed compactions do not reset state.

### 6.4 Patch validation and transactionality

Before mutation:

- all message and call IDs resolve uniquely
- retained ordering is monotonic
- summary anchors remain valid
- tool calls and results remain paired
- inserted IDs are ACP-owned and collision-free
- the resulting V2 messages satisfy their schemas

Validation failure preserves the original request. ACP restores the registry
snapshot so its state cannot claim a transform the model never received. The
failure is logged without message bodies or credentials.

## 7. V2 Lifecycle and Integrations

### 7.1 Setup and cleanup

V2 setup loads config, handles environment self-disable, creates runtime services,
registers hooks/transforms/RPC, starts catalog monitoring and the optional update
check, and returns cleanup.

Registrations are automatically scoped by OpenCode. ACP cleanup aborts event
iterators, update fetches, delayed notices, in-flight adapter work, and owned timers.
Cleanup is idempotent. Partial setup failure disposes already-created resources
before plugin activation fails.

### 7.2 Tools and timing

All five tools register as direct model tools. V2 call ID, message ID, session ID,
and agent map into the shared execution context. `progress()` carries the title
and status metadata currently sent through V1 tool metadata.

Timing uses V2 tool execute-before/after hooks for ACP tools rather than
reconstructing V1 `message.part.updated` events. This retains reliable call and
session correlation.

### 7.3 Commands and model-invisible notices

V2 registers `acp` and `dcp` command definitions. Their executor parses
`prompt.text` and invokes the existing dispatcher directly; it does not resubmit
the command text to the model.

Command output is written as an ACP-owned synthetic message with `resume: false`.
ACP recognizes its ID and removes it from all later primary model contexts. This
keeps the result visible to users without making it model input or triggering a
new model request.

### 7.4 Proxy detection

`BILLION_CONTEXT_PROXY` prevents registration at startup. Manual proxy detection
reads V2 provider settings and finds the exact `/bili/` route marker. ACP refreshes
that state on catalog changes. A changed state reloads tool and command transforms
and immediately guards context processing, allowing removal of the proxy to
re-enable ACP without a server restart.

### 7.5 Notifications

The server adapter emits typed ACP RPC notification events. The package's V2 TUI
entrypoint subscribes and maps them to `ctx.ui.toast.show`. Missing TUI listeners
are non-fatal, so server-only and headless operation continue normally. Config
warnings, compression notices, and update notices share the same channel.

The V1 adapter retains the existing client toast implementation.

### 7.6 Authentication

V1 retains its secure-client Basic-auth interceptor. V2 uses in-process plugin
domains, and the TUI's provided client is already authenticated. ACP V2 does not
read service registration/configuration files or environment credentials.

## 8. Supported-API Fallbacks

### 8.1 Interactive permission ask

OpenCode 2.0.3 lets custom tools declare a permission action and applies wholly
denied rules when building the tool snapshot. Its server plugin context exposes
permission rules but not the method that creates a native permission request.

Therefore:

- `deny`: the tools are not advertised or executed
- `allow`: tools execute normally
- `ask`: execution fails closed before state mutation with an actionable message
  requiring an explicit allow or deny choice

Agent-specific effective rules remain authoritative. ACP does not emulate native
permission prompts through private APIs. V1 behavior remains unchanged.

### 8.2 Completed-text sanitation

OpenCode 2.0.3 has no supported hook that rewrites completed assistant text before
persistence/display. ACP sanitizes hallucinated ACP/DCP references when that text
is next assembled into outbound primary context. It does not rewrite provider HTTP
streams or persisted history. This preserves model-context safety while making the
host limitation explicit.

## 9. Error Handling and Observability

- Setup errors fail plugin activation instead of leaving a partial runtime.
- Projection or patch errors leave the model request untouched and roll back
  request state.
- Expected tool input/permission failures use structured V2 tool errors.
- Persistence errors retain current in-memory state and preserve newest-write
  ordering.
- Catalog and event failures retain the last valid state, log, and continue the
  subscription loop where possible.
- RPC notification delivery never gates compression.
- Logs include runtime, adapter phase, session/call identifiers where safe, and
  error classification; they exclude prompt bodies, tool output, authorization,
  and credentials.

## 10. Verification Strategy

### 10.1 Unit and contract tests

Existing algorithm tests remain authoritative. Shared fixtures exercise both
adapters for model limits, pruning, IDs, nudges, tool pairs, compaction, forks,
permissions, proxy state, and persistence.

V2-specific fixtures cover every normalized projection category and patch
operation. They assert that unchanged provider fields survive, invalid
correlations preserve the request, state rolls back, pairs remain atomic, and
only ACP-owned notices are hidden.

Lifecycle tests cover partial setup, unload/reload, update cancellation, catalog
changes, RPC cleanup, and duplicate-registration prevention.

### 10.2 Installed-package E2E

The E2E harness builds and packs ACP, installs the tarball under isolated home and
XDG directories, disables auto-update, unsets real provider credentials, and uses
the existing local fake provider.

The exact OpenCode 2.0.3 runtime is configured with native `plugins`, `providers`,
`agents`, and `permissions`. Tests cover discovery, five tools, context behavior,
both command names, restart persistence, proxy transitions, permission fallbacks,
and reload/unload. A V1 >= 1.18.29 smoke test validates the same packed dual
entrypoint.

### 10.3 Package verification

`scripts/verify-package.mjs` additionally checks the packed runtime shape,
entrypoint resolution, manifest/lock consistency, tarball exclusions, and absence
of credential-like files.

Required final commands are:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify:package
```

Installed-artifact V1 and V2 E2E checks follow those commands.

## 11. Implementation and Review Sequence

1. Establish dual package entrypoints and host-neutral contracts.
2. Preserve and adapt the V1 path behind `server()`.
3. Add V2 projection normalization and validated request patching.
4. Add V2 tools, timing, commands, permissions, model catalog, and proxy state.
5. Add RPC/TUI notifications and cancellable lifecycle resources.
6. Add shared adapter contracts and V2 unit/integration tests.
7. Extend package verification and installed-artifact V1/V2 E2E.
8. Update compatibility and installation documentation.
9. Run two independent agent reviews of every changed source and test file.
10. Run the complete verification matrix and prepare a PR referencing issue #395.

Implementation work may be delegated to bounded `general` subagents, but the lead
retains architecture, integration, review resolution, and final verification.

## 12. Decisions and Rationale

| Decision               | Options considered                                   | Chosen                    | Why                                                                                 |
| ---------------------- | ---------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Runtime support        | V2-only; separate packages; dual export              | Dual export               | Preserves current V1 users while adding V2 through the documented transition shape. |
| Core representation    | V2-native rewrite; V1 emulation; host adapters       | Shared core with adapters | Minimizes algorithm/state regression while isolating host APIs.                     |
| V2 transcript handling | Reconstruct all messages; patch original V2 messages | Validated patch           | Preserves provider-owned metadata and conversion behavior.                          |
| V2 baseline            | Current docs/head; exact installed release           | 2.0.3 package API         | Matches the reported failure and produces a reproducible compatibility floor.       |
| V2 ask gap             | Private API; custom TUI protocol; fail closed        | Fail closed               | Safe, predictable, and supported in headless as well as TUI environments.           |
| Text completion gap    | Rewrite HTTP streams; outbound sanitation            | Outbound sanitation       | Protocol-neutral and avoids corrupting streamed provider responses.                 |
| Notifications          | Drop; synthetic chat only; RPC + TUI plugin          | RPC + TUI                 | Uses V2's supported separation between server and terminal extensions.              |
| State storage          | Move to V2 KV; retain filesystem                     | Retain filesystem         | Preserves custom paths and V1/V2 state interoperability.                            |

## 13. Alternatives Explicitly Set Aside

- **V2-native engine rewrite**: cleaner eventually, but it expands this migration
  into a rewrite of message algorithms and invalidates much of the mature test
  suite.
- **Whole-transcript V1 emulation**: deceptively small diff that duplicates
  OpenCode's provider-aware lowering and risks metadata loss.
- **V2-only package**: rejected because dual support is required.
- **Private server APIs or service-credential discovery**: rejected as unstable
  and unsafe.
- **OpenCode core changes in this work**: rejected so ACP can work on released
  OpenCode 2.0.3.
- **New compression features**: deferred to keep the API migration reviewable.

## 14. Resolved Questions

- Compatibility mode: dual V1/V2.
- V1 minimum: 1.18.29.
- V2 minimum and test baseline: 2.0.3.
- Behavior target: full supported-API parity with the two explicit V2 fallbacks.
- Architecture: shared core plus explicit host adapters.
- Branch: `2026-09-15_opencode-v2`, created from updated `master` and advanced to
  the completed DCP integration commit before adding V2 work.
