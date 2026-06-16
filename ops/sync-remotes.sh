#!/usr/bin/env bash
set -Eeuo pipefail

BRANCH="${PATRICK_IM_BRANCH:-main}"
GITHUB_REMOTE="${PATRICK_IM_GITHUB_REMOTE:-github}"
GITEE_REMOTE="${PATRICK_IM_GITEE_REMOTE:-old-gitee}"
SKIP_GITHUB="${PATRICK_IM_SKIP_GITHUB:-0}"
WORKTREE_DIR=""
GITEE_EXPECTED=""

GITHUB_INSTALL_URL="https://raw.githubusercontent.com/baisuipingan/patrick-im/main/ops/install.sh"
GITHUB_COMPOSE_URL="https://raw.githubusercontent.com/baisuipingan/patrick-im/main/ops/docker-compose.yml"
GITEE_INSTALL_URL="https://gitee.com/cai-happy/patrickim/raw/main/ops/install.sh"
GITEE_COMPOSE_URL="https://gitee.com/cai-happy/patrickim/raw/main/ops/docker-compose.yml"

cleanup() {
  if [[ -n "${WORKTREE_DIR}" && -d "${WORKTREE_DIR}" ]]; then
    git worktree remove --force "${WORKTREE_DIR}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree is not clean; commit or stash changes before syncing remotes" >&2
    exit 1
  fi
}

replace_links_for_gitee() {
  local path="$1"
  perl -0pi -e "s#\Q${GITHUB_INSTALL_URL}\E#${GITEE_INSTALL_URL}#g; s#\Q${GITHUB_COMPOSE_URL}\E#${GITEE_COMPOSE_URL}#g" \
    "${path}/README.md" \
    "${path}/ops/install.sh"
}

require_clean_worktree
git rev-parse --verify "${BRANCH}" >/dev/null

echo "Pushing ${BRANCH} to ${GITHUB_REMOTE}..."
if [[ "${SKIP_GITHUB}" == "1" ]]; then
  echo "Skipping GitHub push because PATRICK_IM_SKIP_GITHUB=1."
else
  git push "${GITHUB_REMOTE}" "${BRANCH}:${BRANCH}"
fi

echo "Fetching ${BRANCH} from ${GITEE_REMOTE} for a safe mirror lease..."
git fetch "${GITEE_REMOTE}" "${BRANCH}:refs/remotes/${GITEE_REMOTE}/${BRANCH}" >/dev/null
GITEE_EXPECTED="$(git rev-parse "refs/remotes/${GITEE_REMOTE}/${BRANCH}")"

WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/patrick-im-gitee.XXXXXX")"
rmdir "${WORKTREE_DIR}"
git worktree add --detach "${WORKTREE_DIR}" "${BRANCH}"

replace_links_for_gitee "${WORKTREE_DIR}"

(
  cd "${WORKTREE_DIR}"
  git add README.md ops/install.sh
  if git diff --cached --quiet; then
    echo "No Gitee link replacements needed."
  else
    git commit -m "Use Gitee raw links for Gitee mirror"
  fi
  echo "Pushing Gitee mirror to ${GITEE_REMOTE}..."
  git push --force-with-lease="refs/heads/${BRANCH}:${GITEE_EXPECTED}" "${GITEE_REMOTE}" "HEAD:${BRANCH}"
)

echo "Synced ${BRANCH} to GitHub and Gitee."
