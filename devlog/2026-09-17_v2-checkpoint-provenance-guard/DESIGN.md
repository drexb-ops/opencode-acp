# DESIGN - V2 provider-checkpoint provenance guard

- Task ID: `2026-09-17_v2-checkpoint-provenance-guard`
- Date: 2026-09-17

## 1. Problem Shape

ACP's V2 layer normalizes a **projected** (public) history and correlates it with the **outgoing** (model-aware, lowered) request messages via provenance entries. Two views legitimately diverge across native provider compaction checkpoints in OpenCode V2:

```
public context (projected):  [checkpoint, nextUser]
outgoing after compatible model decode:      [decodedCheckpoint, nextUserLowered]
outgoing after incompatible model switch:    [originalUser, originalAssistant, nextUserLowered]
direct-tool view (host.ts passes []):        []
```

Before this change, `claimCheckpointRanges` claimed **every unclaimed outgoing index** between the previous source's last claimed index and the next source's first claimed index as checkpoint content. That is a positional inference: it works only when the window contains exactly the decoded checkpoint message itself.

## 2. Decision

**Claim by exact uniqueness, never by position.** Collect the unclaimed candidates in the window:

| Candidates | Meaning | Action |
|------------|---------|--------|
| exactly 1 | decoded checkpoint message | claim it (compatible case, unchanged behavior) |
| >1 | re-expanded originals from an incompatible model switch | leave all uncorrelated |
| 0 | checkpoint absent from the outgoing view (incompatible switch or direct-tool view) | leave uncorrelated |

Consequences of "uncorrelated":

1. **Outgoing side**: each uncorrelated host message becomes its own `V2OutgoingProvenance` entry with `opaque: true` and `opaqueMessage = <message>` (`normalize.ts`, existing logic). The patcher rejects any non-object-identical replacement of such messages and keeps empty ones alive, so re-expanded originals survive into the final request byte-for-byte and remain individually identifiable in provenance.
2. **Normalized side**: `buildProviderCheckpoint` now renders the entry from source compaction data when it has no outgoing indices — `lowerCompactionText(source)` (existing `<conversation-checkpoint>` envelope with summary + recent context) under origin key `source:{i}:checkpoint:source`, opaque text origin/part. The direct-tool path therefore sees the checkpoint content instead of zero parts.
3. **Patch path safety** (verified in `patch.ts`): a normalized message whose entry has `outgoingMessageIndices: []` is skipped on removal without rejection; its opaque origins have no outgoing pointers so no content edits can be mapped; and because it carries a known normalized ID it can never become an ACP insertion — the fallback-rendered checkpoint is never injected into outgoing requests.
4. **Disclosure**: an unsupported window is disclosed structurally — `providerCheckpoint: true` with `outgoingMessageIndices: []` — and documented on `V2ProvenanceEntry.providerCheckpoint`. No rejection is raised: the projection remains valid and usable, which matches the issue's "safe explicit fallback" acceptance option.

## 3. Trade-offs Considered

- **Host-provided model-aware snapshot** (issue's first acceptance option): cleanest long-term, but requires new host API surface in OpenCode V2; not available to ACP today. Rejected for this iteration; the fallback covers both views without host changes.
- **Reject (>1 candidates) instead of fallback render**: fail-closed, but would break every incompatible-switch session outright; the divergence is benign once ownership stops being inferred, so degrading gracefully is safer.
- **Claiming extras conservatively (old behavior)**: keeps the checkpoint correlated even when provider-added messages sit in the window, but swallows host-owned content into opaque checkpoint territory — the exact misclassification this fix removes. Note the behavioral change: with provider-added extras present, the checkpoint renders from source data rather than decoded outgoing content. Acceptable because the entry stays opaque/protected/non-removable either way.

## 4. Invariants Preserved

- Compatible single-decoded-checkpoint windows correlate exactly as before (regression-locked by test).
- Opaque provider checkpoints remain protected and non-removable (`patch.ts` guard unchanged).
- No persisted-state format, internal-tag, or public-API signature changes.
