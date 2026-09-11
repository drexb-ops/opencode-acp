# WORKLOG — qualityGate.algorithms config-key fix

1. Reproduced from issue #329 config sample: `getInvalidConfigKeys` returned `qualityGate.algorithms.rouge-recall-v1.*` paths.
2. Located skip-list in `lib/config-validation.ts::getConfigKeyPaths`, added `qualityGate.algorithms` (+ explanatory comment).
3. Added 2 tests in `tests/config-validation.test.ts`:
   - nested algorithm params → `[]` (no warning)
   - unknown sibling key (`qualityGate.notARealKey`) still flagged while algorithm params pass
4. Verification: config-validation suite 47/47; full suite 1209/1209; typecheck clean.
5. Dual-agent review dispatched on the PR.
6. Review follow-up (issue #329 floor, ranxianglei): the example/test param names used non-existent keys `minSummaryLength` / `rougeF1Threshold`. Corrected to the real `rouge-recall-v1` params (`layer1MinChars`, `layer1MinRetentionPct`, `layer2MaxRougeF1`, `layer2MaxTop20Recall`) in `REQ.md` (config sample + root-cause prose) and both new tests. Unknown inner keys are silently ignored at runtime, so the old sample would have configured params that never take effect. No logic change — validation fix untouched; suite re-verified green.
