# i10

Transactional **and** human email. Stalwart as the mail engine, SES for
outbound relay, a Resend-compatible API, and an interface that is the point
rather than the polish.

Pronounced _i-ten_ — `i` + 10 letters = **integration**.

> **Keep your code, change one import.** `resend/node` → `@i10/node`.

That promise makes the API surface a constraint accepted up front, not a design
space. `Authorization: Bearer`, the same request and response shapes, the same
error semantics. Only the key _format_ is ours: `i10_live_…`.

---

## Hosts

|                   |                                                  |
| ----------------- | ------------------------------------------------ |
| `i10.tech`, `www` | marketing — `apps/web`, not being built yet      |
| `dash.i10.tech`   | the console                                      |
| `auth.i10.tech`   | `apps/auth` — Clerk, prebuilt components for now |
| `api.i10.tech`    | the send API                                     |
| `docs.i10.tech`   | the docs                                         |
| `mail.i10.tech`   | Stalwart — grey-cloud, the one unproxied name    |
| `_spf.i10.tech`   | the SPF include customers point at               |

## Layout

```
apps/
  api        Hono — the send API. Not Next: it returns a message id in
             single-digit ms, holds long-lived Postgres and Redis pools, runs
             BullMQ workers from the same code, and receives SES webhooks.
  console    Next — dash.i10.tech. Domains, DNS onboarding, keys, message log.
  web        Next — i10.tech. Scaffold only; the marketing site is not being
             built yet.
  docs       Nimbus (Astro) — docs.i10.tech. Pagefind search, Scalar for the
             API reference, markdown twins and llms.txt built in.

packages/
  node       @i10/node — the published SDK. ZERO runtime dependencies.
  next       @i10/next — server client and a signed webhook route handler.
  contracts  @repo/contracts — the zod wire contract. Server-side only.
  ui         @repo/ui — shadcn/ui foundation and design tokens.
  eslint-config, typescript-config

infra/
  k8s        Argo CD app-of-apps, CNPG, Redis, Stalwart, Bulwark, workloads.
  tofu       R2 buckets, DNS, and (empty until extraction) machines.
```

## Getting started

```bash
corepack enable
pnpm install
pnpm dev
```

|            |                                                            |
| ---------- | ---------------------------------------------------------- |
| Node       | 22.12+                                                     |
| pnpm       | 11.24.0 — pinned in `packageManager`, corepack picks it up |
| TypeScript | 6.0.3                                                      |

`pnpm build` · `pnpm lint` · `pnpm check-types` · `pnpm test` · `pnpm format`

---

## Three things that are settled

### The sending architecture

Customers publish three records:

```
send.customer.com             MX    10 feedback-smtp.eu-central-1.amazonses.com
send.customer.com             TXT   "v=spf1 include:_spf.i10.tech ~all"
i10._domainkey.customer.com   TXT   p=<our public key>
```

SPF aligns **and** DKIM aligns, Gmail shows `mailed-by: customer.com`, and
Google's bulk-sender rules are satisfied. Onboarding ships as two tiers: the
DKIM record alone gets a customer sending in two minutes, and the MX and SPF
make the envelope theirs before volume matters.

**⚠ The region is baked into every customer's DNS.** The bounce MX must point at
`feedback-smtp.<region>.amazonses.com`; SES re-verifies it continuously, and
RFC 2181 forbids an MX target that is a CNAME, so it cannot hide behind an i10
hostname. Leaving SES — or merely changing AWS region — means every customer
edits DNS. It is **eu-central-1**, chosen once.

`include:_spf.i10.tech` buys the other half: adding a second relay, or swapping
the sending path, without touching anyone's DNS.

### i10 must be able to walk away from PSL

It runs on the same box, the same tailnet, the same k3s cluster and the same
CNPG **operator**. Separate from day one: its own CNPG Cluster, its own Redis,
its own namespace with default-deny NetworkPolicy, its own Doppler project, its
own R2 buckets, its own Argo `AppProject`, this repository.

> **The one thing that cannot be undone:** any i10 code importing a PSL
> workspace package, or reading a PSL database row. That turns extraction from
> a migration into a rewrite. Treat _"does this couple i10 to PSL?"_ as a
> blocking review question.

### Versioning is the git tag

Nothing in the repo consumes a version number, so there is no version file, no
bump commit and no release PR. `.github/scripts/next-version.mjs` derives the
next version from conventional commits and `release.yml` tags it. Pre-1.0, both
`feat:` and a breaking change take the minor — going 1.0 is a product decision,
not something a commit message triggers.

**Commit messages are load-bearing, not style.** A non-conventional subject is
_skipped_ by the version script rather than rejected, so a release can silently
bump patch when it should have bumped minor. `commitlint` in CI is the guard.

```
feat(api): accept scheduled_at on POST /emails
fix(sdk): do not retry daily_quota_exceeded
```

Scopes are enumerated in `commitlint.config.mjs`.

---

## Deploying

Argo CD watches `main`. The image tag in `infra/k8s/i10/workloads/` is updated
**by a commit** — so `git log infra/` is the deployment history and a rollback
is a revert. One image serves both environments; a promotion re-tags the
staging artifact rather than rebuilding it.

See [`infra/k8s/README.md`](infra/k8s/README.md) for the bootstrap, the
two-secret Doppler pattern, and what deliberately lives in the PSL repo.

## Known constraints worth reading before you touch them

- **Bulwark is AGPL-3.0-only.** Running it unmodified is fine. Modifying it
  obliges publishing the modification, because §13 covers network interaction
  and Bulwark is a server. See the header of
  `infra/k8s/i10/bulwark/bulwark.yaml`.
- **Stalwart is pre-1.0** and its schema is still moving. Pinned one release
  behind latest; read every migration note.
- **ESLint is held at 9.x** — every plugin supports 10 except
  `eslint-plugin-react`.
- **`mail.i10.tech` must stay grey-cloud.** Cloudflare's proxy carries only
  HTTP/HTTPS. Publishing that record also publishes the origin IP, which is
  unavoidable for mail.
- **The zone has two owners.** A proxied `*.i10.tech` wildcard covers the web
  surfaces by hand; OpenTofu owns only the mail records.
