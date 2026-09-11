# WORKLOG — fork PR artifact fix

1. Added `if:` guard to the npm publish step (same-repo heads only).
2. Comment script: Option A (npm PR tag) now conditional; forks get a note + Options B/C.
3. Verified: yaml.safe_load parses; publish.if extracts correctly; embedded JS passes `node --check`; tarball copy + upload glob unaffected when publish is skipped.

No runtime code touched — CI-only change.
