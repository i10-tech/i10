# Risk: scoring workspaces, holding abuse, and watching sign-ins

**Decided:** 2026-09-28, in a discussion-first session for #170. **Status:**
built in one branch (`feat/170-risk-engine`), by the user's explicit choice to
ship everything agreed at once rather than a PR per phase.

This is the record of what was agreed and why. It supersedes the sketches in
#170, #165 (tiers, already shipped) and #166 (rescoped here).

---

## The threat we are actually defending against

One bad workspace is already contained. Every workspace is its own SES tenant
(#156) under SES's Standard reputation policy, so a HIGH finding pauses that
tenant and our accept gate refuses its mail (#157). The free plan caps it at
100 a day and the tier at 3,000 a month (#165).

⚠ **What nothing contained was breadth.** Fifty free workspaces each sending
100 a day to a bought list never trip a per-tenant threshold early, and their
bounces and complaints still land in our SES ACCOUNT's aggregate rates, which
is what AWS reviews and pauses. A farm is the attack the product was open to.
Sending requires a verified domain, so every fake workspace costs the attacker
a domain - or a subdomain of one domain, which costs nothing. The farm
detection below exists for that gap and is the priority of this work.

---

## The shape

```
signals (facts we already store, plus new ones)
   │
   ▼
rules ──► score 0-100 + band + contributions (every point explained)
   │
   ▼
decide ──► actions through ONE door each (tier, hold, SES policy, alert)
   │
   ▼
record ──► assessment + event history (staff review, appeals, training labels)
```

It runs **hourly** as its own CronJob, **immediately** for one workspace when
something happens to it (an SES pause or HIGH finding, a farm tripwire, an
identity anomaly), and **at accept** only for the cheap real-time pieces
(content fingerprints, holds).

### Rules, not a model, from day 1

- **Additive rules with numbers attached**, SpamAssassin's shape: every rule
  that fires adds (or subtracts) points and says why, with the evidence that
  made it fire. The score is the clamped sum; a few rules also set a minimum
  band regardless of points ("an AWS-managed pause is at least high").
- **Recomputed from facts every run, never accumulated.** Decay is the rule's
  window ("paused in the last 30 days: +60"), so a score cannot get stuck and
  a bug in one run does not poison the next.
- **Versioned.** Each assessment records `RULESET_VERSION`, so "the score
  moved because we changed the rules" is distinguishable from "the customer
  changed behaviour".
- **Minimum volumes on every rate.** On 100 sends one complaint is 1%. Rates
  need a denominator and a count before they speak.
- **Earned trust is negative points**, so a workspace can recover and a
  long-standing customer is not one bad day from a hold.
- **No shadow mode.** The user chose protection from day 1. That is safe
  because the automatic actions stop at tier moves and holds, and termination
  is never automatic.

### The model comes later, and only as one more rule

A model trained only on scenarios we write learns our generator, not
attackers - it would be confident and wrong on the first farm that does not
look like our fixtures, and a hold it cannot explain is weak in an appeal and
exposed under GDPR Article 22. So:

- The **synthetic scenarios** (farm, bought list, phishing, a legitimate
  startup ramping up, a legitimate newsletter) are the **rule test suite**: a
  rule change must catch every abuse scenario and leave every legitimate one
  alone.
- **Labels are collected from day 1**: staff holds upheld or released, staff
  labels, SES AWS-managed pauses, long clean tenure. Each label stores the
  feature vector as it was at labelling time, so training never has to
  reconstruct history.
- The **model** (logistic regression, so each feature's contribution is
  explainable) is trained by `risk-admin train` and retrained by the hourly
  run when new labels exist. It is **only activated** when a held-out
  evaluation on real labels passes (minimum label counts per class and AUC);
  until then it records predictions and contributes nothing.
- **Laya** (a 421M-parameter text classifier) is a content classifier behind
  `LAYA_URL`, run off the send path on sampled mail from already-elevated
  workspaces. It needs a GPU host we do not have on the CX33, so it is off
  until that URL exists.

---

## Bands and what they do

| Band      | Score    | Free workspace                                  | Paid workspace                                                       |
| --------- | -------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| low       | under 30 | `normal` (only after 14 clean days in `strict`) | nothing                                                              |
| elevated  | 30-59    | `strict`                                        | staff alert                                                          |
| high      | 60-84    | `strict`                                        | SES tenant switched to the **Strict** reputation policy, staff alert |
| critical  | 85+      | **hold**                                        | **hold**                                                             |
| terminate | -        | **people only, never the score**                | same                                                                 |

⚠ **Termination is human-only.** The score may hold; only staff may end a
workspace.

### Tiers

The score moves a free workspace's tier through `sendingTierStore.set` with
`source: "score"`. ⚠ `set` now takes `respectStaff`: under the same `FOR
UPDATE` lock it refuses when the current row's source is `staff`, so a staff
decision can never be overwritten by the next run - checking `current()`
first and calling `set()` second would leave a window between the two.

### Holds

A hold is its own table, `core.sending_holds`, with `core.sending_hold_events`
beside it - the same shape as tiers.

- ⚠ **Not `tenants.status`.** `suspended` is documented as a billing decision
  and nothing in the code enforces it. Overloading it would mix two release
  paths.
- ⚠ **Not an SES pause.** Re-enabling a paused SES tenant puts it in
  `reinstated`, where SES IGNORES its open findings until they resolve. Every
  release would switch off SES's own protection for that tenant.
- **One door:** `holdStore(db).hold()` / `.release()`. A reason is required,
  the row is locked, and the audit row is written in the same transaction.
- **Enforced at accept** (`sending_held`, a 403 distinct from
  `sending_paused`), **in the worker** (a claimed message of a held workspace
  is canceled, not sent), and **at hold time** (every queued and scheduled
  message of the workspace is canceled with reason `held`, in the same
  transaction as the hold). The console and read-only routes keep working.
- **Mailboxes are not stopped by an automatic hold.** A hold with
  `scope: "all"` is staff-only.
- **Review is due in 24 hours** (`review_due_at`). The hourly run alerts Sentry
  when a hold is overdue - Article 22 requires a real human review.
- **Releasing sets a cut-off.** After a staff release the score may not hold
  that workspace again until `auto_actions_paused_until` (default 14 days)
  unless a rule marked `fresh` fires on evidence newer than the release.
  Staff can also pin a trusted customer the same way without a hold.

### SES policy for high-band paid workspaces

`UpdateReputationEntityPolicy` to `strict` on entering high, back to `standard`
after 14 days below high. SES itself recommends Strict for high-risk tenants.
The IAM grant is `ses:UpdateReputationEntityPolicy` on the tenant ARNs.

### #166, rescoped

No dedicated IP pool per band. Dedicated IPs cost $24.95 per IP per month and
need steady volume; a small "risky" pool would have worse deliverability than
SES's shared pool, and SES's account-level metrics aggregate across tenants
whatever pool they use. Per-band SES policy and holds are the containment.
Dedicated IPs can return later for the GOOD senders, when volume justifies
them.

---

## Signals

Every rule lives in `apps/api/src/risk/rules.ts` with its points, window and
customer-facing category. The families:

**SES (strongest):** current pause and its origin, pause history, open and
recent HIGH/LOW findings, `reinstated`.

**Rates (with minimum volumes):** hard bounces and complaints over 24h and
7d, soft bounces, unsubscribes, and the **early-life bounce rate** (hard
bounces in a workspace's first sends - the best cheap sign of a bought list).
Thresholds follow what SES, Resend and Gmail enforce: Resend pauses at 4%
bounce and 0.08% spam, SES reviews at 5% and 0.1%, Gmail requires spam under
0.3%.

⚠ **The suppression rate is not a rule.** Suppressions come from bounces and
complaints, so counting them again would score one event twice. Unsubscribes
and manual churn are the parts that carry new information.

**Behaviour:** quota hammering (429s on several days), hitting the daily cap
within 48h of sign-up, volume spikes against a workspace's own trailing
average, API error ratios, key churn, domain churn and failed or displaced
domains, tier demotions and prior holds.

**Domains:** registration age from RDAP (looked up once per domain by the
hourly run, stored on the row; ccTLDs without RDAP score neutral),
random-looking subdomain labels, and registrable parent domains shared with
other workspaces.

**Farms (the priority):** at accept, each message's content is fingerprinted
twice - an exact hash of normalised content, and a 32-slot MinHash signature
of its word pairs cut into 8 LSH bands of 4 rows. Two messages sharing two or
more bands are near-duplicates. Normalising strips digits, URL query strings,
tracking tokens and whitespace. ⚠ Only the fingerprints are stored, never the
body; they cannot be turned back into the mail, and they are kept 30 days.
Redis holds, per fingerprint and per band, the set of workspaces that sent it
in the last 48h; when one reaches `RISK_FARM_TRIPWIRE` distinct workspaces,
those workspaces are re-scored immediately. At most 25 fingerprints are taken
per request and the Redis work is one pipeline, so the accept path pays a
bounded, constant cost.

⚠ **MinHash, not SimHash, and it was measured.** The first build used a 64-bit
SimHash. On email-sized text it put genuine near-duplicates (a name changed, a
token appended) 5 to 16 bits apart, so the textbook three-bit threshold missed
them, and a threshold wide enough to catch them needs bands too narrow to mean
anything. MinHash put the same pairs 3 to 5 shared bands apart and unrelated
mail at 0, for about 0.13 ms per 5 KB message. Band equality is also what an
index serves: `fingerprint_peers` is a GIN overlap (`&&`), not a pairwise scan.
The first MinHash also had a bug worth remembering: JavaScript bitwise results
are SIGNED, and a minimum taken across signed and unsigned values made two
copies of one email look 6% alike. Every step is now forced unsigned. A workspace only counts as a farm
member when shared content lines up with at least two linking features:
created within hours of each other, the same registrable parent domain, the
same owner device or IP, the same sign-up country, both young and free. Our
own docs' example templates are allowlisted, and since #222 known public
boilerplate and a workspace's staff-approved templates are left out of every
cross-workspace comparison (see "Trusted content and similarity evidence").

**Identity (people, not workspaces):**

| Source                                          | What it gives                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cloudflare headers on api.i10.tech              | the real client IP and country of every API call, including which IPs each API key is used from |
| The console, forwarding a signed client context | the person's IP, country, user agent, timezone, language and a FingerprintJS device id          |
| IPinfo Lite (`IPINFO_TOKEN`)                    | the network (ASN) behind an IP, so hosting providers can be flagged                             |
| The Tor Project's exit list                     | Tor exit addresses                                                                              |
| Clerk                                           | MFA and passkeys, primary email, account age                                                    |

Detections: many accounts from one IP, subnet or device; one device behind
several users (and behind a held workspace: ban evasion); impossible travel;
sign-ups from hosting networks or Tor; a timezone that disagrees with the IP's
country; an API key used from several countries.

⚠ **The console calls the API in-cluster**, so the API never sees a person's
IP on its own. The console forwards it as `x-i10-client`, signed with
`CLIENT_CONTEXT_SECRET` (HMAC-SHA256 over the payload and a timestamp); the
API refuses an unsigned or stale context rather than trusting a header anyone
could set. Without the secret the console forwards nothing and identity comes
from direct API calls only.

⚠ **Identity rows are cross-tenant by nature** - a sign-up happens before any
workspace exists, and linking compares users with each other. So
`core.identity_events` has RLS with a deny-all policy, and is written and read
only through narrow `SECURITY DEFINER` functions that return counts and ids,
never another user's raw IP.

**Content and links:** link hostnames extracted at accept (never full URLs,
which carry tokens) and checked hourly against Google Web Risk
(`WEBRISK_API_KEY`; the free Safe Browsing API and Spamhaus's free mirrors are
non-commercial only). A match is critical. Laya, when configured.

**Payment and trust:** paid tenure, MFA or passkey on the owner, the owner's
email on one of the workspace's own verified domains, long clean volume.

---

## Templates and vectors (ruleset 2)

Added 2026-09-29, after the first review of this design (the user's, and an
outside one). Four ideas, one core.

### One core, two uses: templates

`content/templates.ts` discovers a workspace's own templates from its
finished mail: two near-duplicate bodies (MinHash bands) are diffed at token
level (Myers), their common runs become the static skeleton, and what differs
becomes holes. A body that fits is stored as the template id plus its values
(#167, #169, #171) - the same 20 KB receipt kept once, not ten thousand times.
The same templates tell the risk engine what NORMAL mail looks like for this
workspace (`trust.known_templates`).

- ⚠ **Byte-exact, by construction and by check.** Rendering is concatenation,
  so any split reconstructs exactly; `compactable` still renders and compares
  before anything is released, and the UPDATE is guarded on the original bytes.
- ⚠ **Linked once, compacted when established.** A new match is LINKED
  (template and values recorded, original kept) and counted once; it is
  COMPACTED only when its template has 3 matches. One coincidence never
  rewrites mail.
- ⚠ **Only finished messages** (sent, failed, canceled). Every reader of
  `message_bodies` restores through `content/restore.ts`: the worker's claim,
  `GET /emails/:id`, the console detail, the risk sampler.
- Per workspace, never shared across workspaces, deleted with it.
- ⚠ The first version of the job linked nothing: it read `created_at` into a
  JavaScript Date (milliseconds) and keyed the UPDATE on it, while the column
  has microseconds. It now carries Postgres's own text. The integration test
  caught it.

### pgvector inside the CNPG cluster

pgvector 0.8.6 ships in the production image (`18.6-standard-bookworm`), so
the vectors live in the same database: same transactions, same RLS, same
definer rules, no vendor. Pinecone would send embeddings of customer mail to a
third party; a separate Neon database would be a second store to keep
consistent. Neither buys anything at our scale.

- `core.content_vectors`: one embedding per distinct content per day,
  `halfvec(384)` with an HNSW cosine index, 30-day retention, tenant RLS.
- `core.behaviour_vectors`: each workspace's 39 behaviour features,
  standardised with fixed scales, `vector(39)` with an HNSW L2 index.
- Cross-workspace questions go through definers (migration 0072) that return
  counts and distances only: `content_neighbors` (iterative HNSW scan, so a
  filter cannot empty the top-k), `behaviour_neighbors` (labelled workspaces
  only), `actor_velocity`.

### The embedder: MiniLM, locally, on WebAssembly

`content/embed.ts`. all-MiniLM-L6-v2 (Apache-2.0, 384 dimensions, 23 MB
quantised), pinned by Hugging Face commit and SHA-256, run by
onnxruntime-web's WASM backend. Measured before choosing:

- `@huggingface/transformers` in Node offers only NATIVE onnxruntime, whose
  binaries are glibc; the runtime image is Alpine. WASM runs anywhere Bun
  does and was proven on `oven/bun:1.4.2-alpine`, amd64, and in the built
  production image (`bun dist/risk-score.js --check-embedder`).
- About 80 ms per 120-word email on one thread, ~310 MB resident, 0.2 s load.
  Only the hourly job loads it; the API only compares stored vectors.
- Its WordPiece tokenizer is implemented here and gives token ids identical to
  the reference library's; embeddings agree at cosine 0.98 or better.
- It separates meaning: two different phishing emails scored 0.63 against
  each other, 0.19 against a receipt.
- multilingual-e5-small was also measured (same speed, 100 languages) but
  its runtime was native-only here; MiniLM is English-first. Multilingual is a
  model swap once needed.
- `RISK_EMBEDDER=hash` (or missing model files) falls back to `hash-v1`,
  feature hashing over words, word pairs and character trigrams - wording, not
  meaning. Vectors are tagged with their model and never compared across models.

### Rules the layer feeds (ruleset 2)

| Rule                           | Points                     | Why this weight                                                                         |
| ------------------------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| `content.like_confirmed_abuse` | 20, or 30 at 2+ workspaces | mail reads like a confirmed abuser's                                                    |
| `content.semantic_crowd`       | 12                         | the same message, reworded, from 4+ new free workspaces                                 |
| `behaviour.like_abuse`         | 8 or 20                    | 50% / 70% of the 10 nearest labelled neighbours were abuse (5+ labelled needed)         |
| `actor.velocity`               | 15 or 30                   | the actor (owner plus anyone on their device or network) made 3 / 6 workspaces in a day |
| `actor.domain_velocity`        | 10                         | 10+ domains across the actor's workspaces in a day                                      |
| `actor.cluster_size`           | 10                         | the actor reaches 10+ live workspaces                                                   |
| `trust.known_templates`        | -5                         | 80%+ of recent mail fits the workspace's own established templates                      |

⚠ **Similarity is evidence, not a verdict.** Its weights are modest until real
labels show how it performs, and a test proves no amount of similarity alone
can reach critical. The model also learns from it (five new features beyond
the 39 behaviour features).

### The feedback-loop rule

**No score may feed another score.** Before ruleset 2, "linked to a HELD
workspace" was penalised, and a hold can be the score's own automatic action
still awaiting review: A held by the score, B critical by association, B held,
then C - a cascade built from the engine agreeing with itself. Linkage now
counts only CONFIRMED abuse (`core.risk_tainted_tenants`): a hold staff
placed, a hold staff upheld, or a staff abuse label. Observations and human
verdicts go in; scores never do. Behaviour neighbours are labelled by outcomes
for the same reason. The integration test proves a score hold taints nobody
until a person confirms it.

### Deploying the vector layer

pgvector is not a trusted extension; only a superuser can create it, and
migrations run as `i10`, which is not one. So:

1. **CNPG creates it** from `infra/k8s/i10/platform-db/database.yaml` (a
   `Database` resource adopting `i10`, `databaseReclaimPolicy: retain`).
2. Migration 0070 says `CREATE EXTENSION IF NOT EXISTS vector`: a no-op when
   step 1 has run, a loud failure when it has not.
3. ⚠ The two are different Argo apps with no ordering between them, so the
   Database resource must be applied BEFORE the merge that carries 0070:
   `kubectl apply -f infra/k8s/i10/platform-db/database.yaml`.

Locally, `compose.dev.yaml` now runs the same CNPG image, bootstrapped by
`dev/postgres/cnpg-entry.sh` to mirror production's roles (`postgres` the
only superuser, `i10` a non-superuser owner, pgvector in `template1` so
throwaway databases have it). All 72 migrations were proven to apply as the
non-superuser owner.

## Trusted content and similarity evidence (ruleset 3, #222)

Added 2026-09-29, the follow-up to #221. Legitimate repeated mail must not
look like a farm, and staff need to see why a similarity rule fired.

⚠ **The false positive is many workspaces, not one.** No content rule counts
a workspace repeating itself. What looks like a farm is many unrelated
workspaces sending the same public boilerplate (Clerk's, Supabase's or
NextAuth's default emails, React Email starters) - exactly what
`content.semantic_crowd`, `content.like_confirmed_abuse` and the farm rules
look for.

### One matcher, two lists

Both lists are skeletons for the existing matcher (`content/templates.ts`), and
`content/trust.ts` decides whether a message IS an entry:

- ⚠ **Byte-exact on the fixed part.** `match()` must fit the whole body. "Close
  to the approved template" earns nothing.
- ⚠ **The holes are fenced.** Each has a length limit (default 100, at most
  1,000, and the limits together may not exceed the fixed text); no value may
  contain `<` or `>`; two placeholders need fixed text between them. A value
  that is a link target must be an `http(s)` address, and every host a value
  carries - a URL, a hostname in plain text, the host after a fixed `https://` -
  must be on the SENDING workspace's own verified domains and clean in Web
  Risk. An unknown verdict is a no. So the holes cannot carry a new message:
  submit-clean-send-something-else does not work.
- **Where it runs.** At accept (`recordContent`, off the request path, reading
  cached Web Risk verdicts only) and in the hourly content job (which may spend
  the Web Risk budget). A matching fingerprint is stored with
  `trusted_by = boilerplate:<id>` or `template:<id>`, and kept out of the Redis
  tripwire; the job marks the vector the same way and records
  `message_bodies.trusted_template_id` for approved templates.
- ⚠ **Fails closed.** A fingerprint keeps its mark only while every message
  with it fitted the same entry; one that did not clears it for the day.
- ⚠ **Excluded on both sides.** `fingerprint_peers` and `content_neighbors`
  (migration 0074) ignore trusted rows for the workspace being scored AND for
  its neighbours: fifty workspaces sending Clerk's reset email are fifty
  workspaces that installed Clerk, and none of them is evidence against the
  others.
- ⚠ **Taking trust away reaches the past.** Removing a boilerplate entry, or
  revoking or withdrawing a template, clears its marks from the fingerprints
  and vectors it excused, so the next score counts that mail in full.
- **Nothing else changes.** Bounces, complaints, velocity, identity, link
  reputation and holds count exactly as before. Boilerplate sent to a bought
  list is still a bought list.

### 1. Known public boilerplate (staff-kept, global)

`core.risk_boilerplate` and `core.risk_boilerplate_events`, both deny-all like
`risk_models`, read and written only through definers
(`risk_boilerplate_list/add/remove/history/nearest`). Every add and remove
requires who and why, and writes its event in the same statement. Until the
admin app (#217):

```
bun run risk-admin boilerplate add --name clerk/reset-password --html reset.html \
  [--text reset.txt] [--subject "..."] [--holes code=12] --by <you> --reason "<why>"
bun run risk-admin boilerplate list | history
bun run risk-admin boilerplate remove <id> --by <you> --reason "<why>"
```

Each entry also stores its MinHash bands and an embedding (from the loaded
embedder). ⚠ The embedding never excuses anything: it only names, in the
evidence, the entry a workspace's UNEXCUSED mail reads closest to ("reads like
Clerk's reset email at 0.96 but did not fit it - a variant worth adding?").

### 2. Workspace templates, reviewed by staff (per workspace)

`core.trusted_templates` and `core.trusted_template_events`, tenant RLS. A
workspace submits the body exactly as it sends it, with `{{name}}` where values
go, from the console (`/templates`, "Reviewed for repeat sending") or the API
(`POST /trusted-templates`, plus list, read and withdraw; domain-restricted
keys are refused, as on `/suppressions`). Limits: 50 live and 10 pending per
workspace, one live submission per skeleton.

- **Staff decide in risk-admin:** `templates pending`, `templates show <id>`
  (the skeleton with its holes named, the fixed part's links with their Web
  Risk verdicts, and the history), `templates approve|reject|revoke <id> --by
<you> [--reason "<note>"]`. ⚠ Approval refuses while any link in the fixed
  part is not checked clean. ⚠ The reason is shown to the workspace, in the
  console and in the decision email (`renderTemplateReview`).
- **Approval stops repetition counting, never results.** The hourly run judges
  each approval on exactly the messages it credited: 100+ sent and 4%+ hard
  bounces, or 0.1%+ complaints with at least two, revokes it (the rules'
  lines). Any staff abuse label (`label abuse`, `release --outcome upheld`)
  revokes every approval of the workspace, at once in risk-admin and from the
  label in the next run. The workspace is emailed on every decision.
- Per workspace, never shared: another workspace sending the same skeleton
  gets nothing from it.

### 3. Evidence for every similarity finding

`content.semantic_crowd`, `content.like_confirmed_abuse`,
`behaviour.like_abuse`, `farm.cluster` and `farm.with_held` attach a `detail`
to their contribution, stored in `risk_assessments.contributions` and every
`risk_assessment_events` row, and printed by `risk-admin explain`:

```json
{
  "signal": "content.semantic_crowd",
  "model": "minilm-l6-v2-q8",
  "neighbours": 17,
  "distinct_workspaces": 8,
  "median_similarity": 0.91,
  "best_similarity": 0.97,
  "confirmed_abuse_neighbours": 5,
  "known_template_matches": 0,
  "boilerplate_matches": 0,
  "boilerplate_match": null
}
```

⚠ Counts and distances only, never another workspace's id, content or
domains. For farm rules the model is `minhash-8x4` and similarity is 1 for an
identical fingerprint, else shared bands over 8; for behaviour it is
`behaviour-v1` with `median_distance` and `nearest_distance` (L2) instead of
similarities. `content_neighbors` now also returns every neighbour hit and
their median and best similarity; `behaviour_neighbors` the median distance;
`fingerprint_peers` the best near-duplicate band count. The ruleset is version
3: no weight changed, but what the similarity rules see did.

### 4. Web Risk under a daily budget

Web Risk's quotas are per minute only, so the budget is ours
(`risk/webrisk.ts`): a Redis counter per UTC day, `WEBRISK_DAILY_LIMIT`
(default 3,000, about 90k a month, inside the free 100k), counted before each
call, failed calls included. ⚠ No Redis means no lookups: a budget that cannot
be counted is spent. A 429, a 5xx or no answer stops every lookup for five
minutes; a 4xx about one host parks that host for an hour. A host nobody could
answer for stays unchecked and is asked next run; it is never recorded clean.
Verdicts stay cached for a day and shared across workspaces, as before.

## Account takeover is a separate response

Impossible travel usually means stolen credentials, not a spammer. When it
fires for a user: every other Clerk session of that user is revoked, the user
is emailed, and a security event is recorded. It adds a few points to the
workspace score, but only holds when abuse signals line up too. Banning a
Clerk user stays a staff action. An API key used from several countries in a
day emails the owner as a possible leak.

---

## Explainability and appeals

- `core.risk_assessments` holds each workspace's current score, band, ruleset
  version and contributions: rule id, points, category and evidence numbers.
- `core.risk_assessment_events` records every band change, every move of 10+
  points and every action, with the contributions at that moment.
- **Customers see categories, not thresholds** ("bounce rate", "linked to a
  flagged group of workspaces"), so the rules cannot be gamed.
- **Appeals before #217 exist:** the hold email says to reply. Staff use
  `bun run risk-admin` (explain, hold, release, pin, label, train, clusters,
  and since #222 boilerplate and templates), which goes through the same doors
  as the score and requires `--by` and `--reason`.

---

## Privacy and compliance (input for #184)

- Lawful basis: legitimate interest in fraud prevention and network security
  (GDPR Recital 47).
- Article 22: automated holds are time-limited and human-reviewed within 24
  hours, with a way to contest; termination is always a person.
- Device fingerprinting falls under ePrivacy Article 5(3); it is collected
  only on signed-in console use, only for security, and must be named in the
  privacy policy.
- Retention: raw IPs and user agents in `identity_events` are nulled after 90
  days (the hourly run does it); derived country, network and device id stay
  for the life of the account. Content fingerprints and link hosts: 30 days.
  `api_requests` (now with client IP and country) keeps its 30-day window.

---

## Configuration

| Variable                   | Default | What it does                                                     |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `RISK_ENABLED`             | `true`  | the whole engine; off means nothing scores or acts               |
| `RISK_ACT_TIERS`           | `true`  | free tier moves                                                  |
| `RISK_ACT_HOLDS`           | `true`  | automatic holds                                                  |
| `RISK_ACT_SES_POLICY`      | `true`  | SES Strict policy for high-band paid                             |
| `RISK_ACT_TAKEOVER`        | `true`  | revoking sessions on impossible travel                           |
| `RISK_FARM_TRIPWIRE`       | `5`     | distinct workspaces per fingerprint before an immediate re-score |
| `CLIENT_CONTEXT_SECRET`    | unset   | shared with the console; unset means no forwarded identity       |
| `IPINFO_TOKEN`             | unset   | network enrichment                                               |
| `WEBRISK_API_KEY`          | unset   | link reputation                                                  |
| `WEBRISK_DAILY_LIMIT`      | `3000`  | Web Risk lookups per UTC day, counted in Redis (#222)            |
| `LAYA_URL`, `LAYA_API_KEY` | unset   | content classifier                                               |

Every action has its own switch so a bad rule can be turned off without a
revert.
