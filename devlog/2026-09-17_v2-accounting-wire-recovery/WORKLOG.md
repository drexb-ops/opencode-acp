# WORKLOG — V2 accounting and persisted wire recovery

- Status: InProgress
- Baseline: `c5ecad7`
- Shared ACP configuration: not modified by this work; a source-plugin entry was
  observed as external state during final verification and was not changed.

## Evidence

- Historical pre-fix logs show message usage of 48–65K (12–16% of a 400K
  window) alongside 669K stale overhead and negative budgets. This was the
  native-compaction usage defect, not legitimate overflow.
- The repaired code has request-scoped semantic accounting, but user-visible
  emergency decisions still need provider calibration to avoid tokenizer/model
  variance.
- Current persisted-state shape demonstrates the orphan-summary risk: an active
  block has 244 effective source IDs, 227 visible in a private captured history,
  and no visible `compressMessageId`. `prune.ts` removes marked messages but does
  not insert `block.summary`; `sync.ts` intentionally does not deactivate blocks
  merely because the compression message vanished.

## Implementation

- V2 accounting now projects only provider-facing tool definitions, excluding
  runtime executors/options/internal IDs. It maintains three request-scoped
  values: a bounded semantic growth estimate for stable persisted cadence, a
  conservative safety estimate for truncation/hard guards, and a provider-
  calibrated estimate for user-visible context-limit/emergency thresholds.
- Provider calibration accepts only the latest usage after the current compaction
  epoch and from the selected provider/model. Historical compaction usage and
  model-switch usage fail closed to semantic estimation. Semantic deltas make
  subsequent additions, pruning and summaries visible without turning tokenizer
  variance into a false critical notice.
- V2 pruning now recovers missing persisted summaries before removing sources.
  A deterministic `msg_dcp_summary_<16 hex>` message is inserted only when an
  active block has exact, removable, visible source membership and no visible
  compression message. Missing-source blocks remain historical; stale/corrupt
  memberships preserve content.
- Summary-buffer visibility now keys missing-call blocks to that exact deterministic
  recovered-summary ID. Visible historical source IDs alone no longer claim that a
  summary reached the provider, and the materializer verifies its generated ID
  against the shared derivation helper before pruning.

## Verification

- New accounting and persisted-wire suites pass with existing V2 wire/token and
  nudge suites: 107 focused tests.
- Negative accounting control proves the conservative 90% estimate would emit
  the false critical notice while provider-calibrated 60% does not. Exact 85%
  boundary still emits the configured critical no-target notice.
- Persisted-summary test creates a real compression, reloads a fresh registry,
  proves original source absence and exactly one summary in the strict V2 provider
  patch, repeats idempotently, and covers absent sources/stale IDs.
- Baseline `c5ecad7` pruning fails the central persisted-summary test.
- Private copied real-state replay now recovers one active merged summary, removes
  all 226 still-visible compressed sources, and changes the provider request from
  738 to 85 messages with the summary present. No private content is logged.
- The final independent re-reviews are pending; all local runtime verification is
  complete.

### Integration correction

- The first installed run passed persisted-summary restart coverage but exposed a
  metric-unit bug in the initial accounting split: turn 1 established a semantic
  growth baseline near 11.3K, then turn 2's first provider report changed the same
  persisted baseline to ~3.6K without compression. The load-bearing no-target E2E
  caught this exact reset.
- `injectCompressNudges` now receives threshold and growth metrics separately.
  Provider calibration controls percentages and critical wording; semantic tokens
  control `lastPerMessageNudgeTokens`, `lastNudgeShownTokens`, tier cadence and
  compression-drop detection. The new multi-turn unit test asserts the persisted
  baseline is byte-for-byte stable when calibration becomes available.
- Negative control replacing the semantic growth metric with the calibrated
  threshold metric fails that regression exactly (`expected 548257`, `actual
240000`), proving the test catches the unit-switch defect.
- The installed nudge cycle then passed every behavioral assertion and produced
  deterministic semantic baselines `11,315 → 11,862 → 15,479`. The prior pins
  `11,062 → 11,609 → 15,226` predated provider-facing tool-schema accounting;
  exact assertions remain in place with the corrected values.
- Final full unit suite after every accounting, dual-metric, recovered-summary,
  provenance, package-harness and test change passes 1,500/1,500 across 21 suites.
- Final installed-artifact matrix passed in 112 seconds against exact OpenCode
  V1 `1.18.29` and V2 `2.0.3`. It verifies immediate source removal + summary
  presence, then restarts only the owned V2/plugin process and verifies on a
  fresh provider request that the original remains absent, exact summary remains,
  protected recent content and opaque shell stdout/exit status survive, and block
  count/summary stay stable. The public host cannot safely delete only the old
  compression call, so that harder orphan case remains covered by unit and the
  private copied-state replay rather than database mutation.

## Verification harness compatibility

- The current npm treats `npm install --no-save <tarball>` in an empty directory
  as a successful no-op. This caused package verification to report that
  `node_modules/opencode-acp` was missing despite npm exiting zero. The isolated
  verifier now creates a minimal private probe manifest before installing; this
  changes no package metadata or runtime behavior.
- A later verifier retry failed with exact diagnostic `npm warn tar TAR_ENTRY_ERROR
ENOSPC: no space left on device, write`; three intentionally retained private
  E2E roots consumed ~9.9 GiB and the package-debug install another ~487 MiB.
  After deleting only those task-owned temporary roots, package verification
  passed with all 261 tarball entries. The verifier now preserves npm stderr so
  future environment failures are actionable instead of a generic install error.
- Final source build after the shared recovered-summary ID correction passed, and
  the rebuilt artifact again passed isolated package verification with 261 entries.
- The final verifier wraps root creation, identity capture, private manifest/config
  setup and npm install in cleanup coverage; even identity-capture failure removes
  only the exact generated child under the approved staging parent.

## Independent review

- Test/E2E reviewer initially returned conditional approval with no P0–P2
  findings. Its documentation notes found two stale `currentTokens` comments in
  `lib/messages/inject/inject.ts` and `lib/state/types.ts`; both now say semantic
  `growthTokens`, matching runtime behavior.
- The second independent source review requested changes: P1 fixed-size residuals
  for structurally omitted values and unsanitized recovered summaries; P2 weak
  carrier/provenance validation and package staging setup outside cleanup; P3 V1
  missing-carrier summary-buffer compatibility. No commit was made.

### Review remediation

- Bounded semantic estimation remains capped at 64 collection entries and 1,024
  traversal nodes. A separate safety counter marks any structurally omitted
  provider value as a one-billion-token fail-closed residual without reading the
  omitted value; encountered long text/binary still receives size-aware counting.
  Hard safety also applies upward-only provider calibration, a 5% framing margin,
  and 256 fixed tokens. Growth/cadence and provider-visible nudge units remain
  unchanged.
- V2 usage calibration now requires exact original provider/model/timestamp
  provenance emitted by projection. Missing or fallback provenance, stale model,
  timestamp mismatch and prior-compaction usage all fail closed to semantic nudge
  estimation.
- Orphan recovery strips internal DCP/ACP metadata from the provider-visible
  summary, rejects wrapper/metadata-only persisted summaries, and recognizes an
  existing carrier only when exact message/call IDs, completed state and a matching
  meaningful summary payload agree. Corruption preserves source content.
- V2 summary-buffer accounting requires the exact recovered summary ID; default
  V1 behavior retains the historical visible-effective-source fallback.
- Package-verifier setup, private manifest/config creation and npm install now all
  live inside the owned-root `try/finally`, so setup failures cannot leak staging
  roots.
- Focused review-remediation suite passes 43/43. Mutation controls independently
  remove safety omission handling, summary sanitation, metadata-only rejection,
  strict carrier validation and strict provenance; each corresponding regression
  fails, and the restored suite passes 43/43. The earlier growth-metric mutation
  also fails its multi-turn baseline regression as required by §5.7.
- Final independent re-reviews are complete. The test/E2E reviewer gives
  unconditional approval with no P0–P3 findings. The source reviewer gives final
  approval with no P0–P3 findings and separately approved the last documentation-
  only `lib/state/types.ts` correction. No reviewer edited files or ran commands.
- Rebuilt package verification passes with 261 entries; typecheck, targeted
  Prettier, shell syntax and `git diff --check` pass. The final installed V1/V2
  matrix retains exact nudge pins `11,315 → 11,862 → 15,479`, both real
  nudge-triggered compress/refire cycles, and immediate plus post-restart provider-
  wire proof.
- Private copied-state replay with sanitized summary matching again recovers one
  exact deterministic summary, removes all 226 selected sources, leaves zero
  compressed sources on wire, and reduces the request from 738 to 85 messages.
