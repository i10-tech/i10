# Migrating Stalwart v0.16 to v1.0 (#365)

v1.0 cannot open a v0.16 store. `stalwart-migrate` copies database `stalwart`
into the empty `stalwart_v1` (both in `../database.yaml`) while v0.16 keeps
serving, then makes one last copy with every v0.16 node stopped. R2 is shared:
blobs are not copied, only the rows that point at them.

This directory is applied by hand. The parent kustomization does not list it,
so Argo neither deploys nor prunes it.

Rehearsed end to end on 2026-11-06 in a scratch namespace: v0.16.27 on
Postgres, our `plan.ndjson` applied, an S3 blob store, this exact pod spec,
`prepare`, `run`, `run --final`, then v1.0.3 started on the result. The v1.0
`plan.ndjson` then dry-ran as unchanged against it.

## Before you start

- v0.16.27 runs on both nodes (the first #365 PR). The tool refuses an older
  source.
- `stalwart_v1` exists and is empty. CNPG creates it from `../database.yaml`.
- `source.json` is byte-for-byte the v0.16 `../config/config.json`, and
  `target.json` is what `../config/config.json` becomes. The tool fingerprints
  both and refuses to continue with either changed, so never edit them
  mid-migration.

Every command below runs from a laptop with this repo checked out.

## 1. Start the tool

```sh
kubectl kustomize infra/k8s/i10/stalwart/migrate | ssh psl-vps kubectl apply -f -
ssh psl-vps kubectl -n i10-prod wait --for=condition=Ready pod/i10-stalwart-migrate
```

## 2. Prepare

⚠ **`prepare` NEEDS A TERMINAL ON BOTH ENDS**, so both `ssh -t` and `exec -it`.
Piped answers are refused.

```sh
ssh -t psl-vps kubectl -n i10-prod exec -it i10-stalwart-migrate -- \
  stalwart-migrate prepare --source /etc/stalwart/config.json
```

The answers the rehearsal gave, all the defaults:

| Question                  | Answer        | Why                                                                                                            |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| External blob store       | `reuse`       | R2 is shared; copying it would double the bucket for nothing                                                   |
| Data categories           | all           | the queue and tasks are copied by the final run only anyway                                                    |
| Changed defaults          | `recommended` | pins the defaults whose change alters behaviour (Pyzor stays on); the tuning plan sets those it wants          |
| OAuth client registration | `accept`      | 1.0 refuses unregistered `client_id`s; we have no OAuth clients yet                                            |
| New permissions           | `grant`       | roles that had an old permission get its 1.0 counterpart; built-in roles get their 1.0 defaults in either case |

Then read the report. On the rehearsal it showed 0 dropped objects and 48
warnings, every one either a permission 1.0 no longer has or an OIDC provider
field without an equivalent:

```sh
ssh psl-vps kubectl -n i10-prod exec i10-stalwart-migrate -- cat /var/lib/stalwart-migrate/prepare-report.txt
```

## 3. Copy while v0.16 serves

Repeat as often as you like; each run copies what changed since the last one.
Run it once more just before the window, so the final copy is short.

```sh
ssh psl-vps kubectl -n i10-prod exec i10-stalwart-migrate -- \
  stalwart-migrate run --source /etc/stalwart/config.json --target /etc/stalwart-v1/config.json
ssh psl-vps kubectl -n i10-prod exec i10-stalwart-migrate -- stalwart-migrate status
```

## 4. The window

⚠ **ARGO WOULD RESTART v0.16 UNDER THE FINAL RUN.** Both StatefulSets are
`selfHeal`, so scaling them to 0 by hand is reverted within minutes, and
`i10-root` selfHeals `i10-stalwart`'s own sync policy back. Either pause both
apps, or make the stop a commit:

- **Pause (faster).** Turn automation off on `i10-root` first, then on
  `i10-stalwart`:

  ```sh
  ssh psl-vps 'for a in i10-root i10-stalwart; do kubectl -n i10-prod patch application $a --type merge -p "{\"spec\":{\"syncPolicy\":{\"automated\":null}}}"; done'
  ssh psl-vps kubectl -n i10-prod scale sts i10-stalwart i10-stalwart-internal --replicas=0
  ```

- **Commit (no hand state).** Merge a change setting `replicas: 0` on both
  nodes, and let Argo stop them.

Wait until neither pod exists, then:

```sh
ssh -t psl-vps kubectl -n i10-prod exec -it i10-stalwart-migrate -- \
  stalwart-migrate run --final --source /etc/stalwart/config.json --target /etc/stalwart-v1/config.json
```

It asks for `yes`, watches the v0.16 store for 30 seconds to check nothing
writes to it, copies the rest (the queue and scheduled tasks included),
finalises the store, verifies a sample of accounts and, last, writes the 1.0
spam model over the 0.16 one in R2. Then:

```sh
ssh psl-vps kubectl -n i10-prod exec i10-stalwart-migrate -- stalwart-migrate report --severity error
ssh psl-vps kubectl -n i10-prod exec i10-stalwart-migrate -- stalwart-migrate verify --full \
  --source /etc/stalwart/config.json --target /etc/stalwart-v1/config.json
```

Merge the v1.0 PR (image v1.0.3, `config.json` on `stalwart_v1`, the converted
`plan.ndjson`). If you paused, restore automation on `i10-root` with `kubectl
apply -f infra/k8s/argocd/root.yaml` (it puts `i10-stalwart`'s back too), or
patch both back to `{"prune":true,"selfHeal":true}`. If you used the commit,
the v1.0 PR restores `replicas: 1`.

## 5. Check v1.0

- `PLAN_FILE=<v1.0 plan.ndjson> ./bootstrap.sh --dry-run` reports every object
  unchanged. Anything else means the plan and the migrated settings disagree.
- Both nodes are `active` in `x:ClusterNode/get`.
- An IMAP login on 993 works. That is the first proof that authd answers v1.0's
  LDAP binds, which the rehearsal could not test without Clerk.
- Mail in on 25, out on 465 and through the 2525 relay, and the webhook arrives
  at the API for each.
- The logs show the search index rebuilding. Searches are incomplete until it
  finishes; OAuth clients sign in again; DAV clients refetch once.

## Going back

- **Before v1.0 has served anyone:** scale v1.0 to 0, revert the v1.0 PR, and
  v0.16.27 starts on `stalwart` exactly as it was. Its spam model in R2 has
  been overwritten, so it retrains from the samples.
- **After:** v1.0 deletes R2 blobs it no longer references, including ones the
  stale `stalwart` still names. So `stalwart` is no longer a fallback;
  `stalwart-migrate rollback` copies v1.0 into a new, empty v0.16 database, and
  it needs this pod's state volume.

## Cleaning up

Once v1.0 has proved itself: delete the pod and the claim (psl-zfs deletes the
volume with it), drop `stalwart` from `../database.yaml` (it is
`databaseReclaimPolicy: retain`, so drop the database by hand too), and delete
this directory.
