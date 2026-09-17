# WORKLOG — Reliable V2 compression

- Status: Verified — ready for local activation
- Baseline: `1fe36e0`, local `master`
- Date: 2026-09-17

## Baseline

- Audit identified issues #419–#425; original repros are retained under
  `/tmp/opencode/acp-audit-*`.
- Baseline typecheck passes.
- Baseline repository-wide formatting check fails on 423 existing files. Changed
  files will receive targeted formatting checks.
- Four focused V2 audit suites previously passed 57/57 despite the real failures.

## Workstreams

- Projection/opaque insertion and repeated system correlation: delegated.
- Cold direct-tool hydration: delegated.
- V2 token accounting: delegated.
- Host capabilities/native history: delegated.
- Non-removable source eligibility, integration, E2E and final evidence: lead.

## Verification and review

- Projection builder reports red-before/green-after reproduction and 34/34 focused
  projection tests passing. Lead replaced the initial nested identity scan with
  indexed lookup to avoid quadratic validation of long opaque part lists.
- Lead removability regressions failed 3/3 before implementation, then passed.
  Added separate atomic-removal coverage for multipart tool sources to distinguish
  source-level removability from part-level edit opacity.
- Integrated wire regression exercises repeated systems, a local compaction with
  old usage, real direct compression, and retained multipart tool objects. It
  verifies summary presence, selected-original absence and request-size reduction
  on the next context hook. Wire/removability tests pass 5/5.
- Integrated typecheck passes at this checkpoint.
- Remaining: completed accounting/host integration, installed-host scenario,
  complete verification, dual independent reviews, and live activation.

## Review and installed-host findings

- Initial integrated full runs passed 1,458/1,459. The first failure exposed a
  missing-system correlation check masked by historical pruning; the check was
  restored. The next failure was the old helper fixture expecting that invalid
  projection to remain valid; it now separately checks early rejection and lost
  sidecar correlation after a valid projection. Projection suite passes 24/24.
- Build and package verification pass (261 tarball entries).
- Installed V1 smoke and V2 main/proxy/tools/commands/restart stages pass. Nudge
  verification correctly stops at the obsolete pinned initial baseline:
  expected 15, observed 12,032 after current-request accounting. The exact
  assertions remain enabled while semantic accounting and deterministic system
  fixture calibration are completed.
- Reviewer A found unbounded opaque/media serialization and a quadratic native
  diagnostic lookup. The lookup now uses a Set; bounded accounting is in progress.
- Reviewer B found resolved V2 error results misclassified as successful
  compression (#426), an unverified cold native-suffix path, and inherited
  OPENCODE_CONFIG_DIR in tests. Runtime/error and native authorization fixes are
  in progress; the test environment now clears the external config override.
- Lead also confirmed and repaired loss of the cold quality-rejection retry
  marker via bounded registry-owned transient bookkeeping; hydration tests pass
  11/11, including acknowledgment retry with no failed-state persistence.
- Both independent signoffs remain pending the corrected integrated delta.

## Corrected review delta

- Request accounting now has stable semantic inputs, bounded tokenizer text,
  collection/depth/global-node limits, bounded request-local caching, and
  size-based residual estimates without binary conversion. Exact-source residuals
  release on source removal; uncorrelated native prefix cost remains retained.
- Native direct-tool authorization is bounded and tied to checkpoint, epoch,
  model and observed source IDs. A real context-hook → authorization → direct
  compression → next-request regression passes; cold unverified suffixes cannot
  create blocks. Both integrated wire tests pass.
- Resolved V2 ACP errors carry explicit metadata and normalize internally as
  failed attempts; original provider result objects remain unchanged. E2E now
  requires the actual positive compression-result form for success classification.
- Test isolation was verified under an inherited external configuration that
  disables ACP: all eight selected diagnostics/eligibility tests still pass.
- Nudge E2E uses a private, stage-only fixed system instruction before packed ACP
  to remove random directory/time content from exact baseline calibration. The
  observed initial/first/second-compression semantic baselines are
  10,126 / 10,620 / 14,001. Initial baseline stability and all four
  protected-no-target turns passed on the subsequent independent harness run.
- Full integrated unit suite now passes **1,478/1,478** (21 suites).
- Final accounting review corrections map ID-less systems using verified outgoing
  provenance and sort oversized keys by bounded descriptors. Tests cover both.
- Reviewers `ses_f52dcf444ffeVLmzCJb8JuXCsi` and
  `ses_f52dc7ecfffecUXVUX3C5ijPyE` found no remaining source/test findings on the
  final delta; their signoffs are conditional on the final complete verification.

## Local configuration

- Backed up global ACP configuration to
  `/tmp/opencode/acp-config-before-v2-reliability-qih7876u.jsonc`.
- Replaced the 570K/250K absolute thresholds with max 75%, min 60%, emergency
  85%. At the configured 400K model window these are 300K/240K/340K, leaving room
  for the 32,768-token completion reserve. Verified the effective config loader
  reads these values. Local activation remains pending final verification.

## Final verification and approval

- **PASS**: full suite **1,480/1,480**, 21 suites, zero failures.
- **PASS**: typecheck, build, package verification (**261** entries), changed-file
  formatting and diff checks.
- **PASS**: exact installed artifact matrix on V1 **1.18.29** / V2 **2.0.3**,
  **149 seconds**, including all five tools, commands, proxy transitions,
  persistence/restart, and allow/deny/ask permissions.
- Final frozen accounting goldens: **11,062 → 11,609 → 15,226**. The earlier
  10,126-series values above document intermediate calibration before the final
  bounded-key framing correction. All final exact assertions and the sequence
  verifier pass, with four protected-no-target negatives and two real compressions.
- **PASS**: installed reliability stage (20 assertions) proves the immediate next
  provider request omits targeted original content, includes the summary, and
  retains unselected opaque shell content and recent user intent.
- Final logs: `/tmp/opencode/acp-repair-full-tests.log` and
  `/tmp/opencode/acp-repair-installed-e2e.log`. Installed diagnostics:
  `/tmp/opencode/acp-e2e/run-9xrAr0BxP8`.
- Both independent reviewers gave final approval after inspecting the completed
  logs and unchanged-strength golden assertions. Their full source/test/E2E/doc
  scopes and all review corrections are recorded above.
- Local commit and live activation follow; no package publication is part of this task.
