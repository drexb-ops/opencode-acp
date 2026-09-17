# REQ — Reliable V2 compression

- Status: InProgress
- Date: 2026-09-17
- References: #419, #420, #421, #422, #423, #424, #425, #426
- Working branch: local `master`, explicitly requested by the user for this repair.

The user approved implementing the findings in the V2 compression audit. Existing
V2 context processing can reject valid repeated system instructions and multipart
tool output. Cold direct tools cannot initialize persisted state. Compaction usage
inflates system overhead, and non-removable sources can be counted as compressed
although they remain on the wire. Host API and model-aware history differences
also require capability handling.

Acceptance:

- Valid repeated system and multipart/error tool histories remain processable.
- Provider-owned objects/content remain protected against mutation/removal.
- Direct tools initialize atomically and preserve same-session serialization.
- Compression success corresponds to removable content, not opaque restored data.
- Current V2 system/context accounting excludes old compaction-request usage.
- Both pinned 2.0.3 and newer top-level model/provider APIs are recognized.
- Native checkpoint history mismatches are handled explicitly and safely.
- A valid compression is tested through the next outgoing request: summary
  retained, selected originals absent, provider data preserved.
- V1 behavior, persistent state schema, and internal `dcp-*` identifiers remain
  compatible. No version bump or publication.
- Full tests/typecheck/build/package checks, exact installed-host E2E, and two
  independent reviews of runtime and tests precede completion.
