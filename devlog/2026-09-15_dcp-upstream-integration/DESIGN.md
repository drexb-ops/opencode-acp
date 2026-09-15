# DESIGN: Preservation-First Unrelated-History Merge

ACP first merges its own refreshed upstream history. It then merges the DCP
official `master` tip with `--allow-unrelated-histories --no-commit`.

Every overlapping file is reconciled against ACP's current architecture;
DCP-only files are retained or explicitly accounted for in `WORKLOG.md`.
This preserves both Git histories without replacing ACP's state registry,
multi-tier compression, ACP tools, configuration, or user-visible identity.

The V2 API migration is excluded from this merge to keep the integration
reviewable and independently verifiable.
