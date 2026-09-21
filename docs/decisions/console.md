# The console

`apps/console`, served at dash.i10.tech. The surface i10's competitive claim
rests on: the comparison set is Resend, Attio, Twenty, Clerk and Cloudflare's
dashboard, and feature parity with Resend is the floor rather than the target.

This file is the plan the build follows and the record of what was decided. It
is written before the code so the decisions are arguable separately from the
diff.

---

## 1. How the console reaches its data

**Decision: a session-authenticated `/console/*` surface on `apps/api`, called
server-side from Next with a Clerk session JWT as a bearer token.**

Three options were on the table.

1. _Console talks to the database directly._ Rejected. It would give the
   tenant-isolation rules a second implementation in a second language, and
   `core` is under RLS with `app.tenant_id` set per transaction — a Next server
   component has no natural place to hold that.
2. _Console mints an API key for itself._ Rejected, and it is the dangerous one.
   An API key is a machine credential whose advertised blast radius is "can send
   mail". Reading a tenant's billing, rotating their keys and creating mailboxes
   are not that, and a key that could do them would make every leaked sending
   key an account takeover.
3. _A session-authed surface on the API._ Chosen.

`requireTenant` (apps/api/src/middleware/tenant.ts) verifies the Clerk session
exactly as `requireUser` does, then resolves the principal to an i10 tenant and
sets the same `auth` context an API key would. Routes below `/console` are
therefore written against `c.get("auth").tenantId` like every other route, and
the stores they call need no changes.

⚠ **`/console` is excluded from the OpenAPI document.** It is the dashboard's
private contract, not the product's API; publishing it would put "list my
invoices" in every generated SDK and then it would have to be supported there.
The rule is the same one `/billing` and `/webhooks` already follow.

⚠ **A session is never accepted on `/emails`, and an API key is never accepted
on `/console`.** Two credentials, two audiences, no overlap — the position
middleware/session.ts already takes, extended rather than softened.

### Resolving a principal to a tenant

`core.tenant_for_principal(clerk_user_id, clerk_org_id)` — a SECURITY DEFINER
function, for the reason 0032 gives at length: the caller cannot set
`app.tenant_id` to a tenant it is trying to discover. It answers one narrow
question and returns the id alone.

Order matters: when an org id is present it wins, because a person who has
switched to an organisation in Clerk's switcher is asking about that
organisation's mail. Falling back to the personal tenant would silently show
them their own domains under the org's name.

---

## 2. Page inventory

Everything Resend has, plus what i10 has and they do not (mailboxes, NS
delegation, route split).

```
/                         Overview — volume, delivery, bounce and complaint rates
/emails                   The log: status, search, date filters, cursor paging
/emails/[id]              One message: preview, HTML, text, headers, event timeline
/logs                     The API request log — envelope only, never a body

/contacts                 Every person, global to the workspace, unique by address
/segments                 Internal groupings. Recipients never see them.
/topics                   What a recipient sees on their preference page

/broadcasts               List
/broadcasts/[id]          Editor and, once sent, its stats
/templates                Reusable emails, grouped by folder
/templates/[id]           Editor, with draft and published as separate things
/domains                  List
/domains/new              Add, with live DNS detection
/domains/[id]             Records, per-record status, verify, delete
/suppressions             Bounces, complaints, and manual entries

/api-keys                 List, create (shown once), rotate, revoke
/webhooks                 Endpoints and deliveries, as two tabs on one page
/mailboxes                i10-only: human mailboxes on your domains

/settings                 Workspace name, identifiers, danger zone
/settings/team            Clerk's organization profile, in our chrome
/settings/billing         Current plan, the catalogue, checkout and plan change
/settings/usage           Every metered feature against its allowance
/settings/unsubscribe-page  What a recipient sees behind an unsubscribe link
/account                  Clerk's user profile — password, MFA, passkeys, sessions
/account/appearance       Theme

/onboarding               Re-entrant, see §4
```

⚠ **`/audiences` IS NOT IN THIS LIST AND THAT IS THE ONE STRUCTURAL DEPARTURE
FROM THE FIRST DRAFT.** The obvious model — a list, with people on it — makes
the same person a different row on every list, so unsubscribing them is a
per-list act and re-importing last quarter's CSV quietly resurrects somebody who
opted out. Contacts are therefore global to a workspace and unique by address;
segments group them and topics are what the recipient controls. Resend made the
same move, and their migration guide is called "Migrating from Audiences to
Segments".

⚠ **`/settings/integrations` IS ALSO ABSENT.** It would list connected DNS
providers, and nothing can connect one yet — see §7. An empty settings page for
a feature that does not exist is worse than no page.

⚠ **AND `/account/security` COLLAPSED INTO `/account`.** Clerk's `<UserProfile />`
owns the password, MFA, passkeys and sessions in one component; splitting it
would mean rendering the same component twice with its navigation hidden and
deep-linked by fragment — two routes that are one component pretending to be
two, which drift the moment Clerk adds a tab.

Every page is server-rendered by default. Client components are the exception
and each one earns it — a table that filters, a form that submits, a chart.

---

## 3. The design language

`packages/ui` is the system and the console imports it. Nothing is styled at the
call site that could be styled in the package.

**Monochrome.** Resend's dashboard is black, white and grey, and so is ours —
not because they did it, but because a transactional-email console is a
dense-data surface where colour has to mean something. Colour is reserved for
state: delivered, bounced, complained, pending. Everything else is neutral.

⚠ **`--brand` stays unset.** The token sheet says so already and this build does
not change it. Focus and selection use the neutral ring.

**Geist**, sans and mono, from the `geist` package rather than `next/font/google`. The font files ship inside the package, so a `docker build` with no network still produces a correctly-typeset image — which a Google Fonts fetch at build time does not. Mono is not
decorative here — API keys, message ids, DNS record values and header dumps are
all things a person copies by eye, and a proportional font makes `l` and `1`
the same glyph.

**Motion** follows Uber Base as documented in the psl-ui skill: 500ms quintic
for moving and entering, 200ms linear for opacity and colour only, 200ms
quadratic ease-in for dismissal. `prefers-reduced-motion` is already honoured
globally in tokens.css.

**Density.** Table rows are 40px. The type ramp starts at 14px and steps by a
major second. Spacing is multiples of 4.

---

## 4. Onboarding

**Re-entrant from the start.** `/onboarding` is a real route anyone can visit at
any time, not a one-shot modal keyed off a flag. The flag decides whether we
_send_ you there, never whether you _may_ go.

It runs on:

- **account creation** — no tenant has a verified domain yet;
- **upgrade from free to any paid plan** — the plan changes what is available
  (more domains, mailboxes, storage), so the flow re-runs to spend the new
  allowance.

It deliberately does **not** run on paid → higher paid. Nothing is unlocked that
needs setting up; the allowance simply moves, and interrupting someone who just
gave us more money to walk them through a domain they added six months ago is
an insult dressed as a wizard.

**The upgrade rule beats the "already set up" shortcut, and the order took two
attempts to get right.** `shouldOnboard` has a branch that answers `false` for
any tenant with a verified domain and a live API key, whatever the onboarding
row says — it exists so that somebody who configured everything through the API
and then opens the console for the first time is not greeted by a wizard asking
for their first domain. That branch used to run first, which quietly meant the
upgrade flow never ran for anybody who was actually using the product: a
verified domain and a live key is what an engaged account looks like, so the
shortcut excluded almost everyone who would ever upgrade. The flow after an
upgrade ends on the plan screen — here is what you bought, here is what you have
used — and that screen is for exactly the person the shortcut was skipping. The
upgrade check is now first and requires `completed_at`, so it cannot fire for
somebody who never finished the flow; they start at the beginning instead.

### Steps

1. **Workspace** — name, and what you are building. Writes the tenant.
2. **Domain** — enter the apex. We resolve its NS records live and name the
   provider, with their mark. Then three paths:
   - **Delegate** (preferred) — publish three NS records and i10 serves the
     mail subdomains itself. Nothing to maintain, SPF/DKIM/DMARC/MX stay
     correct forever.
   - **Connect** — OAuth or an API token against the detected provider, and we
     write the records for them.
   - **Manual** — the six records, copyable, with a live re-check.
3. **Verify** — polls, shows per-record state, explains `temporary_failure` is
   not `failed`.
4. **Send** — mint the first API key, show a curl and an SDK snippet, and watch
   for the first message to arrive.
5. **Plan** — current usage against the allowance, the plan cards, the upgrade
   button.

Step 5 is where metering becomes visible, and it is visible from step 1 as a
persistent meter in the shell rather than only at the end.

---

## 5. DNS providers

A registry — `packages/dns-providers` — with one entry per provider carrying:
its slug and display name, the nameserver hostname patterns that identify it,
whether it supports NS delegation, whether it has an API we can write records
through, whether that API has OAuth, and the exact UI path a person follows to
add a record by hand.

Detection is a live NS lookup on the apex, matched against the patterns. The
result drives the button: "Connect Cloudflare" with their mark when we can
automate it, and a provider-specific walkthrough when we cannot.

⚠ **Google Public DNS and Quad9 are resolvers, not authoritative hosts.** They
cannot hold a customer's records. The registry marks them as such and the UI
explains the difference rather than offering a connect button that could not
work — a person who lists "8.8.8.8" as their DNS provider is telling us what
their laptop resolves through, not who hosts their zone.

Record writing through a provider API is behind the same seam as everything
else: an interface with one method per operation, so a provider that is
research-only today is a file away from being live.

---

## 6. Preview mode

`bun --filter @i10/console dev:preview` renders every screen from fixtures
with no API, no database and no Clerk. It exists so the interface can be argued
about before the stack behind it is running — standing this up for real needs
Postgres, Redis, a Clerk instance and SES credentials, and somebody who wants to
say "that column is wrong" should not have to provision four services first.

⚠ **It cannot be enabled in production, and that is enforced by the compiler
rather than by discipline.** The flag is ANDed with
`process.env.NODE_ENV !== "production"`, which Next replaces with a literal at
build time — so in a production image the expression folds to `false` and the
bundler deletes every branch that reads a fixture. The compiled `api()` goes
straight from its path guard to `fetch`. (The fixture data itself is still
emitted, unreferenced, into the server chunk; that is dead weight rather than a
reachable path, and the README says how to re-check both halves after a Next
upgrade.) There is no variable anybody can set
in a pod to reach it.

⚠ **And it is off by default in development too.** `bun run dev` talks to a real
API. A developer debugging a live query must never silently be looking at
fixtures; that is the failure mode that makes this kind of mode dangerous, and
the only protection is that turning it on is a deliberate, differently-named
command.

The fixtures are deliberately not all healthy — a failed domain, a bounce, a
complaint, a revoked key, an unsubscribed contact, a meter over its allowance
and one metered feature that genuinely cannot be read. Those are the states
worth reviewing, and a preview where everything is fine shows none of them.

---

## 7. Known gaps

What is built and honest about not being finished. Nothing in this list renders
a pretend success; each one either says what it is in the interface or is
disabled with the reason attached.

### Wired end to end

Overview, the delivery log and message detail, domains (list, add, DNS records,
verify, delete), DNS provider detection, API keys, webhook endpoints and
deliveries, suppressions, the request log, usage, plans and checkout, contacts,
properties, segments, topics, broadcasts, templates, workspace settings, team,
profile, appearance, and the five-step onboarding flow.

The request log is fed by a wildcard middleware in `createApp` that records
every API-KEY-authenticated request after the response is built — never a
console page load, because `requireTenant` deliberately sets an empty key id, so
somebody clicking around the dashboard does not bury their own integration calls
under their own navigation. The write is fire-and-forget and its failures are
reported to the API's logger, so an empty page and a broken log are
distinguishable.

### Built against the API but not exercised against a live one

Every `/console/*` route is new in this change and has been type-checked and
unit-tested, but the console has only been run against fixtures — there is no
local Postgres in this repo to point it at. The first real run will find
something.

### Deliberately not built

- **Writing records through a provider's API, beyond the three that work.**
  Cloudflare, DigitalOcean and Hetzner have live adapters
  (`apps/api/src/dns/providers`) with OAuth, publish, conflict refusal and
  clean-up of our own superseded records; every other provider still renders
  "Connect <provider>" disabled. The registry (`packages/dns-providers`)
  carries what the next adapter needs — endpoints, auth method, scopes, OAuth
  URLs, and the `replacesZone` hazard flag. Build order from here: DNSimple
  (cleanest OAuth), then Vercel, Netlify and Linode, which share the same
  authorization-code shape. Route 53 is its own track: cross-account role
  assumption, never a pasted access key.

- **Domain Connect, for the providers we will never get OAuth with.** Raised
  2026-09-21 after seeing Resend use it: the customer clicks once at
  `dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/resend.com/…/apply?…`
  and the whole record set is applied. No OAuth, no stored credential, nothing
  to refresh. It is [an open standard](https://www.domainconnect.org/) that
  GoDaddy, IONOS, Cloudflare and others implement, and it is the only one-click
  path that exists for the twenty-odd registrars whose APIs we cannot use.

  What it costs: being onboarded as a service provider with each DNS host
  SEPARATELY, each with its own submission and review; a JSON template per
  service, hosted by them under our provider id; and a signing keypair, with
  the public half published at `_dcpubkeyv1` in our own zone and a `sig`/`key`
  pair on every URL we generate.

  ⚠ AND IT IS NOT A REPLACEMENT FOR THE OAUTH PATH, WHICH IS THE THING TO
  REMEMBER WHEN THIS IS PICKED UP. It applies once and hands nothing back: it
  cannot re-publish after a key rotation, cannot clear the previous set-up's
  records when a domain is deleted and re-added — the case `dns/superseded.ts`
  exists for — and cannot read what the zone currently holds. Resend's own
  dialog says so: "It does not grant Resend permission to make future
  changes." So it belongs where we have no adapter, never in front of one.
- **Sending a broadcast.** The editor, the segment targeting, the topic
  preference and the stats are all real; the fan-out that turns a broadcast into
  rows in `core.messages` on the bulk queue is not written. The button is not
  rendered rather than rendered and inert.
- **The hosted unsubscribe page.** The settings form exists and says, in the
  interface, that nothing is saved. It needs a public route on a domain we
  control, a signed per-recipient token so nobody can unsubscribe a stranger by
  guessing an id, and a `core.unsubscribe_settings` row to render from.
- **Mailboxes in the console.** `/mailboxes` on the API is session-authenticated
  and works, but it answers for the signed-in PERSON rather than for the tenant
  — deliberately, because a mailbox belongs to whoever holds it. Who may see a
  workspace's mailboxes is a product question, not plumbing, so the page says so
  instead of guessing.
- **The invoice history.** Plan changes, checkout and the payment method are
  wired; downloading an invoice still points at support. Polar owns that
  surface and it needs a different portal call.

  Checkout and the card form both run as an OVERLAY on our own page rather than
  a trip to polar.sh, through `@polar-sh/checkout`. Verified against the Polar
  sandbox: a real checkout renders inside an iframe on `localhost:3000`. Two
  things were measured rather than assumed while wiring it, and both contradict
  what the first draft asserted:

  1. **`embed_origin` on checkout creation is not what makes embedding work.**
     Polar's checkout page answers `frame-ancestors *` with or without it, and a
     checkout created without it renders correctly under
     `?embed=true&embed_origin=…` — which is how the SDK loads it, appending the
     origin itself at frame time. An earlier draft added an environment variable
     and an `embeddable` response flag on that premise; both were removed once
     the sandbox disproved it.
  2. **`POST /v1/customer-sessions` needs a scope Polar does not grant by
     default.** With the organisation access token as issued, it answers `403
insufficient_scope`, so the card form never opens — for anybody, with no
     hint that the token is the problem. `customer_sessions:write` has to be
     added to the token in Polar's dashboard. The client turns that specific 403
     into a message naming the scope, and the route turns it into "this is on
     us, not on your account" rather than "try again in a moment", which would
     be false advice for a condition that never clears.
  3. **Polar has no customer until the first checkout.** With the scope added,
     the same call answers `422 Customer does not exist` for a workspace that
     has never subscribed — which is most of them. So the "Update payment
     method" button is not rendered at all without a subscription, and the page
     says the card is collected during checkout instead. The route still
     translates the 422, as a 409 rather than a 502, for the case where the two
     disagree.
  4. **The payment-method embed cannot be exercised against the sandbox.**
     `@polar-sh/checkout@0.4.1` resolves that iframe's host as
     `window.location.origin` when the page is itself served from polar.sh or
     sandbox.polar.sh, and otherwise hard-defaults to `https://polar.sh` —
     production, with no option to change it. A sandbox session token framed
     against production answers "Session expired", which is what it did when
     tested. The checkout embed is unaffected, because its URL comes from the
     checkout object. So the card form is correct for production and
     unverifiable before it gets there; it is the first thing to check on the
     first real deployment.

- **Filtering the log by delivery state, in SQL.** `last_event` is not a column
  — it is the worst-by-severity of a message's events — so the status filter is
  applied in TypeScript after the page. The consequence is visible and
  documented at the route: a filtered page can return fewer rows than the limit
  while more exist further down, and paging never stalls because the cursor
  comes from the last row EXAMINED rather than the last row returned. Fixing it
  properly means a materialised `messages.last_event` maintained by the ingest
  path, which is a change to the write path and belongs in its own piece of
  work.
- **A client-side error reporter.** Server errors go to Sentry; `error.tsx`
  logs to the console and shows the digest, which is enough to correlate with
  the server-side entry but is not the same as reporting.
- **Per-record DNS visibility, asked of an uncached resolver.** The domain page
  shows SES's verdict per record. What it cannot say is "we can see your DKIM
  record but not your SPF one a minute after you pasted it", because the pod's
  own resolver has cached the NXDOMAIN from before the record existed and will
  serve it for the negative TTL — so a person who has just published a record
  and presses Verify is told, repeatedly, that it is missing. The answer is a
  DNS-over-HTTPS query to a public resolver, against a fixed origin allowlist
  with `redirect: "error"`. An unused implementation of it was removed rather
  than left in the tree: an outbound fetcher inside the API that nothing calls
  is a liability, not a head start.
- **A `script-src` in the console's CSP.** `next.config.ts` sends
  `frame-ancestors`, `base-uri`, `form-action` and `object-src`, which cannot
  break a working page. A script policy on the App Router needs a per-request
  nonce threaded through the middleware and injected into every inline script;
  a wrong one does not degrade, it blanks the page, so it is its own piece of
  work.
- **Filtering the log by engagement.** `opened` and `clicked` are not in the
  severity table, so they can never BE a message's `last_event` — a message that
  was opened is still `delivered`. The status menu therefore does not offer
  them, because a filter that matches nothing every time reads as tracking being
  broken. Asking "who opened this" is a different query against
  `core.message_events` and a different screen.

### Tests the harness cannot run yet

Every store method here talks to Postgres with RLS engaged, and this repo has no
local database to point a test at — so what is unit-tested is the pure logic:
cursors, CSV parsing, the onboarding rule, the tenant middleware's refusals, the
broadcast field mapping, the meter's balance arithmetic and DNS provider
detection, the body limits and the request log. Three assertions are owed as
soon as there is an integration harness:

1. **`listEmails` drains under a status filter.** The filter runs in TypeScript
   after the page, so a rare status returns empty pages with a non-null cursor.
   The console now renders "Load more" whenever the cursor is non-null — before
   the fix it rendered a terminal empty state, and there was no way to reach the
   match forty rows further down. What is untested is that repeated paging
   eventually reaches it and then stops.
2. **`POST /contacts` reports 201 only for a contact it actually created.**
   The upsert reads Postgres's `xmax` system column to tell an insert from an
   update — the standard idiom, but an implementation detail rather than a
   documented one. If it is wrong, the symptom is a 200 where a 201 belonged.
3. **The FK-target checks are not bypassable.** `addToSegment` and
   `setTopicSubscription` re-read both ids under RLS before writing, because a
   Postgres foreign-key check runs as the referenced table's owner and is exempt
   from row security — so the constraint alone is satisfied by another tenant's
   segment. The guard is a plain `select` inside `withTenant`; proving it needs
   two tenants and a database.

### Numbers somebody still has to choose

The plan catalogue is `free` and `pro` with the placeholder allowances seeded in
migrations 0015, 0017 and 0027 — those files say in terms that nobody has made
the pricing decision. The plan cards render whatever the catalogue holds, and
deliberately show no prices at all: those live in Polar, which owns currency,
tax and any per-account discount, so a number typed into the console would be a
price we are not going to charge shown next to a button that takes money.
