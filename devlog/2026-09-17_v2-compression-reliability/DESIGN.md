# DESIGN — Reliable V2 compression

- Status: Accepted for implementation by the user following the audit
- Date: 2026-09-17

## Approach

Repair the existing host-neutral transform and V2 provenance adapter rather than
reconstructing provider transcripts or relaxing opaque-data protection. A broader
rewrite would increase compatibility risk; initialization-only repair would leave
saved blocks unapplied. The chosen approach fixes the complete request lifecycle.

1. Validate retained opaque parts by identity/order through safe ACP insertions;
   correlate repeated system instructions conservatively.
2. Reuse the registry's initialize-and-mutate reservation for V2 direct tools.
   Initialization, tool mutations and deferred effects share the transaction.
3. Mark non-removable V2 sources in transient normalized message metadata. Range
   planning/candidates exclude them from eligible content and savings. Part opacity
   remains separate: a multi-part tool may be removed atomically when allowed.
4. Supply current V2 system/tool overhead to the shared transform via optional
   host-specific accounting inputs. Preserve legacy V1 fallback behavior.
5. Isolate pinned/newer V2 API differences behind capability detection. Require
   trustworthy history correlation; make unavailable native windows explicit.

The lead owns eligibility and cross-module integration. Independent builders own
projection fixes, cold hydration, accounting, and host capabilities. Two additional
reviewers inspect the integrated source and tests before completion.

## Verification

Start with regression cases known to fail on the audited baseline. Include actual
host-lowered shapes, real ID injection, real direct compression with persisted
cold state, first request after compaction, and a subsequent request demonstrating
wire-content reduction. Keep provider identity/order and failure rollback checks.
Run focused tests during work, full checks after integration, then installed V1
1.18.29 / V2.0.3 E2E and live activation evidence. Latest-V2 capability tests are
reported separately from exact installed-host certification.

## Boundaries

No guessed provider-native data rewrites, state migrations, unrelated formatting,
or automatic PR merging. The user's local-master instruction overrides the usual
feature-branch convention for this repair; this dated devlog records that choice.
