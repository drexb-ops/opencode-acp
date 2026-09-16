# REQ - OpenCode V2 Compatibility

- Task ID: `2026-09-15_opencode-v2`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Complete
- Priority: P0
- Owner: OpenCode agent
- References: https://github.com/ranxianglei/opencode-acp/issues/395,
  https://github.com/ranxianglei/opencode-acp/issues/404,
  https://github.com/ranxianglei/opencode-acp/issues/407,
  https://github.com/ranxianglei/opencode-acp/issues/415

## 1. Background & Problem Statement

- **Context**: OpenCode 2 introduced a new plugin API. V1 plugin functions return a
  hooks object, while V2 requires a default definition containing a stable `id`
  and an `effect` or `setup` function.
- **Current behavior (symptom)**: OpenCode 2.0.3 installs `opencode-acp`, imports
  its bundle, and rejects it because its default export is the V1 async plugin
  function. The server reports `SchemaError(Expected object at ["default"])`.
- **Expected behavior**: One published `opencode-acp` package loads on OpenCode
  V1 >= 1.18.29 and OpenCode V2 >= 2.0.3. V2 must provide the same compression
  engine, tools, state compatibility, commands, proxy handling, model-limit
  behavior, and notifications that its public plugin APIs can support.
- **Impact**: ACP is completely inactive on OpenCode V2, so users lose
  model-driven context compression and all associated tools and safeguards.

## 2. Reproduction

- **Environment**:
    - OpenCode: 2.0.3
    - OS/Arch: Linux x64
- **Minimal reproduction steps**:
    1. Configure `opencode-acp@stable` as a server plugin.
    2. Start OpenCode 2.0.3 and inspect the server plugin inventory or log.
    3. Observe that the package imports but fails default-export validation.
- **Relevant configuration**:

    ```jsonc
    {
        "plugins": ["opencode-acp@stable"],
    }
    ```

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility:
        - Preserve V1 support with a documented minimum host version of 1.18.29.
        - Preserve the ACP filesystem state schema, paths, internal `dcp-*` tags,
          message refs, block refs, prompt paths, and configuration precedence.
        - Do not require users to migrate existing ACP state.
    - OpenCode V2 baseline: the exact published `@opencode/plugin@2.0.3` API.
    - The V2 implementation must use documented public APIs only. It must not read
      service credentials or depend on private server internals.
    - V2 context transforms must retain provider metadata, attachments,
      compaction checkpoints, and tool-call/result integrity.
    - V2 permission `ask` must fail closed because OpenCode 2.0.3 does not expose
      native permission-request creation to server plugins.
    - V2 completed text is sanitized before it re-enters model context because
      OpenCode 2.0.3 does not expose a post-generation mutation hook.
    - All source and modified test files require two independent agent reviews.
    - `package.json` version must not change on this feature branch.
    - Same-session initialization, context transforms, and compression tools must
      serialize state mutations so no caller observes or commits partial state.
- **Performance requirements**:
    - Avoid wholesale reconstruction of the V2 model transcript.
    - Do not add model calls or network services to the per-request transform.
    - Preserve existing transform performance characteristics outside adapter
      normalization and validated patch application.
- **Resource limits**:
    - Event subscriptions, timers, update checks, and RPC listeners must be
      cancelled on plugin unload.
- **Non-Goals**:
    - Changing compression algorithms, quality gates, prompt strategy, or state
      schema.
    - Supporting OpenCode V1 releases older than 1.18.29 in the dual-export
      package.
    - Patching OpenCode core to add new plugin APIs.
    - Rewriting provider HTTP streams or using undocumented APIs to emulate
      missing V2 hooks.
    - Publishing or changing the npm version from this feature branch.

## 4. Acceptance Criteria

- **Plugin compatibility**:
    - [x] The packed default export has `id: "opencode-acp"`, a V2 `setup`
          function, and a V1 `server` function.
    - [x] The packed artifact loads as active on OpenCode 2.0.3.
    - [x] The packed artifact passes a V1 >= 1.18.29 compatibility smoke test.
- **V2 behavior**:
    - [x] Primary model context receives ACP pruning, summaries, message refs,
          nudges, protected-content handling, and the ACP system prompt.
    - [x] Compaction, generate, and title requests are not modified by ACP.
    - [x] `compress`, `decompress`, `search_context`, `acp_status`, and
          `acp_context_recap` register once as direct model tools and execute through
          shared ACP logic.
    - [x] `/acp` and `/dcp` execute without sending raw arguments to the model.
    - [x] Command output remains visible but is excluded from later model context.
    - [x] V2 allow and deny permission behavior is enforced; ask fails closed
          before state mutation with an actionable error.
    - [x] `BILLION_CONTEXT_PROXY` and configured `/bili/` routes disable ACP; a
          later catalog change can re-enable it.
    - [x] V2 TUI notifications use a typed RPC bridge and do not affect server-only
          or headless operation.
    - [x] Plugin reload/unload leaves no duplicate registrations, event loops, or
          timers.
- **Data integrity**:
    - [x] Existing state files load without migration or schema changes.
    - [x] V2 projection and patch correlation is validated by message ID and tool
          call ID.
    - [x] An invalid or ambiguous patch preserves the original model request and
          rolls back request-scoped ACP state changes.
    - [x] Same-session concurrent initialization and transform/tool work cannot
          expose partial state or overwrite a newer committed state.
    - [x] Tool-call/result pairs remain atomic and unchanged provider data is
          retained.
    - [x] Completed compaction resets transient ACP state while preserving active
          ACP blocks.
    - [x] Fork recovery retains parent-to-child message/block translation.
- **Packaging and verification**:
    - [x] `npm run typecheck`, `npm test`, `npm run build`, and
          `npm run verify:package` pass; every file changed by this work passes
          targeted Prettier. Repository-wide `npm run format:check` is still run
          and its inherited failures are recorded without mass-formatting
          unrelated history.
    - [x] The package lock is consistent with the manifest.
    - [x] `./server`, `./tui`, and `./rpc` resolve from the packed artifact.
    - [x] Credential-like files and repository-only sources are excluded from the
          tarball.
    - [x] Installed-artifact V1 and V2 E2E tests use isolated homes and a local
          fake provider without real credentials.
    - [x] All new and modified tests pass and satisfy project-specific nudge/E2E
          requirements where those areas are changed.
    - [x] At least two independent agents review every modified source and test
          file before PR readiness is reported.

## 5. Proposed Approach

- **Affected modules and entry files**:
    - `index.ts` and package exports for the dual runtime definition.
    - New V1/V2 host adapters and shared host contracts under `lib/`.
    - V2 message normalization and validated context patching.
    - Shared tool definitions with V1 and V2 registration wrappers.
    - V2 command, catalog, notification RPC, TUI, and lifecycle adapters.
    - Package verification and installed-artifact E2E harnesses.
    - Documentation for installation, compatibility, and V2 limitations.
- **Risks**:
    - Incorrect projection mapping could silently omit context.
    - State could diverge from the actual model request if patch validation and
      state commit are not transactional.
    - Dual-runtime adapter behavior could drift without shared contract tests.
    - V2 provider/tool representations may contain metadata ACP must not rewrite.
- **Rollback strategy**:
    - Revert the V2 adapter and dual-entrypoint commits. The persisted state format
      remains unchanged, so rollback requires no data migration.
