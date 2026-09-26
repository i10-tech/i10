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
#   ./bootstrap.sh --dry-run    show what the plan would create or change, and
#                               stop — reads only. `stalwart-cli apply --dry-run`
#                               cannot do this: it never contacts the server, so
#                               it passes plans the server will refuse.
#   PLAN_FILE=path ./bootstrap.sh --dry-run
#                               preview a plan that is not deployed yet — a
#                               branch's, before merge. Dry-run only: a real
#                               apply always reads what Argo deployed.
#
# Runs anywhere `kubectl` reaches the cluster and `python3` exists — on psl-vps
# as `mo` needs no sudo.
#
# ⚠ ON A GENUINELY FRESH INSTALL, READ config/README.md FIRST. The first
# administrator comes from STALWART_RECOVERY_ADMIN, which must already be in the
# i10-stalwart secret before this can authenticate at all. This script does not
# create it and cannot.
set -euo pipefail

NS="${NS:-i10-prod}"
POD="${POD:-i10-stalwart-0}"
SECRET="${SECRET:-i10-stalwart}"
CONFIGMAP_PREFIX="i10-stalwart-config"

VERIFY_ONLY=false
DRY_RUN=false
RESTART=true
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY_ONLY=true ;;
    --no-restart) RESTART=false ;;
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
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

command -v python3 >/dev/null || die "python3 is required — it speaks to Stalwart's API"

# ⚠ ASK THE CLUSTER BEFORE ASKING FOR THE POD. `kubectl get pod` fails the same
# way when kubectl points at no cluster at all, and reporting that as "pod not
# found" sent a laptop without a context looking for a StatefulSet problem that
# did not exist.
kubectl get namespace "$NS" >/dev/null 2>&1 ||
  die "kubectl cannot reach namespace $NS (context: $(kubectl config current-context 2>/dev/null || echo none)) — run this on psl-vps, or point kubectl at the cluster"
kubectl get pod -n "$NS" "$POD" >/dev/null 2>&1 ||
  die "pod $POD not found in $NS — is the StatefulSet synced?"

# ─────────────────────────────────────────────────────────────────────────────
# The API client
#
# ⚠ STALWART'S MANAGEMENT API, DIRECTLY, THROUGH A PORT-FORWARD — NOT
# stalwart-cli PODS. This used to start one throwaway pod per command: an image
# pull, a scheduling round and a NetworkPolicy race (kube-router builds its
# ipsets from a watch, so a new pod reaches nothing for a second or two) each
# time, about a minute apiece. A JMAP call over a port-forward takes
# milliseconds, needs nothing created in the namespace, and leaves nothing to
# clean up.
#
# ⚠ AND THE PLAN ENGINE IS A PORT OF THE CLI'S, NOT AN INVENTION. `apply` below
# follows stalwart-cli's src/commands/apply.rs rule for rule: upsert fetches
# every object of the type and matches on `matchOn` (and `@type` for
# multi-variant objects); a match is updated with the body minus `@type` and
# every field the schema marks `immutable` or `serverSet`; no match is created
# minus `serverSet`; two matches is an error. `#name` references are never
# rewritten client-side — every request carries a `createdIds` map (RFC 8620
# §3.3) and the server resolves them, exactly as the CLI does. Only the three
# operations plan.ndjson uses are supported; anything else fails loudly.
#
# ⚠ THE CREDENTIAL NEVER REACHES argv OR A POD SPEC. It lives in a shell
# variable and is handed to the helper through its environment for the length
# of one process — not visible in `ps`, and there is no pod whose `-o yaml`
# could show it.
# ─────────────────────────────────────────────────────────────────────────────
HELPER=$(mktemp "${TMPDIR:-/tmp}/stalwart-api.XXXXXX")
PF_PID=""
PF_PORT=$((20000 + RANDOM % 20000))

disconnect() {
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
  fi
}
cleanup() {
  disconnect
  rm -f "$HELPER"
}
trap cleanup EXIT

raw=$(kubectl get secret -n "$NS" "$SECRET" -o jsonpath='{.data.STALWART_RECOVERY_ADMIN}' | base64 -d)
[ -n "$raw" ] || die "STALWART_RECOVERY_ADMIN is empty in secret/$SECRET"
case "$raw" in
  *:*) ;;
  *) die "STALWART_RECOVERY_ADMIN is not in username:password form" ;;
esac

api() {
  STALWART_AUTH="$raw" STALWART_BASE="http://127.0.0.1:$PF_PORT" python3 "$HELPER" "$@"
}

# ⚠ A PORT-FORWARD IS BOUND TO ONE POD, NOT TO THE SERVICE. It dies with the pod
# it picked, so the restart below disconnects first and connects again after.
connect() {
  disconnect
  kubectl port-forward -n "$NS" svc/i10-stalwart "$PF_PORT:8080" >/dev/null 2>&1 &
  PF_PID=$!
  api wait || die "Stalwart's API did not answer through a port-forward on $PF_PORT"
}

cat >"$HELPER" <<'PY'
import base64, gzip, json, os, sys, time, urllib.error, urllib.request

BASE = os.environ["STALWART_BASE"]
AUTH = "Basic " + base64.b64encode(os.environ["STALWART_AUTH"].encode()).decode()
USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]


def ok(msg):
    print(f"   \033[32m✓\033[0m {msg}", flush=True)


def fail(msg):
    print(f"   \033[31m✗\033[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def http(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", AUTH)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        # /api/schema answers with a redirect to a content-hashed path; urllib
        # follows it and keeps the Authorization header on the same host.
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            # ⚠ THE SCHEMA ARRIVES GZIPPED WHETHER OR NOT IT WAS ASKED FOR, AND
            # SOMETIMES WITHOUT SAYING SO. Same rule as stalwart-cli's
            # decode_schema_body: trust the header, else the gzip magic bytes.
            encoding = (r.headers.get("Content-Encoding") or "").strip().lower()
            if encoding in ("gzip", "x-gzip") or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return json.loads(raw or b"null")
    except urllib.error.HTTPError as e:
        fail(f"{method} {path} answered {e.code}: {e.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as e:
        fail(f"{method} {path} failed: {e.reason}")


# Client id -> server id, for every object the plan has matched or created. The
# ones a request references ride along as `createdIds`, and the server resolves
# `#name` itself.
created_ids = {}


def refs_in(value, out):
    if isinstance(value, str):
        if value.startswith("#") and len(value) > 1:
            out.add(value[1:])
    elif isinstance(value, list):
        for v in value:
            refs_in(v, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            if k.startswith("#") and len(k) > 1:
                out.add(k[1:])
            refs_in(v, out)
    return out


def jmap(calls, creating=()):
    body = {"using": USING, "methodCalls": calls}
    # Only the references this request uses, and never one it is creating —
    # the same rule as stalwart-cli's request_created_ids.
    known = {r: created_ids[r] for r in refs_in(calls, set()) - set(creating) if r in created_ids}
    if known:
        body["createdIds"] = known
    resp = http("POST", "/jmap", body)
    created_ids.update(resp.get("createdIds") or {})
    out = []
    for name, args, call_id in resp["methodResponses"]:
        if name == "error":
            fail(f"{call_id}: {args.get('type')}: {args.get('description', '')}")
        out.append(args)
    return out


def describe(err):
    text = f"{err.get('type')}: {err.get('description', '')}".rstrip(": ")
    if err.get("properties"):
        text += f" (properties: {', '.join(err['properties'])})"
    return text


_schema = None


def schema():
    global _schema
    if _schema is None:
        _schema = http("GET", "/api/schema")
    return _schema


def canonical(name):
    c = name if name.startswith("x:") else "x:" + name
    if c not in schema()["objects"]:
        fail(f"unknown object `{name}`")
    return c


def is_singleton(c):
    return schema()["objects"][c].get("type") == "singleton"


def is_multi(c):
    return (schema()["schemas"].get(c) or {}).get("type") == "multiple"


def props_for(c, at_type):
    sc = schema()["schemas"].get(c) or {}
    if sc.get("type") == "multiple":
        variant = next((v for v in sc.get("variants", []) if v.get("name") == at_type), {})
        name = variant.get("schemaName")
    else:
        name = sc.get("schemaName")
    return (schema()["fields"].get(name) or {}).get("properties", {}) if name else {}


def update_kind(props, key):
    return (props.get(key) or {}).get("update", "mutable")


_limit = None


def fetch_all(c):
    global _limit
    if _limit is None:
        core = http("GET", "/jmap/session").get("capabilities", {})
        core = core.get("urn:ietf:params:jmap:core", {})
        _limit = max(1, min(int(core.get("maxObjectsInGet", 256)), 500))
    objs, anchor = [], None
    while True:
        query = {"filter": {}, "limit": _limit}
        if anchor:
            query.update(anchor=anchor, anchorOffset=1)
        ids_ref = {"resultOf": "q", "name": f"{c}/query", "path": "/ids"}
        q, g = jmap([
            [f"{c}/query", query, "q"],
            [f"{c}/get", {"#ids": ids_ref, "properties": None}, "g"],
        ])
        ids = q.get("ids") or []
        objs.extend(g.get("list") or [])
        if len(ids) < _limit:
            return objs
        anchor = ids[-1]


def resolve_ref(value):
    if isinstance(value, str) and value.startswith("#") and value[1:] in created_ids:
        return created_ids[value[1:]]
    return value


def same(a, b):
    return (a is None and b is None) or a == b


def create_objects(c, bodies, known):
    (res,) = jmap([[f"{c}/set", {"create": bodies}, "c"]], creating=bodies.keys())
    for cid, err in (res.get("notCreated") or {}).items():
        fail(f"{c[2:]}: create failed for `{cid}`: {describe(err)}")
    created = res.get("created") or {}
    for cid, obj in created.items():
        created_ids[cid] = obj["id"]
        known.append({**bodies[cid], **obj})
    return len(created)


def update_object(c, sid, patch):
    (res,) = jmap([[f"{c}/set", {"update": {sid: patch}}, "u"]])
    for bad, err in (res.get("notUpdated") or {}).items():
        fail(f"{c[2:]}: update failed for {bad}: {describe(err)}")
    if sid not in (res.get("updated") or {}):
        fail(f"{c[2:]}: the server did not confirm updating `{sid}` (the id may not exist)")


def covers(current, wanted):
    # ⚠ A TYPED SUB-OBJECT COMES BACK WITH THE SERVER'S DEFAULTS FILLED IN —
    # `dkimManagement: {"@type": "Automatic"}` is stored with its algorithms,
    # selector template and rotation periods — so exact equality reports a
    # change on every run. Inside anything carrying `@type`, compare only what
    # the plan sets. Plain maps (`bind`, `subjectAlternativeNames`) are sets and
    # are written whole, so they stay exact: a removed entry must show.
    wanted = resolve_ref(wanted)
    if isinstance(wanted, dict) and "@type" in wanted and isinstance(current, dict):
        return current.get("@type") == wanted["@type"] and all(
            covers(current.get(k), v) for k, v in wanted.items() if k != "@type"
        )
    return same(current, wanted)


def unknown_props(c, at_type, body):
    # ⚠ THE CHECK THAT WOULD HAVE CAUGHT THE StoreLookup BUG ON THE FIRST RUN.
    # Its first version put `description` and the Postgres fields at the top
    # level; the object has only `namespace` and `store`. A create is never
    # matched against anything, so without this a preview reads "would create"
    # and says nothing about a body the server will refuse.
    props = props_for(c, at_type)
    return sorted(k for k in body if k != "@type" and k not in props) if props else []


def changes(current, patch):
    return sorted(k for k, v in patch.items() if not covers(current.get(k), v))


def upsert(c, op, cache, dry=False):
    label = c[2:]
    match_on = op.get("matchOn")
    if isinstance(match_on, str):
        match_on = [match_on]
    if not match_on:
        fail(f"{label}: upsert without `matchOn` — name the properties that identify the object")
    if c not in cache:
        cache[c] = fetch_all(c)
    known = cache[c]
    multi = is_multi(c)
    to_create, to_update = {}, []
    for client_id, body in op["value"].items():
        at_type = body.get("@type")
        if multi and not at_type:
            fail(f"{label}: `{client_id}` is missing `@type` (required to match a multi-variant object)")
        wanted = []
        for p in match_on:
            if p not in body:
                fail(f"{label}: match property `{p}` is missing from `{client_id}`")
            wanted.append((p, resolve_ref(body[p])))
        matches = [
            o for o in known
            if (not multi or o.get("@type") == at_type)
            and all(same(o.get(p), w) for p, w in wanted)
        ]
        if len(matches) > 1:
            fail(f"{label}: ambiguous upsert; {len(matches)} existing objects match on {', '.join(match_on)}")
        props = props_for(c, at_type)
        if matches:
            sid = matches[0]["id"]
            created_ids[client_id] = sid
            patch = {
                k: v for k, v in body.items()
                if k != "@type" and update_kind(props, k) not in ("immutable", "serverSet")
            }
            if patch:
                to_update.append((sid, patch))
        else:
            to_create[client_id] = {
                k: v for k, v in body.items() if update_kind(props, k) != "serverSet"
            }
    if dry:
        for cid, body in op["value"].items():
            bad = unknown_props(c, body.get("@type"), body)
            if bad:
                fail(f"{label} `{cid}`: not properties of {label}: {', '.join(bad)}")
        for cid in to_create:
            print(f"   + would create {label} `{cid}`")
        for sid, patch in to_update:
            diff = changes(next(o for o in known if o.get("id") == sid), patch)
            print(f"   ~ {label} {sid}: " + (f"would change {', '.join(diff)}" if diff else "unchanged"))
        return 0, 0
    created = create_objects(c, to_create, known) if to_create else 0
    for sid, patch in to_update:
        update_object(c, sid, patch)
        next(o for o in known if o.get("id") == sid).update(patch)
    return created, len(to_update)


def update(c, op, dry=False):
    if is_singleton(c):
        if op.get("id") not in (None, "singleton"):
            fail(f"{c[2:]}: a singleton's id must be 'singleton'")
        sid = "singleton"
    else:
        sid = resolve_ref(op.get("id") or fail(f"{c[2:]}: update needs a top-level `id`"))
    if dry:
        bad = unknown_props(c, op["value"].get("@type"), op["value"])
        if bad:
            fail(f"{c[2:]}: not properties of {c[2:]}: {', '.join(bad)}")
        (got,) = jmap([[f"{c}/get", {"ids": [sid], "properties": list(op["value"])}, "g"]])
        current = (got.get("list") or [{}])[0]
        diff = changes(current, op["value"])
        print(f"   ~ {c[2:]} {sid}: " + (f"would change {', '.join(diff)}" if diff else "unchanged"))
        return
    update_object(c, sid, op["value"])


def apply(text, dry=False):
    ops = [json.loads(line) for line in text.splitlines() if line.strip()]
    kinds = {}
    for op in ops:
        kinds[op.get("@type")] = kinds.get(op.get("@type"), 0) + 1
    print("   Plan: " + ", ".join(f"{n} {k}" for k, n in kinds.items()) + f" ({len(ops)} operations)")
    cache, total_created, total_updated = {}, 0, 0
    for i, op in enumerate(ops, 1):
        kind, c = op.get("@type"), canonical(op.get("object", ""))
        if kind == "upsert":
            created, updated = upsert(c, op, cache, dry)
            if not dry:
                ok(f"upserted {c[2:]} ({updated} updated, {created} created)")
        elif kind == "update":
            update(c, op, dry)
            created, updated = 0, 0 if dry else 1
            if not dry:
                ok(f"updated {c[2:]}")
        elif dry:
            fail(f"operation #{i}: `{kind}` has no dry-run preview")
        elif kind == "create":
            created, updated = create_objects(c, op["value"], cache.setdefault(c, [])), 0
            ok(f"created {c[2:]} ({created})")
        else:
            fail(f"operation #{i}: `{kind}` is not supported by bootstrap.sh — "
                 "only upsert, update and create; use stalwart-cli for the rest")
        total_created += created
        total_updated += updated
    if not dry:
        ok(f"done: {total_updated} updated, {total_created} created")


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "wait":
        # The port-forward takes a moment to listen; anything but a refused
        # connection means Stalwart itself is answering.
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/jmap/session", timeout=2)
                return
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.2)
        sys.exit(1)
    elif cmd == "apply":
        apply(sys.stdin.read(), dry="--dry-run" in args)
    elif cmd == "listener":
        names = {o.get("name") for o in fetch_all("x:NetworkListener")}
        sys.exit(0 if args[0] in names else 1)
    elif cmd == "tracer":
        ensure_stdout_tracer()
    elif cmd == "reload":
        (res,) = jmap([["x:Action/set", {"create": {"r": {"@type": "ReloadSettings"}}}, "r"]])
        if "r" not in (res.get("created") or {}):
            fail(f"reload failed: {describe((res.get('notCreated') or {}).get('r', {}))}")
    elif cmd == "zone":
        domains = fetch_all("x:Domain")
        print(domains[0].get("dnsZoneFile", "") if domains else "")
    else:
        fail(f"unknown helper command `{cmd}`")


def ensure_stdout_tracer():
    tracers = fetch_all("x:Tracer")
    if any(t.get("@type") == "Stdout" for t in tracers):
        ok("a Stdout tracer already exists")
        return
    create_objects("x:Tracer", {"stdout": {
        "@type": "Stdout", "enable": True, "level": "info", "ansi": False,
        "multiline": False, "buffered": False, "lossy": False,
        "events": {}, "eventsPolicy": "exclude",
    }}, tracers)
    ok("created a Stdout tracer at level info")
    # Disable the file tracer, which is writing into a directory that is not there.
    for t in tracers:
        if t.get("@type") == "Log" and t.get("enable", True):
            update_object("x:Tracer", t["id"], {"enable": False})
            ok(f"disabled the file tracer ({t['id']})")


main()
PY

connect

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

  # ⚠ THE LISTENER THE SEND WORKER DIALS, CHECKED BY NAME RATHER THAN ASSUMED.
  # The direct route's whole dependency on this server is one line: without
  # `relay` on 2525, every direct-routed message answers `deferred` and waits in
  # the queue — the designed failure, but a silent one until the backlog is
  # large enough to notice. See config/README.md, "The internal relay".
  if api listener relay; then
    ok "the relay listener (2525, in-cluster only) is configured"
  else
    warn "no relay listener — the direct route cannot send"
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

# ⚠ TWO FUNCTIONS, BECAUSE ONLY THE PLAN MAY GO DOWN THE PIPE. The lookup
# prints progress and can `die`; run inside a pipeline it would do both in a
# subshell — its progress line parsed as a plan operation, its exit ignored.
find_plan() {
  CM=$(kubectl get configmap -n "$NS" -o name |
    grep -o "${CONFIGMAP_PREFIX}-[a-z0-9]*" | head -1) ||
    die "no $CONFIGMAP_PREFIX-* ConfigMap in $NS — has Argo synced?"
  [ -n "$CM" ] || die "no $CONFIGMAP_PREFIX-* ConfigMap in $NS — has Argo synced?"
  ok "using ConfigMap $CM"
}
plan_text() {
  kubectl get configmap -n "$NS" "$CM" -o jsonpath='{.data.plan\.ndjson}'
}

if [ "$DRY_RUN" = true ]; then
  say "Previewing plan.ndjson — nothing is written"
  if [ -n "${PLAN_FILE:-}" ]; then
    [ -r "$PLAN_FILE" ] || die "cannot read PLAN_FILE=$PLAN_FILE"
    ok "using $PLAN_FILE (not deployed)"
    api apply --dry-run <"$PLAN_FILE" || die "the plan cannot be applied as written"
  else
    find_plan
    plan_text | api apply --dry-run || die "the plan cannot be applied as written"
  fi
  say "Dry run complete."
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
find_plan
plan_text | api apply || die "the plan did not apply cleanly"

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
api tracer || die "could not ensure the Stdout tracer"

# ─────────────────────────────────────────────────────────────────────────────
say "Reloading settings"
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠ APPLYING IS NOT ACTIVATING. Directory data takes effect immediately, but
# listeners, MTA rules, directory backends and telemetry are parsed once into an
# in-memory snapshot. Every object in plan.ndjson is in that category.
api reload || die "reload failed"
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
  disconnect
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
  connect
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
zone=$(api zone || true)
if [ -n "$zone" ]; then
  printf '%s\n' "$zone" | grep -v " TLSA " | sed 's/^/   /'
else
  warn "no Domain object — plan.ndjson did not create one"
fi

say "Done."
