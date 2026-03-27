#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="${1:-main}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "INFO: Git metadata unavailable; skipping merge/main parity check in non-Git workspace."
  exit 0
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if ! git show-ref --verify --quiet "refs/heads/${TARGET_BRANCH}"; then
  echo "ERROR: Local branch '${TARGET_BRANCH}' does not exist."
  echo "Next task: create or fetch it (for example: git fetch origin ${TARGET_BRANCH}:${TARGET_BRANCH})."
  exit 2
fi

if git merge-base --is-ancestor "${TARGET_BRANCH}" HEAD; then
  echo "OK: '${TARGET_BRANCH}' is fully merged into '${current_branch}'."
else
  echo "MISSING: '${current_branch}' is missing commits from '${TARGET_BRANCH}'."
  echo "Next task: merge or rebase '${TARGET_BRANCH}' into '${current_branch}'."
  exit 1
fi

if git merge-base --is-ancestor HEAD "${TARGET_BRANCH}"; then
  echo "INFO: '${current_branch}' has no unmerged commits relative to '${TARGET_BRANCH}'."
else
  echo "INFO: '${current_branch}' has commits not yet merged into '${TARGET_BRANCH}'."
  echo "Next task: open/complete a PR from '${current_branch}' to '${TARGET_BRANCH}'."
fi
