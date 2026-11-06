# Stalwart configuration

⚠ **Two files here that are not interchangeable, and confusing them is how a
mail server boots into the wrong behaviour.**

## `config.json` - the startup file

Stalwart (v1.0 since #365, v0.16 before it) is not a daemon driven by a large
configuration file.
`config.json` contains **one object**: the
[DataStore](https://stalw.art/docs/ref/object/data-store) telling the server
where its database lives. Everything else - listeners, domains, DKIM
signatures, queue strategies, the directory backend - lives _in that database_
and is managed over the JMAP API.

The docs put it plainly: once the server is running, `config.json` is rarely
touched again, because the datastore location is the only setting that cannot
be changed through the API - the API itself is served out of the datastore.

Mounted at `/etc/stalwart/config.json`, passed with `--config`.

> **This replaced a `config.toml`.** The scaffold originally carried a TOML file
> with `[server]` and `[server.listener.*]` blocks, which is the v0.15 model. In
> v0.16 those keys are database objects, so the file would have been ignored -
> the server would have started on defaults, bound nothing we intended, and
> looked healthy while doing it. That file's own header said every key had to be
> checked against the pinned version before first boot. This is that check.

## `plan.ndjson` - everything else

The declarative configuration, in
[`stalwart-cli apply`](https://stalw.art/docs/management/cli/apply)'s format.
One operation per line; `upsert` matches an existing object by a natural key and
updates it in place, so re-applying converges rather than duplicating.

In practice you do not run that by hand. `../bootstrap.sh` does the whole
sequence - apply, ensure the tracer, reload, restart, verify, and print the DNS
records the server expects - and it is idempotent, so it is also the thing to
run after any edit to this file:

```sh
./infra/k8s/i10/stalwart/bootstrap.sh            # apply and roll
./infra/k8s/i10/stalwart/bootstrap.sh --verify   # check, change nothing
./infra/k8s/i10/stalwart/bootstrap.sh --dry-run  # show what would change
PLAN_FILE=path ./infra/k8s/i10/stalwart/bootstrap.sh --dry-run  # a branch's plan
```

⚠ **IT SPEAKS STALWART'S MANAGEMENT API DIRECTLY, OVER A PORT-FORWARD.** It used
to start one `stalwart-cli` pod per command - an image pull, a scheduling round
and a NetworkPolicy race each, about a minute apiece. The plan engine is a port
of the CLI's own `apply` rules (match on `matchOn`, update without immutable and
server-set fields, `#name` resolved by the server through `createdIds`), and
`--dry-run` proves it: against the deployed plan it reports every object
`unchanged`. Only `upsert`, `update` and `create` are supported; a plan that
needs `destroy` or `reconcile` fails loudly and wants the CLI.

⚠ **It reads the plan out of the DEPLOYED ConfigMap, not out of your working
copy.** Argo carries this file into the pod under a content-hashed name; the
script finds that ConfigMap and applies what it contains. So an uncommitted
local edit does nothing until it is merged and synced - which is the point.
Configuring the server from something nobody else can see is how a cluster ends
up in a state no repository describes.

The underlying command, for when the script is not what you want:

```sh
stalwart-cli apply --file plan.ndjson
```

⚠ **Applying is not activating.** Directory _data_ (accounts, domains, aliases)
takes effect immediately, but anything compiled into the running core -
listeners, MTA rules and expressions, **directory backends**, telemetry - is
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
and then holds no permissions at all - not `emailReceive`, not a single
`jmapMailbox*` or IMAP verb.

The failure this produces is the most expensive kind, because **every signal you
would reach for says the credentials worked**:

```
services/authd   "bind succeeded"  uid=user_… mail=mohamed@i10.tech   ← repeatedly
Apple Mail       "Unable to verify account name or password"
```

The bind is genuinely succeeding - Stalwart → authd → Clerk `verify_password` is
fine end to end. What fails is the first operation _after_ login, and mail
clients almost universally report a post-login refusal as a credentials problem,
because from their side the two are indistinguishable. Two days can go into the
password.

Fixed by assigning Stalwart's built-in **User** role as the default:

```json
"defaultUserRoleIds": { "b": true }
```

⚠ `"b"` is a literal id, and it is a literal id because a plan cannot reference
an object it did not create - `#alias` only resolves within one plan, and the
built-in roles predate ours. Re-derive it rather than trusting this line if it
ever stops matching:

```sh
stalwart-cli query Role --json     # → {"description":"User","id":"b"}
```

The other three built-ins are `c` Group, `d` Tenant Administrator, `e` System
Administrator. `defaultAdminRoleIds` stays empty deliberately: that is the
mapping that would let a directory account administer the server, and it wants a
group membership to key on - see the first-boot section on why
`STALWART_RECOVERY_ADMIN` is still set.

## ⚠ AND THE SERVER HAS BEEN LOGGING INTO A VOID

The default `Tracer` is `@type: "Log"` writing to `/var/log/stalwart`. That
directory **does not exist in the container**, and the root filesystem is
read-only with only `/etc/stalwart`, `/var/lib/stalwart` and `/tmp` mounted. So
the tracer is enabled, at `info`, and producing nothing:

```sh
kubectl logs -n i10-prod i10-stalwart-0 -c stalwart --since=24h | wc -l   # 0
```

Not one line since first boot - which is why every problem in this directory's
history was diagnosed from the outside, by probing ports and reading authd's log
instead of the mail server's own.

**Done on 2026-09-02.** A `Stdout` tracer (`jcvq3ahgaaqa`, level `info`) now
carries the logs, and the file tracer (`jcrkontuahqb`) is disabled. It is not in
`plan.ndjson` because `Tracer` has **no filters**, so `matchOn` has nothing to
key on and neither `upsert` nor `reconcile` can converge - a Tracer is a
create-once object, like the first administrator. If it ever has to be rebuilt:

```sh
stalwart-cli query Tracer --json                      # note the Log tracer's id
stalwart-cli update Tracer <id> --field enable=false
stalwart-cli create Tracer --json '{"@type":"Stdout","enable":true,"level":"info","ansi":false,"multiline":false,"buffered":false,"lossy":false,"events":{},"eventsPolicy":"exclude"}'
stalwart-cli create Action/ReloadSettings
```

⚠ **And the tracer is part of the boot snapshot.** `Action/ReloadSettings` was
not enough - the pod had to be restarted before a single line appeared. Same
class as the certificate, two sections down. Budget a restart when changing it.

⚠ **The account's permission set is cached, and the reload does not clear it
either.** The log shows why: `store.cache-hit key = 1, collection = "accessToken"`.
Assigning `defaultUserRoleIds` above therefore appeared to do nothing for twenty
minutes - the role was in the database and the running server was still serving
the account its old, empty token. A pod restart is what made it take effect.

## ⚠ A PROXIED WILDCARD MAKES EVERY MAIL HOSTNAME HANG INSTEAD OF FAIL

`*.i10.tech` is an A record proxied through Cloudflare, so **every name that is
not explicitly declared resolves - to Cloudflare**. Cloudflare's proxy carries
HTTP and HTTPS and nothing else, so a mail client connecting to
`imap.i10.tech:993` gets a TCP connection that goes nowhere and sits until it
times out.

That is strictly worse than the name not existing. NXDOMAIN fails in
milliseconds and the client moves on; this hangs.

It matters because Apple Mail has no autoconfiguration to fall back on. The
server log settles that - during a full account setup from a Mac and an iPhone,
the autoconfig and autodiscover endpoints were requested **zero** times:

```
url = "/healthz/ready"  167
url = "/healthz/live"    57
(nothing else)
```

macOS and iOS Mail do not implement Thunderbird autoconfig, and they only speak
Microsoft Autodiscover for account type _Exchange_, never for "Other Mail
Account". So Apple guesses hostnames - `imap.<domain>`, `smtp.<domain>`, then
`mail.<domain>` - and the wildcard turned the first two guesses into timeouts.
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
- `Domain.dnsZoneFile` - the record set Stalwart says you should publish -
  derives its `SRV` records from it too.

It defaults to **all eight** protocols: jmap, imap, pop3, smtp, caldav, carddav,
webdav, managesieve. i10 exposes three ports to the internet (25, 465, 993, via
`hostPort` in the parent StatefulSet) and routes only the autoconfig paths over
HTTPS, so seven of those eight were being advertised to every mail client and
nominated for a DNS record while being unreachable. POP3 was the visible one:
Thunderbird would offer a POP3 account on 995 that could never connect.

The plan cuts it to `imap` and `smtp` - what actually answers. Verified after
applying: the XML lost its `pop3` and DAV blocks, and the zone file dropped
`_pop3s`, `_jmap`, `_caldavs` and `_carddavs`, leaving `_imaps._tcp` → 993 and
`_submissions._tcp` → 465.

Adding a protocol back is one entry in that map **and** the ingress or `hostPort`
that makes it reachable. Doing only the first is how this got into the state
above.

`providerInfo` beside it is the provider's own identity - name, documentation
URLs, a contact URI. Stalwart's own description is "information about the
provider to advertise in auto configuration services". Note that v0.16.19 does
not surface it in `config-v1.1.xml`, which still shows the address as the
display name; it is stored and reported, so this is forward-looking rather than
load-bearing.

### ⚠ And a reload is not enough for TLS certificates

`Action/ReloadSettings` does **not** make Stalwart serve a newly registered
certificate. This was established the hard way, and the intermediate state is
convincing enough to fool you: the `Certificate` object applied cleanly, and
querying it back showed `subjectAlternativeNames` of `*.i10.tech, i10.tech` -
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
directory is what closes both - a daily CronJob that compares the certificate's
`notBefore` against the running pod's start time and deletes the pod when the
certificate is the newer of the two.

### ⚠ And `matchOn` compares against the STORED shape, not the one you wrote

The Certificate upsert originally carried

```json
"subjectAlternativeNames": ["i10.tech", "*.i10.tech"]
```

which reads correctly, applies without error, and **matched nothing every time**.
Each apply therefore created another Certificate object - four of them by
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
than one match the upsert now fails loudly rather than adding a fifth - an
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
STARTTLS while every client you test with sees the real one - a failure that is
invisible from the direction you are looking.

## First boot

`config.json` is always present here, so Stalwart never enters bootstrap mode -
an unreachable DataStore makes it exit rather than serve a setup wizard. The
first administrator therefore comes from recovery mode:

1. Start the pod with `STALWART_RECOVERY_MODE=1` and `STALWART_RECOVERY_ADMIN`
   (`username:password`) sourced from Doppler. Recovery mode disables every
   background service - no MTA, no task workers - and serves only the management
   API on 8080.
2. `stalwart-cli apply --file plan.ndjson`, then `Action/ReloadSettings`.
3. Drop **`STALWART_RECOVERY_MODE`** and restart. Mail services come up.

⚠ **DO NOT DROP `STALWART_RECOVERY_ADMIN` AT THE SAME TIME.** It is not an
account - it is a built-in credential that bypasses the directory, and it exists
only while the variable is set. Removing it leaves no way to administer the
server and no way to run the next `apply`.

It is honoured in normal mode as well as recovery mode, which is what makes the
intermediate state workable: services running, backdoor still available.

The backdoor comes out only once a real administrator can sign in - and with an
LDAP directory that means a Clerk user with a hosted address, `active` in the
projection, holding an admin role. That path needs the webhook receiver in
`apps/api` deployed and a role assignment this plan does not yet make. Until
then, `STALWART_RECOVERY_ADMIN` staying set is a known, temporary exception to
the guidance below - not an oversight.

⚠ It must not be left set permanently on production. The docs are explicit: it
is intended to rescue a server that has lost normal access, not to be a primary
login.

## App passwords are not disabled by configuration

The plan originally set `maxAppPasswords: 0` on the Authentication singleton to
enforce the one-email-one-password rule at the server. **Stalwart rejects it** -
`validationFailed: maxAppPasswords: must be at least 1`. There is no setting
that turns the feature off.

It is close to moot in practice: Stalwart stores app passwords as a secret on
the account in the **internal** directory, and i10 runs an external LDAP
directory, so there is nowhere for one to live. The product boundary is held by
never surfacing the feature in i10's own UI rather than by a server setting.

⚠ **SO IT IS ENFORCED BY A ROLE NOW (#365).** The role `i10 User` inherits the
built-in `b` (User) through `roleIds` and lists every `sysAppPassword*` and
`sysApiKey*` permission in `disabledPermissions`; `Authentication` makes it the
default user role. Inheriting instead of copying keeps every permission a later
release adds to `b`. OAuth grants stay, because device sign-in needs them. Role
has no name field, so the plan matches it on `description`: renaming it in the
UI makes the next run create a second one.

## The database

`config.json` points at database `stalwart_v1`, not `i10`. The CNPG cluster
bootstraps only `i10`, so Stalwart's databases and their role are created by
`database.yaml` in the parent directory. Stalwart owns its own database
deliberately: it manages its own schema, migrates it on upgrade, and must never
share a migration surface with the transactional product.

⚠ **THERE IS NO v0.16 STORE ANY MORE.** v1.0 cannot open a v0.16 store, so #365
copied `stalwart` into `stalwart_v1` with `stalwart-migrate` (a hand-applied
pod, in git until the cleanup PR), then dropped `stalwart` and the migration
state. Going back to v0.16 is no longer possible. The next upgrade that needs a
copy repeats the pattern: a new database beside this one, a migrate pod, and
the old store kept until the new one has proved itself.

## Upgrading to v1.0 (#365)

What changed for this directory, every item found by applying the v0.16 plan to
a scratch v1.0.3 server and by a full `stalwart-migrate` rehearsal, not read off
the docs site:

- Renamed fields: Directory `filterMailbox` → `filterRecipient`; Domain
  `isEnabled` → `enable`; BlobStore `accessKey` → `accessKeyId`, and its custom
  region is `{url, region}` instead of `{customEndpoint, customRegion}`;
  NetworkListener `tlsImplicit` → `implicitTls`; MtaRoute `address` → `host`; a
  Postgres store's `timeout` → `connectTimeout` (in `config.json` too).
- `SenderAuth.dkimSignDomain` moved to `MtaStageData.dkimSignDomain`.
- A listener's `maxConnections` is now nullable and inherits from
  SystemSettings. The migration clears every v0.16 default of 8192, so the relay
  no longer pins it.
- `stalwart-migrate prepare` converts all of this itself. Its report for our
  settings: 0 dropped objects, and warnings only for permissions and OIDC
  provider fields 1.0 no longer has. After the migration the converted
  `plan.ndjson` dry-runs as unchanged, which is the check that the two agree.
- A Certificate's `subjectAlternativeNames` is server-set from the PEM, and the
  CN counts. Ours names `i10.tech` and `*.i10.tech` only, so `matchOn` still
  matches; a certificate whose CN is not among its SANs would be created twice.

## The tuning pass (#365)

The second half of `plan.ndjson` (Email onward) is the tuning pass approved on
#365. The proposal lists every setting with its current value and the reason;
what follows are the ones whose reason is not obvious from the value.

- ⚠ **40 MB ON 465, 50 MB ON 25, BECAUSE OF SES.** SES refuses a message over
  40 MB (a fixed quota) and mailbox mail relays through SES, so submission
  stops there instead of failing at delivery. Inbound is 50 MB to match
  `Email.maxMessageSize`, so nothing is accepted that cannot be stored.
  `MtaStageRcpt.maxRecipients` is 50 on 465 for the same reason.
- ⚠ **THE `rcptrate` THROTTLE IS PORT 25 ONLY.** Matched on "not 2525" it also
  capped our own customers on 465 at 25 messages an hour to one recipient.
  Submission has its own per-account limits instead, keyed on
  `authenticatedAs`: 200 an hour and 1000 a day.
- ⚠ **THE OUTBOUND BACKSTOP IS PER SENDER DOMAIN, NOT PER SENDER.** The send
  worker's relay mail carries a unique `bounce+` envelope sender per message,
  so a per-sender limit on it would never trigger. 2525 skips every inbound
  check by design; this is the one limit that catches a runaway worker.
- ⚠ **PYZOR IS OFF ON PURPOSE, AND THE MIGRATION HAD TURNED IT BACK ON.** 1.0
  ships it off, but `prepare`'s recommended policy pins 0.16's `true`. It sends
  a fingerprint of every inbound message and our IP to a third party.
- ⚠ **CACHE SIZES ARE READ AT STARTUP, AND 1.0'S DEFAULTS DO NOT FIT THE POD.**
  `messages` and `messagesLarge` default to 320 MB and 512 MB against a 1 GiB
  limit. The plan sets 128 MB and 64 MB; restart after applying.
- ⚠ **THE CLIENT IP COMES FROM X-Forwarded-For, ONE HOP.** Behind Traefik every
  client looked like Traefik for bans and rate limits. Anything that can reach
  8080 directly can therefore claim any address. Today that is every pod in
  i10-prod (`allow-same-namespace`, which a NetworkPolicy cannot narrow), plus
  Traefik.
- **The cluster and the tailnet are `AllowedIp`** (10.42.0.0/16, fd42::/48,
  100.64.0.0/10, fd7a:115c:a1e0::/48), so a burst of failures from our own
  components can never ban them. **Bans last 30 days** instead of forever.
- **Failure reports are off** (DMARC `ruf`, DKIM and SPF). They send message
  headers to whoever the sender's domain names, which for a mail host is
  personal data leaving to third parties. Aggregate reports stay on, now from
  `i10.tech` with `postmaster@i10.tech` as the contact.
- **MTA-STS names `mail.i10.tech` but stays `testing`.** Enforce after four
  weeks of clean TLS reports, and only with certificate-expiry alerting in
  place: enforcing with a broken certificate stops inbound mail.
- **pop3s, sieve and https are deleted** by an `absent` operation, which is
  bootstrap.sh's own (stalwart-cli has no declarative delete). It destroys
  what matches and does nothing on later runs.

Approved but not in the plan, because each needs something first:

- Blob encryption (`Email.blobEncryptionKey`): a key in Doppler with a copy
  outside it and a rotation runbook. Losing the key loses every message.
- The Prometheus exporter: a scraper and an auth secret.
- `Search.supportedLanguages`: which languages customers write in. Changing it
  later reindexes everything.
- Per-account disk quotas and the API's JMAP rate limit: both need a probe on
  one account first.

## Blobs live in R2 (#357)

Message bodies, attachments and users' Sieve scripts go to the private R2 bucket
`i10-mail` (`BlobStore` in plan.ndjson), so the database holds metadata only and
every Stalwart node reads the same blobs. The keys are `STALWART_S3_ACCESS_KEY`
and `STALWART_S3_SECRET_KEY` in Doppler `prod_stalwart`, from a token scoped to
`i10-mail` alone with Object Read and Write. The bucket is imported in
`infra/tofu/stacks/data`.

⚠ **CHANGING THE BLOB STORE DOES NOT MOVE A SINGLE BLOB.** Stalwart writes new
blobs to the new store and looks old ones up there too, so everything written
before the change stops being readable. The switch to R2 dropped the test mail
that existed then. Moving it again on a server with real mail is an
`--export`/`--import` into fresh stores (`/docs/management/maintenance/migration`),
not a plan edit.

**System Sieve scripts are not blobs.** `SieveSystemScript` (`ses-references`)
is a settings object, and its `contents` live in the data store with the rest of
the plan. Proven on the switch (2026-11-06): re-applying the plan rewrote the
script and `i10-mail` stayed empty, and a relayed send afterwards still carried
the original Message-ID in `References`. A user's own Sieve scripts (filters,
vacation replies) are blobs, and would be lost like any message body.

⚠ **THE STORE CHANGE NEEDS A RESTART, AND THE KEYS NEED ONE BEFORE THAT.** A
setting that names an unset variable is accepted and fails at first use, which
for the blob store is the first delivery. `bootstrap.sh` therefore refuses any
plan that names a variable the running container lacks, and a key added to
Doppler reaches the container only when the pod restarts.

To switch, in this order:

1. Create `i10-mail` by hand (location Eastern Europe, no public access, no
   custom domain), then `tofu apply` in `stacks/data` to import it.
2. Create the token and put both keys in Doppler `prod_stalwart`.
3. Restart the pod (`kubectl rollout restart sts/i10-stalwart -n i10-prod`) so
   it has the keys. Merging this plan rolls it too, through the ConfigMap hash.
4. `./bootstrap.sh` on psl-vps: it applies `BlobStore`, reloads and restarts.
5. Deliver a message and check that a new object is in `i10-mail` and that the
   message reads back over JMAP.

## Two nodes on one box (#358)

Stalwart runs as a two-node cluster on psl-vps: `i10-stalwart-0` (edge) and
`i10-stalwart-internal-0` (internal), both built from `node/statefulset.yaml`.
They share Postgres (data, search), R2 (blobs) and `i10-stalwart-redis`
(in-memory store and coordinator, `redis.yaml`). Neither holds data of its own,
and the pod hostname is the node id, so each StatefulSet's `-0` keeps its id
across restarts.

| Node     | Listeners                    | Tasks                              | Reached through                                            |
| -------- | ---------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| edge     | all, mail ports on hostPorts | all (no `STALWART_ROLE`)           | MX, IMAP/SMTP clients, `i10-stalwart-mail`, `i10-stalwart` |
| internal | `http` (8080) only           | `outboundMta`, `pushNotifications` | `i10-stalwart` only                                        |

⚠ **ONE NODE ON THE HOST'S MAIL PORTS, AND THAT IS NOT A CHOICE.** psl-vps is a
single Kubernetes node and 25/465/993 are hostPorts, so a second pod claiming
them would sit Pending. The internal node exists to take JMAP load (our API, the
webmail) off the pod that handles mail, not to stand in for it.

⚠ **THE `internal` ROLE NAMES ITS LISTENER BY REFERENCE, NOT BY ID.**
`listenerIds` takes server ids, and a rebuilt or migrated store has new ones; a
role naming a stale id is refused (`invalidForeignKey`), or, on a store where
the id exists but is another listener, enables the wrong one. So the line before
the role upserts the `http` listener by name with nothing to change, which binds
`#http` to whatever id it has on this server, and the role writes
`{"#http": true}`. Until #365 the plan pinned `jcrkonsmahab`, the id the 0.16
server gave `http` at first boot.

⚠ **THE SCHEDULER AND SPAM TRAINING STAY ON THE EDGE NODE.** Each node with
`taskScheduler` queues its own copy of every periodic task, and two nodes
training the classifier at once is unsupported. That is why the internal node
has a role at all: without `STALWART_ROLE`, or with a role that does not exist
yet, a node runs everything.

⚠ **STORE AND ROLE CHANGES NEED EVERY NODE RESTARTED.** They are read at
startup; the coordinator carries cache invalidations and setting reloads, not
these. `bootstrap.sh` restarts every pod labelled
`app.kubernetes.io/part-of=i10-stalwart`, edge first.

To bring it up, in this order:

1. Merge with the internal StatefulSet at `replicas: 0` (as shipped). Argo
   starts `i10-stalwart-redis` and rolls the edge pod for its new label.
2. `./bootstrap.sh` on psl-vps: it applies `InMemoryStore` (Redis), then
   `Coordinator` (which Stalwart refuses while the in-memory store is local),
   creates the `internal` role, and restarts.
3. Raise `replicas` to 1 in `internal/kustomization.yaml` and merge.
4. Check both nodes are `active` in `x:ClusterNode/get`, and that JMAP answers
   with either pod deleted.

## The internal relay

The send worker hands direct-route mail to the `relay` listener on **2525**, with
**no account and no credential**. The trust is where the connection comes from:

- **No hostPort** (node/statefulset.yaml) - nothing on the node's public addresses
  answers on 2525.
- **Not in `allow-public-mail`** (networkpolicy.yaml) - traffic from outside the
  namespace cannot reach it. `allow-same-namespace` is what lets the worker in.
- **ClusterIP only** (service.yaml) - `i10-stalwart-mail:2525` is the name the
  worker dials, set in worker.yaml because it is an address, not a secret.

Everything that makes 2525 different is in `plan.ndjson`, keyed on
`local_port == 2525`:

| Object                  | On 2525                                                |
| ----------------------- | ------------------------------------------------------ |
| `MtaStageAuth.require`  | no AUTH                                                |
| `MtaStageRcpt`          | relays, but only for a `bounce+` envelope sender       |
| `MtaStageData`          | no spam filter - this is our own outbound mail         |
| `MtaInboundThrottle` ×2 | exempt - one pod IP sends everything, at 8-way fan-out |

SPF, DMARC, reverse-IP checks and the added headers were already scoped to
`local_port == 25`, and Stalwart only DKIM-signs for authenticated sessions, so
none of them needed a rule - the worker signs before it hands over.

⚠ **THIS REPLACED A SUBMISSION ACCOUNT THAT COULD NEVER HAVE WORKED.** The first
design had the worker authenticate as `submission@i10.tech` on 465. Stalwart
refuses to hold a password for any account while authd is the directory -
`Cannot set credentials for accounts in an external directory` - and authd only
answers binds for Clerk users and its one service DN. `AccountPassword`, which
the bootstrap tried instead, is the _logged-in_ account's own password: pointed
at the recovery admin, it would have changed that. The account was deleted on
2026-09-26.

⚠ **PLAINTEXT, DELIBERATELY.** upyo upgrades whenever STARTTLS is offered and
verifies against the name it dialled; the certificate is `*.i10.tech` and the
worker dials a `.svc.cluster.local` name, with no `servername` override to
verify against instead. So the listener offers no TLS (`useTls: false`) and the
client requires none. Nothing secret crosses the hop, and on one node it never
leaves the host. A second node means encrypting pod traffic (flannel's WireGuard
backend), not this connection.

⚠ **A REFUSAL HERE IS OURS, AND THE WORKER DEFERS IT.** With no AUTH, a relay
misconfiguration surfaces in the message phase - `550 5.1.2 Relay not allowed`
at `RCPT TO`, `503 5.5.1` or `550 5.7.1` at `MAIL FROM` - and every message
would get the same answer. `send/stalwart.ts` keeps those three in the queue
instead of failing it; `5.1.1` and `5.3.4` are still about the message.

⚠ **NEVER ADD 2525 TO A hostPort OR TO `allow-public-mail`.** Either makes this
an open relay for the internet.

## `STALWART_WEBHOOK_SECRET` lives in two places, and must match

The `WebHook` object in `plan.ndjson` reads its `signatureKey` from the
environment - so the value has to be in the **Stalwart** pod's environment, which
is `envFrom: secretRef i10-stalwart`. The API verifies the same HMAC, so the same
value has to be in the **API** pod's environment, which is `i10-api`. Those are
two different Doppler configs.

⚠ **A mismatch fails closed and reads like an outage.** Every notification is
rejected with 403 and the direct route's mail silently stops reporting
`delivered` and `bounced` - the messages still go, so nothing looks broken from
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
`(source_event_id, occurred_at)` dedupe - and that in turn only works because the
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
| `delivery.message-rejected` | `email.bounced`          | no - the address is fine      |
| `delivery.failed`           | `email.bounced`          | no - the retry window ran out |
| `queue.rescheduled`         | `email.delivery_delayed` | no                            |

⚠ **The join key is the VERP envelope sender**, which arrives on these events
from the `delivery.attempt-start` **span** rather than from the event itself.
Stalwart's collector attaches the open span to every event carrying its id and
the webhook serializer is built `.with_spans()`. Widening the include list to an
event that is not emitted inside a delivery span would produce notifications with
no `from`, which this ingest ignores.

⚠ **Asynchronous bounces are invisible, by design.** A receiver that answers
`250` and only later decides the mailbox is gone sends a DSN to the envelope
sender - the customer's `send.<domain>`, whose MX is Amazon's because SES
requires it - and Amazon drops a DSN for mail it did not send. One return path
for both routes costs exactly this; see docs/decisions/mail-routing.md, "One
return path".

## The mailbox lever

`MtaOutboundStrategy.route` is an expression evaluated **per recipient**, and it
is awaited - so it can ask Postgres:

```
sql_query('i10', 'SELECT core.mailbox_route($1)', [sender_domain])
```

⚠ **LOCAL RECIPIENTS ARE MATCHED FIRST, OR THE LEVER SENDS INTERNAL MAIL OUT.**
The route's `match` sends `is_local_domain(rcpt_domain)` to `'local'` before the
lookup runs. It was added on the live server by hand and found missing from
this plan on 2026-11-05, when a dry-run showed `would change route`; applying
the plan as it stood would have deleted it, and with `ses-relay` on, mail
between two i10 mailboxes would have left through SES and come back over the
internet. It is written in the STORED shape (`{"0": {...}}`, a list kept as a
map) so the dry-run compares equal.

`core.mailbox_route` (migration 0036, replaced in 0132) returns the **name of a route**:
`mx` to deliver ourselves, `ses-relay` to hand the message to SES's SMTP
endpoint. It applies the same rule as `resolveRoute` in the API - kill switch,
then the domain's override, otherwise SES. The plan is no longer an input.
Our own mailbox domains come from `MAIL_DOMAINS`, because they are code-defined
rather than rows in `core.domains`.

⚠ **`sender_domain` IS THE RETURN PATH, NOT THE `From:` HEADER.** For human mail
that is the sender's own domain, which is what this wants. For our own
transactional mail on the direct route it is the return path, `send.<domain>` -
which matches no hosted mailbox row, so it answers `mx` and the worker's
decision stands. That is not incidental: this expression sees **every** message
in the queue, and re-routing a transactional message onto SES here would
silently move it off the worker's chosen route. The `hosts_mailboxes` join is
what prevents it.

⚠ **AN UNKNOWN ROUTE NAME FALLS BACK TO MX, WHICH IS WHY THIS SHIPS SAFELY.**
`get_route_or_default` answers `MX_GATEWAY` for a name it cannot resolve and logs
`Smtp(IdNotFound)`. So the worst case is mail leaving the way it does today.

⚠ **SO DOES A QUERY THAT FAILS, AND THAT IS WHY A BROKEN LOOKUP IS SILENT.**
Read from v0.16.19's source (`delivery.rs`, `expr/eval.rs`): any `sql_query`
error - store missing, permission denied, Postgres unreachable - makes `eval_if`
return nothing, the route becomes `"default"`, which is not a route, and that
resolves to MX. Nothing is stalled or deferred; the only trace is an
`Eval(Error)` event. The flip side: a lever that is wired wrong looks exactly
like a lever that is off. Check for `Eval(Error)` before trusting it.

⚠ **THE `StoreLookup` IS `namespace` PLUS A NESTED `store`.** The first version
of this plan put the Postgres fields at the top level with a `description`, and
the server refused it (`invalidPatch … description`) - which stopped every
`bootstrap.sh` run at that line from 2026-09-17 until it was fixed, including
the MtaOutboundStrategy line after it. The server's schema (`/api/schema`) shows
the two fields; the Postgres variant's fields are the same as `DataStore`'s.

⚠ **`stalwart-cli apply --dry-run` WOULD NOT HAVE CAUGHT IT.** It parses the plan
without asking the server about properties: the broken plan dry-runs clean.
`./bootstrap.sh --dry-run` would - it checks every top-level property against
the live schema and names the ones the object does not have.

⚠ **THE `stalwart` ROLE NEEDS USAGE ON `core`, NOT ONLY EXECUTE.** 0036 granted
EXECUTE on the function; resolving `core.mailbox_route` checks the schema first,
so without 0056's `GRANT USAGE ON SCHEMA core` every lookup fails - silently,
per the above. The password comes from CNPG's `i10-stalwart-db-role`, the same
one Stalwart's own data store already uses, so there is nothing to add to Doppler.

### The `ses-relay` route

The `MtaRoute` is the last line of `plan.ndjson`. It authenticates to SES's SMTP
endpoint in eu-central-1 as the IAM user `i10-stalwart-smtp`, which can only
`ses:SendRawEmail`. Its credentials are `SES_SMTP_USER` and `SES_SMTP_PASSWORD`
in Doppler's `prod_stalwart`, reaching the pod through `i10-stalwart`. Until the
lever is thrown, `core.routing_settings.ses_relay_enabled` stays `false` and
`mailbox_route` returns `mx` for everybody.

⚠ **SES SMTP CREDENTIALS ARE NOT AN ACCESS KEY PAIR.** The console's "Create
SMTP credentials" derives the password from a secret key, per region; a key made
for another region is refused.

⚠ **THE USERNAME CANNOT BE AN `EnvironmentVariable`.** Only `SecretKey` fields
(`authSecret`) can name one; `authUsername` is a plain string. The username is an
access key id, which does not belong in git, so the plan writes
`{"@fromSecret": "SES_SMTP_USER"}` and `bootstrap.sh` replaces it with that key
of `i10-stalwart` at apply time. The dry-run prints property names, never values.

⚠ **THE FIELDS ARE FLAT.** `host`, `port`, `protocol`, `implicitTls`,
`authUsername`, `authSecret`. On v0.16 the host was `address` and the 1.0 name
was refused; #365 renamed it. An earlier draft of this section also nested the
rest under `tls` and `auth`. Port 587 with `implicitTls: false` is STARTTLS.

⚠ **SES REFUSES A MESSAGE THAT ARRIVES WITH TWO `DKIM-Signature` HEADERS.**
The first relayed messages on 2026-11-05 bounced with `554 Transaction failed:
Duplicate header 'DKIM-Signature'`, because i10.tech's `dkimManagement` signed
with both ed25519 and RSA. The Domain in `plan.ndjson` now lists only
`Dkim1RsaSha256` (RSA is what every receiver verifies; ed25519 support is
patchy), and the old `v1-ed25519-20260901` key was moved to `retiring` by hand,
which keeps it published but stops it signing. SES adds its own i10.tech
signature on the way out, which is allowed: it only refuses duplicates it is
handed. A customer mailbox domain must likewise be signed by Stalwart with ONE
key. Drop the ed25519 `_domainkey` record from the dns stack once the key is
retired.

⚠ **STALWART DOES NOT SIGN MAIL THAT LEAVES THROUGH SES.** SES overwrites
`Date` and `Message-ID` on every message, so any signature Stalwart adds fails
at the receiver even though the body hash matches. On 2026-11-05 Gmail
reported `dkim=fail header.s=v1-rsa-20260901` both with Message-ID signed and
with only `To:Subject:From:Date` signed. SES's own i10.tech signature is the one
DMARC needs, and every domain `mailbox_route` sends to `ses-relay` is an SES
identity. So `MtaStageData.dkimSignDomain` in `plan.ndjson` (it was
`SenderAuth.dkimSignDomain` on v0.16) asks the same
function the route asks, and signs only when the answer is not `ses-relay`.
Mail that goes out directly keeps Stalwart's signature.

Signing is decided once, when the message is accepted, and the route at each
delivery attempt. Two gaps follow, both narrow. A lookup that fails at
acceptance (the pooler is down) leaves the message unsigned, and if the lookup
fails again at delivery the route falls back to MX, so the message leaves
directly with no DKIM. Turning the relay off sends already-queued mailbox mail
directly, also unsigned. Both land in spam at worst while DMARC is `p=none`;
neither loses mail.

⚠ **THE ORIGINAL MESSAGE-ID TRAVELS IN `References`, OR REPLIES DO NOT
THREAD.** SES gives every message a new `Message-ID`
(`<...-000000@eu-central-1.amazonses.com>`) and cannot be told to keep the
original. The sender's Sent copy keeps the original, so a reply, whose
`In-Reply-To` names SES's id, matched nothing in the sender's mailbox. SES
leaves `References` alone, so the `ses-references` SieveSystemScript appends
the message's own Message-ID to its `References` before it is queued, and the
reply's `References` then names the Sent copy. `MtaStageData.script` runs it
only for authenticated senders whose `mailbox_route` is `ses-relay`, the same
rule as the route and the signing domain. This is the approach of
[milter-autoref](https://github.com/jcsanyi/milter-autoref) for Postfix in front
of SES (#354).

⚠ **AN SES EMAIL-ADDRESS IDENTITY OVERRIDES ITS DOMAIN'S MAIL FROM.** SES
applies the most specific identity it has. A hand-made `mohamed@i10.tech`
identity with no custom MAIL FROM made SES use `amazonses.com` for that
sender, so SPF passed unaligned while the i10.tech domain identity reported
`send.mail.i10.tech` as `SUCCESS`. It was deleted on 2026-11-06: a verified
domain also covers every address at it as a recipient, even in the sandbox.
Look for address identities (`aws sesv2 list-email-identities`) before
trusting a domain's MAIL FROM (#354).

To throw the lever, in this order:

1. `./bootstrap.sh --dry-run` on psl-vps. Every object should be unchanged,
   plus one `+ would create MtaRoute ses-relay`.
2. Restart Stalwart so the pod has `SES_SMTP_PASSWORD` - Doppler syncs the
   Secret, but env vars never update in a running pod - then `./bootstrap.sh`.
3. Set `SES_RELAY_ENABLED=true` in Doppler's API config and roll the API. It
   publishes the flag into `core.routing_settings` at boot; nothing reads the
   environment variable directly.
4. Send a real message from a mailbox and read its headers: the hop after
   `mail.i10.tech` must be `amazonses.com`. Then check Stalwart's log for
   `Eval(Error)`, because a broken lookup falls back to MX silently.

⚠ **STEP 4 IS THE ONE THAT MOVES MAIL**, and today that means i10.tech's own
human mail, because it is the only mailbox domain and it is on `pro`. Verify the
relay works before throwing it - `SES_RELAY_ENABLED=false` puts it straight back.

⚠ **AND SES MUST BE ABLE TO SEND AS THOSE DOMAINS.** Relaying through SES means
SES applies its own policy: the sending identity has to be verified there, or it
refuses the message. A domain that only ever sent direct may not be.
