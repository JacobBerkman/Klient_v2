#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="main"
WORK_BRANCH="work"
ARTIFACT_PATH="artifacts/main-parity.json"

mkdir -p "$(dirname "${ARTIFACT_PATH}")"

git fetch origin "${TARGET_BRANCH}:refs/remotes/origin/${TARGET_BRANCH}"

if ! git show-ref --verify --quiet "refs/heads/${TARGET_BRANCH}"; then
  git branch "${TARGET_BRANCH}" "origin/${TARGET_BRANCH}"
fi

git fetch origin "${TARGET_BRANCH}:${TARGET_BRANCH}" >/dev/null 2>&1 || true

bash scripts/verify-main-merge.sh "${TARGET_BRANCH}" || true

if ! git show-ref --verify --quiet "refs/heads/${WORK_BRANCH}"; then
  echo "ERROR: Local branch '${WORK_BRANCH}' does not exist."
  exit 2
fi

merge_base="$(git merge-base "${WORK_BRANCH}" "${TARGET_BRANCH}")"

behind_count="$(git rev-list --count "${WORK_BRANCH}..${TARGET_BRANCH}")"
ahead_count="$(git rev-list --count "${TARGET_BRANCH}..${WORK_BRANCH}")"

mapfile -t missing_commits < <(git rev-list "${WORK_BRANCH}..${TARGET_BRANCH}")

python3 - "${ARTIFACT_PATH}" "${WORK_BRANCH}" "${TARGET_BRANCH}" "${merge_base}" "${ahead_count}" "${behind_count}" "${missing_commits[@]}" <<'PY'
import json
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1])
work_branch = sys.argv[2]
main_branch = sys.argv[3]
merge_base = sys.argv[4]
ahead_count = int(sys.argv[5])
behind_count = int(sys.argv[6])
missing = sys.argv[7:]

payload = {
    "workBranch": work_branch,
    "mainBranch": main_branch,
    "mergeBase": merge_base,
    "aheadCount": ahead_count,
    "behindCount": behind_count,
    "missingCommitShas": missing,
}
artifact.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

if [[ "${behind_count}" -gt 0 ]]; then
  echo "MISSING: '${WORK_BRANCH}' is behind '${TARGET_BRANCH}' by ${behind_count} commit(s)."
  exit 1
fi

echo "OK: '${WORK_BRANCH}' is fully merged with '${TARGET_BRANCH}'."
