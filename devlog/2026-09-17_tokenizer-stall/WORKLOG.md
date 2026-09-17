# WORKLOG — Long-session tokenizer stall

- Status: Verified in isolation — shared ACP remains disabled
- Baseline: `5ff308c` on local `master`
- Shared ACP: disabled by user; preserve that setting during investigation

Evidence:

- Private replay: 310 settled sources / 738 canonical messages, about 3.9 MB
  captured JSON. Lowering 45 ms; normalization 55 ms; V2 budget **43,522 ms**
  synchronously; RSS approximately 176 MB.
- Tiny strings: 1 count 81 ms, 10 counts 443 ms, 100 counts 4,578 ms.
- Library source constructs and frees the tokenizer per call.
- Official 2.0.3 event-stream watchdog is 45 seconds; service health checks time
  out after 2 seconds and three consecutive timeouts trigger termination/recovery.
- Actual logs show event-stream stalls and repeated service recovery. No direct
  OOM/native-panic/exit-code evidence was found. This is not established as a
  TypeScript loading failure or a JSONC syntax issue.

Private reproduction: `/tmp/opencode/acp-crash-profile.mts`. Captured context is
private local data and must not be committed or published.

Implementation and verification:

- `countTokens` now lazily reuses one tokenizer, with the same NFKC and special
  token semantics and defensive reset/free on encoder failure.
- Public-reference equivalence and repeated-call regression tests pass. The
  original 100-call baseline was 4,518 ms and fails the new 2,000 ms budget.
- Private real-history replay after the fix: budget **897 ms** (previously
  43,522 ms), transform 1,423 ms, complete context handler 2,554 ms; state
  initialized and request patch accepted. Budget token count remained 636,227.
- Scratch project/private foreground OpenCode **2.0.3** loaded the actual local
  `index.ts`. Small prompt 0.239 s; prompt after 250 synthetic history entries
  0.973 s; eight health probes, zero failures, max 0.601 s; server remained alive.
  Diagnostics: `/tmp/opencode/acp-private-source-81hcn0ng`.
- Full suite: **1,482/1,482** passed. Typecheck/build/package verification passed
  (261 package entries).
- Repeated private source-host check also verified both assistant replies were
  delivered: 0.274 s small prompt, 1.023 s after 250 synthetic entries, nine health
  probes, zero failures, max 0.439 s; server remained alive. Diagnostics:
  `/tmp/opencode/acp-private-source-juggv3fn`.
- Installed V1 1.18.29 / V2 2.0.3 artifact matrix passed in **97 seconds** with
  unchanged exact nudge goldens 11,062 → 11,609 → 15,226, wire reliability,
  restart persistence, and permissions.
- Both independent reviewers approved the final source/test delta and verified
  the final check logs. Shared ACP remains disabled; no shared restart was
  performed during this isolated hotfix investigation.
