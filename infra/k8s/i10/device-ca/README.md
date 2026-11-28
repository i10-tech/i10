# The device CA (`i10-device-ca`)

step-ca 0.30.2 (SCEP-only) with the `cahookrelay` sidecar, the hooks transport
CA, and the `ca.i10.tech/scep/apple-scep` route. Mac ACME (`device-attest-01`)
moved to `i10-acmed` + `i10-enrollctl` in I10-62; see
`docs/research/enrollment-at-scale.md` section 6 for the full enrollment plane
architecture and `docs/research/mail-device-binding.md` section 11 for the CA
design. This file covers the deploy: what each manifest is, the order things
come up in, and how to check them.

| File                    | What it holds                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `config/ca.json`        | step-ca's configuration: `apple-scep` provisioner, two SCEP webhooks, no secret     |
| `config/apple-scep.tpl` | the SCEP `apple-scep` certificate template                                          |
| `deployment.yaml`       | the badger volume, the `i10-device-ca` Service, the pod (step-ca and `cahookrelay`) |
| `hooks-tls.yaml`        | the hooks transport CA (cert-manager) and the relay's `localhost` certificate       |
| `trust.yaml`            | the device CA's public certificates, for Traefik, mailfront, enrolld, and enrollctl |
| `networkpolicy.yaml`    | Traefik in on 9000, `i10-enroll-redis` (6379) and DNS out                           |
| `ingressroute.yaml`     | `ca.i10.tech`: SCEP path rule, per-client rate limits, verified hop to step-ca      |

Outside this directory: the DopplerSecrets (`doppler/dopplersecrets.yaml`), the
dedicated enrollment Redis (`redis/enroll-redis.yaml`), `enrollctl`, `acmed`,
`enrolld`, and their certificates/policies (`workloads/enrollctl.yaml`,
`workloads/acmed.yaml`, `workloads/enrolld.yaml`, `workloads/certificate.yaml`,
`workloads/networkpolicy.yaml`), the front's trust bundle mount
(`stalwart/node/statefulset.yaml`), and the DNS records
(`infra/tofu/stacks/dns`).

## The CA

- **One provisioner (`apple-scep`) and nothing else.** SCEP with the RSA
  decrypter. ACME (`apple`) moved to `i10-acmed` + `i10-enrollctl` in I10-62,
  and the unused `scep-notify` webhook was removed. No JWK, OIDC, X5C or admin
  provisioner, `enableAdmin` off, so no remote management. `disableRenewal` is
  set; `disableSmallstepExtensions` is never set, so step-ca's `/renew` and
  `/rekey` refuse these certificates (and neither path is routed anyway).
- **Lifetime:** SCEP 168 h (7 days), well inside the intermediate's 2036-11-26;
  `cahookrelay` refuses any leaf that would extend past
  `CAHOOKRELAY_INTERMEDIATE_NOT_AFTER`. (Mac ACME leaves are signed for 1095
  days directly by `enrollctl` using the same intermediate.)
- **SCEP encrypts its replies with AES-256-CBC** (`encryptionAlgorithmIdentifier`
  2). step-ca's default is DES-CBC. Apple's SCEP client supports AES; real-device
  enrollment is the proof.
- **GetCACert answers the decrypter certificate alone** (`excludeIntermediate`
  on `apple-scep`, `includeRoot` off). Do not add the intermediate or the root
  back. iOS refuses a GetCACert answer in which it cannot pick a CA, and it
  checks the CertRep against the certificate marked `digitalSignature`, while
  step-ca 0.30.2 always signs the CertRep with the decrypter. The decrypter alone
  was the only answer a real iPhone accepted (device probe, 2026-11-27,
  `docs/research/mail-device-binding.md` section 12).
- **The SCEP challenge is the webhook's.** With a `SCEPCHALLENGE` webhook
  configured, step-ca asks `cahookrelay` and never compares the static
  `challenge`. Do not remove that webhook: without it, step-ca compares the
  challenge with an empty password, so an empty challenge would pass.

### The SCEP template

`apple-scep.tpl` renders CN only, no SANs, `digitalSignature` and
`keyEncipherment`, EKU `emailProtection` only. A CSR without a CN fails at
render. The CSR's DNS names and OUs are never copied. `cahookrelay`
(`services/authd/cmd/cahookrelay/body.go`) enforces these template invariants
locally before authorizing issuance.

### The image

`smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270`,
the multi-arch index digest, read with
`docker buildx imagetools inspect smallstep/step-ca:0.30.2` (a registry read;
nothing was pushed). Its user `step` is uid and gid 1000, from the image's own
build history.

**The binary carries a file capability** (`setcap CAP_NET_BIND_SERVICE=+eip` in
step-ca's Dockerfile). With every capability dropped, Linux refuses to exec it:
`exec /usr/local/bin/step-ca: operation not permitted`. The init container
copies it into an `emptyDir` (a copy has no file capability) and step-ca runs
the copy, mounted read-only. It listens on 9000 and needs no capability.

### Where the keys are

- `prod_device_ca` in Doppler, synced to the Secret `i10-device-ca`
  (token Secret `doppler-token-i10-device-ca`): the root and intermediate
  certificates, the intermediate key (PKCS#8, unencrypted, so step-ca runs with
  no `--password-file`), and the SCEP decrypter's certificate and key.
- Mounted into `step-ca` by named `items` (4 keys: root, intermediate cert/key,
  decrypter key). `enrollctl` (`workloads/enrollctl.yaml`) mounts ONLY
  `intermediate.crt` and `intermediate.key` to sign Mac ACME leaves (never the
  root or SCEP decrypter key). The decrypter's certificate is also in `ca.json`
  (public; step-ca has no file option for it).
- The DopplerSecret's `secrets:` list and the `items:` mounts both keep any
  inherited root key out of both pods.
- `prod_device_ca_hooks`, synced to `i10-device-ca-hooks` (token Secret
  `doppler-token-i10-device-ca-hooks`): `ENROLL_REDIS_PASSWORD` (for the
  `cahookrelay` ACL user on `i10-enroll-redis`), passed to the `cahookrelay`
  sidecar only. `step-ca` never holds it.

## The hooks transport CA

A namespace-local cert-manager CA used for nothing else: `i10-hooks-tls-bootstrap`
(self-signed) signs `i10-hooks-tls-root` (20 years, key never rotated), and the
CA Issuer `i10-hooks-tls` signs two 90-day server leaves (both hot-reloaded
every 30 seconds):

| Certificate           | Names                        | Life    | Trusted by                                                             |
| --------------------- | ---------------------------- | ------- | ---------------------------------------------------------------------- |
| `i10-cahookrelay-tls` | `localhost`, `IP:127.0.0.1`  | 90 days | `step-ca`, through `SSL_CERT_FILE` + `SSL_CERT_DIR`                    |
| `i10-enrollctl-tls`   | `i10-enrollctl.i10-prod.svc` | 90 days | `enrolld` (`ENROLLD_API_CA_FILE`), `acmed` (`ACMED_ENROLLCTL_CA_FILE`) |

`i10-api` no longer runs a `:3443` hooks listener and no longer mounts a hooks
TLS certificate.

**`SSL_CERT_DIR` is set as well as `SSL_CERT_FILE`.** Go's root loader reads
`SSL_CERT_FILE` instead of the default bundle file, but it still reads every
file in `/etc/ssl/certs` unless `SSL_CERT_DIR` names other directories
(`crypto/x509/root.go`, `loadOnDiskRoots`). With only `SSL_CERT_FILE`, step-ca's
webhook client would also trust the image's public CA bundle.

## Who trusts the device CA

Traefik, the mail front, `enrolld`, and `enrollctl`, from `trust.yaml`:

- `ca.crt` (the root): Traefik's `ServersTransport` verifies step-ca's own TLS
  certificate against it for `serverName: i10-device-ca.i10-prod.svc`. step-ca
  cuts that certificate from the intermediate for `ca.json`'s `dnsNames`, the
  two names the intermediate is constrained to.
- `bundle.pem` (root and intermediate): the front's `MAILFRONT_DEVICE_CA_BUNDLE`
  on the edge StatefulSet (993 client certificate requests list these subjects),
  `enrolld`'s `ENROLLD_DEVICE_CA_BUNDLE`, and `enrollctl`'s
  `ENROLLCTL_DEVICE_CA_BUNDLE` (Phase 4 SCEP identity verification, reloaded
  every 30 seconds). All mount without `subPath` so edits reach them without a
  restart.

## The public surface

`ca.i10.tech`, DNS-only (grey cloud), through Traefik with the existing
wildcard certificate, path-scoped to three prefixes across three backends:

- `Path(/scep/apple-scep) || PathPrefix(/scep/apple-scep/)` -> `i10-device-ca` (`ingressroute.yaml`, SCEP only)
- `PathPrefix(/acme/apple/)` -> `i10-acmed` (`workloads/acmed.yaml`, stateless keyless Mac ACME)
- `PathPrefix(/enroll/apple/)` -> `i10-enrolld` (`workloads/enrolld.yaml`, Apple OTA Profile Service)

Everything else on `ca.i10.tech` (`/provisioners`, `/roots`, `/root/*`, `/1.0/*`,
`/sign`, `/renew`, `/rekey`, `/revoke`, `/health`, `/version`, `/crl`, unknown
prefixes) matches no router and gets Traefik's plain 404.

All three IngressRoutes use per-client IPv4/IPv6 `/64` rate and in-flight
limits plus body size limits; host-wide caps were removed now that ACME no
longer writes unexpiring rows to `step-ca`'s badger volume and forged OTA links
are rejected locally in `enrolld`.

## Network policies, and what they do not do

`i10-device-ca` admits Traefik on 9000 and lets the pod out ONLY to
`i10-enroll-redis` on 6379 and CoreDNS on 53 (no Postgres, no API, no
`enrollctl`, no internet).

⚠ **NetworkPolicy alone keeps two namespaces in.** Policies only add, and the
psl repo's `allow-traefik` and `allow-cnpg-operator` let every pod in `traefik`
and `cnpg-system` reach EVERY port of every pod in `i10-prod`. So step-ca's 9000,
`enrollctl`'s 3443 and `i10-enroll-redis`'s 6379 are all reachable from those
namespaces, whatever the policies in this repo say. What keeps them out is not
the network: `enrollctl` answers only a valid bearer token
(`ENROLLCTL_{ENROLLD,ACMED}_TOKEN_HASHES`, a bare 404 otherwise), and Redis
answers only an ACL user with its password (the `default` user is off).

⚠ **Traefik can read every Secret in `i10-prod`.** The Traefik chart's
cluster-wide RBAC lets it read every Secret, and its CRD provider caches them.
That now includes `i10-profile-signing-tls` (the profile-signing key) and
`i10-device-ca` (the device intermediate key, mounted into `step-ca` and
`enrollctl`), the bearer tokens, and every enrollment Redis password. It also
terminates TLS for `ca.i10.tech`, so it sees every link token, SCEP challenge
and Mac OU permit in flight, and so does Cloudflare while `ca.i10.tech` is
still served by the proxied wildcard. A Traefik compromise is therefore a
compromise of the enrollment plane: it can sign profiles, issue device
certificates, and act as any enrollment client.

The fix is on the psl side: namespaced RBAC for Traefik with
`rbac.secretResourceNames` limited to its TLS Secrets, and a port-scoped
`allow-traefik` for `i10-prod` (`docs/research/enrollment-at-scale.md`
section 4).

## Rollout

1. **Doppler configs and token Secrets** (`doppler/dopplersecrets.yaml`):
   create `prod_enrollctl`, `prod_acmed` (with `ACMED_NONCE_KEYS`),
   `prod_enroll_redis`, `prod_enroll_writer_db` and `prod_api_enroll`, update
   `prod_enrolld` and `prod_device_ca_hooks`, and create the matching
   `doppler-token-*` Secrets in `i10-prod`. The two API enrollment keys go in
   `prod_api_enroll`, NOT `prod_api` (whose Secret the worker and CronJobs
   mount).
2. **CNPG managed role** (`platform-db/cluster.yaml`): reconcile `enroll_writer`
   before running database migrations so `*_enroll_writer_grants_and_triggers`
   succeeds.
3. **Enrollment Redis** (`redis/enroll-redis.yaml`): bring up `i10-enroll-redis`
   and confirm all 5 ACL users (`health`, `api`, `enrollctl`, `cahookrelay`,
   `acmed`) are loaded.
4. **Certificates** (`device-ca/hooks-tls.yaml`, `workloads/certificate.yaml`):
   wait for `i10-cahookrelay-tls`, `i10-enrollctl-tls`, and
   `i10-profile-signing` (`i10-profile-signing-tls`, Let's Encrypt DNS-01 for
   `profiles.i10.tech`) to report Ready.
5. **Workloads**: roll `i10-enrollctl`, `i10-acmed`, `i10-enrolld`,
   `i10-device-ca` (now SCEP-only), and `i10-api` (now with `ENROLL_REDIS_*`
   from `i10-api-enroll` and no `:3443` listener).

## First-run checks

Run in order; each one assumes the one before it passed.

```bash
NS=i10-prod
# 1. The Secrets carry their keys (never print values).
for s in i10-device-ca i10-device-ca-hooks i10-enrolld i10-enrollctl i10-acmed i10-enroll-redis-acl i10-enroll-writer-db-role; do
  printf '%s: ' "$s"
  kubectl -n $NS get secret "$s" -o go-template='{{range $k, $v := .data}}{{$k}} {{end}}{{"\n"}}'
done
# 2. The certificates are Ready.
kubectl -n $NS get certificate i10-hooks-tls-root i10-cahookrelay-tls i10-enrollctl-tls i10-profile-signing
# 3. Enrollment pods are up.
kubectl -n $NS rollout status deploy/i10-enroll-redis deploy/i10-enrollctl deploy/i10-acmed deploy/i10-enrolld deploy/i10-device-ca deploy/i10-api
kubectl -n $NS logs deploy/i10-device-ca -c step-ca | grep -E 'Serving HTTPS|error'
kubectl -n $NS logs deploy/i10-device-ca -c cahookrelay | grep listening
# 4. SCEP webhook sidecar checks webhook IDs and fails closed locally.
kubectl -n $NS exec deploy/i10-device-ca -c step-ca -- sh -c '
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for id in d4185e32-67aa-4d2c-bf83-7463fa45eaa5 00000000-0000-0000-0000-000000000000; do
    curl -sS --cacert /etc/step-ca/hooks-ca/ca.crt -X POST https://127.0.0.1:9443/scep-challenge \
      -H "Content-Type: application/json" -H "X-Smallstep-Webhook-ID: $id" \
      -d "{\"timestamp\":\"$ts\"}" -w " %{http_code}\n"
  done'
# 5. ca.i10.tech serves ACME (from acmed), SCEP (from step-ca), and 404 for everything else.
#    The untokened ACME directory is a 404 BY DESIGN: every acmed URL sits under a Mac's
#    path token (/acme/apple/d/<token>/directory, only in that Mac's sealed profile), and
#    acmed answers anything else with a bare 404 before touching Redis. Expect 404 here.
curl -sS -o /dev/null -w '%{http_code} untokened directory (want 404)\n' https://ca.i10.tech/acme/apple/directory
#    acmed itself is checked on its health endpoint, which is not routed publicly:
kubectl -n $NS port-forward deploy/i10-acmed 18080:8080 >/dev/null & pf=$!; sleep 2
curl -sS -o /dev/null -w '%{http_code} acmed healthz (want 200)\n' http://127.0.0.1:18080/healthz
kill $pf
#    A full ACME check needs a tokened URL: enroll a test Mac (or run cmd/enrollload's Mac
#    path) and fetch the DirectoryURL from its sealed profile; its JSON names URLs under the
#    same https://ca.i10.tech/acme/apple/d/<token>/ base.
curl -sS -o /dev/null -w '%{http_code} GetCACaps\n' 'https://ca.i10.tech/scep/apple-scep?operation=GetCACaps'
for p in /provisioners /roots /roots.pem /root/x /1.0/sign /sign /renew /rekey /revoke /health /version /crl \
         /acme/other/directory /scep/apple-scepx /scep/other; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" "https://ca.i10.tech$p"
done
curl -sS --path-as-is -o /dev/null -w '%{http_code} dot-dot\n' https://ca.i10.tech/acme/apple/../../provisioners
curl -sS --path-as-is -o /dev/null -w '%{http_code} encoded dot-dot\n' 'https://ca.i10.tech/acme/apple/%2e%2e/%2e%2e/provisioners'
# 6. The front's 993 asks for a client certificate naming the device CA; 465 does not.
openssl s_client -connect mail.i10.tech:993 -servername mail.i10.tech </dev/null 2>/dev/null \
  | sed -n '/Acceptable client certificate CA names/,/Requested Signature/p'
openssl s_client -connect mail.i10.tech:465 -servername mail.i10.tech </dev/null 2>/dev/null \
  | grep -c 'Acceptable client certificate CA names'   # expect 0
```

## Disk usage

With ACME moved to `i10-acmed` + `i10-enroll-redis` (bounded TTLs), `step-ca`'s
badger volume no longer accumulates unexpiring ACME nonces, accounts, or orders.
Check disk usage with
`kubectl -n i10-prod exec deploy/i10-device-ca -c step-ca -- df -h /home/step/db`;
a full volume can still be recovered by scaling `i10-device-ca` to 0 and wiping
the PVC (`deployment.yaml`).

## Rotation (year 7)

A new root and intermediate are made the same way, name-constrained the same
way. First add the new root to `ca.crt` and the new root and intermediate to
`bundle.pem`, beside the old ones, so Traefik, the front, `enrolld`, and
`enrollctl` accept both. Then put the new keys in `prod_device_ca`, restart
`i10-device-ca` and `i10-enrollctl`, and update
`CAHOOKRELAY_INTERMEDIATE_NOT_AFTER` in `device-ca/deployment.yaml` to the new
intermediate's expiry. Remove the old root from `ca.crt` once `step-ca` serves
the new chain, and the old pair from `bundle.pem` at year 10.

## What was run locally (2026-11-26)

On this exact image digest, with this `ca.json` and these templates, on a
throwaway test PKI with the real intermediate's name constraint (only the
decrypter certificate differed, to match the test key):

- step-ca started read-only, as uid 1000, with every capability dropped and no
  new privileges, from the copied binary. The unmodified binary failed with
  `operation not permitted`.
- `/health` answered; the ACME directory's links named the `Host` sent; SCEP
  `GetCACaps` answered; `/provisioners` carried the four webhook URLs and no
  key (step-ca redacts the SCEP key fields).
- step-ca's TLS certificate verified against the test root for both Service
  names and was refused for `ca.i10.tech` and `i10-api-ca-hooks.i10-prod.svc`.
- One SCEP `PKCSReq` made step-ca's own webhook client call the real
  `cahookrelay` (built from this repo, with this file's environment) at
  127.0.0.1:9443, trusted through `SSL_CERT_FILE`; the relay added the bearer
  token and the right webhook id and reached a stub of the API's listener, whose
  `allow: false` step-ca honoured.
- The front's own `ParseCertPool` read `bundle.pem` as two certificates.
