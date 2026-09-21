#!/usr/bin/env bash
#
# Did the commit CI just pushed actually reach production, and did it come up?
#
# ⚠ "DID IT COME UP" RATHER THAN "IS EVERYTHING HEALTHY", AND THE DIFFERENCE IS
# LOAD-BEARING — see §2. This answers for the rollout it was given a sha for; it
# does not answer for the Application as a whole, because Argo's aggregate
# health folds in every failed CronJob Job and one of those blocked every deploy
# for reasons no deploy could fix.
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
# Usage:  verify-rollout.sh <argo-revision-sha> [images] [image-tag-sha]
#
# `argo-revision-sha` is the DEPLOY commit Argo must reach; `image-tag-sha` is
# the commit the images are TAGGED with. They differ — see the note by
# IMAGE_SHA — and conflating them made §4 unpassable.

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

# ⚠ EVERY APP THAT CAN CARRY A BUILT IMAGE, NOT JUST THE ONE WE WAIT ON. CI
# rebuilds `i10-authd`, whose only deployment is a SIDECAR in the Stalwart
# StatefulSet — which belongs to the `i10-stalwart` Application, not to
# `i10-workloads`. So §4 asserted an image owned by an app this script never
# refreshed and never waited for, and failed on a race it had no part in.
#
# ⚠ THEY ARE NUDGED BUT NOT GATED ON. Requiring every app to reach `Synced`
# would re-couple this check to unrelated failures — exactly what §2 stopped
# doing. Refreshing them costs nothing, removes the three-minute wait, and §3
# then waits for the workloads themselves, which is the honest bar.
APPS="${I10_APPS:-$APP i10-stalwart}"

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

# ⚠ A THIRD ARGUMENT, BECAUSE THE TWO SHAS ARE NOT THE SAME COMMIT AND §4 HAD
# BEEN COMPARING THE WRONG ONE SINCE IT WAS WRITTEN. Argo syncs to the DEPLOY
# commit — the one CI creates when it pins the digests — while the images are
# tagged `prod-${GITHUB_SHA}`, the MERGE commit that triggered the build. The
# deploy commit always comes after, so `prod-<deploy sha>` is a tag that does
# not exist and never will.
#
# ⚠ THE EFFECT WAS A CHECK THAT COULD NOT PASS. §4 reported "stale images" on
# every single deploy, including ones where exactly the right image was running
# — which is indistinguishable, in the job summary, from a rollout that really
# did not land. Two failing checks were hiding each other.
#
# ⚠ IT DEFAULTS TO `SHA` SO AN OLD CALLER STILL WORKS, and a deployment that
# genuinely tags by the deploy commit needs no change.
IMAGE_SHA="$(printf '%s' "$SAFE" | awk '{print $3}' | tr -dc '0-9a-f' | head -c 40)"
IMAGE_SHA="${IMAGE_SHA:-$SHA}"

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
for app in $APPS; do
  kubectl annotate application "$app" -n "$NAMESPACE" \
    argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1
done

# ── 2. wait for the revision to be synced ────────────────────────────────────

# ⚠ THIS WAITS FOR `Synced`, NOT FOR `Healthy`, AND THAT NARROWING IS
# DELIBERATE. Argo's app health is the WORST health of every resource it owns,
# and that set includes the CronJobs — so one failed Job holds the whole
# Application at `Degraded` until its history rolls over. `i10-billing-reconcile`
# has been failing every thirty minutes on three Polar subscriptions that no
# code change can fix, which made this check fail EVERY deploy, for a reason
# that had nothing to do with the deploy.
#
# ⚠ AND A CHECK THAT IS RED ON EVERY RUN IS NOT A CHECK. It is the same failure
# the tofu workflow records: people stop reading it, and the next real failure
# goes with it. The protection has to be about THIS rollout to keep its meaning.
#
# ⚠ WHAT IS NOT GIVEN UP IS THE PART THAT CATCHES A BROKEN DEPLOY. Three checks
# remain and each is specific to what just shipped: the revision below is the
# deploy commit and nothing else; §3 waits for every Deployment to finish
# rolling, which is what catches a crashloop, an ImagePullBackOff or a bad
# config; and §4 asserts the new tag is in a live pod spec. Both of today's
# broken images — the ones whose entrypoints had moved to `dist/src/` — were
# caught by §3 and §4, not by aggregate health.
#
# ⚠ HEALTH IS STILL READ AND STILL REPORTED, one line below, because a Degraded
# Application is worth knowing about even when it is not this deploy's fault.
# It is a warning here and an error nowhere.
deadline=$((SECONDS + SYNC_TIMEOUT))
revision="" sync="" health="" synced=false

while (( SECONDS < deadline )); do
  read -r revision sync health < <(
    kubectl get application "$APP" -n "$NAMESPACE" -o \
      jsonpath='{.status.sync.revision} {.status.sync.status} {.status.health.status}' \
      2>/dev/null
  )

  if [[ "$revision" == "$SHA" && "$sync" == "Synced" ]]; then
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

echo "verify-rollout: Argo is synced to ${SHORT}"

if [[ "$health" != "Healthy" ]]; then
  # ⚠ TO STDOUT AND NOT stderr, AND IT DOES NOT SET A FAILURE. This is the line
  # that keeps the fact visible now that it no longer blocks: something in the
  # Application is unwell, and it is somebody's job — just not this job's, and
  # not this deploy's fault.
  echo "verify-rollout: WARNING — the Application is ${health}, which this deploy"
  echo "  did not necessarily cause. Not failing on it; the rollout checks below"
  echo "  are what decide. Worth looking at:"
  kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null \
    | grep -vE 'Running|Completed' | head -10 | sed 's/^/    /'
fi

# ── 3. wait for every rollout ────────────────────────────────────────────────

failed=()

# ⚠ STATEFULSETS AND DAEMONSETS TOO, NOT ONLY DEPLOYMENTS. The list used to be
# `kubectl get deployments`, which silently skipped Stalwart — the StatefulSet
# that carries the `i10-authd` sidecar. §4 then asserted that image was running
# at the new tag having never waited for the thing that rolls it, so a deploy
# that rebuilt authd failed on timing rather than on anything being wrong.
#
# ⚠ `kubectl rollout status` TAKES THE KIND IN THE ARGUMENT, so the loop reads
# `kind/name` and passes it through unchanged. Hard-coding `deployment/` is what
# made the omission invisible: the names came from one query and the kind from
# somewhere else, and nothing connected them.
while read -r target; do
  [[ -z "$target" ]] && continue
  name="${target#*/}"

  if kubectl rollout status "$target" -n "$NAMESPACE" \
      --timeout="${ROLLOUT_TIMEOUT}s" >/dev/null 2>&1; then
    echo "  ok       ${target}"
    continue
  fi

  echo "  FAILED   ${target}" >&2
  # ⚠ THE CONTAINER'S OWN STATE, NOT THE DEPLOYMENT'S. `ImagePullBackOff`,
  # `CreateContainerConfigError` and a crashloop are indistinguishable from the
  # deployment; the container status is the only place they differ, and they
  # have nothing in common as fixes.
  kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/name=${name}" \
    -o jsonpath='{range .items[*]}    {.metadata.name}  {range .status.containerStatuses[*]}{.state}{end}{"\n"}{end}' >&2 2>&1
  failed+=("$target")
done < <(
  kubectl get deployments,statefulsets,daemonsets -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.kind}/{.metadata.name}{"\n"}{end}' 2>/dev/null \
    | tr '[:upper:]' '[:lower:]'
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
        | grep -q "/${image}:prod-${IMAGE_SHA}@"; then
      echo "  ok       ${image} is running prod-${IMAGE_SHA:0:7}"
    else
      echo "  FAILED   ${image} is not running prod-${IMAGE_SHA:0:7}" >&2
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
