#!/usr/bin/env bash
#
# Did the commit CI just pushed actually reach production, and is it healthy?
#
# ⚠ THIS EXISTS BECAUSE "PUSHED" AND "DEPLOYED" WERE THE SAME SENTENCE IN THE
# WORKFLOW SUMMARY AND ARE NOT THE SAME EVENT. CI pinned the digests, pushed,
# and declared the rollout done — while Argo had not yet polled, the image had
# not been pulled, and nothing had started. Every failure after that point was
# invisible to the pipeline: a bad manifest, a missing secret, an
# ImagePullBackOff, a container that crashlooped on a config error. The first
# anybody knew was opening the site.
#
# ⚠ IT RUNS ON THE BOX, NOT ON THE RUNNER, BECAUSE THE CONTROL PLANE IS NOT
# EXPOSED. `argocd-server` is a ClusterIP with no ingress and the Kubernetes API
# is not public — deliberately. The alternative is publishing one of them to the
# internet so a CI runner can call it, which trades a lot of attack surface for
# a convenience. SSH is already open and already audited.
#
# ⚠ AND IT IS THE FORCED COMMAND FOR CI'S KEY. `authorized_keys` pins this
# script with `command=`, so the key GitHub holds cannot open a shell, read a
# secret or change a workload — it can ask this one question and read the
# answer. See infra/scripts/README.md.
#
# Usage:  verify-rollout.sh <40-hex-sha> [comma,separated,image,names]

set -uo pipefail

# ⚠ NOT `set -e`. Almost every command here is a probe whose failure IS the
# information being gathered; exiting on the first non-zero would report one
# slow rollout as a hard failure and skip every remaining check.

# ⚠ SET EXPLICITLY, BECAUSE k3s's `kubectl` IGNORES `~/.kube/config` BY DEFAULT.
# The binary at /usr/local/bin/kubectl is k3s, which points itself at
# /etc/rancher/k3s/k3s.yaml unless KUBECONFIG says otherwise — and that file is
# root-only. The CI user has its own client certificate and its own config, so
# without this line every kubectl below fails with "permission denied", each one
# into /dev/null, and the script reports a rollout that never came up rather than
# a credential that was never read. An hour to find, one line to fix.
#
# ⚠ `${KUBECONFIG:-...}` RATHER THAN AN ASSIGNMENT, so running this by hand as a
# human with a working kubeconfig still does what you expect.
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

NAMESPACE="${I10_NAMESPACE:-i10-prod}"
APP="${I10_APP:-i10-workloads}"

# ⚠ THE BUDGETS ARE SPLIT, BECAUSE THE TWO WAITS FAIL FOR DIFFERENT REASONS.
# Argo not syncing is a control-plane problem; pods not becoming ready is an
# application problem. One combined timeout would report whichever happened to
# run out and send somebody to look in the wrong place.
SYNC_TIMEOUT="${I10_SYNC_TIMEOUT:-180}"
ROLLOUT_TIMEOUT="${I10_ROLLOUT_TIMEOUT:-240}"

# ── the argument ─────────────────────────────────────────────────────────────

# ⚠ READ FROM `SSH_ORIGINAL_COMMAND` WHEN THERE IS ONE, because that is where a
# forced command finds what the client asked for — and it is validated to
# characters that cannot form a command. A forced command that interpolated an
# unvalidated string would be a remote shell with extra steps.
RAW="${*:-${SSH_ORIGINAL_COMMAND:-}}"
SAFE="$(printf '%s' "$RAW" | tr -dc '0-9a-z, -')"

SHA="$(printf '%s' "$SAFE" | awk '{print $1}' | tr -dc '0-9a-f' | head -c 40)"
IMAGES="$(printf '%s' "$SAFE" | awk '{print $2}' | tr -dc '0-9a-z,-')"

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "verify-rollout: expected a 40-character commit sha, got: ${RAW:0:60}" >&2
  exit 2
fi

SHORT="${SHA:0:7}"
echo "verify-rollout: waiting for ${SHORT} in ${NAMESPACE}"

# ── 1. make Argo look now ────────────────────────────────────────────────────

# ⚠ THIS IS WHY THE WAIT IS SECONDS RATHER THAN MINUTES. Argo polls git every
# three minutes by default, so without a nudge most of every deploy was spent in
# a queue nobody could see. The annotation asks for a reconcile immediately;
# `hard` also drops the manifest cache, which matters because a commit that
# changes only an image line can otherwise be served from it.
kubectl annotate application "$APP" -n "$NAMESPACE" \
  argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1

# ── 2. wait for the revision to be synced and healthy ────────────────────────

deadline=$((SECONDS + SYNC_TIMEOUT))
revision="" sync="" health="" synced=false

while (( SECONDS < deadline )); do
  read -r revision sync health < <(
    kubectl get application "$APP" -n "$NAMESPACE" -o \
      jsonpath='{.status.sync.revision} {.status.sync.status} {.status.health.status}' \
      2>/dev/null
  )

  if [[ "$revision" == "$SHA" && "$sync" == "Synced" && "$health" == "Healthy" ]]; then
    synced=true
    break
  fi
  sleep 5
done

if [[ "$synced" != true ]]; then
  echo "verify-rollout: FAILED — Argo did not reach ${SHORT}" >&2
  echo "  revision: ${revision:-<none>}" >&2
  echo "  sync:     ${sync:-<none>}" >&2
  echo "  health:   ${health:-<none>}" >&2
  # ⚠ THE CONDITIONS ARE WHERE THE REASON ACTUALLY IS. "OutOfSync" says nothing;
  # "ComparisonError: unable to resolve revision" says everything.
  kubectl get application "$APP" -n "$NAMESPACE" -o \
    jsonpath='{range .status.conditions[*]}  {.type}: {.message}{"\n"}{end}' >&2 2>&1
  exit 1
fi

echo "verify-rollout: Argo is synced to ${SHORT} and healthy"

# ── 3. wait for every rollout ────────────────────────────────────────────────

failed=()

while read -r deploy; do
  [[ -z "$deploy" ]] && continue

  if kubectl rollout status "deployment/${deploy}" -n "$NAMESPACE" \
      --timeout="${ROLLOUT_TIMEOUT}s" >/dev/null 2>&1; then
    echo "  ok       ${deploy}"
    continue
  fi

  echo "  FAILED   ${deploy}" >&2
  # ⚠ THE CONTAINER'S OWN STATE, NOT THE DEPLOYMENT'S. `ImagePullBackOff`,
  # `CreateContainerConfigError` and a crashloop are indistinguishable from the
  # deployment; the container status is the only place they differ, and they
  # have nothing in common as fixes.
  kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/name=${deploy}" \
    -o jsonpath='{range .items[*]}    {.metadata.name}  {range .status.containerStatuses[*]}{.state}{end}{"\n"}{end}' >&2 2>&1
  failed+=("$deploy")
done < <(
  kubectl get deployments -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null
)

if (( ${#failed[@]} > 0 )); then
  echo "verify-rollout: FAILED — not ready: ${failed[*]}" >&2
  exit 1
fi

# ── 4. prove the new build is the one running ────────────────────────────────

# ⚠ ARGO BEING SYNCED IS NOT PROOF THE NEW IMAGE IS SERVING. `Synced` compares
# the manifest to the cluster; a deployment whose pods are still the previous
# generation satisfies it for the moments before the rollout starts, and
# `rollout status` above returns immediately for a deployment nothing changed.
# Asserting the tag is what makes this a check rather than a pause.
#
# ⚠ AND IT IS SKIPPED WHEN NO IMAGE WAS REBUILT, which is most infrastructure
# commits. A deploy that only edits a manifest pins no new tag, so demanding one
# would fail every such change — the caller says what it built.
if [[ -n "$IMAGES" ]]; then
  missing=()
  IFS=',' read -ra wanted <<< "$IMAGES"
  for image in "${wanted[@]}"; do
    [[ -z "$image" ]] && continue
    if kubectl get pods -n "$NAMESPACE" \
        -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null \
        | grep -q "/${image}:prod-${SHA}@"; then
      echo "  ok       ${image} is running prod-${SHORT}"
    else
      echo "  FAILED   ${image} is not running prod-${SHORT}" >&2
      missing+=("$image")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    echo "verify-rollout: FAILED — stale images: ${missing[*]}" >&2
    exit 1
  fi
fi

echo "verify-rollout: ${SHORT} is live and healthy"
exit 0
