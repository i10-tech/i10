# Stalwart configuration

⚠ **Two files here that are not interchangeable, and confusing them is how a
mail server boots into the wrong behaviour.**

## `config.json` — the startup file

Stalwart v0.16 is not a daemon driven by a large configuration file.
`config.json` contains **one object**: the
[DataStore](https://stalw.art/docs/ref/object/data-store) telling the server
where its database lives. Everything else — listeners, domains, DKIM
signatures, queue strategies, the directory backend — lives _in that database_
and is managed over the JMAP API.

The docs put it plainly: once the server is running, `config.json` is rarely
touched again, because the datastore location is the only setting that cannot
be changed through the API — the API itself is served out of the datastore.

Mounted at `/etc/stalwart/config.json`, passed with `--config`.

> **This replaced a `config.toml`.** The scaffold originally carried a TOML file
> with `[server]` and `[server.listener.*]` blocks, which is the v0.15 model. In
> v0.16 those keys are database objects, so the file would have been ignored —
> the server would have started on defaults, bound nothing we intended, and
> looked healthy while doing it. That file's own header said every key had to be
> checked against the pinned version before first boot. This is that check.

## `plan.ndjson` — everything else

The declarative configuration, applied with
[`stalwart-cli apply`](https://stalw.art/docs/management/cli/apply). One
operation per line; `upsert` matches an existing object by a natural key and
updates it in place, so re-applying converges rather than duplicating.

In practice you do not run that by hand. `../bootstrap.sh` does the whole
sequence — apply, ensure the tracer, reload, restart, verify, and print the DNS
records the server expects — and it is idempotent, so it is also the thing to
run after any edit to this file:

```sh
./infra/k8s/i10/stalwart/bootstrap.sh            # apply and roll
./infra/k8s/i10/stalwart/bootstrap.sh --verify   # check, change nothing
```

⚠ **It reads the plan out of the DEPLOYED ConfigMap, not out of your working
copy.** Argo carries this file into the pod under a content-hashed name; the
script finds that ConfigMap and applies what it contains. So an uncommitted
local edit does nothing until it is merged and synced — which is the point.
Configuring the server from something nobody else can see is how a cluster ends
up in a state no repository describes.

The underlying command, for when the script is not what you want:

```sh
stalwart-cli apply --file plan.ndjson
```

⚠ **Applying is not activating.** Directory _data_ (accounts, domains, aliases)
takes effect immediately, but anything compiled into the running core —
listeners, MTA rules and expressions, **directory backends**, telemetry — is
parsed once into an in-memory snapshot at boot. Saving the object updates the
database without rebuilding that snapshot. It applies only after:

```sh
stalwart-cli create Action/ReloadSettings
```

Every object in this plan is in that category, so the reload is not optional.

## ⚠ AN EXTERNAL DIRECTORY GIVES YOU AUTHENTICATION AND NOTHING ELSE

`Authentication.defaultUserRoleIds` ships **empty**, and with the internal
directory that is invisible because accounts created through the admin UI get a
role along the way. An LDAP-backed account is created by nobody. It authenticates
and then holds no permissions at all — not `emailReceive`, not a single
`jmapMailbox*` or IMAP verb.

The failure this produces is the most expensive kind, because **every signal you
would reach for says the credentials worked**:

```
services/authd   "bind succeeded"  uid=user_… mail=mohamed@i10.tech   ← repeatedly
Apple Mail       "Unable to verify account name or password"
```

The bind is genuinely succeeding — Stalwart → authd → Clerk `verify_password` is
fine end to end. What fails is the first operation _after_ login, and mail
clients almost universally report a post-login refusal as a credentials problem,
because from their side the two are indistinguishable. Two days can go into the
password.

Fixed by assigning Stalwart's built-in **User** role as the default:

```json
"defaultUserRoleIds": { "b": true }
```

⚠ `"b"` is a literal id, and it is a literal id because a plan cannot reference
an object it did not create — `#alias` only resolves within one plan, and the
built-in roles predate ours. Re-derive it rather than trusting this line if it
ever stops matching:

```sh
stalwart-cli query Role --json     # → {"description":"User","id":"b"}
```

The other three built-ins are `c` Group, `d` Tenant Administrator, `e` System
Administrator. `defaultAdminRoleIds` stays empty deliberately: that is the
mapping that would let a directory account administer the server, and it wants a
group membership to key on — see the first-boot section on why
`STALWART_RECOVERY_ADMIN` is still set.

## ⚠ AND THE SERVER HAS BEEN LOGGING INTO A VOID

The default `Tracer` is `@type: "Log"` writing to `/var/log/stalwart`. That
directory **does not exist in the container**, and the root filesystem is
read-only with only `/etc/stalwart`, `/var/lib/stalwart` and `/tmp` mounted. So
the tracer is enabled, at `info`, and producing nothing:

```sh
kubectl logs -n i10-prod i10-stalwart-0 -c stalwart --since=24h | wc -l   # 0
```

Not one line since first boot — which is why every problem in this directory's
history was diagnosed from the outside, by probing ports and reading authd's log
instead of the mail server's own.

**Done on 2026-09-02.** A `Stdout` tracer (`jcvq3ahgaaqa`, level `info`) now
carries the logs, and the file tracer (`jcrkontuahqb`) is disabled. It is not in
`plan.ndjson` because `Tracer` has **no filters**, so `matchOn` has nothing to
key on and neither `upsert` nor `reconcile` can converge — a Tracer is a
create-once object, like the first administrator. If it ever has to be rebuilt:

```sh
stalwart-cli query Tracer --json                      # note the Log tracer's id
stalwart-cli update Tracer <id> --field enable=false
stalwart-cli create Tracer --json '{"@type":"Stdout","enable":true,"level":"info","ansi":false,"multiline":false,"buffered":false,"lossy":false,"events":{},"eventsPolicy":"exclude"}'
stalwart-cli create Action/ReloadSettings
```

⚠ **And the tracer is part of the boot snapshot.** `Action/ReloadSettings` was
not enough — the pod had to be restarted before a single line appeared. Same
class as the certificate, two sections down. Budget a restart when changing it.

⚠ **The account's permission set is cached, and the reload does not clear it
either.** The log shows why: `store.cache-hit key = 1, collection = "accessToken"`.
Assigning `defaultUserRoleIds` above therefore appeared to do nothing for twenty
minutes — the role was in the database and the running server was still serving
the account its old, empty token. A pod restart is what made it take effect.

## ⚠ A PROXIED WILDCARD MAKES EVERY MAIL HOSTNAME HANG INSTEAD OF FAIL

`*.i10.tech` is an A record proxied through Cloudflare, so **every name that is
not explicitly declared resolves — to Cloudflare**. Cloudflare's proxy carries
HTTP and HTTPS and nothing else, so a mail client connecting to
`imap.i10.tech:993` gets a TCP connection that goes nowhere and sits until it
times out.

That is strictly worse than the name not existing. NXDOMAIN fails in
milliseconds and the client moves on; this hangs.

It matters because Apple Mail has no autoconfiguration to fall back on. The
server log settles that — during a full account setup from a Mac and an iPhone,
the autoconfig and autodiscover endpoints were requested **zero** times:

```
url = "/healthz/ready"  167
url = "/healthz/live"    57
(nothing else)
```

macOS and iOS Mail do not implement Thunderbird autoconfig, and they only speak
Microsoft Autodiscover for account type _Exchange_, never for "Other Mail
Account". So Apple guesses hostnames — `imap.<domain>`, `smtp.<domain>`, then
`mail.<domain>` — and the wildcard turned the first two guesses into timeouts.
The visible symptom was minutes of "Verifying" followed by a demand that the
user type `mail.i10.tech` by hand.

Fixed with two grey-cloud records, which must stay grey for the same reason
`mail` is:

```
imap.i10.tech.  CNAME  mail.i10.tech.
smtp.i10.tech.  CNAME  mail.i10.tech.
```

The general rule: **any hostname a mail client might guess needs an explicit
grey-cloud record**, because the wildcard guarantees it will resolve either way.
The `.mobileconfig` profile is the only path that does no guessing at all, which
is why it connects noticeably faster than a hand-typed account.

## `SystemSettings.services` is the client-provisioning contract

One map, two consumers, and that is the reason it is worth understanding:

- the autoconfig XML at `/mail/config-v1.1.xml` and the autodiscover response
  list exactly the protocols in it, and
- `Domain.dnsZoneFile` — the record set Stalwart says you should publish —
  derives its `SRV` records from it too.

It defaults to **all eight** protocols: jmap, imap, pop3, smtp, caldav, carddav,
webdav, managesieve. i10 exposes three ports to the internet (25, 465, 993, via
`hostPort` in the parent StatefulSet) and routes only the autoconfig paths over
HTTPS, so seven of those eight were being advertised to every mail client and
nominated for a DNS record while being unreachable. POP3 was the visible one:
Thunderbird would offer a POP3 account on 995 that could never connect.

The plan cuts it to `imap` and `smtp` — what actually answers. Verified after
applying: the XML lost its `pop3` and DAV blocks, and the zone file dropped
`_pop3s`, `_jmap`, `_caldavs` and `_carddavs`, leaving `_imaps._tcp` → 993 and
`_submissions._tcp` → 465.

Adding a protocol back is one entry in that map **and** the ingress or `hostPort`
that makes it reachable. Doing only the first is how this got into the state
above.

`providerInfo` beside it is the provider's own identity — name, documentation
URLs, a contact URI. Stalwart's own description is "information about the
provider to advertise in auto configuration services". Note that v0.16.19 does
not surface it in `config-v1.1.xml`, which still shows the address as the
display name; it is stored and reported, so this is forward-looking rather than
load-bearing.

### ⚠ And a reload is not enough for TLS certificates

`Action/ReloadSettings` does **not** make Stalwart serve a newly registered
certificate. This was established the hard way, and the intermediate state is
convincing enough to fool you: the `Certificate` object applied cleanly, and
querying it back showed `subjectAlternativeNames` of `*.i10.tech, i10.tech` —
which are **server-derived from the PEM**, so the server had demonstrably read,
parsed and validated the material. It went on presenting
`CN=rcgen self signed cert` to every client regardless.

Only restarting the pod switched it. Certificate selection is part of the
boot-time snapshot, not something the reload rebuilds.

That has a consequence beyond first setup. cert-manager renews the wildcard
roughly every 60 days, and **two** independent things then stop the new
certificate from being served: the PEM arrives as an environment variable, which
is fixed for the life of a container, and Stalwart would not switch certificates
without a restart even if it were not. `cert-reload.yaml` in the parent
directory is what closes both — a daily CronJob that compares the certificate's
`notBefore` against the running pod's start time and deletes the pod when the
certificate is the newer of the two.

### ⚠ And `matchOn` compares against the STORED shape, not the one you wrote

The Certificate upsert originally carried

```json
"subjectAlternativeNames": ["i10.tech", "*.i10.tech"]
```

which reads correctly, applies without error, and **matched nothing every time**.
Each apply therefore created another Certificate object — four of them by
2026-09-02, each holding its own copy of the private key, with
`defaultCertificateId` quietly following the newest.

Stalwart stores a `set<string>` as a map. `matchOn` compares the value in the
plan against the value the server would return, so the plan has to be written in
the stored shape:

```json
"subjectAlternativeNames": { "i10.tech": true, "*.i10.tech": true }
```

Proven by the error the map form produces: `ambiguous upsert; 4 existing objects
match on subjectAlternativeNames`. The array form produced no error at all,
which is exactly why it went unnoticed.

Two things follow.

**Duplicates already in the database must be deleted by hand, once.** With more
than one match the upsert now fails loudly rather than adding a fifth — an
improvement, but it means the next apply will not succeed until the extras are
gone. Keep the id in `SystemSettings.defaultCertificateId`, delete the rest:

```sh
stalwart-cli query Certificate --json          # note the id you are keeping
stalwart-cli delete Certificate <other-id>
```

**And `subjectAlternativeNames` is server-set, so this field is a match key and
nothing else.** Writing it does not change what the certificate covers; the SANs
come from the PEM. A `reconcile` operation rejects the object without it
(`match property ... is missing from the object body`), which is the other reason
it is present.

### The certificate only applies to SNI clients unless you say otherwise

`SystemSettings.defaultCertificateId` is what a connection with **no SNI** gets.
Mail clients send SNI; a sending MTA connecting to port 25 generally does not.
Leaving it null means inbound mail is offered a self-signed certificate on
STARTTLS while every client you test with sees the real one — a failure that is
invisible from the direction you are looking.

## First boot

`config.json` is always present here, so Stalwart never enters bootstrap mode —
an unreachable DataStore makes it exit rather than serve a setup wizard. The
first administrator therefore comes from recovery mode:

1. Start the pod with `STALWART_RECOVERY_MODE=1` and `STALWART_RECOVERY_ADMIN`
   (`username:password`) sourced from Doppler. Recovery mode disables every
   background service — no MTA, no task workers — and serves only the management
   API on 8080.
2. `stalwart-cli apply --file plan.ndjson`, then `Action/ReloadSettings`.
3. Drop **`STALWART_RECOVERY_MODE`** and restart. Mail services come up.

⚠ **DO NOT DROP `STALWART_RECOVERY_ADMIN` AT THE SAME TIME.** It is not an
account — it is a built-in credential that bypasses the directory, and it exists
only while the variable is set. Removing it leaves no way to administer the
server and no way to run the next `apply`.

It is honoured in normal mode as well as recovery mode, which is what makes the
intermediate state workable: services running, backdoor still available.

The backdoor comes out only once a real administrator can sign in — and with an
LDAP directory that means a Clerk user with a hosted address, `active` in the
projection, holding an admin role. That path needs the webhook receiver in
`apps/api` deployed and a role assignment this plan does not yet make. Until
then, `STALWART_RECOVERY_ADMIN` staying set is a known, temporary exception to
the guidance below — not an oversight.

⚠ It must not be left set permanently on production. The docs are explicit: it
is intended to rescue a server that has lost normal access, not to be a primary
login.

## App passwords are not disabled by configuration

The plan originally set `maxAppPasswords: 0` on the Authentication singleton to
enforce the one-email-one-password rule at the server. **Stalwart rejects it** —
`validationFailed: maxAppPasswords: must be at least 1`. There is no setting
that turns the feature off.

It is close to moot in practice: Stalwart stores app passwords as a secret on
the account in the **internal** directory, and i10 runs an external LDAP
directory, so there is nowhere for one to live. The product boundary is held by
never surfacing the feature in i10's own UI rather than by a server setting.

If that ever needs real enforcement, the mechanism is a permission denial on a
Role, not a limit — see `/docs/auth/authorization/permissions`.

## The database

`config.json` points at database `stalwart`, not `i10`. The CNPG cluster
bootstraps only `i10`, so the `stalwart` database and its role are created by
`database.yaml` in the parent directory. Stalwart owns its own database
deliberately: it manages its own schema, migrates it on upgrade, and must never
share a migration surface with the transactional product.

## `STALWART_WEBHOOK_SECRET` lives in two places, and must match

The `WebHook` object in `plan.ndjson` reads its `signatureKey` from the
environment — so the value has to be in the **Stalwart** pod's environment, which
is `envFrom: secretRef i10-stalwart`. The API verifies the same HMAC, so the same
value has to be in the **API** pod's environment, which is `i10-api`. Those are
two different Doppler configs.

⚠ **A mismatch fails closed and reads like an outage.** Every notification is
rejected with 403 and the direct route's mail silently stops reporting
`delivered` and `bounced` — the messages still go, so nothing looks broken from
the customer's side until they notice half their webhooks never arrive. Check it
by looking for `rejected a Stalwart notification` in the API log.

⚠ **It is NOT base64-decoded before it keys the HMAC**, unlike every other secret
in this repository. Stalwart signs with the configured string's own bytes
(`hmac::Key::new(HMAC_SHA256, settings.key.as_bytes())`), so
`apps/api/src/webhooks/stalwart.ts` deliberately does not use `decodeSecret`.
There is a test holding it to that, because "fixing" it to match its neighbours
is the obvious wrong move.

⚠ **And the signature has no timestamp**, so it never expires and a captured
request can be replayed forever. What makes that harmless is the
`(source_event_id, occurred_at)` dedupe — and that in turn only works because the
id is derived from the event's content rather than from Stalwart's own event id,
which changes on every redelivery. See `sourceEventIdFor`.

## What the webhook is for

`core.message_events` was written only by the SES ingest, so a direct-routed
message stopped at `sent` and never reached `delivered` or `bounced`. The five
events in the plan's include list are what close that:

| Stalwart event              | i10 event                | suppresses?                   |
| --------------------------- | ------------------------ | ----------------------------- |
| `delivery.delivered`        | `email.delivered`        | no                            |
| `delivery.rcpt-to-rejected` | `email.bounced`          | **yes, on 5xx only**          |
| `delivery.message-rejected` | `email.bounced`          | no — the address is fine      |
| `delivery.failed`           | `email.bounced`          | no — the retry window ran out |
| `queue.rescheduled`         | `email.delivery_delayed` | no                            |

⚠ **The join key is the VERP envelope sender**, which arrives on these events
from the `delivery.attempt-start` **span** rather than from the event itself.
Stalwart's collector attaches the open span to every event carrying its id and
the webhook serializer is built `.with_spans()`. Widening the include list to an
event that is not emitted inside a delivery span would produce notifications with
no `from`, which this ingest ignores.

⚠ **Asynchronous bounces are still invisible.** A receiver that answers `250` and
only later decides the mailbox is gone sends a DSN to the envelope sender, and we
accept no inbound mail for customer `bounce.` domains. That is what the VERP
envelope was originally built for and it remains the open half.

## The mailbox lever, and the one piece that is not here yet

`MtaOutboundStrategy.route` is an expression evaluated **per recipient**, and it
is awaited — so it can ask Postgres:

```
sql_query('i10', 'SELECT core.mailbox_route($1)', [sender_domain])
```

`core.mailbox_route` (migration 0036) returns the **name of a route**:
`mx` to deliver ourselves, `ses-relay` to hand the message to SES's SMTP
endpoint. It applies the same rule as `resolveRoute` in the API — kill switch,
then the domain's override, then the plan — so a plan change takes effect on the
next message rather than the next deploy.

⚠ **`sender_domain` IS THE RETURN PATH, NOT THE `From:` HEADER.** For human mail
that is the sender's own domain, which is what this wants. For our own
transactional mail on the direct route it is `bounce.<domain>` — the VERP
envelope — which matches no row, so it answers `mx` and the worker's decision
stands. That is not incidental: this expression sees **every** message in the
queue, and re-routing a transactional message onto SES here would give it a
return path SES does not own and break the SPF alignment the direct route exists
for. The `hosts_mailboxes` join is what prevents it.

⚠ **AN UNKNOWN ROUTE NAME FALLS BACK TO MX, WHICH IS WHY THIS SHIPS SAFELY.**
`get_route_or_default` answers `MX_GATEWAY` for a name it cannot resolve and logs
`Smtp(IdNotFound)`. So the worst case is mail leaving the way it does today.

⚠ **SO DOES A QUERY THAT FAILS, AND THAT IS WHY A BROKEN LOOKUP IS SILENT.**
Read from v0.16.19's source (`delivery.rs`, `expr/eval.rs`): any `sql_query`
error — store missing, permission denied, Postgres unreachable — makes `eval_if`
return nothing, the route becomes `"default"`, which is not a route, and that
resolves to MX. Nothing is stalled or deferred; the only trace is an
`Eval(Error)` event. The flip side: a lever that is wired wrong looks exactly
like a lever that is off. Check for `Eval(Error)` before trusting it.

⚠ **THE `StoreLookup` IS `namespace` PLUS A NESTED `store`.** The first version
of this plan put the Postgres fields at the top level with a `description`, and
the server refused it (`invalidPatch … description`) — which stopped every
`bootstrap.sh` run at that line from 2026-09-17 until it was fixed, including
the MtaOutboundStrategy line after it. `sw describe StoreLookup` shows the two
fields; the Postgres variant's fields are the same as `DataStore`'s.

⚠ **`apply --dry-run` WOULD NOT HAVE CAUGHT IT.** It fetches the schema and
parses the plan but does not validate properties: the broken plan dry-runs
clean. Only a real apply finds a wrong field.

⚠ **THE `stalwart` ROLE NEEDS USAGE ON `core`, NOT ONLY EXECUTE.** 0036 granted
EXECUTE on the function; resolving `core.mailbox_route` checks the schema first,
so without 0056's `GRANT USAGE ON SCHEMA core` every lookup fails — silently,
per the above. The password comes from CNPG's `i10-stalwart-db-role`, the same
one Stalwart's own data store already uses, so there is nothing to add to Doppler.

### What is missing: `ses-relay`

The `MtaRoute` is deliberately **not** in `plan.ndjson`, because it needs SES SMTP
credentials that do not exist yet — and a plan referencing a missing environment
variable is a plan that may not apply. Until it exists,
`core.routing_settings.ses_relay_enabled` stays `false` and `mailbox_route`
returns `mx` for everybody, so nothing routes to a gateway that is not there.

To turn the lever on, in this order:

1. **Create SES SMTP credentials** in the AWS console (IAM → SES → SMTP
   settings). These are NOT an access key pair; SES derives an SMTP password from
   a secret key and they are not interchangeable.
2. Put them in Doppler's Stalwart config as `SES_SMTP_USER` and
   `SES_SMTP_PASSWORD`, so they reach the pod through `i10-stalwart`.
3. Add this line to `plan.ndjson` and run `./bootstrap.sh`:

   ```json
   {
     "@type": "upsert",
     "object": "MtaRoute",
     "matchOn": ["description"],
     "value": {
       "ses-relay": {
         "@type": "Relay",
         "description": "SES SMTP relay for mailbox mail",
         "host": "email-smtp.eu-central-1.amazonaws.com",
         "port": 587,
         "tls": { "@type": "StartTls" },
         "auth": {
           "@type": "Basic",
           "username": {
             "@type": "EnvironmentVariable",
             "variableName": "SES_SMTP_USER"
           },
           "secret": {
             "@type": "EnvironmentVariable",
             "variableName": "SES_SMTP_PASSWORD"
           }
         }
       }
     }
   }
   ```

   ⚠ Check the object's field names with `stalwart-cli describe MtaRoute` before
   pasting. This block is written from the schema's shape and has not been
   applied against a running server.

4. Set `SES_RELAY_ENABLED=true` in Doppler's API config and roll the API. It
   publishes the flag into `core.routing_settings` at boot; nothing reads the
   environment variable directly.

⚠ **STEP 4 IS THE ONE THAT MOVES MAIL**, and today that means i10.tech's own
human mail, because it is the only mailbox domain and it is on `pro`. Verify the
relay works before throwing it — `SES_RELAY_ENABLED=false` puts it straight back.

⚠ **AND SES MUST BE ABLE TO SEND AS THOSE DOMAINS.** Relaying through SES means
SES applies its own policy: the sending identity has to be verified there, or it
refuses the message. A domain that only ever sent direct may not be.
