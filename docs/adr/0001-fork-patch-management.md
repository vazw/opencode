# ADR-0001: Ownership of the fork's custom patch series

Status: Accepted (2026-10-24)
Date: 2026-10-24
Related: `script/fork/fork.sh`, `docs/fork/permission-fix.md`, design draft 2026-10-24 (scratch, not tracked)

## Context

This repository carries a deliberate fork delta of ten files on top of `anomalyco/opencode`'s `dev` branch. The delta is small, but it must survive repeated upstream pulls on a fast-moving branch, and it touches at least one hot file: `packages/core/src/permission.ts`, which upstream edits often and which the delta changes across three sequential commits.

The host cannot install `bun`, so no part of this workflow is verified by a local package-manager run. Verification goes through `podman`, always with `-e OPENCODE_VERSION=2.1.4`, because a binary built with the default `0.0.0` version cannot reach the server and every test that needs a server would then fail for an unrelated reason.

On 2026-10-24 the worktree diverged into a state that could not be recovered by inspection. Three independent defects combined:

- the global `rebase.autoStash=true` stashed a dirty tree, rebased, and re-applied the stale stash, silently restoring 205 files to a `v2.1.4` snapshot;
- `git pull` has two modes, fast-forward and rebase, and only one of them was ever guarded, so the same command behaved differently depending on local state;
- `.tmp/` was never ignored. A `gitignore` pattern without a slash matches a path component exactly, so the project's designated scratch root (`tmp` versus `.tmp`) counted as permanent dirt and `git status --porcelain` was permanently non-zero.

A permanently non-zero status is what made the other two defects invisible: when the dirty count is always large, a rebase that restores 205 stale files looks like ordinary noise. The invariant that follows is INV-CLEAN: `git status --porcelain` must be empty at every point where history moves, and the allowlist is empty permanently. To make an empty allowlist achievable, each source of permanent dirt had to move either into history (the `AGENTS.md` section, the `@opentunnel/client` pin) or into ignored space (`.tmp/`, the generated `services/www` artefacts, the relocated agent scratch directories).

The shape that resulted is one stack, with `local/fork-config` as the branch builds run from:

```
origin/dev
  base: one upstream commit, recorded as refs/fork/last-base
    series 1: fix(core): fix permission relativization bug and update environment instruction
    series 2: fix(core): stop absolutizing shell command resources
    series 3: fix(core): match path- and wrapper-qualified spellings in shell denies
      local 1: docs(fork): document fork permission fix
      local 2: chore(cli): pin @opentunnel/client for local builds
      local 3: chore: ignore fork scratch root and generated openapi
      local 4: chore(cli): sync lockfile with @opentunnel/client pin
        fix/permission-relative-glob points at series 3
        local/fork-config points at local 4
```

The split is what makes the delta reviewable. `origin/dev..fix/permission-relative-glob` is the only part that could ever be proposed upstream, and `fix/permission-relative-glob..local/fork-config` is everything that is deliberately local and must never be exported.

Before any history motion during that recovery, the whole repository was copied into a bundle under `.tmp/backups/` and the pre-recovery tips were pinned under `refs/backups/`, so every step of the repair had a named rollback point. The same discipline applies to the wrapper: it never takes a destructive action that a later step could not undo from a recorded ref.

This decision is recorded because it is hard to reverse, since it fixes where the delta lives and how every future session syncs; because it is surprising without context, since a reader will ask why there are two branches and three refs; and because it is the result of a real trade-off between six candidate models.

## Decision

Adopt a rebase-only patch-series branch as the ownership model, with `format-patch` demoted to a derived artefact and a second worktree demoted to a transient probe. Concretely:

1. `fix/permission-relative-glob` remains the single patch-series branch. It holds three commits that are separate by intent (relativization, stop absolutizing shell resources, deny-only canonicalization) and is based on one specific `origin/dev` commit. It is rebased on sync and never merged.
2. `local/fork-config` is stacked on top of the series and carries the local layer: fork documentation, the dependency pin, the ignore rules and `script/fork/`. It is never exported and never proposed upstream. It is the branch builds run from.
3. `git format-patch` output is generated and never edited. It is written to `.tmp/patches/fork/` for backup and for the patch-apply drift check. The branch is authoritative; the patches are a projection of it.
4. Upstream builds and rehearsals happen in throwaway worktrees under `.tmp/probe/`, created and removed by the tooling. There is no standing second checkout.
5. Sync is performed by one wrapper, `script/fork/fork.sh sync`, which separates `fetch` from `rebase`, disables auto-stash for that invocation, asserts preconditions and postconditions, and fails closed. It is the only verb that moves history.

The ref protocol that makes the green point checkable is local-only and never pushed:

- `refs/fork/last-base` records the `origin/dev` commit the series currently sits on.
- `refs/fork/last-green` records the series tip that was last proven green by a build.
- `refs/fork/last-build` records the tree tip that was actually built and tested, normally `local/fork-config`'s HEAD.

`verify` proves that `last-green` is an ancestor of `last-build`, so the pair states "this delta, on this tree, was green". It also proves that `last-green` descends from `last-base` and that the series is exactly the expected number of commits on that base. A green point that does not descend from the current base is reported as STALE rather than as a failure, because that is the normal state between `sync` and `mark-green`; only the ancestry test can detect it, since the commit count is the same in both states.

The verb surface is `status`, `preflight`, `sync`, `verify`, `export`, `drift` and `mark-green`. `sync` is the only history-moving verb; `mark-green` writes exactly two refs and only after every guard has passed, so a refusal leaves refs bit-identical; `status`, `preflight`, `verify` and `drift` are read-only; `export` writes only inside `.tmp/patches/fork/`.

`sync` cannot silently shrink the series. Two distinct mechanisms could drop a series commit, and both are closed: `--empty=stop` stops the rebase when a commit becomes empty instead of dropping it, and `--reapply-cherry-picks` prevents git from preemptively dropping a commit whose patch-id already exists upstream, which would otherwise disappear without `--empty=stop` ever firing. A postcondition independently asserts the series count on the new base before `last-base` moves.

`export` requires two independent proofs before it writes anything. The range `last-base..last-green` must be exactly the series count, which rejects a branch that descends from the local layer because that range would be longer; and every path in the range must be under `packages/core/`. A deny-list runs as a second layer but is not the primary guard, because measured against the six local-layer files a deny-list catches only `AGENTS.md` and `.gitignore`.

Every guard exits non-zero with a `fork:` message naming the reason. No verb accepts a flag that bypasses a guard: there is no `--force`, no `--continue-anyway` and no stashed fallback. `preflight`'s only outputs are a pass and a refusal with a count.

The wrapper never runs a destructive git command. It does not contain `git pull`, `git reset --hard`, `git checkout -- .`, `git clean`, `git push`, `git stash push` or `rm -rf`. A failed rebase is aborted rather than left mid-conflict, and the failure message describes that abort instead of telling the operator to continue a rebase that no longer exists. Probe worktrees are removed with `git worktree remove --force` and plain directories with `find -depth -delete`, followed by `git worktree prune`, so a failed removal cannot leave a stale registration behind.

`drift` implements the two cheap tiers of drift detection. Tier 1 asks `git merge-tree --write-tree --merge-base` whether the series would merge cleanly onto the current `origin/dev`; it writes one unreferenced tree object and moves no ref. Tier 2, enabled by `--apply`, replays the exported patches in order onto a detached probe worktree at `origin/dev` and reports how many apply, which proves the claim that the delta can be rebuilt from a pristine upstream tree.

There is no bespoke lock file. Two concurrent `sync` runs are already serialised by git's own `index.lock` and `HEAD.lock`, and `preflight` refuses while a rebase is in progress, so adding a lock would only add a new failure mode, a stale lock, for a race git already handles.

## Options considered

Six candidate models were scored on six criteria, `++` best to `--` worst. Conflict cost is the recurring per-pull cost once drift exists.

| # | Model | Conflict cost | Reproducibility | Reviewability | Bisectability | Build/run | Failure recovery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Rebase-only dedicated branch (status quo shape) | `+` rerere-friendly, conflicts resolved once per upstream change | `+` branch name plus fetch is enough | `++` `git diff origin/dev...HEAD` is the review artefact | `++` full-history `git bisect` works | `++` checkout and run | `++` `rebase --abort` or `--skip` |
| B | `format-patch` series applied with `git am` on a pinned base | `+` same conflicts, but no branch identity to lean on | `++` patches restate the base explicitly | `+` patch files readable, but duplicate the commits | `--` bisect only within the applied series | `--` requires an apply step before every build, and partial-apply states are confusing | `-` `am --abort` works, but which patch is applied is ambient state |
| C | `stgit` stacked patches | `+` | `+` | `+` | `+` | `--` tool absent, would require installing, which is forbidden here and a new host dependency | `-` a second state model to learn and to lose |
| D | Merge-based branch | `--` every sync re-merges and re-resolves, and conflicts accumulate in history | `-` | `-` `origin/dev...HEAD` becomes misleading and the PR diff noisy | `-` merge commits pollute bisect | `+` | `-` `merge --abort` only |
| E | Separate worktree, pristine upstream versus custom | n/a, does not by itself solve re-application | `+` | `+` | `+` | `--` 8.3 GB of `node_modules` per worktree, doubled builds, two installs | `+` blast radius contained |
| F | Build-time vendored patch over a pristine tree | `-` conflicts surface as build failures, not as reviewable hunks | `++` | `-` the patch is invisible in review | `--` | `--` breaks the dev loop, since editor and typecheck point at pristine sources | `-` opaque |

Two probe findings shaped the weighting:

1. `git merge-tree` predicted zero conflicts against the current `origin/dev`, and upstream has touched none of the ten patched files since `v2.1.4`. The recurring conflict cost of A is therefore currently near zero, so the model was chosen for verifiability rather than for minimising a cost that is not being paid.
2. A permanent second worktree (E) costs 8.3 GB of dependencies per clone and must be rebuilt from scratch after every upstream change, which is the same work as a rehearsal but always on. E is valuable as a transient probe, not as a standing layout.

## Consequences

Positive:

- Every sync has a mechanical pass or fail, so "did it work" stops being a judgement call.
- The reviewable artefact stays `git diff origin/dev...fix/permission-relative-glob`.
- Re-applying the delta to any future `origin/dev` is one command plus at most ten files of conflict surface.
- `git bisect` spans upstream and fork history in one run.
- The exported patch series is a plain-text restatement of the delta that survives outside git, so the delta can be rebuilt on another clone or another machine without the branch.

Negative and accepted costs:

- Two branches, three refs and one wrapper: the invariant only holds if sessions use `script/fork/fork.sh` instead of raw `git pull`. Raw git remains possible, and the wrapper cannot prevent it, only detect it afterwards through `status`.
- `refs/fork/*` live in `.git` only and are not pushed, so a re-clone loses the green point. It is recoverable from `git log` at the cost of one manual annotation.
- The `rerere` cache is local, so conflict resolutions are not shared with other clones.
- A sync moves both branches, because the local layer must be rebased too. This is mitigated by checking out the top branch and using `rebase --update-refs`.
- `.gitignore` becomes a fork-owned file: a one-line addition that upstream may edit near.
- `mark-green` cannot verify that a build actually happened. It annotates the green point and prints that caveat; recording a green point without a build stays a human error that the tooling can only name, because no artifact exists to check and the build output directory is ignored and may be stale.

## Rejected alternatives

- Squashing the series into one commit. It reduces conflict surface marginally but destroys the three-commit narrative and makes bisecting the fork's own regressions impossible.
- Making patches in a tracked `patches/` directory the source of truth. It duplicates history, invites hand-editing, and makes "is the tree what the commits say" ambiguous.
- Keeping the local edits as permanent uncommitted dirt with an allowlist. An allowlist is how the 205-file state became normal.
- `stgit`. It is absent, installation is not authorised, and it gains nothing that A does not already give here.

## References

- Design draft 2026-10-24, sections 3.1 to 3.5: context, options weighed, decision, consequences and rejected alternatives.
- Design draft 2026-10-24, sections 4.1 to 4.5: INV-CLEAN, policy settings, preflight, postcondition and the advisory-only hook policy.
- Design draft 2026-10-24, sections 7.1 to 7.4: the ongoing cycle, what sync must do, refreshing the exported series, and early detection of upstream changes to patched files.
- Design draft 2026-10-24, section 9: the four drift-detection tiers, of which tiers 1 and 4 are implemented by `drift` and `export`.
- `script/fork/fork.sh`: the single entrypoint that implements this decision.
- `docs/fork/permission-fix.md`: what the patch series changes and why.
