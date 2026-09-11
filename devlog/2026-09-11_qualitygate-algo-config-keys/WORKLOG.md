# WORKLOG — qualityGate.algorithms config-key fix

1. Reproduced from issue #329 config sample: `getInvalidConfigKeys` returned `qualityGate.algorithms.rouge-recall-v1.*` paths.
2. Located skip-list in `lib/config-validation.ts::getConfigKeyPaths`, added `qualityGate.algorithms` (+ explanatory comment).
3. Added 2 tests in `tests/config-validation.test.ts`:
   - nested algorithm params → `[]` (no warning)
   - unknown sibling key (`qualityGate.notARealKey`) still flagged while algorithm params pass
4. Verification: config-validation suite 47/47; full suite 1209/1209; typecheck clean.
5. Dual-agent review dispatched on the PR.
