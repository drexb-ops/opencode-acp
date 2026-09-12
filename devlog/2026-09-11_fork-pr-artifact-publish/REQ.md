# REQ — build-artifact fails on fork PRs: NPM_TOKEN unavailable (#366)

## Problem

`.github/workflows/pr-artifact.yml` runs `npm publish --tag pr-N` on every PR. Fork-opened PRs have no access to repo secrets (`NPM_TOKEN` is empty), so the publish step fails with `ENEEDAUTH`, the whole `build-artifact` job goes red, and the artifact + install-instructions comment never appear for fork PRs (e.g. PR #341).

## Fix

1. Gate the publish step on same-repo heads: `if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}`. Fork PRs skip npm but still build, pack, upload the artifact, and comment.
2. Make the comment's "Option A — npm PR tag" section conditional: hidden for forks, replaced by a note pointing at the GitHub/artifact install options.

Downstream steps verified: with publish skipped, `npm pack` produces the base-version tarball, which the tarball step copies to `opencode-acp-pr<N>.tgz` and the upload glob (`opencode-acp-pr*.tgz`) still matches.

## Acceptance

- [x] YAML parses; embedded comment JS passes `node --check`
- [x] Same-repo PRs: behavior unchanged (publish + full comment)
- [x] Fork PRs: job green, artifact + comment with Options B/C
- [ ] Observed green on a real fork PR after merge
