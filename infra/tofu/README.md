# OpenTofu

**Tofu owns shape. Never data, never deploys.**

Kubernetes workloads are Argo's job (`infra/k8s`). Secrets are Doppler's. What
lives here is the substrate underneath both: R2 buckets, DNS records, and —
eventually — machines.

## The strata

State splits by **blast radius**, one state file per stratum. A stack reads
from lower strata and never writes to them.

|     | Stratum     | Holds                          | Notes                                 |
| --- | ----------- | ------------------------------ | ------------------------------------- |
| S0  | `bootstrap` | The `i10-tofu-state` R2 bucket | Local state, **committed on purpose** |
| S1  | `data`      | R2 buckets, the zone lookup    | `prevent_destroy` on everything       |
| S2  | `platform`  | Machines                       | **Empty today** — i10 shares psl-vps  |
| S3  | `dns`       | Every record on `i10.tech`     | The most product-critical stack here  |

### Why S0's state is committed

It holds one bucket name and no secrets, and it creates the bucket every other
stack stores state in — so it cannot store its own state there. The alternative
is a bucket nothing can recreate if it is lost.

### Why S2 is empty and still exists

i10 runs on psl-vps: same box, same tailnet, same k3s cluster, same CNPG
operator. There is no machine of its own to create. The `for_each` iterates a
map that is currently `{}`, and declaring the node shape while the count is
zero is what makes the first real machine a tfvars edit rather than a resource
written under time pressure. Same reasoning as the `i10` Argo AppProject being
defined before i10 existed: a boundary is free to create early and expensive to
retrofit.

## Running a stack

```bash
cd stacks/<stratum>
cp backend.hcl.example backend.hcl        # then fill in the account id
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan -out=tfplan
```

`stacks/bootstrap` has no backend — it runs on local state and skips the
`init -backend-config` line.

**Apply is a human action**, deliberately. `tofu.yml` formats, validates and
plans; it never applies. A DNS mistake on a mail domain is a deliverability
incident, not a rollback.

## Traps already paid for

**An R2 token's dashboard label can lie.** It can say bucket-scoped while its
actual policy is not, and the symptom is `AccessDenied` on both ListObjectsV2
and HeadObject — which reads as a missing-object 403. Set the permission
**first**, then pick the bucket. Prove any key pair before wiring it in:

```bash
curl -s --aws-sigv4 "aws:amz:auto:s3" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "https://<account>.r2.cloudflarestorage.com/i10-tofu-state?list-type=2"
```

Want `<ListBucketResult>`, not `<Error>`.

**`TF_ENCRYPTION` needs an unquoted heredoc delimiter**, so the shell
interpolates the passphrase, and one attribute per line. Written on one line,
`state { method = … enforced = true }` is invalid HCL and fails with an error
that never mentions encryption.

**R2 has no object versioning**, and a bucket lock is not a substitute — locks
prevent objects being deleted _or overwritten_, and OpenTofu overwrites the
state object on every apply. A lock on the state bucket breaks the second apply.

**Never put a bucket lock on `i10-backups` either.** CNPG's Barman prunes
expired WAL and base backups itself, on its own schedule, and would fail
silently underneath a lock tuned to something else's horizon.

## The one thing to back up

PSL's durable stratum is import-only, so its committed tfvars is a complete
recipe for rebuilding state. **i10's is not** — this stack creates its buckets
rather than importing them, so Tofu is the only thing that knows it owns them.

Add `i10-tofu-state` to the nightly backup job: timestamped copies, never
overwritten. Losing that state means importing every bucket by hand.
