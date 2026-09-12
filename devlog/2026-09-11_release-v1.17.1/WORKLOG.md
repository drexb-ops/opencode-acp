# WORKLOG — Release v1.17.1

1. Verified master since v1.17.0: #389 → #390 → #385 (perf) all merged 2026-09-11.
2. Audited #385 (bot-authored): benchmark evidence, dual-agent review noted in PR body, persisted-state compatibility claimed; full suite re-run below confirms.
3. Branched `2026-09-11_release-v1.17.1` from github/master (220bd86).
4. package.json 1.17.0 → 1.17.1.
5. Changelog entries (EN + zh): #385 headline with RC1–RC4 detail, #389 with real rouge-recall-v1 param names, #390 CI-only note.
6. Verification results:
   - check-pr.sh: all checks passed
   - typecheck: 0 errors
   - tests: 1229/1229 pass
   - build: OK
7. Commit, push, PR #___ (human merges).
