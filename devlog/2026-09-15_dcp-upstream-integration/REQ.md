# REQ: Integrate Current Official DCP

## Objective

Integrate the current official DCP `master` tree and history into ACP while
preserving ACP's existing product behavior and custom work.

## Constraints

- Update ACP from its current `origin/master` before integrating DCP.
- DCP and ACP have unrelated Git histories; retain both histories in the final
  DCP integration merge commit.
- Resolve conflicts with ACP behavior as the source of truth.
- Do not delete or overwrite existing ACP work.
- Verify formatting, type checking, tests, build output, and package contents.

## Deferred Work

The OpenCode V2 plugin-API migration follows this upstream integration as a
separate change.
