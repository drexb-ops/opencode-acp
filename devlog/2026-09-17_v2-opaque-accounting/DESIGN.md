# DESIGN - V2 opaque-source accounting fix (#420)

- Task ID: `2026-09-17_v2-opaque-accounting`
- Home Repo: `opencode-acp`
- Status: Done

## 1. Problem Model

The V2 host lowers projected session history into outgoing messages before each
request. Some projected sources are **opaque**: their content is owned by the
provider (completed native compactions, system records, foreign synthetics) and
must survive on the wire byte-for-byte. `restoreMissingV2OpaqueSources`
(`lib/v2/projection/restore.ts`) enforces this by re-inserting any such source
that ACP's pipeline removed, and `applyV2ContextPatch` refuses to drop them.

Before this change, compress planning (`prepareExecutableRangePlans`) knew about
protected *tools*, the last user message, and recent-message protection — but
not about V2 source removability. A selection covering a completed compaction
therefore:

1. counted its chars/tokens toward `minCompressRange` and savings,
2. stored a compression block whose "compressed" content is restored verbatim
   on every subsequent request,
3. reported `Compressed N messages ... saved X tokens` while the wire delta was
   zero for that content.

## 2. Design Decisions

### 2.1 Capability on `HostServices`, not a V2-specific branch in planning

Planning lives in runtime-agnostic `lib/compress/`. Instead of importing V2
projection code into it, the fix adds an optional capability:

```ts
// lib/host/types.ts
nonRemovableSourceIds?(sessionID: string): Promise<ReadonlySet<string>>
```

- **Absence = legacy contract** ("every source is removable"), so V1 hosts,
  test fixtures, and standalone callers are untouched (pinned by test T7).
- Only the V2 adapter implements it, because only V2 has opaque sources that
  are restored after removal.

### 2.2 Derivation: re-normalize, read provenance flags

`resolveNonRemovableSourceIds` (`lib/v2/host.ts`) fetches the current projected
history via `context.session.context({sessionID})`, runs
`normalizeV2ProjectedHistory(projected, [], {…projectionOptions, sessionID})`,
and collects every entry with:

```ts
entry.opaque && !entry.allowSourceRemoval &&
entry.sourceType !== "acp-synthetic" &&
!isAcpOwnedNoticeId(entry.sourceMessageId)
```

— the exact predicate `restoreMissingV2OpaqueSources` uses to decide what to
put back. Mapping through `normalizedMessageId` yields the same IDs ACP sees in
selections.

**Why classify even when normalization reports a rejection:** provenance flags
(`opaque`, `allowSourceRemoval`, `sourceType`, `normalizedMessageId`) are
computed by `makeDraft` from the projected *source* record alone, before
lowered-outgoing correlation. Normalizing without a request transcript
(`[]` outgoing) makes correlation rejections (e.g. "patchable origin … no exact
lowered outgoing match") expected; they only affect outgoing mapping, never the
flags. A source that cannot be normalized at all produces no selectable message
either, so nothing ends up under-protected. Throwing on `valid === false`
(bug found in first implementation attempt) would have made every real V2
session fail closed.

**Cost:** one extra normalization per compress execution (not per LLM call).
Compress is rare relative to transforms; acceptable.

### 2.3 Where filtering happens: inside planning, before counting

`filterNonRemovableSources(selection, set)` runs in
`prepareExecutableRangePlans` immediately after the three existing soft filters
(protected tools → last user → recent protection), so:

- `messageIds` / `messageTokenById` shrink **before** `totalChars` accumulation
  and the `minCompressRange` check — no false volume,
- a plan emptied entirely by this filter is attributed to it
  (`skippedNonRemovablePlanIndices`); if *all* plans are emptied this way,
  planning throws a specific error telling the model these records save nothing
  and to pick a removable range (distinct from the generic
  "filtered out" errors),
- mixed plans proceed with only removable IDs; `applyCompressionState` then
  naturally stores blocks, token stats, and `directMessageIds` covering only
  removable messages — no changes needed in state accounting.

The block anchor stays the range start reference; anchors pointing at an
excluded message are harmless because block membership (not the anchor) drives
pruning, and the anchor message remains visible either way.

### 2.4 Fail closed when provenance is unavailable

If the host exposes the capability but the resolver throws (host context
unavailable, etc.), the tool execution rejects with an actionable error and
mutates nothing. Proceeding unfiltered would silently reproduce the #420 bug;
planning without knowledge is not safe for a V2 host. Pinned by test T6.

### 2.5 Reporting

Mixed-selection success output appends:

```
⚠️ N provider-owned message(s) were excluded from compression: those records
remain in visible context and NO savings were counted for them.
```

so the model sees why the compressed count is smaller than the requested range.

## 3. What the wire shows (acceptance criterion 3)

After a mixed compression, the next request's outgoing messages contain:

- the provider-owned compaction source **byte-identical** (restored),
- the removable messages **gone** (pruned via block membership),
- net byte savings equal to the removed removable content.

The block summary itself reaches the model through the compress tool call's
`summary` parameter — opencode persists the assistant turn carrying that call
in history, and ACP's patcher preserves it unchanged. No code path injects
block summaries as new messages (verified by exhaustive search of
`lib/messages/`), so tests validate wire bytes rather than asserting a summary
message appears.

## 4. Explicitly Out of Scope

- Marking opaque sources as `BLOCKED` candidates in nudge/candidate guidance
  (`lib/messages/inject/`) — reduces wasted tool calls but doesn't affect
  correctness; deferred.
- `tests/soft-block.test.ts` hardcoding `/tmp/...` (fails in sandboxes with
  read-only `/tmp`) — pre-existing environmental issue, reported in the issue
  thread, not fixed here to keep this diff focused.
- Any release/version bump (release branches only).
