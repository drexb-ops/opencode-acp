# REQ — qualityGate.algorithms nested params falsely flagged as "Unknown keys" (#329)

## Problem

Configuring per-algorithm quality-gate parameters triggers a false startup warning:

```jsonc
{
  "qualityGate": {
    "enabled": true,
    "algorithm": "rouge-recall-v1",
    "algorithms": {
      "rouge-recall-v1": {
        "layer1MinChars": 200,
        "layer1MinRetentionPct": 2.5,
        "layer2MaxRougeF1": 0.05,
        "layer2MaxTop20Recall": 0.20
      }
    }
  }
}
```

`ACP: config warning — Unknown keys: qualityGate.algorithms.rouge-recall-v1...`

The config is legal and consumed at runtime (`lib/compress/quality-gate/evaluate.ts:104` reads `qg.algorithms[algoName]`) — only the key-allowlist check is wrong.

## Root cause

`getConfigKeyPaths()` in `lib/config-validation.ts` recurses into `qualityGate.algorithms` because it isn't in the dynamic-key skip list (unlike `compress.providers`, `messageFilters.filters`, `compress.modelMaxLimits`). Every nested key it emits (`qualityGate.algorithms.rouge-recall-v1`, `...layer1MinChars`) fails the static allow-list lookup.

## Fix

Add `qualityGate.algorithms` to the recursion skip list with a comment explaining the dynamic-map convention (next path segment = user-chosen algorithm id; inner shape validated by the owning subsystem).

## Acceptance

- [x] New tests: nested algorithm keys → no warning; sibling unknown keys still flagged
- [x] Full suite + typecheck green
- [ ] Dual-agent review
