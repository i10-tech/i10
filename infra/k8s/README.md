# i10 on Kubernetes

i10 runs on the **same psl-vps, same tailnet, same k3s cluster and the same
CNPG operator** as PSL. It must still be able to leave for its own machine
without a data migration, and that is achievable only because the separation
lands at the layers that are expensive to retrofit.

## Shared, deliberately

The machine, the tailnet, the k3s cluster, the CNPG **operator**, one Argo CD
instance, cert-manager, Traefik, and OneUptime - which watches both products
but owns neither, so it costs nothing at extraction.

## Separate, from day one

Its own CNPG **Cluster**, its own Redis, its own namespace with a default-deny
NetworkPolicy, its own Doppler project, its own R2 buckets, its own repository,
its own Argo `AppProject`.

## The one thing that cannot be undone

> Any i10 code importing a PSL workspace package, or reading a PSL database row.

That turns extraction from a migration into a rewrite, and no amount of later
discipline recovers it. Treat **"does this couple i10 to PSL?"** as a blocking
review question. The good news is that i10 needs neither Keto nor its tuples,
so the most likely accidental coupling is already closed by design.

---

## What lives in the PSL repo, and why

Three things i10 depends on are **not** in this repository, and none of them is
an oversight:

| Object                                 | Where                               | Why                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `i10-prod` Namespace + NetworkPolicies | psl repo, `platform` project        | A Namespace is cluster-scoped, and the `i10` AppProject deliberately has an empty `clusterResourceWhitelist`. i10 cannot widen its own permissions by committing to its own repo - that restriction _is_ the boundary. |
| The `i10` AppProject itself            | psl repo, `argocd/projects.yaml`    | Same reason. A project that could edit its own trust boundary is not one.                                                                                                                                              |
| `cloudflare-token-i10` DopplerSecret   | psl repo, `doppler-operator-system` | It feeds **cert-manager**, which is shared platform infrastructure. i10's own workload secrets live here, in `i10-prod`.                                                                                               |
| StorageClasses `psl-zfs`, `psl-zfs-db` | psl repo, `platform` project        | Cluster-scoped platform objects. They are named `psl-*` for historical reasons, not ownership - worth renaming before i10 leaves, so nothing reads as borrowed.                                                        |

**Also needed in the psl repo before Stalwart can serve mail:** Traefik TCP
entrypoints for 25, 465, 587 and 993. The chart nests the Service spec under
`service.spec`; keys placed directly on `service` are accepted and then
**silently ignored**, which is how a dual-stack rebuild left the Service
IPv4-only while every value looked right. Verify with `kubectl get svc -o yaml`,
never by reading the values file.

---

## Layout

```
argocd/
  root.yaml          the ONLY Application applied by hand
  apps/              one file per component; adding one is a commit
i10/
  doppler/           DopplerSecrets → Kubernetes Secrets
  platform-db/       CNPG Cluster, ObjectStore, Pooler, ScheduledBackup
  redis/             The queues' Redis, i10's own
  stalwart/          the mail engine (kustomize, for config hashing)
  bulwark/           JMAP webmail - AGPL-3.0, read the header before editing
  workloads/         api, console, web, docs, and the TLS certificate
```

## Bootstrap

Argo CD, cert-manager, Traefik, CNPG and the Doppler operator are already on
the cluster - installed by the psl repo's `platform` project. i10 adds itself
in three steps.

**1. Doppler service tokens.** The one thing in `i10/doppler/` that is not in
git. Create one Secret per config, in `i10-prod`:

```bash
kubectl -n i10-prod create secret generic doppler-token-i10-root \
  --from-literal=serviceToken='dp.st.prod.…'
```

One per config: `root`, `api`, `console`, `auth`, `stalwart`, `bulwark`,
`platform`. They live in `i10-prod` rather than `doppler-operator-system`
because a `tokenSecret` must share a namespace with the `DopplerSecret` naming
it, and the `i10` AppProject cannot create objects outside `i10-*`. Following
PSL's one-namespace convention would mean a PSL-repo commit per i10 workload.

Check each token's prefix - it encodes the config it was minted from
(`dp.st.prod_api.…` vs `dp.st.prod.…`), and a token from the wrong config syncs
the wrong key set **without erroring**.

**2. The root Application.**

```bash
kubectl apply -f infra/k8s/argocd/root.yaml
```

⚠ This creates an Application **in `i10-prod`**, not `argocd`. That needs two
platform settings which live in the PSL repo, and it needs **both**:

```
argocd-cmd-params-cm    application.namespaces: i10-prod
AppProject i10          sourceNamespaces: [i10-prod]
```

The application controller and server must be restarted after the ConfigMap
changes. With only one of the two in place, Applications in `i10-prod` are
**silently ignored** - no error, no event, they simply never reconcile.

Why not the ordinary app-of-apps in `argocd`: the `i10` project's destinations
are `i10-*`, so a root in `argocd` is rejected by the very boundary that makes
i10 extractable. Of the three ways out, this is the only one where the boundary
still holds - Argo refuses to let an Application outside `argocd` claim a
project that does not list its namespace.

**3. Verify the secrets actually arrived.**

```bash
kubectl -n i10-prod get secret i10-shared -o jsonpath='{.data}' | jq 'keys'
```

⚠ A `DopplerSecret` naming keys that do not exist **does not error**. It
produces a Secret carrying only Doppler's three metadata keys and reports
healthy. Check the key list, never the condition.

## The two-secret pattern

Doppler has no folders. The layout is a root config plus branch configs, and
the inherited copies of root's keys were **deliberately deleted** from every
branch so each has a folder-like scope. The consequence: root's shared base
never reaches a consumer on its own.

```yaml
envFrom:
  - secretRef: { name: i10-shared } # prod root
  - secretRef: { name: i10-api } # prod_api
```

Later entries win on conflict. A Deployment mounting only its own config starts
without `SENTRY_DSN`, and **nothing errors** - errors go to stdout and are
reported nowhere, forever.

`SENTRY_ENVIRONMENT` used to fail the same way and no longer can: `loadEnv`
refuses to start when `NODE_ENV` is production and it was left at its
`development` fallback. Staging and production run the same image, so that
value is the only thing distinguishing their events.

## Deploying

The image tag in `workloads/*.yaml` is updated **by a commit**, not by a deploy
command. Build publishes an image and its digest goes into the manifest, so
`git log infra/` is the deployment history and a rollback is a revert.

`i10-workloads`, `i10-stalwart` and `i10-bulwark` are deliberately **not** on
automated sync: their images do not exist until the first Build run, and
automation would leave Argo permanently red on `ImagePullBackOff`. Turn it on
in the same commit that first pins a real digest.

## Edge proof: `x-i10-edge` and `EDGE_SECRET` (#345)

The origin (Traefik on :443) answers the internet directly - grey-cloud hosts
such as `mail.i10.tech` point at the same box - so `cf-connecting-ip` and the
other `cf-*` headers are only as true as the caller who typed them. The API,
console and auth app therefore believe them ONLY when the request carries
`x-i10-edge` equal to `EDGE_SECRET` (compared in constant time). Without the
proof the client address is unknown, and an unknown address is REFUSED by the
API-key and console IP allowlists. Per-IP rate limits are skipped for an
unknown address (the per-connection and per-directory caps still apply).

**1. Generate the secret** (never paste it anywhere but Doppler and Cloudflare):

    openssl rand -base64 48

**2. Doppler.** Set `EDGE_SECRET` in the i10 project, `prod` (root) config. It
reaches api, console and auth through `i10-shared`. ⚠ The API refuses to boot in
production without it (32 characters or more), so it must be in Doppler BEFORE
the code deploys. The operator syncs the Secret but no pod reloads; the deploy
restarts them.

**3. Cloudflare Transform Rule.** Rules > Transform Rules > Modify Request
Header > Create rule > "Set static":

- Rule name: `i10 edge proof`
- Expression (edit expression):
  `(http.host in {"api.i10.tech" "dash.i10.tech" "auth.i10.tech"})`
- Set static header `x-i10-edge` to the secret.

Do NOT include `clerk.i10.tech`: that host is a Worker which forwards headers
to Clerk and needs no proof (the gateway also strips `x-i10-edge` as a second
guard). Do not cover the mail, mta-sts or autoconfig hosts.

**4. Rollout order, with no lockout window.** Doppler first, the Transform Rule
second, the code deploy last. The old code ignores the header, so the first two
steps change nothing. Reversing it is the unsafe order: between a deploy and
the rule every address is unknown, and every IP-allowlisted API key and console
session would be refused.

**5. Verify.** Against the origin directly, forging an allowlisted address on a
workspace that has the API-key allowlist on:

    curl -si --resolve api.i10.tech:443:<origin-ip> \
      -H 'cf-connecting-ip: <an allowlisted address>' \
      -H "Authorization: Bearer $KEY" https://api.i10.tech/domains

Expect `403 ip_not_allowed`. The same call through Cloudflare from an
allowlisted address returns 200. The Logs page shows no address for the forged
request.

**Traefik allowlist.** `i10/workloads/edge-allowlist.yaml` defines
`i10-cloudflare-only` but is NOT attached: Traefik's Service uses klipper-lb
with `externalTrafficPolicy: Cluster`, which masquerades the source, so
attaching it would 403 everything. The file says what the PSL repo needs first.

## Traps already paid for

- **`kubectl apply` cannot create large CRDs** - they exceed the 262144-byte
  `last-applied-configuration` annotation limit. Every Application here sets
  `ServerSideApply=true`.
- **A default-deny NetworkPolicy blocks the CNPG operator, not just users.** The
  Cluster reaches 2/2 Running with initdb complete and then reports
  `Instance Status Extraction Error: HTTP communication issue`. Postgres is
  fine; the operator just cannot scrape it. The allow-from-`cnpg-system` policy
  lives in the psl repo's namespaces file.
- **Never name a `Pooler` `<cluster>-rw`, `-ro` or `-r`.** It creates a Service
  named after itself and the Cluster already owns those three. It fails as
  `phase: inactive` with `AuthUserSecret not found`, which points at entirely
  the wrong thing; the real cause is only in the operator log.
- **A branch or preview Cluster must have no `plugins` and no `backup` block.**
  Two clusters archiving to one `destinationPath` interleave WAL and corrupt
  the timeline for both.
- **Probe an image tag before pinning it.**
  `ghcr.io/cloudnative-pg/postgresql:18.5` does not exist; 18.4 and 18.6 do.
