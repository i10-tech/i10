#!/usr/bin/env bash
#
# Bring a Stalwart instance from "the pod is running" to "mail works".
#
# ⚠ THIS SCRIPT EXISTS BECAUSE ARGO CANNOT DO THIS PART. Everything under this
# directory is applied by Argo, but Stalwart's real configuration lives inside
# its own database and is reached over its management API — not through
# Kubernetes objects. `plan.ndjson` is carried into the pod by a ConfigMap and
# then does nothing at all until something applies it. This is that something.
#
# It is idempotent. Run it after any change to plan.ndjson, and run it on a
# fresh install. The one non-idempotent object it touches — the Tracer, which
# has no natural key to match on — is created only when absent.
#
#   ./bootstrap.sh              apply, reload, restart, verify
#   ./bootstrap.sh --verify     verify only, change nothing
#   ./bootstrap.sh --no-restart apply and reload, skip the restart
#
#   ./bootstrap.sh --set-submission-password
#                               prompt for the send worker's SMTP password and
#                               set it. Not part of a normal run: Stalwart keeps
#                               a hash, so there is nothing to converge on and
#                               re-setting it would invalidate Doppler's copy.
#
# ⚠ ON A GENUINELY FRESH INSTALL, READ config/README.md FIRST. The first
# administrator comes from STALWART_RECOVERY_ADMIN, which must already be in the
# i10-stalwart secret before this can authenticate at all. This script does not
# create it and cannot.
set -euo pipefail

NS="${NS:-i10-prod}"
POD="${POD:-i10-stalwart-0}"
SECRET="${SECRET:-i10-stalwart}"
CLI_IMAGE="${CLI_IMAGE:-ghcr.io/stalwartlabs/cli}"
SVC_URL="${SVC_URL:-http://i10-stalwart.${NS}.svc.cluster.local:8080}"
CONFIGMAP_PREFIX="i10-stalwart-config"

VERIFY_ONLY=false
RESTART=true
SET_SUBMISSION_PASSWORD=false
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY_ONLY=true ;;
    --no-restart) RESTART=false ;;
    --set-submission-password) SET_SUBMISSION_PASSWORD=true ;;
    -h | --help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die() {
  printf '   \033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

kubectl get pod -n "$NS" "$POD" >/dev/null 2>&1 ||
  die "pod $POD not found in $NS — is the StatefulSet synced?"

# ─────────────────────────────────────────────────────────────────────────────
# Credentials
#
# ⚠ SPLIT ON THE BOX, NEVER PASSED AS AN ARGUMENT. The secret holds
# "username:password" as one value; the CLI wants them separately. Both halves
# go into the pod through a temporary Secret rather than through `args`, because
# anything in argv is visible in `kubectl get pod -o yaml` to everyone with read
# access to the namespace.
# ─────────────────────────────────────────────────────────────────────────────
TMP_SECRET="stalwart-bootstrap-$$"
cleanup() {
  kubectl delete secret -n "$NS" "$TMP_SECRET" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete pod -n "$NS" -l "app.kubernetes.io/name=stalwart-bootstrap" \
    --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

raw=$(kubectl get secret -n "$NS" "$SECRET" -o jsonpath='{.data.STALWART_RECOVERY_ADMIN}' | base64 -d)
[ -n "$raw" ] || die "STALWART_RECOVERY_ADMIN is empty in secret/$SECRET"
case "$raw" in
  *:*) ;;
  *) die "STALWART_RECOVERY_ADMIN is not in username:password form" ;;
esac
CLI_USER="${raw%%:*}"
kubectl create secret generic "$TMP_SECRET" -n "$NS" \
  --from-literal=password="${raw#*:}" --dry-run=client -o yaml |
  kubectl apply -f - >/dev/null
unset raw

# ─────────────────────────────────────────────────────────────────────────────
# sw — run one stalwart-cli command in a throwaway pod.
#
# ⚠ restartPolicy: OnFailure IS LOAD-BEARING, AND THE REASON IS NOT OBVIOUS.
# The namespace runs a default-deny NetworkPolicy. kube-router builds its ipsets
# from a watch, so a pod that starts within a second or two of being created can
# reach nothing — the CLI fails with a bare connection error that looks like the
# server being down. OnFailure lets the container retry until the policy catches
# up, which takes one or two attempts. With `Never` this script fails
# intermittently and blames Stalwart.
#
# ⚠ AND THE IMAGE HAS NO SHELL. ghcr.io/stalwartlabs/cli is distroless: `args`
# must be the CLI's own arguments and nothing may be wrapped in `sh -c`.
# ─────────────────────────────────────────────────────────────────────────────
sw() {
  local name="sw-$RANDOM-$RANDOM"
  local args
  args=$(printf '"%s",' "$@")
  args="[${args%,}]"

  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  namespace: $NS
  labels: { app.kubernetes.io/name: stalwart-bootstrap }
spec:
  restartPolicy: OnFailure
  containers:
    - name: cli
      image: $CLI_IMAGE
      args: $args
      env:
        - { name: STALWART_URL, value: "$SVC_URL" }
        - { name: STALWART_USER, value: "$CLI_USER" }
        - name: STALWART_PASSWORD
          valueFrom: { secretKeyRef: { name: $TMP_SECRET, key: password } }
EOF

  local phase=""
  for _ in $(seq 1 40); do
    phase=$(kubectl get pod -n "$NS" "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [ "$phase" = "Succeeded" ] && break
    sleep 3
  done
  kubectl logs -n "$NS" "$name" 2>&1 || true
  kubectl delete pod -n "$NS" "$name" --ignore-not-found >/dev/null 2>&1 || true
  [ "$phase" = "Succeeded" ] || return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# sw_file — like sw, but the JSON payload comes from a mounted Secret.
#
# ⚠ THIS EXISTS SO A CREDENTIAL NEVER TRAVELS IN `args`. A pod's arguments live
# in its spec: readable by anything that can `get pod -o yaml`, logged by
# admission webhooks, and retained in the API server until the pod is reaped.
# `sw` builds its args from its parameters, so the moment a payload contains a
# secret it must not use it.
#
#   sw_file <Object> <id> <secret-name>   # the Secret holds key `payload.json`
# ─────────────────────────────────────────────────────────────────────────────
sw_file() {
  local object="$1" id="$2" secret="$3"
  local name="swf-$RANDOM-$RANDOM"

  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  namespace: $NS
  labels: { app.kubernetes.io/name: stalwart-bootstrap }
spec:
  restartPolicy: OnFailure
  volumes:
    - name: payload
      secret: { secretName: $secret }
  containers:
    - name: cli
      image: $CLI_IMAGE
      args: ["update", "$object", "$id", "--file", "/payload/payload.json"]
      volumeMounts:
        - { name: payload, mountPath: /payload, readOnly: true }
      env:
        - { name: STALWART_URL, value: "$SVC_URL" }
        - { name: STALWART_USER, value: "$CLI_USER" }
        - name: STALWART_PASSWORD
          valueFrom: { secretKeyRef: { name: $TMP_SECRET, key: password } }
EOF

  local phase=""
  for _ in $(seq 1 40); do
    phase=$(kubectl get pod -n "$NS" "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [ "$phase" = "Succeeded" ] || [ "$phase" = "Failed" ] && break
    sleep 3
  done

  # ⚠ THE LOG IS NOT PRINTED ON SUCCESS. `update` echoes the object back, and for
  # a credential that means the value we just set — into a terminal, a CI log and
  # whatever scrapes them. Only the failure path is shown, and Stalwart's errors
  # name the property rather than quoting it.
  if [ "$phase" != "Succeeded" ]; then
    kubectl logs -n "$NS" "$name" 2>&1 | sed 's/^/   /'
  fi
  kubectl delete pod -n "$NS" "$name" --ignore-not-found >/dev/null 2>&1

  [ "$phase" = "Succeeded" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# Verification — used at the end, and on its own with --verify.
# ─────────────────────────────────────────────────────────────────────────────
verify() {
  local failures=0

  say "Verifying"

  # ⚠ THE CONTAINER HAS NO openssl AND ITS /bin/sh IS BUSYBOX. No `/dev/tcp`
  # either — that is a bash feature. Both checks below are written against what
  # the image actually ships: nc and curl. Getting this wrong once produced two
  # confident failures against a server that was working perfectly.
  local greeting
  greeting=$(kubectl exec -n "$NS" "$POD" -c stalwart -- \
    sh -c 'printf "QUIT\r\n" | timeout 5 nc 127.0.0.1 25 | head -1' 2>/dev/null || true)
  case "$greeting" in
    *mail.i10.tech*) ok "SMTP greeting: ${greeting%%$'\r'*}" ;;
    "") warn "could not read the SMTP greeting" ;;
    *)
      warn "SMTP greeting is ${greeting%%$'\r'*} — SystemSettings.defaultHostname did not take"
      failures=$((failures + 1))
      ;;
  esac

  # ⚠ WITHOUT SNI, AND THAT IS THE WHOLE POINT OF THE CHECK. A mail client sends
  # SNI and gets the right certificate regardless; a sending MTA on port 25
  # generally does not, and that is the connection `defaultCertificateId` exists
  # for. Checking with SNI would pass while inbound mail was being offered a
  # self-signed certificate — invisible from the direction you are looking.
  #
  # curl against an IP LITERAL sends no SNI, which is exactly the case we want.
  # It then fails to speak HTTP to an SMTP port, which does not matter: the TLS
  # handshake has already happened and -v has already printed the peer subject.
  local subject
  subject=$(kubectl exec -n "$NS" "$POD" -c stalwart -- \
    sh -c 'curl -sv --max-time 5 --insecure https://127.0.0.1:465 2>&1 | grep -m1 "subject:"' 2>/dev/null || true)
  subject=$(printf '%s' "$subject" | sed 's/^[* ]*subject: *//')
  case "$subject" in
    *i10.tech*) ok "certificate without SNI: $subject" ;;
    *)
      warn "certificate without SNI is '${subject:-unreadable}' — expected CN=i10.tech."
      warn "  A reload does NOT switch certificates; the pod must be restarted."
      failures=$((failures + 1))
      ;;
  esac

  local code
  for path in "/mail/config-v1.1.xml?emailaddress=probe@i10.tech" "/.well-known/mta-sts.txt"; do
    code=$(kubectl exec -n "$NS" "$POD" -c stalwart -- \
      curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$path" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      ok "$path → 200"
    else
      warn "$path → $code"
      failures=$((failures + 1))
    fi
  done

  # authd is the other half of every login. A bind that never reaches Clerk is
  # indistinguishable, from the client's side, from a wrong password.
  if kubectl logs -n "$NS" "$POD" -c authd --tail=200 2>/dev/null | grep -q '"msg":"listening"'; then
    ok "authd is listening"
  else
    warn "authd has not logged 'listening' recently"
  fi

  # The direct route's whole dependency on this server, in one line. Without an
  # account to authenticate as, every direct-routed message answers `deferred`
  # and waits in the queue — the designed failure, but a silent one until the
  # backlog is large enough to notice.
  if sw query Account --json 2>/dev/null | grep -q '"emailAddress":"submission@i10.tech"'; then
    ok "the submission account exists"
  else
    warn "no submission@i10.tech — the direct route cannot send"
    failures=$((failures + 1))
  fi

  # ⚠ THE LISTENER THE SEND WORKER DIALS, CHECKED BY NAME RATHER THAN ASSUMED.
  # 587 has no listener on this server and does not need one; 465 is implicit
  # TLS, which is what submission.ts configures from the port number.
  if sw query NetworkListener --json 2>/dev/null | grep -q '"submissions"'; then
    ok "the submissions listener (465, implicit TLS) is configured"
  else
    warn "no submissions listener — nothing accepts authenticated mail"
    failures=$((failures + 1))
  fi

  # ⚠ THE TRAP THAT COST A DAY. The default Tracer writes to /var/log/stalwart,
  # which does not exist on a read-only root filesystem — so the server logs
  # NOTHING and every problem has to be diagnosed from outside.
  if [ "$(kubectl logs -n "$NS" "$POD" -c stalwart --tail=5 2>/dev/null | wc -l)" -gt 0 ]; then
    ok "stalwart is logging to stdout"
  else
    warn "stalwart has logged nothing — the Stdout tracer is missing or needs a restart"
    failures=$((failures + 1))
  fi

  return "$failures"
}

if [ "$VERIFY_ONLY" = true ]; then
  verify || die "verification found problems"
  say "All good."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
say "Applying plan.ndjson"
# ─────────────────────────────────────────────────────────────────────────────
#
# The plan is already inside the pod, mounted from the hashed ConfigMap Argo
# generated. Reading it from there rather than from the working copy is what
# makes this reflect what is DEPLOYED — running it against an uncommitted local
# edit would configure the server from something no one else can see.
CM=$(kubectl get configmap -n "$NS" -o name |
  grep -o "${CONFIGMAP_PREFIX}-[a-z0-9]*" | head -1) ||
  die "no $CONFIGMAP_PREFIX-* ConfigMap in $NS — has Argo synced?"
[ -n "$CM" ] || die "no $CONFIGMAP_PREFIX-* ConfigMap in $NS — has Argo synced?"
ok "using ConfigMap $CM"

kubectl create configmap "stalwart-bootstrap-plan" -n "$NS" \
  --from-literal=plan.ndjson="$(kubectl get configmap -n "$NS" "$CM" -o jsonpath='{.data.plan\.ndjson}')" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

PLAN_POD="sw-plan-$$"
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $PLAN_POD
  namespace: $NS
  labels: { app.kubernetes.io/name: stalwart-bootstrap }
spec:
  restartPolicy: OnFailure
  containers:
    - name: cli
      image: $CLI_IMAGE
      args: ["apply", "--file", "/plan/plan.ndjson"]
      env:
        - { name: STALWART_URL, value: "$SVC_URL" }
        - { name: STALWART_USER, value: "$CLI_USER" }
        - name: STALWART_PASSWORD
          valueFrom: { secretKeyRef: { name: $TMP_SECRET, key: password } }
      volumeMounts: [{ name: plan, mountPath: /plan, readOnly: true }]
  volumes:
    - name: plan
      configMap: { name: stalwart-bootstrap-plan }
EOF
phase=""
for _ in $(seq 1 40); do
  phase=$(kubectl get pod -n "$NS" "$PLAN_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  [ "$phase" = "Succeeded" ] && break
  sleep 3
done
kubectl logs -n "$NS" "$PLAN_POD" 2>&1 | sed 's/^/   /'
kubectl delete pod -n "$NS" "$PLAN_POD" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete configmap -n "$NS" stalwart-bootstrap-plan --ignore-not-found >/dev/null 2>&1 || true
[ "$phase" = "Succeeded" ] || die "the plan did not apply cleanly"

# ─────────────────────────────────────────────────────────────────────────────
say "Ensuring a Stdout tracer"
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠ NOT IN plan.ndjson, AND IT CANNOT BE. `Tracer` has no filters, so `matchOn`
# has nothing to key on and neither upsert nor reconcile can converge — a second
# apply would create a second tracer. It is a create-once object, like the first
# administrator, so this checks before creating.
#
# ⚠ AND THE DEFAULT ONE IS A TRAP. Stalwart ships a Log tracer pointing at
# /var/log/stalwart. That directory does not exist in the container and the root
# filesystem is read-only, so it is enabled, at info, and discarding everything.
# Between first boot and 2026-09-02 the server never logged a single line.
tracers=$(sw query Tracer --json || die "could not query tracers")
if printf '%s' "$tracers" | grep -q '"@type":"Stdout"'; then
  ok "a Stdout tracer already exists"
else
  sw create Tracer --json '{"@type":"Stdout","enable":true,"level":"info","ansi":false,"multiline":false,"buffered":false,"lossy":false,"events":{},"eventsPolicy":"exclude"}' ||
    die "could not create the Stdout tracer"
  ok "created a Stdout tracer at level info"

  # Disable the file tracer, which is writing into a directory that is not there.
  log_id=$(printf '%s' "$tracers" | grep '"@type":"Log"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  if [ -n "$log_id" ]; then
    sw update Tracer "$log_id" --field enable=false >/dev/null && ok "disabled the file tracer ($log_id)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
say "Ensuring the submission account"
# ─────────────────────────────────────────────────────────────────────────────
#
# The identity the send worker authenticates as to hand us transactional mail
# for the direct route. See docs/decisions/mail-routing.md.
#
# ⚠ AN ACCOUNT IN STALWART'S OWN STORE, NOT IN authd, AND THAT IS THE WHOLE
# POINT. Every principal authd knows is a Clerk user — `filterLogin` is
# `(objectClass=inetOrgPerson)(mail=?)` against a projection of Clerk, and a bind
# is a `verify_password` call against Clerk. Putting a machine in there would
# mean inventing a person: a Clerk user with a password we rotate, visible to the
# identity system that exists for customers, and one Clerk outage away from the
# send worker being unable to send. `metering@i10.tech` established this pattern
# on 2026-09-06 for the same reason; this is the second one.
#
# ⚠ THE ACCOUNT IS IDEMPOTENT; THE PASSWORD IS NOT AND CANNOT BE. Stalwart
# stores a hash, so there is nothing to compare a desired value against — a
# re-run that "ensured" the password would have to overwrite it every time,
# invalidating whatever is in Doppler. So this creates the account when absent
# and sets a password ONLY when explicitly asked:
#
#   ./bootstrap.sh --set-submission-password
#
# ⚠ AND THE SECRET IS NEVER PRINTED, WRITTEN TO A FILE, OR PASSED AS AN
# ARGUMENT. A pod's `args` are readable by anyone who can `get pod -o yaml`, so
# the payload travels as a mounted Secret instead. The value is read from your
# terminal, sent to Stalwart, and put in a Secret for you to copy into Doppler.
SUB_LOCAL="${SUB_LOCAL:-submission}"
SUB_DOMAIN="${SUB_DOMAIN:-i10.tech}"
SUB_EMAIL="$SUB_LOCAL@$SUB_DOMAIN"

# ⚠ `emailAddress` IS SERVER-SET, DERIVED FROM `name` AND `domainId`. Sending it
# is rejected outright, and the domain id is a registry id rather than the name —
# so it has to be looked up rather than written down. Hardcoding the current `b`
# would work today and break on any rebuild of this server.
#
# ⚠ THE `id` IS TAKEN FROM THE END OF THE LINE, WHICH IS MEASURED RATHER THAN
# ASSUMED. These records nest — `{"name":"i10.tech",…,"certificateManagement":
# {"@type":"Manual"},…,"id":"b"}` — so a `[^}]*` window stops at the FIRST inner
# brace and never reaches the id, which is how the obvious version of this
# silently extracts nothing. Anchoring on `"id":"…"` immediately before the
# closing brace is what survives the nesting; the server puts it last in both
# Domain and Account. If that ever changes, the `die` below is the alarm — an
# empty id must never fall through into a create.
sub_domain_id=$(sw query Domain --json 2>/dev/null |
  grep "\"name\":\"$SUB_DOMAIN\"" |
  sed -n 's/.*"id":"\([^"]*\)"[^"]*$/\1/p' | head -1)
[ -n "$sub_domain_id" ] || die "no Domain named $SUB_DOMAIN — apply plan.ndjson first"

if sw query Account --json 2>/dev/null | grep -q "\"emailAddress\":\"$SUB_EMAIL\""; then
  ok "$SUB_EMAIL already exists"
else
  # ⚠ TWO PERMISSIONS OUT OF 660, AND `Replace` RATHER THAN `Inherit`. The
  # default user role carries the whole mailbox surface — IMAP, JMAP, sieve,
  # every folder — none of which a submission client has any use for.
  # `authenticate` opens the session and `emailSend` submits; a credential that
  # leaks can post mail and cannot read any.
  #
  # ⚠ AND NOTHING IS EVER DELIVERED HERE. The account exists to be authenticated
  # as. The description says so for whoever finds it in the admin UI at three in
  # the morning and wonders whose mailbox it is.
  sw create Account/User --json "{
    \"@type\": \"User\",
    \"name\": \"$SUB_LOCAL\",
    \"domainId\": \"$sub_domain_id\",
    \"description\": \"i10 send worker - direct-route SMTP submission. Not a mailbox.\",
    \"roles\": {\"@type\": \"User\"},
    \"permissions\": {
      \"@type\": \"Replace\",
      \"enabledPermissions\": {\"authenticate\": true, \"emailSend\": true},
      \"disabledPermissions\": {}
    }
  }" >/dev/null || die "could not create $SUB_EMAIL"
  ok "created $SUB_EMAIL"
fi

if [ "$SET_SUBMISSION_PASSWORD" = true ]; then
  say "Setting the submission password"
  # ⚠ THE ACCOUNT'S OWN PASSWORD, NOT AN AppPassword, AND NOT FOR WANT OF
  # TRYING. `AppPassword` carries `allowedIps` and its own permission set, which
  # would both be worth having — but it is not creatable by an administrator:
  # `create AppPassword` answers `notFound` with or without an account id,
  # because an app password is minted by the account holder inside their own
  # session. There is no holder here to log in as. `AccountPassword.secret` is
  # mutable and is what is left.
  #
  # ⚠ THE NARROW GRANT IS THE CONTROL, THEN, RATHER THAN THE SOURCE ADDRESS.
  # The account has two permissions and no mailbox, so the blast radius of this
  # credential is "can post mail through our MTA" — which is the thing it is for.
  # The table rather than the JSON: `query Account` prints `Id  Email Address …`,
  # and two whitespace-separated columns are less to get wrong than a nested
  # record. See the note on the domain lookup above for why the JSON is awkward.
  sub_id=$(sw query Account 2>/dev/null | awk -v e="$SUB_EMAIL" '$2 == e { print $1; exit }')
  [ -n "$sub_id" ] || die "could not resolve the id of $SUB_EMAIL"

  printf '   Paste a password for %s (input hidden): ' "$SUB_EMAIL"
  read -rs sub_pw
  printf '\n'
  [ -n "$sub_pw" ] || die "empty password"

  # ⚠ THROUGH A MOUNTED Secret, NEVER THROUGH `args`. A pod's arguments are in
  # its spec, readable by anything with `get pod`, and they persist in the API
  # server until the pod is reaped.
  kubectl create secret generic i10-stalwart-submission -n "$NS" \
    --from-literal=STALWART_SUBMISSION_HOST="i10-stalwart-mail.$NS.svc.cluster.local" \
    --from-literal=STALWART_SUBMISSION_PORT=465 \
    --from-literal=STALWART_SUBMISSION_USER="$SUB_EMAIL" \
    --from-literal=STALWART_SUBMISSION_PASSWORD="$sub_pw" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl create secret generic sw-password-payload -n "$NS" \
    --from-literal=payload.json="{\"secret\":\"$sub_pw\"}" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  unset sub_pw

  sw_file AccountPassword "$sub_id" sw-password-payload ||
    die "could not set the password for $SUB_EMAIL"
  kubectl delete secret sw-password-payload -n "$NS" --ignore-not-found >/dev/null
  ok "password set for $SUB_EMAIL"

  cat <<DOPPLER

   The four values are now in the Secret i10-stalwart-submission, for you to
   copy into Doppler's prod_api config — which is what the i10-api Secret syncs
   and what worker.yaml already mounts wholesale, so no manifest change is
   needed. Exactly as with STALWART_API_TOKEN:

     kubectl get secret i10-stalwart-submission -n $NS \\
       -o go-template='{{range \$k,\$v := .data}}{{\$k}}={{\$v | base64decode}}{{"\\n"}}{{end}}'

   ⚠ 465, NOT 587. There is no 587 listener on this server and no reason to add
   one: 465 is implicit TLS from the first byte, which RFC 8314 §3 prefers over
   STARTTLS precisely because it has no cleartext phase to strip.
   apps/api/src/send/submission.ts derives the TLS mode from the port.

   ⚠ AND DELETE i10-stalwart-submission ONCE IT IS IN DOPPLER. Two homes for one
   credential is one that gets rotated and one that does not.

DOPPLER
fi

# ─────────────────────────────────────────────────────────────────────────────
say "Reloading settings"
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠ APPLYING IS NOT ACTIVATING. Directory data takes effect immediately, but
# listeners, MTA rules, directory backends and telemetry are parsed once into an
# in-memory snapshot. Every object in plan.ndjson is in that category.
sw create Action/ReloadSettings >/dev/null || die "reload failed"
ok "settings reloaded"

# ─────────────────────────────────────────────────────────────────────────────
if [ "$RESTART" = true ]; then
  say "Restarting the pod"
  # ─────────────────────────────────────────────────────────────────────────
  #
  # ⚠ THE RELOAD IS NOT ENOUGH, AND THIS IS NOT BELT AND BRACES. Three things
  # are established to survive a reload and require a restart:
  #
  #   1. TLS certificate selection. The Certificate object applies cleanly and
  #      the server keeps serving the previous one.
  #   2. The tracer. Changed and reloaded, it still logs nothing.
  #   3. The per-account permission set, cached as `accessToken`. Assigning
  #      defaultUserRoleIds appeared to do nothing for twenty minutes because
  #      the running server kept serving the old, empty token.
  kubectl delete pod -n "$NS" "$POD" --wait=false >/dev/null
  kubectl wait --for=delete "pod/$POD" -n "$NS" --timeout=90s >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    ready=$(kubectl get pod -n "$NS" "$POD" -o jsonpath='{.status.containerStatuses[*].ready}' 2>/dev/null || true)
    [ "$ready" = "true true" ] && break
    sleep 3
  done
  [ "${ready:-}" = "true true" ] || die "the pod did not come back ready"
  ok "pod restarted and ready"
  sleep 3
else
  warn "skipping the restart — the certificate, tracer and cached permissions may be stale"
fi

verify || warn "verification found problems; see above"

# ─────────────────────────────────────────────────────────────────────────────
say "DNS records this server expects"
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠ ON A REBUILD THE DKIM KEYS ARE NEW. Stalwart generates its signing keys at
# first boot and holds the private halves in its own database. A rebuilt server
# has different keys under different selectors, so the DKIM records in
# infra/tofu/stacks/dns are WRONG until they are replaced from this output — and
# the failure is silent: mail sends, DKIM fails, DMARC alignment fails, and it
# lands in spam.
#
# TLSA records are filtered out on purpose. Stalwart offers 22 of them; DANE
# pins the certificate, cert-manager renews every 60 days, and nothing updates
# the pins — so publishing them breaks inbound delivery at the first renewal.
# They also do nothing without DNSSEC, which this zone does not have.
warn "This is what Stalwart SUGGESTS, not what i10 publishes."
warn "  infra/tofu/stacks/dns is the authority. It deliberately differs:"
warn "  DMARC stays p=none until the reports are clean (Stalwart proposes p=reject),"
warn "  and the report addresses point at a mailbox that exists."
warn "  What you DO need from here after a rebuild is the two _domainkey records."
domain_id=$(sw query Domain --json | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$domain_id" ]; then
  sw get Domain "$domain_id" --json |
    python3 -c 'import sys,json
raw = [l for l in sys.stdin.read().splitlines() if l.strip().startswith("{")]
zone = json.loads(raw[-1]).get("dnsZoneFile", "") if raw else ""
for line in zone.splitlines():
    if " TLSA " not in line:
        print("   " + line)'
else
  warn "no Domain object — plan.ndjson did not create one"
fi

say "Done."
