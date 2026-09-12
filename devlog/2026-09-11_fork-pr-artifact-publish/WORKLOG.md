# WORKLOG — fork PR artifact fix

1. Added `if:` guard to the npm publish step (same-repo heads only).
2. Comment script: Option A (npm PR tag) now conditional; forks get a note + Options B/C.
3. Verified: yaml.safe_load parses; publish.if extracts correctly; embedded JS passes `node --check`; tarball copy + upload glob unaffected when publish is skipped.

No runtime code touched — CI-only change.

## Review round 2 (dual-agent, reviewer #3 on CI file)

3 findings fixed before merge:
- **F1 (bug)**: `context.repo.full_name` doesn't exist in github-script (`context.repo` = `{owner, repo}`) → `isFork` was always `true` → Option A never shown even for same-repo PRs. Fixed: compare `head.repo.full_name` vs `` `${owner}/${repo}` ``.
- **F2**: fork PRs get read-only GITHUB_TOKEN → comment step would 403 and turn the job red (previously masked by the ENEEDAUTH). Fixed: `continue-on-error: true` on the comment step.
- **F3**: Option B hardcoded `github:ranxianglei/opencode-acp#<branch>` — the fork's branch ref doesn't exist on the base repo. Fixed: `installRepo` = head repo full_name for forks.

Re-verified: YAML parses, embedded JS passes `node --check`, all three assertions checked programmatically.
