#!/usr/bin/env bash
# script/fork/fork.sh — the fork's single sync entrypoint (ADR-0001).
#
# The fork keeps a three-commit patch series on fix/permission-relative-glob and a
# local layer stacked on top of it on local/fork-config. This wrapper is the only
# supported way to move that history: it separates `fetch` from `rebase`, disables
# auto-stash for that invocation, asserts preconditions and postconditions, and
# fails closed. `sync` is the only verb that moves refs; `mark-green` writes the
# two green-point refs and nothing else.
#
# INV-CLEAN: `git status --porcelain` must be empty wherever history moves.
# The allowlist is empty, permanently.
set -euo pipefail
IFS=$'\n\t'

BR_SERIES=fix/permission-relative-glob
BR_TOP=local/fork-config
UPSTREAM=origin/dev
REF_BASE=refs/fork/last-base
REF_GREEN=refs/fork/last-green
REF_BUILD=refs/fork/last-build
REF_PRE=refs/fork/pre-rebase
FORK_SERIES_COUNT=${FORK_SERIES_COUNT:-3}
FORK_ALLOWED_PREFIX=packages/core/
PATCH_DIR=.tmp/patches/fork
PROBE_ROOT=.tmp/probe

repo_root=""
# Probe paths are script-global, not function-local: the EXIT trap fires after the
# verb's function has returned, so a `local` would be out of scope and cleanup would
# silently no-op, leaking a registered worktree. Both are reset before the trap is
# installed in cmd_drift.
probe=""
patches=""

die() { printf 'fork: %s\n' "$1" >&2; exit 1; }
warn() { printf 'fork: %s\n' "$1" >&2; }
note() { printf 'note: %s\n' "$1" >&2; }

usage() {
  cat <<'EOF'
usage: script/fork/fork.sh <verb>

verbs:
  status      report branch, dirty count, fork refs, ahead/behind and the green point
  preflight   fail-closed precondition check; never moves anything
  sync        fetch, then rebase both branches onto origin/dev (the only history-moving verb)
  verify      postcondition audit; reports a STALE green point without failing
  export      write the patch series to .tmp/patches/fork/ (generated, never edited)
  drift       predict conflicts against origin/dev; --apply rehearses the patch series
  mark-green  pin refs/fork/last-green to the series tip and last-build to HEAD (after a build)

branches:
  local/fork-config              top branch: series + local layer (build from here)
  fix/permission-relative-glob   patch series only (exported, never merged)

refs (local-only, never pushed):
  refs/fork/last-base   the origin/dev commit the series sits on
  refs/fork/last-green  the series tip last proven green by a build
  refs/fork/last-build  the tree tip that was actually built and tested

INV-CLEAN: git status --porcelain must be empty wherever history moves; the allowlist is empty.

exit: 0 pass, 1 refusal/failure, 2 usage
EOF
  exit "${1:-0}"
}

# require_repo: fail before any cd when the caller is not inside a work tree.
require_repo() {
  if ! repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    die "not a git repository"
  fi
  cd "$repo_root"
}

require_ref() {
  if ! git rev-parse --verify --quiet "$1" >/dev/null; then
    die "$1 missing"
  fi
}

dirty_count() {
  git status --porcelain | wc -l | tr -d ' '
}

# require_clean [message]: INV-CLEAN, with an optional verb-specific reason.
require_clean() {
  local n
  n=$(dirty_count)
  if [ "$n" != 0 ]; then
    die "${1:-worktree not clean: $n entries — refusing to move history}"
  fi
}

# require_branch <branch> [message-prefix]: the checked-out branch must match.
require_branch() {
  local cur
  cur=$(git symbolic-ref --short -q HEAD || true)
  if [ "$cur" != "$1" ]; then
    die "${2:-must run from $1} (current: ${cur:-detached HEAD})"
  fi
}

# assert_series_state: the series is exactly FORK_SERIES_COUNT commits on last-base.
# Deliberately never called from sync's postcondition, where last-base has not moved yet.
assert_series_state() {
  local count
  require_ref "$REF_BASE"
  if ! git merge-base --is-ancestor "$REF_BASE" "$BR_SERIES"; then
    die "series tip does not descend from refs/fork/last-base"
  fi
  count=$(git rev-list --count "$REF_BASE..$BR_SERIES")
  if [ "$count" != "$FORK_SERIES_COUNT" ]; then
    die "series has $count commits on refs/fork/last-base, expected $FORK_SERIES_COUNT — bump FORK_SERIES_COUNT only if the change is intentional"
  fi
}

abort_rebase_if_any() {
  if [ -e "$(git rev-parse --git-path rebase-merge)" ] || [ -e "$(git rev-parse --git-path rebase-apply)" ]; then
    if ! git rebase --abort; then
      warn "could not abort rebase"
    fi
    note "rebase aborted; refs/fork/pre-rebase holds the pre-sync series tip"
  fi
}

# new_probe_dir <prefix>: create and print an absolute, empty directory under .tmp/probe/.
new_probe_dir() {
  mkdir -p "$repo_root/$PROBE_ROOT"
  mktemp -d "$repo_root/$PROBE_ROOT/$1.XXXXXX"
}

# cleanup_probe <dir>: remove a probe worktree or plain directory, never change the exit
# status of the verb (every command is guarded), and never leave a stale registration.
cleanup_probe() {
  if [ -z "${1:-}" ]; then
    return 0
  fi
  git worktree remove --force "$1" 2>/dev/null || find "$1" -depth -delete 2>/dev/null || true
  git worktree prune >/dev/null 2>&1 || true
  return 0
}

# ref_short <ref>: 10-char abbreviation, or "missing" when the ref is absent.
# `git rev-parse --short` accepts exactly one revision, so this is called per ref.
ref_short() {
  if git rev-parse --verify --quiet "$1" >/dev/null; then
    git rev-parse --short=10 "$1"
  else
    printf 'missing'
  fi
}

# counts_ab <branch>: print "<behind> <ahead>" relative to origin/dev.
counts_ab() {
  local c
  c=$(git rev-list --left-right --count "$UPSTREAM...$1")
  printf '%s %s\n' "$(printf '%s' "$c" | cut -f1)" "$(printf '%s' "$c" | cut -f2)"
}

cmd_status() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo

  local branch dirty base_short green_short build_short upstream_short
  local s_ab c_ab s_behind s_ahead c_behind c_ahead
  local series_count green_state green_note cur

  branch=$(git symbolic-ref --short -q HEAD || printf 'detached HEAD')
  dirty=$(dirty_count)
  base_short=$(ref_short "$REF_BASE")
  green_short=$(ref_short "$REF_GREEN")
  build_short=$(ref_short "$REF_BUILD")
  upstream_short=$(ref_short "$UPSTREAM")

  green_note=""
  if [ "$green_short" != missing ] && git rev-parse --verify --quiet "$BR_SERIES" >/dev/null; then
    if [ "$(git rev-parse "$REF_GREEN")" = "$(git rev-parse "$BR_SERIES")" ]; then
      green_note=" (series tip)"
    fi
  fi

  s_behind=unknown
  s_ahead=unknown
  if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null && git rev-parse --verify --quiet "$BR_SERIES" >/dev/null; then
    s_ab=$(counts_ab "$BR_SERIES")
    s_behind=${s_ab% *}
    s_ahead=${s_ab#* }
  fi

  c_behind=unknown
  c_ahead=unknown
  if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
    c_ab=$(counts_ab HEAD)
    c_behind=${c_ab% *}
    c_ahead=${c_ab#* }
  fi

  series_count=unknown
  if [ "$base_short" != missing ] && git rev-parse --verify --quiet "$BR_SERIES" >/dev/null; then
    series_count=$(git rev-list --count "$REF_BASE..$BR_SERIES")
  fi

  if [ "$green_short" = missing ]; then
    green_state=missing
  elif [ "$base_short" = missing ]; then
    green_state=unknown
  elif git merge-base --is-ancestor "$REF_BASE" "$REF_GREEN"; then
    green_state=fresh
  else
    green_state=stale
  fi

  printf 'branch: %s\n' "$branch"
  printf 'dirty: %s\n' "$dirty"
  printf 'refs/fork/last-base: %s (origin/dev %s)\n' "$base_short" "$upstream_short"
  printf 'refs/fork/last-green: %s%s\n' "$green_short" "$green_note"
  printf 'refs/fork/last-build: %s\n' "$build_short"
  printf '%s: %s behind, %s ahead of origin/dev\n' "$BR_SERIES" "$s_behind" "$s_ahead"
  cur=$(git symbolic-ref --short -q HEAD || printf 'detached HEAD')
  printf 'current (%s): %s behind, %s ahead of origin/dev\n' "$cur" "$c_behind" "$c_ahead"
  printf 'series count: %s (expected %s)\n' "$series_count" "$FORK_SERIES_COUNT"
  printf 'green point: %s\n' "$green_state"
}

cmd_preflight() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo

  local state
  for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    if [ -e "$(git rev-parse --git-path "$state")" ]; then
      die "operation in progress: $state"
    fi
  done

  if ! git symbolic-ref -q HEAD >/dev/null; then
    die "detached HEAD (checkout local/fork-config)"
  fi

  require_clean

  if ! git rev-parse --verify --quiet "$REF_BASE" >/dev/null; then
    die "refs/fork/last-base missing — run: git update-ref refs/fork/last-base <origin/dev sha>"
  fi

  printf 'preflight: ok\n'
}

cmd_sync() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo
  cmd_preflight "$@"
  require_branch "$BR_TOP" "sync must run from $BR_TOP"
  require_ref "$BR_SERIES"
  assert_series_state

  git update-ref -m "fork sync: pre-rebase series tip" "$REF_PRE" "$(git rev-parse "$BR_SERIES")"

  if ! git fetch origin --prune; then
    die "sync: fetch failed"
  fi

  # --empty=stop stops on a commit that became empty instead of silently dropping it;
  # --reapply-cherry-picks stops git from preemptively dropping a patch that landed
  # upstream, so that case surfaces as an empty commit for a human decision.
  if ! git -c rebase.autoStash=false rebase --update-refs --empty=stop --reapply-cherry-picks "$UPSTREAM"; then
    abort_rebase_if_any
    die "sync: rebase failed — rebase aborted; refs/fork/pre-rebase holds the pre-sync series tip; resolve conflicts with raw git rebase per draft §7.1, then re-run"
  fi

  # Postconditions, all asserted before last-base moves. assert_series_state is
  # deliberately not used here: it is defined against the old last-base.
  require_clean "sync: postcondition failed — worktree dirty after rebase"
  if ! git merge-base --is-ancestor "$UPSTREAM" HEAD; then
    die "sync: postcondition failed — origin/dev is not an ancestor of HEAD"
  fi
  if ! git merge-base --is-ancestor "$UPSTREAM" "$BR_SERIES"; then
    die "sync: postcondition failed — the series branch was not rebased onto origin/dev"
  fi
  local n
  n=$(git rev-list --count "$UPSTREAM..$BR_SERIES")
  if [ "$n" != "$FORK_SERIES_COUNT" ]; then
    die "sync: postcondition failed — series has $n commits on origin/dev, expected $FORK_SERIES_COUNT"
  fi

  git update-ref -m "fork sync: base" "$REF_BASE" "$(git rev-parse "$UPSTREAM")"
  printf 'sync: ok base=%s series=%s top=%s\n' \
    "$(git rev-parse "$REF_BASE")" "$(git rev-parse "$BR_SERIES")" "$(git rev-parse HEAD)"
}

cmd_verify() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo
  require_clean
  if ! git merge-base --is-ancestor "$UPSTREAM" HEAD; then
    die "verify: origin/dev is not an ancestor of HEAD"
  fi
  require_ref "$REF_BASE"
  require_ref "$REF_GREEN"
  require_ref "$REF_BUILD"
  require_ref "$BR_SERIES"
  assert_series_state
  if ! git merge-base --is-ancestor "$REF_GREEN" "$REF_BUILD"; then
    die "verify: last-green is not an ancestor of last-build"
  fi

  local green_count lag
  if git merge-base --is-ancestor "$REF_BASE" "$REF_GREEN"; then
    green_count=$(git rev-list --count "$REF_BASE..$REF_GREEN")
    if [ "$green_count" != "$FORK_SERIES_COUNT" ]; then
      die "verify: green point has $green_count commits on refs/fork/last-base, expected $FORK_SERIES_COUNT"
    fi
    if [ "$(git rev-parse "$REF_GREEN")" != "$(git rev-parse "$BR_SERIES")" ]; then
      lag=$(git rev-list --count "$REF_GREEN..$BR_SERIES")
      note "green point lags the series tip by $lag commits — run mark-green after a passing build"
    fi
    printf 'verify: OK (green point fresh: last-green %s, last-build %s)\n' \
      "$(git rev-parse --short=10 "$REF_GREEN")" "$(git rev-parse --short=10 "$REF_BUILD")"
  else
    # Normal state between sync and mark-green. A stale green point is not an error;
    # only the ancestry test detects it (the commit count is 3 in both states).
    printf 'verify: OK (postcondition); green point STALE — run mark-green after a passing build\n'
  fi
}

cmd_export() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo
  require_ref "$REF_BASE"
  require_ref "$REF_GREEN"
  require_ref "$BR_SERIES"

  if [ "$(git rev-parse "$REF_GREEN")" != "$(git rev-parse "$BR_SERIES")" ]; then
    die "refs/fork/last-green ($(git rev-parse --short=10 "$REF_GREEN")) is not the series tip ($(git rev-parse --short=10 "$BR_SERIES")) — run verify, then mark-green after a passing build"
  fi
  if ! git merge-base --is-ancestor "$REF_BASE" "$REF_GREEN"; then
    die "refs/fork/last-green does not descend from refs/fork/last-base"
  fi

  local n stray leaked dir cnt
  n=$(git rev-list --count "$REF_BASE..$REF_GREEN")
  if [ "$n" != "$FORK_SERIES_COUNT" ]; then
    die "export range has $n commits, expected $FORK_SERIES_COUNT — refusing to export a range that is not exactly the patch series"
  fi

  # Primary guard: the exported range must be entirely upstreamable code.
  stray=$(git diff --name-only "$REF_BASE..$REF_GREEN" | grep -vE "^$FORK_ALLOWED_PREFIX" || true)
  if [ -n "$stray" ]; then
    die "series touches paths outside $FORK_ALLOWED_PREFIX: $stray — the local layer must never be exported"
  fi

  # Second layer, not the primary guard: a deny-list misses most of the local layer.
  leaked=$(git diff --name-only "$REF_BASE..$REF_GREEN" | grep -E '^(AGENTS\.md|script/fork/|docs/adr/|\.gitignore$)' || true)
  if [ -n "$leaked" ]; then
    die "series contains local-layer paths: $leaked — the local layer must never be exported"
  fi

  dir="$repo_root/$PATCH_DIR"
  case "$dir" in
    "$repo_root"/.tmp/*) : ;;
    *) die "refusing to write outside .tmp/ ($dir)" ;;
  esac

  mkdir -p "$dir"
  find "$dir" -maxdepth 1 -name '*.patch' -delete
  git format-patch --no-signature --zero-commit --output-directory "$dir" "$REF_BASE..$REF_GREEN" >/dev/null

  cnt=$(find "$dir" -maxdepth 1 -name '*.patch' | wc -l | tr -d ' ')
  if [ "$cnt" != "$FORK_SERIES_COUNT" ]; then
    die "export produced $cnt patches, expected $FORK_SERIES_COUNT"
  fi
  printf 'export: %s patches in %s\n' "$cnt" "$PATCH_DIR"
  ls -1 "$dir"
}

cmd_drift() {
  local apply conflicts rc out p total ok failed
  apply=0
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    --apply)
      apply=1
      shift
      case "${1:-}" in
        -h|--help) usage 0 ;;
        "") : ;;
        *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
      esac
      ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo
  require_ref "$UPSTREAM"
  require_ref "$REF_BASE"
  require_ref "$REF_GREEN"

  conflicts=0
  set +e
  out=$(git merge-tree --write-tree --merge-base="$UPSTREAM" "$UPSTREAM" "$REF_GREEN" 2>&1)
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    printf 'drift: clean (merge-tree: no conflicts)\n'
  elif [ "$rc" = 1 ]; then
    printf 'drift: conflicts predicted:\n'
    printf '%s\n' "$out" | sed -n '2,$p'
    conflicts=1
  else
    die "merge-tree failed (rc=$rc): $out"
  fi

  if [ "$apply" != 1 ]; then
    return 0
  fi
  if [ "$conflicts" != 0 ]; then
    return 1
  fi

  # Tier 2: rehearse the patch series on a throwaway worktree at origin/dev.
  # Both variables are initialised before the trap is installed: under `set -u` an
  # unset variable inside the trap would mask the verb's real exit status.
  probe=""
  patches=""
  trap 'cleanup_probe "${probe:-}"; cleanup_probe "${patches:-}"' EXIT INT TERM

  probe=$(new_probe_dir drift)
  git worktree add -q --detach "$probe" "$UPSTREAM" >/dev/null
  patches=$(new_probe_dir patches)
  git format-patch --no-signature --zero-commit --output-directory "$patches" "$REF_BASE..$REF_GREEN" >/dev/null

  total=0
  ok=0
  failed=0
  for p in "$patches"/*.patch; do
    total=$((total + 1))
    # Absolute patch paths: `-C` changes the child's cwd, so a relative path breaks.
    if git -C "$probe" apply --check "$p" && git -C "$probe" apply "$p"; then
      ok=$((ok + 1))
    else
      printf 'drift: DOES NOT APPLY: %s\n' "$p"
      failed=1
      break
    fi
  done
  if [ "$failed" = 1 ]; then
    exit 1
  fi
  printf 'drift: apply-check %s/%s patches apply to origin/dev\n' "$ok" "$total"
}

cmd_mark_green() {
  case "${1:-}" in
    -h|--help) usage 0 ;;
    "") : ;;
    *) printf 'fork: unexpected argument: %s\n' "$1" >&2; usage 2 ;;
  esac

  require_repo
  require_clean
  if ! git merge-base --is-ancestor "$UPSTREAM" HEAD; then
    die "mark-green: origin/dev is not an ancestor of HEAD"
  fi
  require_branch "$BR_TOP"
  assert_series_state
  if ! git merge-base --is-ancestor "$BR_SERIES" HEAD; then
    die "mark-green: series tip is not an ancestor of HEAD"
  fi

  local old_green old_build
  old_green=$(git rev-parse --verify --quiet "$REF_GREEN" || printf '(none)')
  old_build=$(git rev-parse --verify --quiet "$REF_BUILD" || printf '(none)')

  git update-ref -m "fork mark-green: series tip" "$REF_GREEN" "$(git rev-parse "$BR_SERIES")"
  git update-ref -m "fork mark-green: built tip" "$REF_BUILD" "$(git rev-parse HEAD)"

  printf 'mark-green: last-green %s -> %s\n' "$old_green" "$(git rev-parse "$REF_GREEN")"
  printf 'mark-green: last-build %s -> %s\n' "$old_build" "$(git rev-parse "$REF_BUILD")"
  note "mark-green is only meaningful after a passing build; the script cannot verify that"
}

verb=${1:-}
case "$verb" in
  status|preflight|sync|verify|export|drift|mark-green)
    shift
    "cmd_${verb//-/_}" "$@"
    ;;
  -h|--help|help) usage 0 ;;
  "") usage 2 ;;
  *)
    printf 'fork: unknown verb: %s\n' "$verb" >&2
    usage 2
    ;;
esac
