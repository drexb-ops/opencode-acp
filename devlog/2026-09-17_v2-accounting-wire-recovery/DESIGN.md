# DESIGN — Separate safety accounting and recover orphaned summaries

## Accounting

OpenCode displays actual provider usage from the latest completed assistant turn
after compaction. ACP must estimate the next request before that provider call.
Use the provider value as the calibrated basis for user-facing context-limit and
critical decisions when it belongs to the current compaction epoch, then apply
bounded semantic deltas for newly added, removed and summarized sources. Maintain
three separate metrics: bounded semantic units for persisted growth/cadence,
provider-calibrated units for user-visible thresholds, and an upward-only,
fail-closed planned-wire estimate for hard overflow protection. Structurally
omitted provider payloads must not be traversed past the estimator's CPU bounds;
the safety metric treats them as over-limit while the growth metric remains stable.
A baseline must never switch token units when provider calibration first becomes
available on turn two. Calibration requires exact original model/timestamp
provenance and never reuses compaction-request usage as system overhead.
Diagnostics must state which estimate triggered a rule.

## Persisted summaries

Compression state and summary visibility are separate invariants. A block may stay
active after OpenCode removes its historical compress tool message. When at least
one removable source from that block is still present, insert one deterministic
ACP-owned synthetic summary adjacent to the earliest safe source before pruning.
The V2 patcher already supports ACP-owned insertions; use stable IDs and provenance
so replay is idempotent. Sanitize internal DCP/ACP metadata from the recovered wire
summary, reject metadata-only summaries, and trust a historical carrier only when
its exact message ID, call ID, completed state and summary payload agree. Nested
blocks use the surviving active summary only once.
If no effective source remains, retain the block as historical state but insert
nothing. Never replace or remove non-removable provider checkpoints.

## Verification

Tests start from a real compress call and persisted file, create a fresh registry,
remove the original compress-call message, and inspect the exact next canonical
provider request. They also cover repeated hooks, absent sources, stale mappings,
opaque multipart objects, native compaction usage, and 75/85 percent boundaries.
An isolated private OpenCode server—not the shared service—provides final runtime
evidence.
