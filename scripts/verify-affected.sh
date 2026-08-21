#!/bin/sh
# The pre-push gate: the static guardrails, then typecheck and tests for the workspace
# packages this branch changed since its merge base with origin/main, plus every
# package that depends on one of them. A change in packages/core still runs the API
# suite; a docs-only or scripts-only branch runs no package tests and leaves that to
# CI, which always runs everything.
#
#   pnpm verify:affected          # run it
#   pnpm verify:affected --list   # print the packages it would run, and stop
#
# `pnpm verify` is the full gate, and what CI runs.
#
# The package set comes from `git diff` rather than pnpm's `--filter "...[ref]"`
# selector, which matched nothing from a linked worktree while git saw every change.
set -e
cd "$(dirname "$0")/.."

# Git exports GIT_DIR and friends into hooks, and a child git prefers them over its own
# working directory, so a test that shells out to git would run against this repo
# instead of its fixture. Scrub them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

list_only=false
if [ "$1" = "--list" ]; then list_only=true; fi

if ! git rev-parse --verify -q origin/main >/dev/null; then
  echo "verify:affected: no origin/main ref; running the full gate instead" >&2
  if $list_only; then exit 0; fi
  exec pnpm verify
fi
base=$(git merge-base HEAD origin/main)
changed=$(git diff --name-only "$base" HEAD)

# The pnpm selectors go in the positional parameters. A root dependency or tsconfig
# change affects every package; otherwise each changed apps/<name> or packages/<name>
# selects itself plus its dependents. Packages without the script are skipped by pnpm.
set --
if printf '%s\n' "$changed" | grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|patches/)'; then
  echo "verify:affected: root dependency or tsconfig change; every package is affected"
  set -- -r
else
  for dir in $(printf '%s\n' "$changed" | grep -E '^(apps|packages)/[^/]+/' | cut -d/ -f1,2 | sort -u); do
    set -- "$@" "--filter=...{$dir}"
  done
fi

if [ $# -eq 0 ]; then
  echo "verify:affected: no workspace package changed since $(git rev-parse --short "$base"); skipping typecheck and tests (CI still runs them)"
  if $list_only; then exit 0; fi
  exec pnpm run ci
fi

if $list_only; then
  echo "base: $(git rev-parse --short "$base")"
  exec pnpm "$@" exec node -e 'console.log("  " + require("./package.json").name)'
fi

pnpm run ci
pnpm "$@" typecheck
pnpm "$@" test
