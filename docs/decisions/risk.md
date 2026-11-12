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
record ──► assessment + event history (staff review, appeals, labels)
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
- **No engine-wide shadow mode.** The user chose protection from day 1. That
  is safe because the automatic actions stop at tier moves and holds, and
  termination is never automatic. A single new rule can run in shadow first
  (see "Snapshots, replay and shadow rules").
- **A rule that throws is reported, not dropped.** `evaluate` stays pure: it
  scores every other rule and returns the failures (rule id and error) beside
  the assessment. The runner logs each at error level with the rule and
  workspace, sends it to Sentry, and the hourly "risk run complete" line counts
  them (`ruleFailures`). It used to vanish from the score without a trace.

### No trained model

A model trained only on scenarios we write learns our generator, not
attackers - it would be confident and wrong on the first farm that does not
look like our fixtures, and a hold it cannot explain is weak in an appeal and
exposed under GDPR Article 22. So:

- The **synthetic scenarios** (farm, bought list, phishing, a legitimate
  startup ramping up, a legitimate newsletter) are the **rule test suite**: a
  rule change must catch every abuse scenario and leave every legitimate one
  alone.
- **Labels are collected from day 1** in `core.risk_labels`: staff holds
  upheld or released, staff labels, SES AWS-managed pauses, long clean tenure.
  They are the ground truth the rules are evaluated against. A label records
  the outcome, its source and weight, and who set it; it carries no features.
- **The logistic-regression model was removed in ruleset 4**, with its
  training (`risk-admin train` and the hourly retrain), its `model` rule, its
  `core.risk_models` table and `risk_assessments.model_score`. Its features
  included `ses_paused_now`, `ses_pauses`, `tier_demotions` and
  `upheld_holds`, the same events that produce its abuse labels, so it would
  have learned its own labels back (target leakage). With no labels it could
  never activate anyway. Any later model starts from features that are not
  the label sources.
- **The content judge** (ruleset 7) asks a hosted or self-hosted decision
  model typed questions about each distinct content a workspace sends, once
  per content, off the send path. Its rules run in shadow until replay has
  measured them. It replaced a Laya classifier that read one sampled message
  from already-elevated workspaces and was never deployed. See "The content
  judge" below.

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
  After the pause, what the release cleared stays cleared for the same
  evidence (see "Decision memory").

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
domains, demotions to the strict tier by staff, and prior holds.

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
sign-ups from hosting networks or Tor; an API key used from several countries.
The timezone check (a browser timezone far from the IP's country, 3 points)
was removed in ruleset 4: a zone's offset against a country centre's solar
offset is off by hours for wide countries, so it was noise.

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
which carry tokens) and checked hourly by the link providers (section 4 below):
the public security DNS resolvers by default, Google Web Risk when listed and
keyed (the free Safe Browsing API and Spamhaus's free mirrors are
non-commercial only). Web Risk, or both resolvers agreeing, is critical; one
resolver alone is 45 points and no floor. The content judge's answers, in
shadow (see "The content judge").

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
- Cross-workspace questions go through definers (migration 0072) that return
  counts and distances only: `content_neighbors` (iterative HNSW scan, so a
  filter cannot empty the top-k) and `actor_velocity`.
- Behaviour similarity (`core.behaviour_vectors`, `behaviour_neighbors` and the
  `behaviour.like_abuse` rule, a vote among a workspace's nearest labelled
  neighbours) was removed in ruleset 4: with no labels it had nothing to vote
  with, and its vector was the removed model's features.

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
| `actor.velocity`               | 15 or 30                   | the actor (owner plus anyone on their device or network) made 3 / 6 workspaces in a day |
| `actor.domain_velocity`        | 10                         | 10+ domains across the actor's workspaces in a day                                      |
| `actor.cluster_size`           | 10                         | the actor reaches 10+ live workspaces                                                   |
| `trust.known_templates`        | -5                         | 80%+ of recent mail fits the workspace's own established templates                      |

⚠ **Similarity is evidence, not a verdict.** Its weights are modest until real
labels show how it performs, and a test proves no amount of similarity alone
can reach critical.

### The feedback-loop rule

**No score may feed another score.** Before ruleset 2, "linked to a HELD
workspace" was penalised, and a hold can be the score's own automatic action
still awaiting review: A held by the score, B critical by association, B held,
then C - a cascade built from the engine agreeing with itself. Linkage now
counts only CONFIRMED abuse (`core.risk_tainted_tenants`): a hold staff
placed, a hold staff upheld, or a staff abuse label. Observations and human
verdicts go in; scores never do. The integration test proves a score hold
taints nobody until a person confirms it.

The same rule applies to a workspace's own history. `history.demotions` once
counted every demotion to the strict tier, including the ones the score made
from its own band, so a high score raised the score with no new evidence.
Since ruleset 4 it counts only demotions staff made (`sending_tier_events`
rows with `source = 'staff'`).

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
  must be on the SENDING workspace's own verified domains and clean in the link
  checkers. An unknown verdict is a no. So the holes cannot carry a new message:
  submit-clean-send-something-else does not work.
- **Where it runs.** At accept (`recordContent`, off the request path, reading
  cached link verdicts only) and in the hourly content job (which may spend the
  link-check budgets). A matching fingerprint is stored with
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
`identity_events`, read and written only through definers
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

`content.semantic_crowd`, `content.like_confirmed_abuse`, `farm.cluster` and
`farm.with_held` attach a `detail`
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
identical fingerprint, else shared bands over 8. `content_neighbors` now also
returns every neighbour hit and their median and best similarity;
`fingerprint_peers` the best near-duplicate band count. The ruleset is version
3: no weight changed, but what the similarity rules see did.

### 4. Link checking behind one port, with providers and health

Added 2026-11-11. The engine asks a `LinkChecker` (`risk/link-check.ts`); behind
it sit providers, each answering one hostname as **unsafe** (with labels),
**clean** or **unknown**. Unknown is never clean: an unchecked link earns no
trust and its host is asked again next run. A provider may also **skip** a name
it can never speak about (an IP literal, a single label, a private suffix);
a host every provider skips is recorded clean, so a workspace cannot fill the
hourly batch of 100 with names that never resolve.

⚠ **Web Risk was dead for at least a month and nothing said so.** Measured in
production on 2026-11-10: it answered 403 because billing was not enabled on
the Google project, every verdict was unknown, `links.unsafe` could never fire,
and each provider failing soft meant no alert. So Google is no longer the
default: `RISK_LINK_PROVIDERS` (default `dns`) lists the providers, and Web Risk
joins only when it is listed and `WEBRISK_API_KEY` is set. It is otherwise
unchanged (below) and works again the moment a working key is configured.

**Which providers.** `dns` is two providers, Cloudflare's malware-blocking
resolver (`security.cloudflare-dns.com`) and Quad9 (`dns.quad9.net`), over DNS
over HTTPS (RFC 8484, HTTP/2 because Quad9 refuses HTTP/1.1 and Bun's `fetch`
speaks only that). Neither needs an account. ⚠ **The hostname only, never the
URL:** opening a customer's link would consume a magic link or an unsubscribe,
and fetching an address an attacker chose is SSRF. The name is validated first
(ASCII labels, at most 253 characters, under an ICANN suffix; no IP literal,
single label, `.local`, `.internal`, reverse-DNS or `.onion`).

**Telling a block from a name that does not exist.** Quad9 blocks by answering
NXDOMAIN, which is also what a nonexistent name gets; the only documented
difference is the authority section, empty for a block and carrying the zone's
SOA for a real NXDOMAIN (docs.quad9.net/FAQs). Cloudflare answers `0.0.0.0`,
which a zone can publish itself. So a block-shaped answer is never believed
alone: the same operator's unfiltered resolver (`cloudflare-dns.com`,
`dns10.quad9.net`) is asked, and only a name that resolves there for real is
blocked. A genuine NXDOMAIN, or a zone that really publishes `0.0.0.0`, is
clean; what the pair cannot settle is unknown. A nonexistent name is never
blocked.

**Points.** `links.unsafe` is still one rule. Web Risk is 90 with the critical
floor, as before. Both resolvers blocking the same host is the same. Exactly one
resolver is 45 points and no floor: one list's false positive must not hold a
customer's mail on its own. The evidence names the providers that flagged each
host. The verdict stored in `core.link_hosts.verdict` is `clean` or
`provider=labels` segments (`cloudflare=blocked;quad9=blocked`); a segment-less
value is an old Web Risk row and reads as Web Risk's, so nothing migrates. The
ruleset is version 5. ⚠ A verdict is stored once, so it is stored complete: an
unsafe answer is written at once only when it is already decisive (Web Risk, or
two providers); otherwise every provider must have answered, so one resolver
being down cannot freeze a half-answer.

**Budgets, so a farm cannot make us a nuisance.** Each resolver has a Redis
counter per UTC day, `RISK_DNS_DAILY_LIMIT` (default 5,000 queries), counted
before each query is sent. No Redis means no queries. An outage (any non-200, a
timeout, an unreadable answer) parks that resolver for five minutes; one name
that will not resolve (SERVFAIL, or a case the pair cannot settle) parks that
name for an hour. Calls time out at three seconds, with at most four in flight.
Clean answers are cached six hours, blocked ones a day, per resolver, under
`risk:link:<resolver>:<host>` (which is also how the cache records the
provider).

**Terms.** Cloudflare's resolver is covered by its Website and Online Services
Terms of Use, which forbid overburdening its servers and exceeding documented
limits but say nothing specific about automated or commercial lookups. Quad9
publishes no terms of service; its FAQ says it is free for everyone and asks
ISPs, service providers and other large organisations to contact them before
sending large-scale traffic. Our caps keep us far below large-scale.

**Health.** `risk/provider-health.ts` records every outbound call per provider
in Redis. A provider that has failed five times in a row, the first at least 30
minutes ago, raises one alert through the engine's `alert` (Sentry), then at most
one a day while it stays down, and logs when it recovers; one success resets the
count. A 403 from Web Risk counts, which is the case that went unnoticed. A
provider that is not configured, has no key, has spent its budget or is parked
made no call and is never "failing". The content judge's calls are reported the
same way, per model (`judge:<model>`). The run summary carries each provider's clean, unsafe, unknown and
skipped counts.

**Web Risk, unchanged.** A budget is ours, because Google's quotas are per
minute only (`risk/webrisk.ts`): a Redis counter per UTC day,
`WEBRISK_DAILY_LIMIT` (default 3,000, about 90k a month, inside the free 100k),
counted before each call, failed calls included. ⚠ No Redis means no lookups: a
budget that cannot be counted is spent. A 429, a 5xx or no answer stops every
lookup for five minutes; a 4xx about one host parks that host for an hour. A
host nobody could answer for stays unchecked and is asked next run; it is never
recorded clean. Verdicts stay cached for a day and shared across workspaces.

## Snapshots, replay and shadow rules

A rule change used to be testable only on the synthetic scenarios, or by
letting it act on customers. Three pieces fix that; none changes scoring, so
`RULESET_VERSION` stays where it was.

- **Fact snapshots** (`core.risk_fact_snapshots`, `risk/snapshot.ts`). The
  `Facts` a score was computed from, with the ruleset version, trigger, score,
  band, contributions and shadow contributions. Written whenever the event log
  writes an event (first assessment, band change, a swing of 10+ points, an
  action), and otherwise for the first score of each UTC day, so a quiet
  workspace costs one row a day. The judged-content summary is part of the
  facts, so replay sees the judgements the score saw. Dates are stored as `{"$date": iso}` and
  revived by `reviveFacts`. **Deny-all**, reached only through the definers in
  migration 0153: a workspace can never read its own snapshot.
- **Retention: 180 days**, purged by the hourly run beside the identity purge.
  It covers the longest window any rule reads (SES pauses and holds, 180 days)
  and two quarters of history to replay a change against.
- **Replay** (`risk/replay.ts`, `bun run risk-admin replay [--since]
[--until] [--tenant] [--json]`). Re-scores the kept snapshots with the rules
  in the checkout (and the current `RISK_SHADOW_RULES`) and prints a band
  transition table, the workspaces whose band would change with old and new
  score, per rule the snapshots where its contribution differs or where it
  could not run, and per shadow rule where it fired and where it would have
  moved the band. Pure: it writes nothing and calls no outside service.
  **Old snapshots are replayed as they are**: a rule that reads a field an
  older shape lacks throws, is counted as a rule failure, and the rest score.
- **Shadow rules.** A rule with `mode: "shadow"` is evaluated and recorded
  (`shadow` on the assessment, its events and its snapshots, and in `risk-admin
explain`) and moves no score, band, floor or action. A shadow contribution
  has `wouldAdd` and `wouldFloor` instead of `points` and `floor`, and sits
  beside the assessment rather than in it, so `decide` cannot be handed one.
  New rules can start in shadow; making one live is a code change and a
  ruleset bump.
- **The brake**, `RISK_SHADOW_RULES`: live rule ids forced into shadow without
  a deploy, for a rule misfiring in production. An unknown id refuses to
  boot, and every process logs the list when it starts. There is no setting
  the other way.

## Decision memory (ruleset 6)

Section 10 of the acceptable use policy promises: "A decision made by a person
stays made. Once a reviewer has cleared a concern, we do not raise the same
concern again without new evidence." The release pause alone does not keep
that promise: when it ends, every concern the person already cleared counts in
full again, and the same workspace is flagged again for the same reason.
Decision memory keeps it. The pause is unchanged; it stops the engine acting
for a while, and the memory stops it re-raising what was cleared afterwards.

- **Every staff decision is recorded** (`core.risk_staff_decisions`,
  `risk/decisions.ts`): `release`, `pin`, `uphold` and a staff `hold`, with
  who, when, the note, the engine's score and band at that moment, whether
  the workspace was held, every live concern in view, the concerns it covers,
  and a **forced fact snapshot** of the facts it was made on, all in the
  transaction of the release, pin or hold itself. **Deny-all**, reached only
  through the definers in migration 0155. A decision is never deleted; a
  revocation (`risk-admin revoke-decision`) is recorded on its row.
- **Evidence keys.** A rule's hit names the specific things it flagged
  (`host:<host>`, `peer:<digest>`, `user:<digest>`, `domain:<name>`,
  `finding:<type>:<opened>`, `pause:<at>`). Another workspace or person is
  only ever a digest (`core.risk_digest`, and `digest` in `risk/rules.ts`),
  because contributions are stored where the workspace itself can read them.
  Rules with nothing identifiable (rates, counts of API calls, a boolean such
  as Tor) have no keys.
- **The rule, per live contribution.** It is **cleared** when a release or pin
  in effect covered the same rule, its points are no higher than they were
  then, and either every key it flags was among the keys cleared or, for a
  keyless rule, it carries no `freshAt` newer than the decision. Otherwise it
  counts **in full**: one new host, one new peer, a higher grade of the same
  rule. There is no partial credit: a cleared concern plus new evidence is a
  concern a person has not weighed, and only the whole of it says how bad it
  is. A keyed rule is judged by its keys, not `freshAt`, because
  `links.unsafe` dates its evidence to the end of the day the link was sent,
  and the same host sent again is the host staff judged.
- **Cleared is structurally separate**, like shadow: a `ClearedContribution`
  has `wouldAdd` and `wouldFloor`, names the decision that cleared it, sits
  beside the assessment (`cleared` on the assessment, its events and its
  snapshots) and is shown in `risk-admin explain` as worth zero. `decide`
  cannot be handed one, so a cleared critical floor moves nothing.
- **Never cleared:** a rule that was not firing when the decision was made; a
  key that was not in view; a stronger hit of a cleared rule; anything after
  an `uphold` or a staff `hold`, which cover nothing (the definer refuses one
  that claims to); earned trust (negative points); and anything once the
  decision is revoked or expired. Clearing is per concern: a workspace cleared
  for one reason is held as before for an unrelated one. Staff may clear a
  subset with `--rules`.
- **Expiry: 180 days** (`DECISION_MEMORY_DAYS`), the longest window any rule
  reads, so a years-old release never excuses today's behaviour.
- **Replay stays exact.** The decisions in effect are part of `Facts`
  (`facts.decisions`, loaded by `risk_decisions_in_effect`, revoked ones with
  their revocation), so evaluation stays a pure function of the facts and a
  snapshot replays its cleared contributions. Snapshots taken before ruleset 6
  have no decisions and replay as "none".
- **Decision cases** (`risk-admin cases`): every decision as a JSON line, with
  its snapshot, the engine's score and band, the staff decision and note, and
  whether they disagree (the engine held or scored high and staff released or
  pinned; the engine scored low and staff held or upheld), disagreements
  first. It is the ground truth the engine is measured against; nothing reads
  it yet.

---

## The content judge (ruleset 7)

The content signal used to be a Laya classifier asked one yes/no question
about one sampled message, only for workspaces already elevated or in a farm,
cached for six hours. Laya was never deployed, so it never ran, and it would
have read almost none of the mail. It is gone, with `LAYA_URL`.

**A decision model, behind a port.** `risk/judge`: a judge takes one email
(subject, text, sender display name and domain, a differing Reply-To domain,
linked hosts) and answers five typed `noul` questions with a probability
each, and writes no text: `phishing`, `spam`, `impersonates_brand`,
`asks_for_credentials`, `is_marketing`. Two providers speak the same System
One shape:

- `workers-ai`: Cloudflare's REST API, `POST /client/v4/accounts/{id}/ai/run/{model}`,
  for `@cf/cloudflare/clef-flash` (9B, 24,576-token context) and
  `@cf/cloudflare/clef` (27B, 65,536). The body names the model
  (`clef-flash` or `clef`); the answer comes wrapped in
  `{ result, success, errors }`.
- `systemone`: a self-hosted Laya, or TypeSafe's Jev, at `POST {url}/v1/systemone`.

The question text lives in `risk/judge/contract.ts`, with a byte-identical copy
in `tools/risk-eval/src/judges/contract.ts` so the evaluation harness measures
exactly what runs; an API test fails when they differ.

**The email is hostile data.** It travels only in `state.email`, a JSON field
of its own, never inside a question's instructions, and every instruction
tells the model to treat the email as evidence and disregard anything in it
about how it should be judged. Each field is capped (text at 12,000
characters, which stays under 24K tokens in any script; 25 link hosts), and a
cut is recorded as `truncated`, on the state and on the judgement.

**Once per content.** The content half of the hourly job (`content/job.ts`,
`content/judging.ts`) reads bodies of any status, newest first, groups them by
exact fingerprint, and judges only content with no judgement under the
current model: a template sent ten thousand times costs one call. Mail queued
for tonight is judged before it goes. Content that is known boilerplate or a
staff-approved template (the same trust matcher as the other passes, failing
closed) is never judged. A body is stamped `judged_at` once its content is
resolved; content a budget or an outage refused stays unstamped and is tried
next hour, within the 7-day window.

**Budgets, before each call, in Redis.** Per workspace per UTC day (200), for
everybody together (5,000) and, separately, for second opinions (500); failed
calls count. No Redis, no calls. A failing model is parked for five minutes,
and every call is reported to provider health. A workspace that spends its
budget is itself a signal: `core.risk_content_judge_days` records per day the
distinct contents seen, judged and capped, and the facts carry their 7-day
sums for a later rule.

**The second opinion.** When the first model's `phishing` or
`impersonates_brand` probability is in the unsure band (0.35 to 0.75), the
second model is asked too and both answers are stored. A question is unsafe
only when both are above 0.5. If the second model is not configured,
unavailable or over its budget, the first answer stands and is counted as
unconfirmed. The second opinion can only take suspicion away.

**Facts and rules, in shadow.** `Facts.content` summarises the judged content
the workspace sent in the last 7 days: per question, the distinct contents
and messages found unsafe, how many were unconfirmed, the highest probability,
and the fingerprints concerned, which become `content:<exact>` evidence keys
so decision memory clears a content once and counts new content in full. Four
rules read it, all in **shadow**, with proposed points that replay will
measure: `content.judge.phishing` 30 (floor `high` once any phishing content
is confirmed), `content.judge.impersonates_brand` 20,
`content.judge.asks_for_credentials` 10, `content.judge.spam` 12.
`is_marketing` has no rule yet. Their evidence is counts only, because
contributions are stored where the workspace can read them.

**Never negative.** Mail text is attacker-controlled, so a judge answer may
add suspicion and never remove it: the rules clamp at zero, and a property
test over random judgements and every scenario proves no judged content lowers
a score or a band, even with the rules promoted, and that in shadow nothing
judged moves the score, the band, a floor or an action.

**Staff only.** `core.risk_content_judgements` and the day counts are deny-all,
behind the definers in migration 0157: exact probabilities shown to a sender
would be a gradient to tune against. `risk-admin explain` shows the summary
and the shadow results; `risk-admin judge <workspace>` lists recent
judgements with both models' answers.

---

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
  `bun run risk-admin` (explain, hold, release, pin, label, clusters,
  since #222 boilerplate and templates, since ruleset 6 decisions,
  revoke-decision and cases, and since ruleset 7 `judge`), which goes through
  the same doors as the score and requires `--by` and `--reason`.

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
- Fact snapshots: 180 days, staff only. They hold no mail body, no address
  and no secret, but they are personal data: the owner's Clerk user id, the
  owner's first-seen time and first country, other workspaces' ids (farm
  peers), the registrable parents of its verified sending domains and the
  unsafe link hosts it sent, SES
  pause origins, and the name of the nearest boilerplate entry. The first
  country outlives the 90-day `identity_events` window it was derived from;
  it is kept so a replay scores the identity rules as they ran.
- **Content judge (ruleset 7): mail leaves i10 when a hosted provider is set.**
  Until now content analysis ran entirely inside our own processes: the
  embedder is local (MiniLM on WebAssembly) and fingerprints, templates and
  vectors stay in our database. With `RISK_JUDGE_PROVIDER=workers-ai` the
  subject, the body text (up to 12,000 characters), the sender's display name
  and domain, the Reply-To domain and the linked hosts of each distinct
  content are sent to Cloudflare Workers AI for judging. Cloudflare lists the
  Clef models as zero data retention, but it is still a **processor**:
  Cloudflare (Workers AI) must be added to the subprocessor list, and the
  privacy policy updated, **before** this is enabled in production. A
  self-hosted `systemone` (Laya) on our own hosts keeps mail inside i10; Jev
  is a third-party processor like Cloudflare. Judgements are kept 30 days,
  staff only, and carry probabilities, never mail text.

---

## Configuration

| Variable                                              | Default      | What it does                                                              |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `RISK_ENABLED`                                        | `true`       | the whole engine; off means nothing scores or acts                        |
| `RISK_ACT_TIERS`                                      | `true`       | free tier moves                                                           |
| `RISK_ACT_HOLDS`                                      | `true`       | automatic holds                                                           |
| `RISK_ACT_SES_POLICY`                                 | `true`       | SES Strict policy for high-band paid                                      |
| `RISK_ACT_TAKEOVER`                                   | `true`       | revoking sessions on impossible travel                                    |
| `RISK_FARM_TRIPWIRE`                                  | `5`          | distinct workspaces per fingerprint before an immediate re-score          |
| `RISK_SHADOW_RULES`                                   | empty        | live rule ids forced into shadow (the brake); unknown ids refuse          |
| `CLIENT_CONTEXT_SECRET`                               | unset        | shared with the console; unset means no forwarded identity                |
| `IPINFO_TOKEN`                                        | unset        | network enrichment                                                        |
| `RISK_LINK_PROVIDERS`                                 | `dns`        | link checkers: `dns` and/or `webrisk` (empty runs none)                   |
| `RISK_DNS_DAILY_LIMIT`                                | `5000`       | DNS queries per resolver per UTC day, counted in Redis                    |
| `WEBRISK_API_KEY`                                     | unset        | Web Risk key; used only if `webrisk` is a listed provider                 |
| `WEBRISK_DAILY_LIMIT`                                 | `3000`       | Web Risk lookups per UTC day, counted in Redis (#222)                     |
| `RISK_JUDGE_PROVIDER`                                 | unset        | content judge: `workers-ai` or `systemone`; unset judges nothing          |
| `RISK_JUDGE_MODEL`                                    | per provider | `@cf/cloudflare/clef-flash` (workers-ai), `jev-1` (systemone)             |
| `RISK_JUDGE_SECOND_MODEL`                             | per provider | `@cf/cloudflare/clef` (workers-ai), none (systemone); `none` turns it off |
| `RISK_JUDGE_CF_ACCOUNT_ID`, `RISK_JUDGE_CF_API_TOKEN` | unset        | Workers AI account and token (workers-ai only)                            |
| `RISK_JUDGE_URL`, `RISK_JUDGE_API_KEY`                | unset        | Laya or Jev base URL and optional key (systemone only)                    |
| `RISK_JUDGE_DAILY_LIMIT`                              | `5000`       | judgements per UTC day, every workspace together                          |
| `RISK_JUDGE_TENANT_DAILY_LIMIT`                       | `200`        | judgements per workspace per UTC day                                      |
| `RISK_JUDGE_SECOND_DAILY_LIMIT`                       | `500`        | second opinions per UTC day                                               |

Every action has its own switch so a bad rule can be turned off without a
revert.
