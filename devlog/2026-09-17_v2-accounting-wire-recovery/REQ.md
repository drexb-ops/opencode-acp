# REQ — V2 accounting and persisted wire recovery

- Status: InProgress
- Date: 2026-09-17
- Branch: local `master`, explicitly requested by the user
- Publication: local testing only; do not create upstream issues or push

The user reports ACP declaring context critically full while OpenCode reports
substantially lower usage, and older compression blocks not reliably reaching
the provider request. Keep the existing ACP configuration unchanged and keep ACP
disabled in the shared service during development.

Acceptance:

- Native/local compaction usage from an older request cannot become current
  system overhead or create a negative context budget.
- User-visible emergency/critical decisions use a trustworthy post-compaction
  provider-calibrated value when available; conservative wire estimates remain
  available for the hard safety guard and disclose their source.
- A known compressed source is counted neither in the outgoing request nor in
  current context usage; its summary is counted once.
- A persisted active block whose original compression tool message disappeared
  must not prune remaining sources without inserting its summary. The summary
  reaches the immediate next provider request after a fresh registry/reload.
- If all source content disappeared through OpenCode compaction, blocks remain
  historical without leaking orphan summaries or claiming current wire savings.
- Repeated hooks are idempotent; provider-owned opaque content and tool pairs
  retain identity/order. V1 behavior and persisted state schema remain compatible.
- Add baseline-negative tests, complete unit/installed verification and two
  independent reviews before a local commit. Do not activate the shared plugin.
