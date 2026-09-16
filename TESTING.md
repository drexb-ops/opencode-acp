# Testing Guide — opencode-acp

> Practical reference for writing and running tests. All test files live flat in `tests/*.test.ts`.

---

## Running Tests

```bash
# Run all tests
npm test
# Equivalent to:
node --import tsx --test tests/*.test.ts

# Check repository-wide formatting (see the focused workflow below)
npm run format:check

# Run a single test file
node --import tsx --test tests/token-counting.test.ts

# Run multiple specific files
node --import tsx --test tests/message-ids.test.ts tests/message-utils.test.ts

# Run the V2 adapter/runtime suites
node --import tsx --test tests/v2-*.test.ts

# Typecheck and build the package
npm run typecheck
npm run build

# Verify the packed package (build + verification in one command)
npm run check:package

# Or run the package verifier after an existing build
npm run verify:package

# Inspect the npm pack file list (ignore lifecycle scripts)
npm pack --dry-run --json --ignore-scripts
```

Test totals are intentionally not hardcoded here: `npm test` discovers the
current `tests/*.test.ts` set, which changes as coverage grows. The in-process
suite includes V1/V2 contract and adapter tests, transaction and persistence
tests, and full message-pipeline tests.

The V2 adapter targets the exact `@opencode/plugin@2.0.3` API and the package
claims OpenCode V1 `>=1.18.29`. `npm run verify:package` checks the built and
packed entrypoint shape, import graph, manifest/lock consistency, exclusions,
and credential-like filenames; it does not install the tarball into an
OpenCode host. Installed-artifact V1/V2 E2E coverage from Phase 9 is still
pending on this branch, so the commands above must not be reported as proof of
that host-level matrix.

---

## Test Framework

| Layer       | Technology                              | Import                                    |
| ----------- | --------------------------------------- | ----------------------------------------- |
| Test runner | Node.js built-in (`node:test`)          | `import test from "node:test"`            |
| Assertions  | Node.js built-in (`node:assert/strict`) | `import assert from "node:assert/strict"` |
| TypeScript  | `tsx` (on-the-fly transpilation)        | `--import tsx` flag                       |

No external test libraries (Jest, Vitest, Mocha) are used. Everything is the Node.js built-in test runner.

### Key Assertion Patterns

```typescript
assert.equal(actual, expected) // Strict equality
assert.deepEqual(actual, expected) // Deep structural equality
assert.match(string, /regex/) // Regex match
assert.doesNotMatch(string, /regex/) // Regex non-match
assert.rejects(asyncFn, /error pattern/) // Promise rejection
```

---

## Architecture-level coverage

Coverage is organized by behavior rather than a fixed test count. The following
table names representative suites; `npm test` remains the source of truth for
the complete set.

| Area                                      | Representative suites                                                                                                                                                                                                     | Coverage                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compression engine and summaries          | `compress-*.test.ts`, `batch-compress.test.ts`, `compression-groups.test.ts`, `decompress-logic.test.ts`, `recap.test.ts`, `quality-gate-*.test.ts`, `tier-*.test.ts`                                                     | Range/message compression, batch lifecycle, decompression, recap/status, quality gates, tier detection, and summary handling                         |
| Message transformation and context safety | `e2e-message-transform.test.ts`, `e2e-blocks-nudges.test.ts`, `inject*.test.ts`, `prune.test.ts`, `sync.test.ts`, `reasoning-strip.test.ts`, `truncate-tools.test.ts`, `enforce-budget.test.ts`, `message-filter.test.ts` | IDs and tags, nudges, pruning, synchronization, reasoning removal, tool-output limits, budget enforcement, and third-party filters                   |
| Persistence and state transactions        | `persistence.test.ts`, `storage-path.test.ts`, `registry.test.ts`, `state-transaction.test.ts`, `compress-rollback.test.ts`, `rebuild.test.ts`, `model-switch-limits.test.ts`, `context-limit-fallback.test.ts`           | Filesystem state, custom paths, concurrent initialization, serialized mutations, rollback, fork/rebuild recovery, and model-limit changes            |
| Shared/V1 host behavior                   | `host-tool-contract.test.ts`, `hooks-permission.test.ts`, `host-permissions.test.ts`, `plugin-entrypoint.test.ts`, `update.test.ts`, `bili-proxy*.test.ts`                                                                | Shared tool contracts, V1 hooks, permissions, dual entrypoint shape, update lifecycle, and proxy self-disable                                        |
| V2 projection and runtime adapters        | `v2-message-projection.test.ts`, `v2-context*.test.ts`, `v2-tools.test.ts`, `v2-commands.test.ts`, `v2-timing.test.ts`, `v2-proxy.test.ts`, `v2-notifications.test.ts`, `v2-lifecycle.test.ts`                            | Loss-aware projection and validated patches, direct tools, commands, timing, permission fallbacks, proxy refresh, RPC/TUI notifications, and cleanup |
| Properties and regressions                | `property-*.test.ts`, `compression-candidates-property.test.ts`, `nudge-loop-fix.test.ts`, `tier-detection-fix.test.ts`, `regex-tag-leak.test.ts`, `tool-pair-integrity.test.ts`, `trigger-policy-integration.test.ts`    | Invariants, generated inputs, historical bug regressions, tool-pair atomicity, and trigger-policy behavior                                           |
| In-process end-to-end flows               | `e2e-message-transform.test.ts`, `e2e-blocks-nudges.test.ts`, `e2e-tier-compression.test.ts`, `e2e-tier-simulation.test.ts`                                                                                               | Full in-process transform and tier flows; these are not installed-artifact host tests                                                                |

Installed-artifact V1/V2 E2E is a separate Phase 9 deliverable and remains
pending on this branch.

---

## Test Data Patterns

All tests construct mock data inline using helper functions. There are no shared test fixtures or external data files.

### Building `PluginConfig`

Every test file creates its own config helper. Keep it synchronized with the
current `PluginConfig` shape, including the required top-level fields and the
state/quality/filter sections:

```typescript
import type { PluginConfig } from "../lib/config"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: false,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission,
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
            toolOutputNudgeThreshold: 5000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: {
            enabled: false,
            filters: {},
        },
    }
}
```

Individual tests may override `storagePath`, model-limit maps, provider/model
overrides, or other fields for the behavior under test.

### Building `WithParts` Messages

Two common patterns. The **simple** one-message builder:

```typescript
function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
    created: number,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created },
              }
            : { id, role, sessionID, agent: "assistant", time: { created } }

    return {
        info: info as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}
```

The **multi-message** builder (`buildMessages`) returns an array representing a mini-conversation:

```typescript
function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
        },
    ]
}
```

### Building Parts

**Text part:**

```typescript
function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}
```

**Tool part:**

```typescript
function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}
```

### Building `SessionState`

Always via the factory function:

```typescript
import { createSessionState } from "../lib/state"

const state = createSessionState()
state.sessionId = "session-1"
```

Manually populate blocks when needed:

```typescript
state.prune.messages.blocksById.set(1, {
    blockId: 1,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: 0,
    durationMs: 0,
    mode: "message",
    topic: "one",
    batchTopic: "one",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "msg-a",
    compressMessageId: "message-1",
    compressCallId: "call-1",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: ["msg-a"],
    effectiveToolIds: [],
    createdAt: 1,
    summary: "a",
    survivedCount: 0,
    generation: "young",
})
```

Or use the `buildBlock()` helper from `compression-targets.test.ts`:

```typescript
function buildBlock(
    blockId: number,
    runId: number,
    mode: "range" | "message",
    durationMs: number,
): CompressionBlock {
    return {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs,
        mode,
        topic: `topic-${blockId}`,
        batchTopic: mode === "message" ? `batch-${runId}` : `topic-${blockId}`,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `origin-${runId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
        survivedCount: 0,
        generation: "young",
    }
}
```

### Mocking the Client

Tests that call compress tools or hook handlers mock the `client` parameter as `any`:

```typescript
const tool = createCompressRangeTool({
    client: {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
    },
    state,
    logger,
    config: buildConfig(),
    prompts: {
        reload() {},
        getRuntimePrompts() {
            return { compressRange: "", compressMessage: "" }
        },
    },
} as any)
```

For toast notification capture:

```typescript
const toastCalls: string[] = []
const tool = createCompressRangeTool({
    client: {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
        tui: {
            showToast: async ({ body }: { body: { message: string } }) => {
                toastCalls.push(body.message)
            },
        },
    },
    // ...
} as any)
```

### Filesystem Isolation

Tests that touch persistence set temp directories:

```typescript
const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })
```

---

## Writing New Tests

### Step-by-Step

1. **Identify the source module.** Read the source file to understand the public API (exported functions).
2. **Choose the test tier.** Is it a pure function (Tier 1), needs mock data (Tier 2), or needs integration (Tier 3)? See the priority table below.
3. **Create the test file.** Name it `tests/{module-name}.test.ts` (e.g., `tests/protected-patterns.test.ts`).
4. **Write the boilerplate.** Use the template below.
5. **Write test cases.** Start with happy path, then edge cases, then error cases.
6. **Run the test.** `node --import tsx --test tests/{module-name}.test.ts`
7. **Run all tests.** `npm test` — verify nothing breaks.

### Template

```typescript
import assert from "node:assert/strict"
import test from "node:test"

// Import what you're testing
import { yourFunction } from "../lib/your-module"

// Optional: import types you need for mock data
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"

// --- Helper functions (copy from existing tests as needed) ---

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: false,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
            toolOutputNudgeThreshold: 5000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: {
            enabled: false,
            filters: {},
        },
    }
}

// --- Tests ---

test("yourFunction does X when Y", () => {
    // Arrange
    const input = /* ... */

    // Act
    const result = yourFunction(input)

    // Assert
    assert.equal(result, expected)
})

test("yourFunction handles edge case Z", () => {
    // ...
})
```

### Naming Conventions

- Test files: `{module-name}.test.ts` — matches the source module path (e.g., `lib/protected-patterns.ts` → `tests/protected-patterns.test.ts`)
- Test descriptions: Full sentences describing the behavior, e.g., `"compress message mode rejects compressed block ids"`
- Helper functions: `buildConfig()`, `buildMessage()`, `buildMessages()`, `textPart()`, `toolPart()`, `buildBlock()`

### Tips

- **Copy helpers, don't import them.** Every test file defines its own `buildConfig()` and `buildMessage()` helpers. This keeps tests self-contained and avoids shared mutable state.
- **Use `as any` freely for mock client objects.** The OpenCode client SDK types are verbose. Tests only implement the methods they call.
- **Use `Date.now` mocking** for timing tests (see `hooks-permission.test.ts` lines 199–381).
- **Unique session IDs** prevent test pollution: `` const sessionID = `ses_test_name_${Date.now()}` ``

---

## Choosing a test level

Use the lowest level that can prove the behavior, then add contract or pipeline
coverage when host integration is involved:

1. **Pure/unit:** deterministic token, ID, shape, query, policy, protection,
   filtering, nudge, and quality-gate logic.
2. **Contract/mock:** shared tool definitions, V1 translation, V2 projection and
   patch validation, commands, permissions, notifications, and timing with
   mocked host services.
3. **Filesystem/lifecycle:** config layers, persistence, custom storage paths,
   state transactions, registry initialization, update cleanup, and plugin
   setup/unload.
4. **In-process pipeline:** message transforms and tier flows using the
   `e2e-*.test.ts` suites; preserve tool-call/result pairs and provider-owned
   fields in assertions.
5. **Installed artifact:** build and pack once, then run isolated host checks.
   The dual-host V1/V2 artifact suite is the pending Phase 9 work on this
   branch and is not covered by `npm test`.

---

## Formatting

`npm run format:check` checks the entire repository. The current branch inherits
formatting failures outside this focused change, so do not mass-format unrelated
history. Run Prettier only on the Markdown files you changed, then check the
same set:

```bash
npx prettier --write README.md README.zh-CN.md CONFIGURATION.md CONFIGURATION.zh-CN.md TESTING.md
npx prettier --check README.md README.zh-CN.md CONFIGURATION.md CONFIGURATION.zh-CN.md TESTING.md
```

---

## Common Pitfalls

1. **Forgetting `survivedCount` and `generation` on `CompressionBlock`.** The type makes them required. Always include `survivedCount: 0` and `generation: "young"` when building blocks.

2. **Missing `model` field on user message `info`.** User messages in the SDK have `model: { providerID, modelID }`. Assistant messages don't. The `buildMessage` helper handles this, but if you construct manually, include it.

3. **`as WithParts["info"]` cast.** The SDK `Message` type is complex. All tests cast the `info` object: `info: { ... } as WithParts["info"]`. This is normal.

4. **`Date.now` mocking leaks.** If you mock `Date.now`, always restore it in a `finally` block (see `hooks-permission.test.ts`).

5. **Session ID uniqueness.** Tests that create compress tool calls or persist state should use unique session IDs to avoid cross-test pollution: `` `ses_test_${Date.now()}` ``.
