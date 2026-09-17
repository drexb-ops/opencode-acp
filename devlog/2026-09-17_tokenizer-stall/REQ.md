# REQ — Eliminate long-session tokenizer stalls

- Status: Verified in isolation
- Date: 2026-09-17
- Issue: #427
- Branch: local `master`, per explicit user instruction

The 5ff308c reliability repair passed unit and small installed-host tests, but
live activation made OpenCode unresponsive on a large session. Keep the user's
ACP entry disabled and reproduce only in an isolated process/private server.

Acceptance:

- Eliminate repeated vocabulary construction while preserving exact tokenizer
  normalization, special-token behavior, empty-input and failure fallbacks.
- A private replay of the captured long context completes without watchdog-scale
  synchronous delays or abnormal memory growth.
- A scratch project with its own opencode.json and private foreground host can
  load ACP from source, process small and large-history prompts, and answer health
  checks without interrupting the shared service.
- Add baseline-negative performance coverage, verify supported V1/V2 behavior,
  obtain two independent reviews, and report activation status honestly.
