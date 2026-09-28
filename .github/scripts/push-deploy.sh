#!/usr/bin/env bash
# Commits the pinned manifests and lands the commit on the deploy branch (#210).
#
# Expects the pin step to have already rewritten infra/k8s. Reads:
#   REGISTRY, NAMESPACE      image repository prefix
#   GITHUB_SHA               the commit the images were built from
#   GITHUB_REF_NAME          the branch to push (main)
#   GITHUB_REPOSITORY, GH_TOKEN   for the compare API
#   PINNED                   space-separated images the pin step rewrote
#   DIGESTS_DIR              one file per image holding its digest
#   GITHUB_OUTPUT            where `pushed` and `pinned` are written
#
# ⚠ A REJECTED PUSH IS NOT REBASED ANY MORE; IT IS PINNED AGAIN. The pin commit
# only rewrites image lines, and a second deploy commit for the same image
# rewrites the SAME lines - so a rebase conflicted every time two merges landed
# close together, and the second merge built fine and never deployed. Resetting
# to the new head and re-running the rewrite cannot conflict.
#
# ⚠ AND AN IMAGE ALREADY PINNED AT A NEWER COMMIT IS LEFT ALONE. Runs are
# serialised per branch, but a manual dispatch or a slow retry can still finish
# after a newer run; overwriting its pin would roll production back to older
# code. "Newer" is "contains this run's commit", asked of GitHub because the
# checkout is shallow.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${GITHUB_OUTPUT:-/dev/null}"
read -r -a images <<<"${PINNED:-}"

# The compare API's status of `head` relative to `base`: ahead, behind,
# identical or diverged. Overridable so the loop can be exercised locally.
compare_status() {
  if [[ -n "${DEPLOY_COMPARE:-}" ]]; then
    "$DEPLOY_COMPARE" "$1" "$2"
    return
  fi
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/compare/$1...$2" |
    jq -r .status
}

commit() {
  git add -- infra/k8s
  if git diff --cached --quiet; then return 1; fi
  git commit -q -m "chore(deploy): pin $* at ${GITHUB_SHA:0:7} [skip ci]"
}

done_with() {
  echo "pushed=$1" >>"$out"
  echo "pinned=${*:2}" >>"$out"
  exit 0
}

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if ! commit "${images[@]}"; then
  echo "Manifests already reference these digests - nothing to deploy."
  # ⚠ RECORDED, BECAUSE THE VERIFY STEP MUST NOT RUN. With no new commit there
  # is nothing for Argo to move to, so waiting for one would spend the whole
  # timeout and then report a failed rollout for a deploy that correctly did
  # nothing.
  done_with false
fi

for attempt in 1 2 3 4 5; do
  if git push -q origin "HEAD:${GITHUB_REF_NAME}"; then
    echo "Pushed on attempt ${attempt}: ${images[*]}"
    done_with true "${images[@]}"
  fi

  echo "Push rejected - pinning again on top of origin/${GITHUB_REF_NAME}."
  git fetch -q origin "${GITHUB_REF_NAME}"
  git reset -q --hard "origin/${GITHUB_REF_NAME}"

  wanted=()
  for image in "${images[@]}"; do
    upstream=$(git grep -h -o -E "${REGISTRY}/${NAMESPACE}/${image}:prod-[0-9a-f]{40}" HEAD -- infra/k8s |
      head -1 | sed -E 's/.*:prod-//' || true)
    if [[ -n "$upstream" ]]; then
      status=$(compare_status "$GITHUB_SHA" "$upstream")
      if [[ "$status" == "ahead" || "$status" == "identical" ]]; then
        echo "  ${image}: already pinned at ${upstream:0:7}, which contains ${GITHUB_SHA:0:7} - left alone."
        continue
      fi
    fi
    wanted+=("$image")
  done

  if ((${#wanted[@]} == 0)); then
    echo "Every image is already pinned at this commit or a newer one - nothing to deploy."
    done_with false
  fi

  for image in "${wanted[@]}"; do
    python3 "$here/pin-image.py" "${REGISTRY}/${NAMESPACE}/${image}" \
      "${REGISTRY}/${NAMESPACE}/${image}:prod-${GITHUB_SHA}@$(cat "${DIGESTS_DIR}/${image}")"
  done
  images=("${wanted[@]}")

  if ! commit "${images[@]}"; then
    echo "Manifests on the new head already reference these digests - nothing to deploy."
    done_with false
  fi
done

echo "::error::Could not push the deploy commit after 5 attempts."
exit 1
