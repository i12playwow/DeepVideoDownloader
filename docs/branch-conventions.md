# Branch & tag conventions

How this repo stays tidy: one permanent branch, short-lived feature/release
branches, immutable tags. These rules are what the branch-protection config
and the rulesets already enforce — this doc records the intent so nobody has
to rediscover it by trial and error.

## Branches

| Branch | Purpose | Lifetime |
| --- | --- | --- |
| `master` | The only permanent branch. Always releasable; every change arrives via squash-merge from a PR. | forever |
| `feat-*` / `<topic>` | Feature or fix work heading to a PR (e.g. `feat-error-retryable-markers`). | until merged, then deleted |
| `release-X.Y.Z` | A version-bump PR for release X.Y.Z (title `X.Y.Z: version bump …`). | until merged, then deleted |

Rules:

1. **One permanent branch.** Everything else is short-lived and gets deleted
   the moment its PR merges. A stale branch whose content is fully absorbed
   into `master` (common after squash merges, where git ancestry is lost) is
   deleted too — verify with `git diff <branch-tip> master` first.
2. **Never commit straight to `master`** — protection requires the `tests`
   check via PR anyway (see AGENTS.md, "Master merges go through the gated
   workflow").
3. **Branch names are lowercase, hyphenated, no slashes** unless prefixed by
   the automation that owns them (e.g. `i12playwow-*` Copilot worktree
   branches, which are pruned with their worktrees once merged).
4. **After every squash-merge**: delete the branch (local + remote) and
   `git fetch --prune`. History lives in the squash commit and the PR; the
   branch ref is redundant the moment it merges.

## Tags

| Pattern | Meaning |
| --- | --- |
| `vMAJOR.MINOR.PATCH` (e.g. `v1.3.13`) | Annotated release tag, created on the version-bump squash commit on `master`. |

Rules:

1. **Tags are immutable.** A `tag-protection` ruleset (ruleset id
   `23640568`) covers `refs/tags/*` with the `deletion` and
   `non_fast_forward` rules and **no bypass actors** — not even repo admins
   can delete or retag. Live-fire verified: a delete push of `v1.3.11` is
   rejected with "push declined due to repository rule violations".
2. Tags are **annotated**, created only on `master` at the version-bump
   squash, and pushed once. If a release must be fixed, ship `X.Y.(Z+1)` —
   never move a tag.
3. Every tag gets a GitHub Release named `Deep Video Downloader X.Y.Z` with
   notes in the house style and the setup installer attached (see the release
   checklist in AGENTS.md before building any 1.3.x dist).

## Release flow (the happy path)

1. Branch `release-X.Y.Z` from `master`; bump `package.json`; the commit
   message links the green drill evidence (`scripts/check-release-drill.js`
   enforces this on any version bump).
2. PR → CI (`tests` + `boot-verify`) must be green on the head.
3. Squash-merge via the tests-gated pipeline (AGENTS.md documents the
   phantom-check fallback if the API refuses a sane, green head).
4. Tag the squash commit on `master` (annotated, `vX.Y.Z`), push the tag.
5. Create the GitHub Release (draft → attach installer → publish).
6. Delete the release branch; `git fetch --prune`.
