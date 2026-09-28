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
own docs' example templates are allowlisted.

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
  `bun run risk-admin` (explain, hold, release, pin, label, train, clusters),
  which goes through the same doors as the score and requires `--by` and
  `--reason`.

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
| `LAYA_URL`, `LAYA_API_KEY` | unset   | content classifier                                               |

Every action has its own switch so a bad rule can be turned off without a
revert.
