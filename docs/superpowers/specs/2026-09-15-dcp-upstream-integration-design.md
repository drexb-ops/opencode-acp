# DCP Upstream Integration Design

## Goal

Bring the complete current history and final tree of the official
`Opencode-DCP/opencode-dynamic-context-pruning` `master` branch (v3.1.15,
`11f6517`) into ACP without discarding ACP's existing work. Before that
integration, bring ACP's current upstream `origin/master` (`c6066c4` at design
time) into the ACP feature branch.

## Baseline

- ACP integration branch: `2026-09-15_dcp-upstream-integration`, created from
  `2026-09-11_acp-transform-performance` at `626b7bb`.
- ACP's locally known `origin/master`: `98311e4`; its remote head is newer at
  `c6066c4` and must be fetched.
- DCP's local `master` and official `origin/master` already match at
  `11f6517` (v3.1.15).
- ACP and DCP have no common Git commit, so Git cannot perform a normal
  ancestor-based merge.

## Chosen Approach

Use a preservation-first, two-stage integration:

1. Fetch ACP's `origin` and merge its refreshed `origin/master` into this
   branch. This is an ordinary merge because ACP shares that history.
2. Fetch DCP's current official `master` into an `dcp-upstream` remote in the
   ACP checkout. Merge it with `--allow-unrelated-histories --no-commit`, then
   resolve the complete tree before creating the merge commit.

The final merge commit retains DCP's history. The resolved working tree is the
integrated product: every DCP-only path is retained, and every overlapping path
is reconciled rather than accepted wholesale.

## Conflict Resolution Rules

ACP remains the behavioral source of truth where both projects implement the
same concern. In particular, preserve ACP's:

- product naming, configuration files, commands, storage locations, and
  backward-compatibility guarantees;
- `SessionStateRegistry` and its persisted-state migration behavior;
- range compression, `decompress`, `search_context`, `acp_status`, and
  `acp_context_recap` tools;
- multi-tier compression, quality gate, candidate planning, proxy detection,
  and performance optimizations;
- ACP documentation, release process, changelog, and development-log rules.

For DCP changes that touch those same areas, carry the final upstream behavior
only when it can be incorporated without removing or regressing an ACP
guarantee. Resolve equivalent bug fixes into ACP's architecture rather than
reintroducing DCP's older single-state or message-mode implementation.

Retain DCP-only files and non-conflicting changes, adapting names and package
metadata where needed so they build and test in ACP. Do not silently delete an
incoming path; each such path must be classified as retained, incorporated into
an ACP counterpart, or deliberately omitted with a documented incompatibility
reason in the integration worklog.

## Merge Procedure

1. Record clean working-tree state and remote heads.
2. Fetch ACP `origin`; merge the refreshed `origin/master`; resolve and verify
   that merge independently.
3. Add or update the read-only `dcp-upstream` remote with the official DCP URL
   and fetch its `master` branch.
4. Start an unrelated-history, no-commit merge from `dcp-upstream/master`.
5. Create a path-by-path conflict ledger. Reconcile source, package metadata,
   configuration schema, tests, assets, scripts, and documentation according to
   the rules above.
6. Run the verification suite before committing the DCP merge. Record every
   material resolution in the worklog.

## Verification

For each merge stage:

- confirm no unmerged paths remain and run `git diff --check`;
- run `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run build`;
- compare the resulting package files with `npm run verify:package`;
- inspect the built entrypoint and package exports to ensure the merger did not
  restore DCP-only package identity or remove ACP tools;
- run targeted tests for touched behavior and add regression coverage where an
  upstream fix is translated into ACP's implementation.

## Error Handling and Recovery

All merges begin with `--no-commit` or occur on this dedicated branch. If a
conflict cannot be resolved while preserving ACP behavior, abort only the
active merge, document the blocker, and return to the last verified commit.
No reset, forced update, or deletion of existing ACP work is permitted.

## Deferred Scope

The OpenCode V2 plugin-API port is intentionally deferred until the source
baseline is integrated and verified. It is a separate migration because both
ACP and DCP currently use the V1 return-hooks API; mixing its broad API rewrite
with unrelated-history conflict resolution would make regressions unreviewable.
