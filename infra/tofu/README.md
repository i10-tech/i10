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

**`i10-tofu-state-rw` IS IP-ALLOWLISTED TO psl-vps, AND THE DENIAL IS
INDISTINGUISHABLE FROM A DEAD KEY.** The token permits only
`178.105.164.132` and `2a01:4f8:1c18:45fb::1`. Used from anywhere else — a
laptop, CI — R2 answers the same `<Code>AccessDenied</Code>` it returns for a
revoked credential, with nothing naming the address as the cause. Every
diagnostic points the wrong way: the key is well-formed, it fails on **every**
bucket rather than one, and the dashboard shows the token active with the right
permission. The conclusion that fits all of it is "the key is dead", and acting
on it means rotating a perfectly good credential and watching the new one fail
identically.

⚠ **THEREFORE THIS STACK RUNS FROM psl-vps, NOT A WORKSTATION.** That is the
posture the allowlist buys: a credential that can write DNS state is usable from
one machine. Note the asymmetry — `CLOUDFLARE_API_TOKEN` is **not** restricted,
so provider reads succeed from a laptop and only the state backend fails, which
is why `tofu init` gets as far as "Successfully configured the backend" before
erroring on `HeadObject`.

Confirm where you are before believing any other diagnosis:

```bash
curl -s -4 https://ifconfig.me   # want 178.105.164.132
```

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

## Who owns the zone

`i10.tech` has **two owners on purpose**. A proxied wildcard `*.i10.tech`
covers every web surface — `dash`, `auth`, `api`, `docs` — and stays
hand-managed in Cloudflare. Tofu owns the mail half: the host Stalwart answers
on, the MX, SPF, DKIM, DMARC, the RFC 6186 client-provisioning records and the
MTA-STS policy id — twenty-two records in all.

The split is by blast radius. A wrong web record is a 522 somebody notices in a
minute. A wrong SPF or DKIM record fails DMARC **silently**, while damaging
sender reputation, and the first symptom is mail landing in spam days later.
Those are the records that want a reviewed plan.

### What the reconciliation changed (2026-09-02)

`stacks/dns` had **never been applied** — no `backend.hcl`, no
`terraform.tfvars`, only the examples. Every record in the zone had been created
by hand, and the file had been written from intent months earlier. By the time
mail actually flowed, the two had diverged, and applying it would have been
worse than not having it:

| the file said                      | the zone says                | applying it would have                                                      |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `v=spf1 include:spf.i10.tech ~all` | `v=spf1 mx -all`             | dropped the `mx` mechanism, so **every message Stalwart sends fails SPF**   |
| a `spf.i10.tech` include record    | does not exist               | created a record nothing references yet                                     |
| `p=none; …; fo=1`                  | `p=none; …; adkim=s; aspf=s` | silently loosened alignment                                                 |
| relative names (`name = "mail"`)   | fully qualified              | shown a diff on **every** record — provider v5 dropped the v4 relative form |
| 5 records                          | 22                           | left 17 mail records unmanaged                                              |

Every resource now carries an `import` block and every value was read back from
the API rather than written from intent. **The contract is that `tofu plan` on
an untouched zone is empty.** A non-empty plan means either the zone was edited
by hand or the file is stale — both worth knowing before an apply.

The SES portability record (`spf.i10.tech`) is deliberately still absent: it
belongs with the apex SPF change, and both are noted in `main.tf` as the thing
to do the day SES production access lands. Adding it now would break the
empty-plan contract for no benefit.

## Every stratum imports rather than creates

Both R2 buckets and the state bucket were made by hand before these stacks
existed, so all three are adopted through `import` blocks. Keep it that way: a
stack that creates nothing means its committed tfvars **is** the recipe for
rebuilding state — lose the state file, re-run init, and the imports put it
back. Import blocks are evaluated during `plan`, which is read-only, so a wrong
id fails before anything is touched.

That property weakens the moment a stratum creates rather than imports. When
`stacks/platform` holds a real machine, add `i10-tofu-state` to the nightly
backup job — timestamped copies, never overwritten.
