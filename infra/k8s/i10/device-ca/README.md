# The device CA (`i10-device-ca`)

step-ca 0.30.2 with the CA webhook relay as a sidecar, the hooks transport CA,
and the `ca.i10.tech` route. It signs the certificates that sign Macs in to
their mail (#383 PR 3). The design is
`docs/research/mail-device-binding.md` section 11. This file covers the deploy:
what each manifest is, the order things come up in, and how to check them.

| File                    | What it holds                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `config/ca.json`        | step-ca's configuration: two provisioners, four webhooks, no secret                 |
| `config/apple.tpl`      | the ACME `apple` certificate template                                               |
| `config/apple-scep.tpl` | the SCEP `apple-scep` certificate template                                          |
| `deployment.yaml`       | the badger volume, the `i10-device-ca` Service, the pod (step-ca and `cahookrelay`) |
| `hooks-tls.yaml`        | the hooks transport CA (cert-manager) and the relay's `localhost` certificate       |
| `trust.yaml`            | the device CA's public certificates, for Traefik and the mail front                 |
| `networkpolicy.yaml`    | Traefik in, the API's 3443 and DNS out                                              |
| `ingressroute.yaml`     | `ca.i10.tech`: two path rules, the rate limits, the verified hop to step-ca         |

Outside this directory: the two DopplerSecrets (`doppler/dopplersecrets.yaml`),
the API's hooks Service, certificate mount, listener certificate and policy
(`workloads/api.yaml`, `certificate.yaml`, `networkpolicy.yaml`), the front's
trust bundle mount (`stalwart/node/statefulset.yaml`), and the DNS records
(`infra/tofu/stacks/dns`).

## The CA

- **Two provisioners and nothing else.** `apple`: ACME, `device-attest-01`
  only, attestation format `apple`. `apple-scep`: SCEP with the RSA decrypter.
  No JWK, OIDC, X5C or admin provisioner, `enableAdmin` off, so no remote
  management. Both have `disableRenewal`; `disableSmallstepExtensions` is never
  set, so step-ca's `/renew` and `/rekey` refuse these certificates (and
  neither path is routed anyway).
- **Lifetimes:** ACME 26280 h (1095 days, under the API's three calendar years),
  SCEP 168 h (7 days). Both end well inside the intermediate's 2036-11-26; the
  API refuses any leaf that would not (`CA_INTERMEDIATE_NOT_AFTER`).
- **SCEP encrypts its replies with AES-256-CBC** (`encryptionAlgorithmIdentifier`
  2). step-ca's default is DES-CBC. Apple's SCEP client supports AES; PR 4's
  real-device enrollment is the proof.
- **The SCEP challenge is the webhook's.** With a `SCEPCHALLENGE` webhook
  configured, step-ca asks it and never compares the static `challenge`. ⚠ Do
  not remove that webhook: without it, step-ca compares the challenge with an
  empty password, so an empty challenge would pass (the `AUTHORIZING` hook would
  still refuse, but that is the only gate left).

### The two templates

Both were rendered with go.step.sm/crypto v0.77.1 (step-ca 0.30.2's version)
exactly as step-ca builds their data, and the output was fed to the API's own
parse and `templateRefusal` (`apps/api/src/ca-hooks/body.ts`): both pass, and the
ACME template's subjectAltName extension matches the API's encoding byte for
byte.

- `apple.tpl`: CN is the order's one permanent identifier (the attested
  serial), the CSR's one OU (the permit's nonce) is copied, the permanent
  identifier is the only SAN, `digitalSignature`, EKU `clientAuth` only. An
  order without exactly one permanent identifier, or a CSR without exactly one
  OU, fails at render. The CSR's DNS names are never copied.
- `apple-scep.tpl`: CN only, no SANs, `digitalSignature` and `keyEncipherment`,
  EKU `emailProtection` only. A CSR without a CN fails at render. The CSR's DNS
  names and OUs are never copied.

### The image

`smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270`,
the multi-arch index digest, read with
`docker buildx imagetools inspect smallstep/step-ca:0.30.2` (a registry read;
nothing was pushed). Its user `step` is uid and gid 1000, from the image's own
build history.

⚠ **The binary carries a file capability** (`setcap CAP_NET_BIND_SERVICE=+eip`
in step-ca's Dockerfile). With every capability dropped, Linux refuses to exec
it: `exec /usr/local/bin/step-ca: operation not permitted`. The init container
copies it into an `emptyDir` (a copy has no file capability) and step-ca runs
the copy, mounted read-only. It listens on 9000 and needs no capability.

### Where the keys are

- `prod_device_ca` in Doppler, synced to the Secret `i10-device-ca`
  (token Secret `doppler-token-i10-device-ca`): the root and intermediate
  certificates, the intermediate key (PKCS#8, unencrypted, so step-ca runs with
  no `--password-file`), and the SCEP decrypter's certificate and key.
- Mounted into the step-ca container only, by named `items`. The decrypter's
  certificate is also in `ca.json` (public; step-ca has no file option for it).
  If it ever disagrees with the key, step-ca refuses to start
  (`mismatch between decrypter certificate and decrypter public keys`).
- ⚠ The Doppler config inherits the root `prod` config's keys, shadowed today
  with empty values. The DopplerSecret's `secrets:` list and the `items:` mount
  both keep a later root key out of this pod.
- `prod_device_ca_hooks`, synced to `i10-device-ca-hooks` (token Secret
  `doppler-token-i10-device-ca-hooks`): `CA_HOOK_TOKEN`, mounted into the relay
  only. step-ca never holds it.

## The hooks transport CA

A namespace-local cert-manager CA used for nothing else: `i10-hooks-tls-bootstrap`
(self-signed) signs `i10-hooks-tls-root` (20 years, key never rotated), and the
CA Issuer `i10-hooks-tls` signs two leaves:

| Certificate            | Names                           | Life     | Trusted by                                                                    |
| ---------------------- | ------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `i10-cahookrelay-tls`  | `localhost`, `IP:127.0.0.1`     | 90 days  | step-ca, through `SSL_CERT_FILE`                                              |
| `i10-api-ca-hooks-tls` | `i10-api-ca-hooks.i10-prod.svc` | 10 years | the relay, through `CAHOOKRELAY_UPSTREAM_CA_FILE` (its own Secret's `ca.crt`) |

⚠ **`SSL_CERT_DIR` is set as well as `SSL_CERT_FILE`.** Go's root loader reads
`SSL_CERT_FILE` instead of the default bundle file, but it still reads every
file in `/etc/ssl/certs` unless `SSL_CERT_DIR` names other directories
(`crypto/x509/root.go`, `loadOnDiskRoots`). With only `SSL_CERT_FILE`, step-ca's
webhook client would also trust the image's public CA bundle.

The relay re-reads its certificate every 30 seconds, so its 90-day renewal
needs nothing. The API reads its certificate once (`Bun.serve` cannot reload
`tls`): restart the API after the first issue and after the reissue around
year 7.

## Who trusts the device CA

Only Traefik and the mail front, from `trust.yaml`:

- `ca.crt` (the root): Traefik's `ServersTransport` verifies step-ca's own TLS
  certificate against it for `serverName: i10-device-ca.i10-prod.svc`. step-ca
  cuts that certificate from the intermediate for `ca.json`'s `dnsNames`, the
  two names the intermediate is constrained to.
- `bundle.pem` (root and intermediate): the front's `MAILFRONT_DEVICE_CA_BUNDLE`
  on the edge StatefulSet only. 993's certificate request lists these subjects,
  and a Mac picks an identity whose issuer is listed (the intermediate).

## The public surface

`ca.i10.tech`, DNS-only (grey cloud), through Traefik with the existing
wildcard certificate, path-scoped to `PathPrefix(/acme/apple/)` and
`Path(/scep/apple-scep) || PathPrefix(/scep/apple-scep/)`. Everything else on the
host (`/provisioners`, `/roots`, `/root/*`, `/1.0/*`, `/sign`, `/renew`,
`/rekey`, `/revoke`, `/health`, `/version`, `/crl`) matches no router and gets
Traefik's plain 404.

Rate limits, per client address and for the whole host: 30 and 120 requests a
minute, 4 and 16 in flight, bodies at most 1 MiB. The host-wide limit is what
bounds the badger volume: every new nonce, account and order is a row step-ca
never expires.

## Network policies, and what they do not do

`i10-device-ca` admits Traefik on 9000 and lets the pod out to the API's 3443
and CoreDNS only. `api-ca-hooks-clients` (workloads) admits the step-ca pod to
the API's 3443. ⚠ Policies only add: the psl repo's `allow-traefik` and
`allow-cnpg-operator` let every pod in `traefik` and `cnpg-system` reach every
port here, so step-ca's 9000 and the API's 3443 are reachable from those two
namespaces whatever these files say. Neither is useful there: step-ca has no
admin surface and every issuance asks the API; the API's listener answers
anything without the relay's token with a bare 404. The egress half is real:
this pod reaches nothing else.

## Rollout

The manifests are safe in any order Argo syncs them; the list below is the
order they become useful in. Everything except DNS arrives with the merge.

1. **DopplerSecrets** (`i10-doppler-secrets`): `i10-device-ca` and
   `i10-device-ca-hooks`. Until they exist the step-ca pod waits in
   `ContainerCreating`.
2. **The hooks transport CA and its certificates** (cert-manager, from
   `i10-device-ca` and `i10-workloads`). Until the relay's certificate exists
   the pod keeps waiting; until the API's exists, the API's optional mount is
   empty and its listener stays off (`no_certificate`).
3. **step-ca with the relay** (`i10-device-ca`).
4. **The API's Service, mount and policy** (`i10-workloads`). The pod template
   changes (fsGroup, port, env, mount), so the API rolls by itself. If it rolled
   before `i10-api-ca-hooks-tls` existed, restart it once the Secret is there:
   `kubectl -n i10-prod rollout restart deploy/i10-api`.
5. **The front's bundle** (`i10-stalwart`). Optional mount, read every 30
   seconds. ⚠ The pod template changes (the mount and the two
   `*_MAC_SMTP_SAME_ADDRESS` settings), so **both Stalwart nodes roll**: a short
   mail restart, as for any Stalwart manifest change.
6. **Traefik** (`i10-device-ca`). ⚠ The route answers as soon as it syncs:
   before the DNS record, the proxied `*.i10.tech` wildcard already sends
   `ca.i10.tech` to Traefik through Cloudflare. Same two paths either way; with
   step-ca not ready it answers 503.
7. **DNS, by hand, last:** `infra/tofu/stacks/dns`, two new records `ca_v4` and
   `ca_v6`. The plan must show exactly those two additions and nothing else.
   Apply only after the first-run checks below pass.

No Doppler value changes in this deploy: the API already has its three
`CA_HOOK_*` settings, and the relay's token and the CA's keys are new Secrets
that no running pod reads. The one restart that may be needed is the API's,
in step 4.

## First-run checks

Run in order; each one assumes the one before it passed.

```bash
NS=i10-prod
# 1. The Secrets carry their keys (never print values).
kubectl -n $NS get secret i10-device-ca -o go-template='{{range $k, $v := .data}}{{$k}} {{end}}{{"\n"}}'
kubectl -n $NS get secret i10-device-ca-hooks -o go-template='{{range $k, $v := .data}}{{$k}} {{end}}{{"\n"}}'
# 2. The three certificates are Ready.
kubectl -n $NS get certificate i10-hooks-tls-root i10-cahookrelay-tls i10-api-ca-hooks-tls
# 3. step-ca and the relay are up.
kubectl -n $NS rollout status deploy/i10-device-ca
kubectl -n $NS logs deploy/i10-device-ca -c step-ca | grep -E 'Serving HTTPS|error'
kubectl -n $NS logs deploy/i10-device-ca -c cahookrelay | grep listening
# 4. The API's listener is on (restart it first if this finds nothing).
kubectl -n $NS logs deploy/i10-api | grep 'ca hooks'          # expect "ca hooks listening"
# 5. The relay reaches it. A body without attestation data is refused before
#    any database work: expect {"allow":false} and 200. A wrong id: 404.
kubectl -n $NS exec deploy/i10-device-ca -c step-ca -- sh -c '
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for id in e39699ea-6eab-4326-a1ef-fd8c6899a7ef 00000000-0000-0000-0000-000000000000; do
    curl -sS --cacert /etc/step-ca/hooks-ca/ca.crt -X POST https://127.0.0.1:9443/acme-authorize \
      -H "Content-Type: application/json" -H "X-Smallstep-Webhook-ID: $id" \
      -d "{\"timestamp\":\"$ts\"}" -w " %{http_code}\n"
  done'
kubectl -n $NS logs deploy/i10-device-ca -c cahookrelay | grep 'webhook relayed'
# 6. ca.i10.tech serves only the two prefixes (through Cloudflare until step 7
#    of the rollout, then direct). Expect 200, 200, then 404 for every other.
curl -sS -o /dev/null -w '%{http_code} directory\n' https://ca.i10.tech/acme/apple/directory
curl -sS -o /dev/null -w '%{http_code} GetCACaps\n' 'https://ca.i10.tech/scep/apple-scep?operation=GetCACaps'
for p in /provisioners /roots /roots.pem /root/x /1.0/sign /sign /renew /rekey /revoke /health /version /crl \
         /acme/other/directory /scep/apple-scepx /scep/other; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" "https://ca.i10.tech$p"
done
curl -sS --path-as-is -o /dev/null -w '%{http_code} dot-dot\n' https://ca.i10.tech/acme/apple/../../provisioners
curl -sS --path-as-is -o /dev/null -w '%{http_code} encoded dot-dot\n' 'https://ca.i10.tech/acme/apple/%2e%2e/%2e%2e/provisioners'
# The directory's links must name https://ca.i10.tech/acme/apple/ (Host kept).
curl -sS https://ca.i10.tech/acme/apple/directory
# 7. The front's 993 asks for a client certificate naming the device CA; 465 does not.
openssl s_client -connect mail.i10.tech:993 -servername mail.i10.tech </dev/null 2>/dev/null \
  | sed -n '/Acceptable client certificate CA names/,/Requested Signature/p'
openssl s_client -connect mail.i10.tech:465 -servername mail.i10.tech </dev/null 2>/dev/null \
  | grep -c 'Acceptable client certificate CA names'   # expect 0
# 8. After the DNS apply: grey cloud on both families, then repeat check 6 with -4 and -6.
dig +short A ca.i10.tech; dig +short AAAA ca.i10.tech     # the box, not Cloudflare
```

## Disk usage

⚠ **There is no alerting path in the cluster to attach a disk alert to.**
Neither repo runs Prometheus, Alertmanager, kube-state-metrics or a node
exporter (Stalwart's exporter was deferred for the same reason, see
`stalwart/config/README.md`), and OneUptime is the hosted service, with nothing
in-cluster reporting to it. Proposed, not built: a CronJob here that mounts the
`i10-device-ca-db` volume read-only (ReadWriteOnce allows a second pod on the
same node), and when usage passes 70 percent calls a OneUptime incoming-request
monitor whose URL lives in Doppler, so the alert lands where the rest of i10's
monitoring does. Until then, check by hand:
`kubectl -n i10-prod exec deploy/i10-device-ca -c step-ca -- df -h /home/step/db`.
A full volume is recovered by wiping it (`deployment.yaml`, the PVC's comment).

## Rotation (year 7)

A new root and intermediate are made the same way, name-constrained the same
way. First add the new root to `ca.crt` and the new root and intermediate to
`bundle.pem`, beside the old ones, so Traefik and the front accept both. Then
put the new keys in `prod_device_ca`, restart step-ca, and set
`CA_INTERMEDIATE_NOT_AFTER` in `prod_api` to the new intermediate's (restart the
API). Remove the old root from `ca.crt` once step-ca serves the new chain, and
the old pair from `bundle.pem` at year 10.

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
