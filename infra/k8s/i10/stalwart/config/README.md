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
records the server expects - and it is idempotent. Since #412 Argo runs it for
you after every sync (next section); by hand it is for a restart, a fresh
install and a preview:

```sh
./infra/k8s/i10/stalwart/bootstrap.sh            # apply and roll
./infra/k8s/i10/stalwart/bootstrap.sh --verify   # check, change nothing
./infra/k8s/i10/stalwart/bootstrap.sh --dry-run  # show what would change
PLAN_FILE=path ./infra/k8s/i10/stalwart/bootstrap.sh --dry-run  # a branch's plan
```

## Applied by Argo (#412)

`../apply-hook.yaml` is a PostSync hook Job in the `i10-stalwart` Argo app. It
runs the same `bootstrap.sh` as `--in-cluster --if-changed`, so there is one
engine and two ways of reaching Stalwart: a port-forward and `kubectl exec` by
hand, the pods' own addresses and plain sockets in the Job. A merged edit to
`plan.ndjson` is applied and verified with no human step.

What one run does:

1. **Gate.** A dry run against the live server. If it says every object is
   `unchanged`, the Job logs "Nothing changed" and ends: a sync that did not
   touch the plan costs a few reads. If the plan has a schema error, or names an
   environment variable the pods do not have, the dry run fails the sync before
   anything is written.
2. **Apply** once, through the edge node (`i10-stalwart-0`). The settings live
   in the shared Postgres store, so applying on the second node too would only
   repeat the writes. The applier writes every operation, not only the changed
   ones, as it always has; each is idempotent.
3. **Reload on every node**, each addressed directly, so it does not depend on
   the coordinator carrying the request.
4. **Verify** against both nodes: the SMTP greeting and the certificate served
   without SNI (edge), the autoconfig and MTA-STS paths (both), and the `relay`
   listener. A failure fails the sync; the plan is already applied by then, and
   the log says so.

⚠ **THE JOB NEVER RESTARTS A POD.** A restart is a mail blip, and a plan change
should not cost one by default. Which settings need one is not something the
Job can decide with certainty, so it applies the plan, reloads, and tells a
person. The dry run names the object types this README documents as read only
at startup - `Certificate` and `SystemSettings` (the served certificate),
`Role` and `Authentication` (the cached permission set), `Cache` (sizes),
`BlobStore`, `InMemoryStore`, `Coordinator` and `ClusterRole` (store and role
settings) - and when the plan changed one of them the log ends

```
! A PERSON MUST RESTART THE PODS: run ./bootstrap.sh by hand on psl-vps.
! Restart needed for: Cache (read at startup, a reload does not apply them)
```

That list is what is PROVEN, not everything: it is by object type, so it
over-reports, and a startup-read setting that is not on it would be missed. When
unsure, restart.

⚠ **THE PODS HAVE ALREADY ROLLED BEFORE THE HOOK RUNS.** Editing `plan.ndjson`
renames the ConfigMap (it carries the content hash), which rolls both pods; the
hook runs after they are Healthy. A startup-read setting is therefore applied
after the startup that should have read it, which is exactly why the line above
asks for a second restart. The Job's pod is deleted when it succeeds, so that
line is readable only while the sync is open: after a plan change that touches
the list, run `./bootstrap.sh` by hand, do not wait to be told.

⚠ **THE ENVIRONMENT CHECK CANNOT `exec`, SO IT ASKS THE POD SPEC.** By hand the
check lists the running container's variables. The Job has no `exec` (its Role
is `get` on the two pods and nothing else), so it reads each pod's spec: a name
passes if the pod's `env` lists it, or if the pod takes `envFrom` the
`i10-stalwart` Secret and the Job, which takes the same Secret, holds that key.
It cannot see a key added to the Secret after a pod started. That is narrow in
practice - a plan change rolls the pods first, and they start with the Secret as
it is then - but a hand re-run of the hook after adding a key to Doppler
passes without the pods having it. `./bootstrap.sh --dry-run` by hand asks the
running container and does not.

- **Credential.** `STALWART_RECOVERY_ADMIN` and every `@fromSecret` value reach
  the Job through `envFrom: i10-stalwart`. They are never put in argv or printed.
- **Never wedges a sync.** `hook-delete-policy: BeforeHookCreation,HookSucceeded`
  (the policy, and the reason for it, are in `workloads/api.yaml`),
  `activeDeadlineSeconds: 300` and `backoffLimit: 1`. A failed run's pod stays
  for reading until the next sync.
- **Network.** `stalwart-http-clients` (`networkpolicy.yaml`) admits the Job,
  by its label `app.kubernetes.io/name: i10-stalwart-apply`, to 8080 on both
  nodes. Its 25 and 465 checks go through `allow-public-mail`.
- **The script is its own ConfigMap**, `i10-stalwart-apply`, not part of
  `i10-stalwart-config`, whose hash rolls the Stalwart pods.
- **Not in the Job:** the two checks that read pod logs (authd, the stdout
  tracer), and the DNS listing. They need `pods/log`, and say nothing about a
  plan. `./bootstrap.sh --verify` runs them.
- **A third node** has to be named in the Job's `STALWART_NODES` and in its Role.

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
  8080 directly can therefore claim any address. That is Traefik plus the pods
  `stalwart-http-clients` (`networkpolicy.yaml`) lists: the API group, the
  apply hook and Bulwark.
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

- ⚠ **DNS GOES TO OUR OWN unbound, NOT THE CLUSTER'S.** `DnsResolver` is
  `Custom` at 10.43.53.53 (`../resolver/`). Through CoreDNS and Tailscale,
  Spamhaus and URIBL refused every query, so no message was ever scored on a
  blocklist hit. It is one replica: while it is down, MX and SPF lookups fail
  and mail waits in the queue rather than being misjudged.
  ⚠ **OVER TCP, OR DANE IS OFF.** With the server set to `udp`, Stalwart's
  startup check reports "The configured DNS resolver cannot validate DNSSEC.
  DANE has been disabled" even though unbound validates (it sets AD for
  queries with DO). With `tcp` the warning is gone.
- **Search covers English, Arabic, French, German and Spanish.** Each message's
  language is detected when it is indexed, and a language not listed is
  processed as English. Adding one later means reindexing every message.

Approved but not in the plan yet:

- The Prometheus exporter and alerts: deferred, because the cluster has no
  collector to scrape it.
- Per-account disk quotas and the API's JMAP rate limit: both need a probe on
  one account first.

### ⚠ Blob encryption: the key must never change

Message bodies, attachments, Sieve scripts and queued messages in R2 are
encrypted with the `Blob key 2026-11` SymmetricKey (aes256Gcm), selected in
both `Email` and `FileStorage`. The key material is `STALWART_BLOB_KEY` in
Doppler `prod_stalwart`, read from the environment, so it is never in the
database or a config export.

⚠ **ONLY THE BLOBS ARE ENCRYPTED. EVERYTHING IN POSTGRES IS PLAINTEXT.**
Subjects, senders, recipients, message previews, mailboxes, contacts and the
search index stay unencrypted in the Postgres data store and in every backup of
it. Blob encryption covers bodies, attachments, Sieve scripts, files and the
outbound queue, and nothing else; protecting the rest needs the disks or the
database encrypted, which psl-vps does not do.

The production key object:

| Field       | Value                              |
| ----------- | ---------------------------------- |
| id          | `b`                                |
| description | `Blob key 2026-11`                 |
| cipher      | `aes256Gcm`                        |
| fingerprint | `ef49aa35e2bec4fe2c5340188e1d8dbc` |

The fingerprint is not secret. It is what to compare when something reports a
key mismatch.

- ⚠ **CHANGING THE VALUE STOPS ALL MAIL.** Stalwart stores a fingerprint of the
  key when it is created. A different value under the same name fails that
  check, and the server then refuses to write any blob (no delivery, no
  append) rather than write unencrypted. Never rotate it in Doppler.
- ⚠ **LOSING THE VALUE LOSES EVERY MESSAGE, AND THE VALUE ALONE IS NOT THE
  ESCROW.** Every blob records the id of the SymmetricKey object that encrypted
  it, not only the key material. A store rebuilt from empty may hand the
  recreated object a different id than `b`, and then the right value still
  cannot read a single blob. So the key's escrow is two things together: the
  value, kept outside Doppler, and the Postgres backup of the Stalwart database,
  which holds the object and its id. Restoring that database brings back id `b`
  and the fingerprint above. No recovery from the escrowed value has been
  rehearsed.
- **To rotate:**
  1. Add the new variable to Doppler and restart both nodes first. A variable
     reaches a pod only on restart, and `bootstrap.sh` refuses a plan that names
     one the pods lack.
  2. Add a new SymmetricKey, point `Email` and `FileStorage` at it, reload, then
     run a `BlobRecode` task with
     `encryption: {"@type": "Encrypt", "keyId": <new id>}`.
  3. Keep the old key and variable until that task has finished on every shard
     (one `store.blob-store-recoded` event per shard, 256 in all).
  4. Keep an offline copy of the old key as well, in case a backup taken before
     the rotation is restored: that backup's blobs are encrypted with it.
  - While an `Encrypt` task is pending its key cannot be deleted, and starting a
    new `BlobRecode` replaces the pending shards of the earlier one, so do not
    start a second before the first has finished.
- **Only the recovery admin can delete a key**, and the server cannot tell
  whether blobs still need it. Never delete one unless a `BlobRecode` has moved
  every blob off it.
- New blobs are encrypted from the reload on. What was stored before was
  converted once, with a `BlobRecode` task (#365); that is a one-off, so it is
  not in this plan.
- **Faults are alerted on.** `store.decrypt-error`, `store.crypto-error`,
  `encryption.key-change` and `encryption.gateway-bounced` are in the webhook's
  include list; see "Encryption faults" below.

### The encryption gateway (B14)

`Encryption.gatewayEnable` is on, and `gatewayOutbound` is opportunistic: a
message to a remote recipient whose OpenPGP key or S/MIME certificate the server
knows leaves encrypted with that key, and everyone else gets the original. The
server only encrypts to keys it trusts at `harvested` or better. Harvesting
needs a DMARC pass from the sender's domain, and then either an Autocrypt key
that verified a PGP/MIME signature on the message, or an S/MIME certificate with
a valid chain to a trusted root. Unsigned Autocrypt keys and self-signed S/MIME
certificates are `unverified` and are not used.
`Encryption.atRestEnable` is a different feature (B3 in the
proposal) and stays off.

The gateway's other settings are written into the plan with the **Stalwart
1.1.0 defaults**, pinned on purpose so that an upstream change of a default
cannot move our behaviour silently: `gatewayMethods` (OpenPGP and S/MIME),
`gatewayMinTrust` (`harvested`), `gatewayHeaderProtection` (`baseline`),
`gatewayEncryptSigned` (on) and `harvestKeys`
(`!is_local_domain(sender_domain)`).

⚠ **`baseline` HIDES THE SUBJECT FROM CLIENTS THAT CANNOT SHOW IT.** It
replaces the outer Subject with `[...]`, which a client without RFC 9788
support lists as `[...]` and shows the real Subject only at the top of the
decrypted body. That is a product decision still open: `noConfidentiality`
keeps the Subject visible, `baseline` hides it.

- ⚠ **THE GATEWAY ENCRYPTS EVERY QUEUED MESSAGE, NOT ONLY MAILBOX MAIL.** It
  runs when a message enters the queue, so the send worker's mail on 2525 would
  be encrypted too: a customer's receipts and sign-up codes would arrive as
  PGP/MIME with the Subject replaced by `[...]`. The policy's second rule
  disables it for `bounce+` envelope senders, which is every message the worker
  relays. It is the same test as `MtaStageRcpt.allowRelaying`, with the port
  named by this expression's own variable: `received_via_port` here,
  `local_port` there. Without the port, a logged-in user on 465 who submitted
  with a `bounce+...` envelope sender would skip the gateway. The first rule is
  the default one, which leaves local recipients alone.
- **It works through `ses-relay`.** The gateway removes any DKIM signature from
  each encrypted copy and signs it again with the keys the original would use,
  which `MtaStageData.dkimSignDomain` makes none for mail that leaves through
  SES. SES then signs the copy as it signs everything else. SES's new
  `Message-ID` and `Date` stay outside the encrypted part; the protected copy
  of the headers inside it keeps the originals, so a client with RFC 9788
  support threads the reply against the sender's Sent copy.
- **Each keyed recipient gets its own copy and its own SMTP transaction**, about
  a third larger than the original. A message near the 40 MB SES limit can
  therefore be refused for an encrypted recipient only.
- **Turning it off** is `gatewayEnable: false`. Messages already in the queue
  keep the copies they were given at acceptance.

### DKIM records publish themselves (B4)

i10.tech's `dnsManagement` is `Automatic` through the `DnsServer` "Cloudflare
i10.tech, DKIM records only". With DNS on `Manual`, 1.0 creates a key once and
never rotates it; with it on `Automatic`, Stalwart publishes a new key's
`_domainkey` record, waits for it to resolve, signs with it, and removes the
old record after `retireAfter`. The defaults rotate every 90 days.

- ⚠ **`publishRecords` IS `dkim` ONLY, AND MUST STAY SO.** Its default is every
  record type Stalwart knows: MX, SPF, DMARC, MTA-STS, CAA, SRV and autoconfig.
  `infra/tofu/stacks/dns` is the authority for those, and they deliberately
  differ from what Stalwart would write (DMARC stays `p=none`, for one). With
  the default, Stalwart and `tofu apply` would overwrite each other.
- **The `_domainkey` records Stalwart writes are not in tofu**, and tofu leaves
  records it does not declare alone. The SES selectors (`ses_byodkim`,
  `domain_dkim`) stay in tofu: SES holds those keys, not Stalwart.
- **The token is `STALWART_CLOUDFLARE_DNS_TOKEN`** in Doppler `prod_stalwart`:
  Zone Read and DNS Edit on the i10.tech zone and nothing else. Do not reuse
  `CLOUDFLARE_API_TOKEN` from `prod_tofu` or `prod_platform`, which reach R2
  and every zone. Env vars only reach a running pod on restart, and
  `bootstrap.sh --dry-run` refuses the plan until the pod has the variable.
- **It only matters for mail that leaves directly.** Stalwart does not sign
  `ses-relay` mail (see "The `ses-relay` route"), so today Stalwart's key signs
  the worker's direct-route mail and mailbox mail while the relay is off.
- **No PowerDNS server.** Customer domains are not Stalwart `Domain` objects,
  their mailbox mail is signed by SES, and PowerDNS deliberately has no API
  (`../../powerdns/README.md`): zones are rows `apps/api` writes. A Stalwart
  write path into those zones would be a second source of truth.
- **The ed25519 key `v1-ed25519-20260901` was moved to `retiring` by hand** and
  has no `nextTransitionAt`, so Stalwart may never retire it. If it is still
  `retiring` a week after this lands, delete its record and key by hand.

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

⚠ **THE EXPORT IS PLAIN TEXT, AND THE IMPORT WRITES EVERY BLOB UNENCRYPTED.**
The export reads blobs through the server, so the file holds every message
decrypted, and its SymmetricKey objects too: handle it like the keys
themselves. The import runs before any settings exist, so it writes with the
defaults (LZ4, no encryption). Run a `BlobRecode` task with
`encryption: {"@type": "Encrypt", "keyId": <id>}` after it, or the imported mail
sits in R2 in the clear.

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
They share Postgres (data, search), R2 (blobs) and Stalwart Keep
(`i10-stalwart-keep`, the in-memory store and coordinator, `keep.yaml`; see
[Stalwart Keep](#stalwart-keep)). Neither holds data of its own, and the pod hostname is the node id, so each
StatefulSet's `-0` keeps its id across restarts.

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

To bring it up from nothing, in this order:

1. Create the Keep keys in Doppler ([Stalwart Keep](#stalwart-keep), step 1).
   Merge with the internal StatefulSet at `replicas: 0`. Argo starts
   `i10-stalwart-keep` first and rolls the edge pod for its new label.
2. Wait until Keep has been up for eleven minutes, so the first restart does not
   meet its lock quarantine.
3. `./bootstrap.sh` on psl-vps: it applies `InMemoryStore` (Keep), then
   `Coordinator` (which Stalwart refuses while the in-memory store is local),
   creates the `internal` role, and restarts.
4. Raise `replicas` to 1 in `internal/kustomization.yaml` and merge.
5. Check both nodes are `active` in `x:ClusterNode/get`, and that JMAP answers
   with either pod deleted.

## Stalwart Keep

Both nodes keep their locks, counters and cluster events in
[Stalwart Keep](https://stalw.art/docs/cluster/keep/), one `i10-stalwart-keep`
pod (`../keep.yaml`). It is the only in-memory store Stalwart has. It replaced
`i10-stalwart-redis` on 2026-11-15 (#452), and that Redis was removed after two
days without a fault.

⚠ **A SINGLE KEEP SERVER, BECAUSE THERE IS ONE KUBERNETES NODE.** Keep supports
one server or a cluster of members. Three members on psl-vps would all die with
the node, and would cost a fixed member list of IP literals, `hostNetwork` and a
peer port that Kubernetes cannot firewall. The Stalwart side is the `Keep`
variant of `InMemoryStore` in `plan.ndjson`, with `Coordinator` left at
`Default`, which reuses the same client.

⚠ **EVERY RESTART OF THE KEEP POD STALLS LOCKS FOR ABOUT TEN MINUTES.** A server
that starts in the default `rejoin` mode refuses new locks for the lock
quarantine, 604 s for a single server (`max-lock-ttl` 600 s, which Stalwart
needs, plus 3 s and a small term). Outbound delivery, scheduled tasks and search
indexing take locks and wait it out. Nothing is lost, and mail is still
received and served. Locks held at the moment of the restart do not survive it:
a restarted server comes back empty, a renewal or release of a lost lock is
answered `NotFound`, and its holder learns that at its next renewal, while the
quarantine stops a second holder taking it meanwhile. What restarts the pod: a
new Keep image, any edit to `keep.toml` (the ConfigMap name carries a hash,
which is why the file has no comments), a changed resource request or limit, and
the node rebooting.

The docs describe the nodes as retrying reads and lock operations within the
request deadline (`deadline` 5000 ms, `attemptTimeout` 1000 ms by default) and
report a Keep restart to subscribers as possible loss, so they discard their
caches and check their queues. A full outage of the only Keep server longer than
the deadline was not tested here, so do not assume the nodes recover by
themselves. After any Keep restart, run the two greps in
[section 3](#3-checking-the-nodes-are-on-keep) (`Failed to connect to Stalwart
Keep` and `store.keep-error`) on both nodes, and delete a node that logs them.
Both Stalwart pods also wait for Keep to accept connections before they start
(the `wait-for-keep` init container), which covers a machine reboot.

`--start bootstrap` would skip the wait and is deliberately not in the pod
template; it is right only when no client can hold a lock, which is never true
of a restart that is not a whole-cluster restart.

### 1. Create the secrets (once, before Keep first starts)

Five values go in Doppler, in a config of their own, `prod_stalwart_keep`, so
they never become environment variables of the Stalwart pods (`keep.yaml`
explains). Run this on a machine that has `doppler` and `kubectl`; the keys live
in a temporary directory that is removed on exit and never in the repository.
The project and config names (`i10`, `prod_stalwart_keep`) are assumed, and
these commands were not run when this was written, so check them first. The
`>/dev/null` keeps `doppler` from printing the values it stores:

```sh
set -eu
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

# One key pair for Keep, and one for the two Stalwart nodes together.
openssl genpkey -algorithm ed25519 -out keep.key
openssl pkey -in keep.key -pubout -out keep.pub
openssl genpkey -algorithm ed25519 -out node.key
openssl pkey -in node.key -pubout -out node.pub
# The cluster secret: 32 hexadecimal digits, shared by Keep and the nodes.
openssl rand -hex 16 | tr -d '\n' >cluster.secret

doppler configs create prod_stalwart_keep -p i10 -e prod
doppler secrets set KEEP_CLUSTER_SECRET -p i10 -c prod_stalwart_keep <cluster.secret >/dev/null
doppler secrets set KEEP_MEMBER_KEY -p i10 -c prod_stalwart_keep <keep.key >/dev/null
doppler secrets set KEEP_CLIENTS_PEM -p i10 -c prod_stalwart_keep <node.pub >/dev/null
doppler secrets set KEEP_NODE_KEY -p i10 -c prod_stalwart_keep <node.key >/dev/null
doppler secrets set KEEP_SERVERS_PEM -p i10 -c prod_stalwart_keep <keep.pub >/dev/null

kubectl -n i10-prod create secret generic doppler-token-i10-stalwart-keep \
  --from-literal=serviceToken="$(doppler configs tokens create stalwart-keep-k8s \
    -p i10 -c prod_stalwart_keep --plain)"
```

| Doppler key           | Holds                  | Read by                           |
| --------------------- | ---------------------- | --------------------------------- |
| `KEEP_CLUSTER_SECRET` | the 32 hex digits      | Keep (file), both nodes (env)     |
| `KEEP_MEMBER_KEY`     | Keep's private key     | Keep only                         |
| `KEEP_CLIENTS_PEM`    | the nodes' public key  | Keep: the clients it accepts      |
| `KEEP_NODE_KEY`       | the nodes' private key | both nodes (one key, shared)      |
| `KEEP_SERVERS_PEM`    | Keep's public key      | both nodes: the server they trust |

One node key serves both nodes. The store's `keyPath` is shared configuration,
so both nodes read the same path; a key each would need a Secret per
StatefulSet, and both pods already have the same trust, the same Secrets and the
same image. Keep then lists one client key. Split it the day one node must be
revoked alone.

The Doppler operator copies the values into the `i10-stalwart-keep` Secret.
Before merging, and again after, check its key list, because a DopplerSecret
that names a key Doppler lacks does not fail:

```sh
kubectl -n i10-prod get secret i10-stalwart-keep -o json | jq -r '.data | keys[]'
```

Expect the five `KEEP_*` keys plus Doppler's own `DOPPLER_*` ones. A trailing
newline on any value is harmless: Keep and Stalwart both accept it.

### 2. Changing the in-memory store

The nodes read `InMemoryStore` only when they start (a `Reload` copies the
running one, `crates/common/src/cache/reload.rs`), so an edit to its line in
`plan.ndjson` (hosts, keys, timeouts) does nothing until they restart. The hook
logs `Restart needed for: InMemoryStore` until then; that is this procedure, not
a fault.

⚠ **BOTH NODES RESTART TOGETHER, NEVER ONE AT A TIME.** Nodes on different store
settings do not see each other's locks, and both take outbound queue locks, so
one message could be delivered twice. If a node restarts alone while the two
differ, restart the other one at once.

1. **Merge the change.** The ConfigMap name changes, so both nodes roll, and the
   PostSync hook applies `plan.ndjson` after them.
2. **If Keep restarted, wait out its quarantine.** Keep must have been running
   for eleven minutes (604 s plus margin) before the nodes take their first
   locks:

   ```sh
   kubectl -n i10-prod get pod -l app.kubernetes.io/name=i10-stalwart-keep \
     -o jsonpath='{.items[0].status.containerStatuses[0].state.running.startedAt}{"\n"}'
   ```

3. **Restart every Stalwart node together.** One command, so neither is ever up
   on settings the other is not on:

   ```sh
   kubectl -n i10-prod delete pod i10-stalwart-0 i10-stalwart-internal-0 --wait=false
   kubectl -n i10-prod wait --for=condition=Ready pod/i10-stalwart-0 \
     pod/i10-stalwart-internal-0 --timeout=300s
   ```

   Not `./bootstrap.sh`: its restart goes one pod at a time, which is right for
   a certificate or a role and wrong for a store change. Scaling to 0 and back is
   not an option either, since `selfHeal` reverts a hand-edited `replicas` within
   seconds.

### 3. Checking the nodes are on Keep

- Neither node says `Failed to connect to Stalwart Keep`, and neither logs a
  `store.keep-error` event:
  `kubectl -n i10-prod logs i10-stalwart-0 -c stalwart | grep -E 'Stalwart Keep|keep-error'`,
  then the same for `i10-stalwart-internal-0`. Both print nothing when it
  worked. A node that failed to open the store runs without an in-memory store
  until it restarts, so a hit here means delete that pod once Keep is fixed.
- Keep sees them: its last `keep: stats` line (one a minute) shows `conns` above
  0, about 3 per node, and `busy` 0.
- Both nodes are `active` in `x:ClusterNode/get`, and `x:InMemoryStore/get`
  returns the `Keep` variant:

  ```sh
  kubectl -n i10-prod port-forward svc/i10-stalwart 18080:8080 &
  ADMIN=$(kubectl -n i10-prod get secret i10-stalwart \
    -o jsonpath='{.data.STALWART_RECOVERY_ADMIN}' | base64 -d)
  curl -s -K - -H 'Content-Type: application/json' http://127.0.0.1:18080/jmap/ \
    -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:ClusterNode/get",{"ids":null},"c1"],["x:InMemoryStore/get",{"ids":null},"c2"]]}' \
    <<<"user = \"$ADMIN\""
  ```

- A send and a receive: send a message from the product to an address you read
  and confirm it arrives; send one in from outside to a mailbox and confirm it
  appears over JMAP. Both go through the queue, which takes its locks from Keep.
- JMAP keeps answering with either pod deleted: delete
  `i10-stalwart-internal-0`, call the API or open the webmail, wait for it to
  return, then do the same with `i10-stalwart-0`.
- `./bootstrap.sh --verify`.

### What 1.0.3 to 1.1.0 changed for us

Read from the 1.1.0 changelog and the two schemas, and checked by dry-running
the whole of `plan.ndjson` against a 1.1.0 server (every object and field is
accepted).

- **Passkey permissions.** New `sysPasskey*` permissions are missing from the
  default roles of an upgraded server, and the release suggests starting once
  with `STALWART_UPDATE_ROLE_PERMISSIONS=true`. **We do not**: passkeys are for
  accounts in the internal directory, ours are all in the authd LDAP directory,
  and the recovery administrator holds every permission. The variable would
  also edit the roles `Authentication` points at, which are ours.
- **`/healthz/ready` now answers 503 while the data store does not answer.**
  Both nodes go unready during a Postgres failover and the `i10-stalwart`
  Service has no endpoint until it ends. That is the probe doing its job. The
  mail ports are hostPorts and do not depend on it.
- **PostgreSQL waits are bounded** (`responseTimeout`, default 2 minutes).
  `config.json` does not set it, so the default applies.
- **Shutdown drains outbound delivery and releases its queue locks** (up to 8
  seconds), so a Stalwart restart no longer leaves a 10 minute lock behind. The
  pods' default 30 second grace period covers it.
- **Cache swap**: the Redis variant became `InMemory`, and a `FileSystem` blob
  swap store went. `plan.ndjson` sets only the cache sizes, so neither applies.
- **The relay on 2525, the LDAP directory and the roles** are untouched by the
  changelog, and the dry run accepted them as written.

The image cannot be rolled back: 1.1.0 may have written data 1.0.3 cannot read.
Restore from the nightly backup if it comes to that.

Not verified: that two nodes on different 1.x versions share a queue correctly
during the roll. The two StatefulSets restart within a minute of each other and
the queue lock code shows no format change between the two, but a mixed-version
pair was never run.

### Counters and keys on Keep

From the [Keep docs](https://stalw.art/docs/cluster/keep/stalwart#move-from-redis):
a counter's expiry is set only when it is created and is not refreshed on each
increment, `key_get` returns a 64-bit integer and not decimal text, and keys
written by expressions and Sieve are lost when Keep stops without a handoff.
Nothing in `plan.ndjson` calls `key_get`, `key_set` or `key_incr`, and the one
Sieve script (`ses-references`) uses `editheader` and `variables` only. What
does use the store is the throttles (`iprate`, `rcptrate`, `rcptflood`,
`submithour`, `submitday`, the outbound `backstop` and the queue quota), whose
counters start from zero when Keep restarts, so a restart lets one window's worth
through again. The fixed windows suit a counter that does not refresh. Keep has
no persistence.

Under its 128 MiB cap Keep evicts counters first and never a lock. A counter that
is evicted restarts from zero.

## Upgrading to 1.2.0

Read from the 1.2.0 changelog and the source of the `v1.1.0` and `v1.2.0` tags,
and proved on a loopback copy of this setup (2026-11-23): a store built by
1.1.0 with this plan, upgraded in place to the official `v1.2.0-alpine` image
(index digest `sha256:2b7dfee66dfd116a903607826e03e4f8af8841207fae28098aa908c568ca919a`),
with authd and the mail front from the branch. Every `TestLiveProbe` subtest
passed, `./bootstrap.sh --dry-run` accepted all of `plan.ndjson`, and the
rollback below was run.

- **No store migration.** `DATABASE_SCHEMA_VERSION_BASE` is 7 in both
  (`crates/common/src/lib.rs`). 1.2.0 opened the 1.1.0 store as it was.
- **The mail front is unaffected.** IMAP LOGIN, AUTHENTICATE, SASL, SMTP AUTH,
  PROXY v2 and the LDAP backend are byte-identical between the tags. The IMAP
  receiver reads the same grammar and changed only how a request's size is
  counted (each token now also costs its in-memory size): the front's largest
  pre-sign-in command, 16 KiB and 64 arguments, stays far under the 64 KiB
  pre-sign-in limit. Every other assumption the front makes was re-read in the
  source and re-probed.
- **Sessions end when an account's permissions or password change, inside
  Stalwart.** On the next IMAP command or IDLE wake, with
  `* BYE Account access changed, please log in again.` It sees only changes made
  in Stalwart (a role edit ended a session on its next NOOP); an authd revocation
  is not one, and SMTP has nothing like it. The mail front's sweep stays the
  revocation path for every protocol.
- **Exchange** (EWS, MAPI, ActiveSync, Autodiscover on the HTTP listener) is off
  by default (`x:Exchange.enable: false`). The plan pins it off so nothing turns
  it on before #517 designs it.
- **Smaller limits**: at most 5 distinct EHLO names per SMTP session (then
  `421`), AUTH refused during a mail transaction, writes time out when a client
  stops reading, passwords over 1024 bytes refused by the internal directory
  only (a bind token is about 95), and limits on FETCH items, SEARCH criteria,
  sequence sets and flags per command.

### The new permissions, added by the plan

The release asks for `sysMailRule*`, `sysBlockedSender*`, `sysSafeSender*` and
`sysCalendarSettings*` on the user, group and administrator roles, and
`sysExchangeGet` and `sysExchangeUpdate` on the administrator role (17 names,
the only ones the 1.2.0 schema adds). Three `Role` upserts in `plan.ndjson` add
them to Stalwart's own roles `User` (`b`), `Group` and `System Administrator`,
matched on `description`, as patch paths (`"enabledPermissions/sysMailRuleGet":
true`), so every other entry those roles hold is left alone. `i10 User` inherits
them from `b`.

⚠ **NOT `STALWART_UPDATE_ROLE_PERMISSIONS=true`.** That variable adds the
missing defaults to the roles `Authentication` names, and here those are ours:
probed on a copy of the store, it added 15 permissions to `i10 Group`, which is
meant to hold `emailReceive` alone, and gave `i10 User` the `sysPasskey*` set the
1.1.0 upgrade deliberately left out (above). It is also a one-off that needs two
restarts and leaves nothing in git. The plan is idempotent and checked by every
dry run: after it applies, `Role b`, `Role c` and `Role e` read `unchanged`.

`i10 Group` stays as it is. Groups never sign in, so they do not need the
permissions.

### ⚠ Required: free/busy is not shared across customers

1.2.0 adds `x:Calendar.shareFreeBusy`, **on by default**
(`crates/registry/src/schema/structs.rs:917`, default at `structs_impl.rs:9877`).
It lets every account read every other account's busy times "within the same
tenant, or across the whole server when tenants are not used". We use no
Stalwart tenants, so with it on, any user reads any other customer's users'
busy times. It gates both paths: JMAP `Principal/getAvailability`
(`crates/groupware/src/calendar/availability.rs:115`) and CalDAV scheduling
free/busy (`crates/dav/src/calendar/scheduling.rs:414`). The plan sets it to
`false` on the `Calendar` line.

Probed on the loopback 1.2.0 (2026-11-23) with `alice@i10.test` and
`carol@other.test` in two different i10 tenants, each with a busy event:

| alice asks for          | Default (on)                                                      | `shareFreeBusy: false`          |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------- |
| carol, JMAP             | carol's busy block, 10:00 to 11:00 (no title)                     | `[]`                            |
| carol, CalDAV free/busy | `2.0;Success`, `FREEBUSY;FBTYPE=BUSY:20261124T100000Z/...110000Z` | `3.8;No authority`              |
| herself, both           | her busy time (JMAP with the event)                               | the same: her own still answers |

A reload applies it; no restart is needed. The cost: colleagues in the same
company no longer see each other's free/busy without a calendar share. A
per-customer setting needs Stalwart tenants, which the Community edition does not
have.

### ⚠ Automatic forwarding to outside addresses is off

Owner decision (2026-11-23), like Microsoft 365's default: mail rules are on, but
nothing a user sets up may forward mail automatically to a domain this server
does not host. Move, copy, flag, mark read, junk, auto-reply, the blocked and
safe sender lists, and forwards to hosted addresses all keep working.

Stalwart has no setting for this. `x:SieveUserInterpreter` has only
`maxRedirects` and `allowedNotifyUris`, with nothing per domain
(`crates/common/src/config/mailstore/scripts.rs:83-101`). The
`x:MailRule` redirect action has no domain check (`MailRuleRedirect` is
`addresses` and `keepCopy`), and a forward to an outside address is accepted at
creation. So the plan enforces it where every automatic message passes,
**whether a mail rule or hand-written Sieve produced it**: the outbound route.

- Mail rules compile into the `managed` Sieve script: the forward action is Sieve
  `redirect` and the reply action is Sieve `vacation`
  (`crates/email/src/sieve/rules/emit.rs:876-945`).
- Everything Sieve sends is queued as `MessageSource::Autogenerated`
  (`crates/smtp/src/outbound/local.rs:116-126`,
  `crates/smtp/src/scripts/event_loop.rs:495-501`). A `redirect` or a `notify`
  keeps the account as its return path; a `vacation` reply has an empty one.
- The route expression sees `source` (`"autogenerated"`), `sender` and
  `rcpt_domain` (`crates/smtp/src/queue/mod.rs:405-457`).
- `MtaOutboundStrategy.route` gains one branch after `is_local_domain`:
  `source == 'autogenerated' && !is_empty(sender)` routes to `local`. Local
  delivery of an address the server does not host fails permanently with
  `550 5.5.0 Mailbox not found.` (`crates/email/src/message/delivery.rs:180-187`),
  so the message never leaves. An unknown route name would not do: it falls back
  to MX delivery (`crates/common/src/network/mta.rs:324-347`).
- Nothing else is caught. Calendar invitations go through an internal SMTP
  session (`crates/services/src/task_manager/tasks/imip.rs:255-301`), MDNs and
  vacation replies have an empty sender, and DSNs are their own source. The
  other autogenerated sender is enterprise metric alerts, which we do not
  configure.

Probed on the loopback 1.2.0 (2026-11-23), with a sink SMTP server standing in
for the outside world (the probe's `else` route; prod's is the `sql_query`
route):

| Case                                                                     | Result                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Rule forwarding to `x@outside.test`, before the branch                   | Delivered to the sink, `MAIL FROM:<alice@i10.test>`: the hole              |
| The same rule, after                                                     | Not delivered: `550 5.5.0`, `delivery.dsn-perm-fail`; alice keeps her copy |
| Hand-written Sieve `redirect :copy` and `notify "mailto:..."` to outside | Neither delivered, the same `550`                                          |
| Rule forwarding to `carol@other.test` (hosted, another tenant)           | Delivered to carol; alice keeps her copy                                   |
| Vacation reply to an outside sender                                      | Delivered, `MAIL FROM:<>`, "Out of office"                                 |
| Ordinary send from a client through the mail front to an outside address | Delivered                                                                  |
| Calendar invitation to an outside attendee                               | Delivered                                                                  |

⚠ **WHAT THE USER SEES: NOTHING.** A Sieve redirect asks for no DSN (`Notify::Default`
maps to no flags, `crates/smtp/src/scripts/mod.rs:163-175`), and a permanent
failure is reported only to recipients that asked (`crates/smtp/src/queue/dsn.rs:560-562`).
So no bounce comes back. A rule that forwards outside **without keeping a copy
loses the message**: probed, it reached neither the sink nor alice's mailbox.
Stalwart cannot refuse such a rule at creation, so i10's own rule editor (the
webmail, and the HTTP front #517 puts before Exchange and JMAP) must refuse an
outside forward address before it is saved. The route branch is the backstop for
anything that gets past it. Today no user can create a rule or a script at all:
JMAP is not published (`../ingressroute.yaml`) and there is no ManageSieve
listener.

The vacation reply above ran with the spam filter off on the probe only: the test
message had no SPF or DKIM, and 1.2.0 no longer answers spam with a vacation
reply. That is unrelated to the route.

### Rolling it out

1. Check that last night's backup of `stalwart_v1` exists. A downgrade should
   never need it (below), but it is the fallback.
2. Merge. Argo rolls both StatefulSets to 1.2.0 (the image and the plan's
   ConfigMap hash both change). Do not dry-run this branch's plan against a 1.1.0
   server first: 1.1.0 has no `Exchange` object, and the dry run stops there.
3. The PostSync Job applies the plan once both nodes are Ready on 1.2.0, and
   logs `Restart needed for: Role`. A role's permissions are read at startup.
   (`Exchange` reads `unchanged`: off is already the default.)
4. On psl-vps, run `./bootstrap.sh` (apply, reload, restart, verify).
5. Check the roles and the two settings above. `./bootstrap.sh --dry-run` must
   read `unchanged` on `Role b`, the Group role, the System Administrator role,
   `Calendar` and `MtaOutboundStrategy`, and nothing else. Then sign in with a
   real client through the mail front, read, and send one message.

### Rolling it back

The store needs no migration back, but **1.1.0 cannot read a role that holds a
1.2.0 permission**. On the probe copy every such role answered
`serverUnavailable`, and every sign-in failed with `NO Internal Server Error`
after authd had accepted the bind. So take the permissions out while 1.2.0 is
still running, then roll the image back:

1. Revert the PR in git, **except the `MtaOutboundStrategy` route branch**, and
   do not let Argo sync it yet. Mail rules made on 1.2.0 leave their `managed`
   Sieve script in place, so their forwards would leave on 1.1.0 without it.
   1.1.0 knows the `source` variable and read the stored route back unchanged
   (probed). The stored `shareFreeBusy` does not stop 1.1.0 reading `Calendar`
   (probed), and 1.1.0 has no free/busy sharing to turn off.
2. With 1.2.0 still running, port-forward to 8080 and remove the 17 names from
   `b`, the Group role and the System Administrator role (find their ids with
   `x:Role/get`, as in "First boot"). Each one is a `x:Role/set` update setting
   `enabledPermissions/<name>` to `null`.
3. Sync. The pods restart on 1.1.0. The stored `Exchange` object is ignored by
   1.1.0 (probed). The plan's `Exchange`, `shareFreeBusy` and patch lines are
   gone with the revert. Left in place, the Job's dry run would fail before
   writing anything.
4. `./bootstrap.sh --verify`, and sign in once through the mail front.

What it costs: mail rules, blocked and safe senders and calendar settings made
on 1.2.0 stay in the store as data 1.1.0 does not read. Whether the `managed`
Sieve script compiled from mail rules keeps running on 1.1.0 was not probed. If
1.2.0 cannot start at all, step 2 is impossible: restore the backup.

## The internal relay

The send worker hands direct-route mail to the `relay` listener on **2525**, with
**no account and no credential**. The trust is where the connection comes from:

- **No hostPort** (node/statefulset.yaml) - nothing on the node's public addresses
  answers on 2525.
- **Not in `allow-public-mail`** (networkpolicy.yaml) - traffic from outside the
  namespace cannot reach it. `stalwart-relay-clients`, in the same file, admits
  the send worker and no other pod.
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

## The mail front (#383)

993 and 465 are no longer Stalwart's TLS. The `mailfront` container in the same
pod (`services/authd/README.md`, "Mail front") terminates TLS on the pod's
addresses and hands each connection to Stalwart over PROXY v2 (SMTP with the
SSL extension, IMAP without it, below). It exists because Stalwart never ends a
session that has signed in, and the front can: it closes a connection the moment
its account loses access. Every person sign-in it forwards carries its bind
token, and authd refuses a person bind without one (`services/authd/README.md`,
"The bind token"). Port 25 and the `relay` on 2525 are unchanged.

The two listeners the front sits in front of are upserted by name in
`plan.ndjson`, in the stored shape:

| Listener      | Bind            | TLS                                | PROXY header from |
| ------------- | --------------- | ---------------------------------- | ----------------- |
| `imaps`       | `127.0.0.1:993` | none (`useTls`, `implicitTls` off) | `127.0.0.1` only  |
| `submissions` | `127.0.0.1:465` | none                               | `127.0.0.1` only  |

What was probed on a local v1.1.0 before relying on it (2026-11-21,
`docs/research/mail-device-binding.md`, "Mail front probes"):

- **The SSL TLV makes a plaintext listener count as TLS.** With it, IMAP offers
  `AUTH=PLAIN` and accepts LOGIN, and `is_tls` is true in SMTP expressions (so
  the default `saslMechanisms` rule offers AUTH on 465). Without it, IMAP says
  LOGINDISABLED and SMTP answers `503 5.5.1 AUTH not allowed`.
- **TLS is also what turns on bearer sign-ins** (OAUTHBEARER, XOAUTH2,
  `common/src/auth/sasl.rs:83`). Stalwart checks a bearer token itself and never
  asks authd, so it would sign a client in without the front's bind token. Two
  plan lines shut them, probed on v1.1.0 on 2026-11-23
  (`docs/research/mail-device-binding.md` section 9):
  - `Imap.allowPlainTextAuth: true`, and the front sends IMAP upstream without
    the TLV. LOGIN and AUTHENTICATE PLAIN work as before; both bearer
    mechanisms answer `NO [PRIVACYREQUIRED]`, "require a TLS connection". The
    setting is global, so it would also allow plaintext
    LOGIN on any other cleartext IMAP or POP3 listener: there is none (the plan has
    only `imaps`, on loopback), and ⚠ one must never be added.
  - `MtaStageAuth.saslMechanisms`: `[plain, login]` when
    `local_port == 465 && is_tls`, otherwise none. SMTP keeps the TLV, because
    Stalwart offers no AUTH on a connection it thinks is cleartext; EHLO now
    says `AUTH PLAIN LOGIN`, and AUTH XOAUTH2 or OAUTHBEARER answer
    `554 5.7.8 Authentication mechanism not supported.`
- **`remote_ip` is the client's** (from the header), so the auth-failure webhook,
  the throttles and auto-ban see real addresses.
- **`local_port` is the header's destination port, not the bind's.** The front
  sends the port the client reached, so every `local_port == 465` rule in this
  plan holds. A front that sent another port would silently switch them off.
- **No STARTTLS is offered** on the plaintext listeners, and the front refuses it.
- **The default listeners bind `[::]` with `SO_REUSEADDR` and `SO_REUSEPORT`.**
  A specific address on the same port cannot be bound while they listen (the
  front waits, logging "port is taken"), and `SO_REUSEPORT` is shared only
  between sockets of the same user.

⚠ **A LISTENER CHANGE NEEDS A RESTART.** Stalwart's docs: "Listener changes take
effect after a restart." `bootstrap.sh` lists `NetworkListener` among the
startup-read objects, so after the hook applies this plan it ends with "A PERSON
MUST RESTART THE PODS".

### Rolling it out

Three merges, in this order, because Argo deploys `main` as it lands:

1. **The database role.** The `mailfront` role in `platform-db/cluster.yaml`
   and its `i10-mailfront-db-role` DopplerSecret, after the Doppler values and
   the service tokens exist (`services/authd/README.md`, "Mail front", "Its
   database role", step 1, which also makes the two bind token keys). Check
   that CNPG created it before the next step.
2. **The code** (the `mailfront` binary in the authd image, the role's grants,
   the pass-through versions and the domain index migrations). Nothing runs the
   front yet. Its post-merge pin commit publishes the image the next step
   references.
   ⚠ **FROM THAT PIN, EVERY PERSON SIGN-IN IS REFUSED UNTIL STEP 3's RESTART.**
   The pin rolls authd, and the new authd accepts a person bind only with the
   front's token; nothing sends one until the front runs, and authd has no
   keys until this deploy adds `AUTHD_BIND_TOKEN_KEYS`. There is no permissive
   phase, by decision. Delivery is unaffected (the service bind needs no
   token). Accepted while prod has no mail users; with users, run step 3
   straight after the pin.
3. **This deploy** (`node/statefulset.yaml`, `plan.ndjson`, `bootstrap.sh`,
   `internal/kustomization.yaml`, `networkpolicy.yaml`, and the
   `i10-mail-bind-token` DopplerSecret in `doppler/dopplersecrets.yaml`). Check
   that the operator has synced that Secret with both keys
   (`kubectl -n i10-prod get secret i10-mail-bind-token -o jsonpath='{.data}' | jq 'keys'`)
   before the restart: both references are optional, so a missing key starts
   the containers and refuses every sign-in instead of failing loudly. ⚠ The
   `mailfront` container runs the same image as the authd container, and must
   stay on it: `.github/scripts/pin-image.py` rewrites every reference to
   `i10-authd` under `infra/k8s` on each authd build, so the two move together.
   A digest older than step 2's pin has no mailfront binary, crash-loops, and
   keeps the pod NotReady.
   1. Argo rolls the pods. The `mailfront` container starts, finds Stalwart
      still holding `[::]:993` and `[::]:465`, and waits. Stalwart still owns
      both, but no person can sign in: authd already needs the front's token.
   2. The PostSync hook applies the two listener upserts and reloads. Stalwart
      keeps its old sockets, because a reload does not rebind, and the hook's
      log ends with "A PERSON MUST RESTART THE PODS".
   3. A person runs `./bootstrap.sh` on psl-vps, which restarts the pods.
      Stalwart binds `127.0.0.1`, and the front binds the pod's addresses
      within a second. Any later restart of the pods would do the same.
      `./bootstrap.sh --verify` then reads port 25's certificate with STARTTLS
      (still Stalwart's) and checks that 993 and 465 are the front, not
      Stalwart.

### Rolling it back

The plan engine only upserts. **Deleting the two lines does not move the
listeners back**: the stored objects keep `127.0.0.1` and no TLS. A rollback is
one change with both halves:

1. In `node/statefulset.yaml`: delete the `mailfront` container and the
   `mailfront-tls` volume, and put the two ports back on the `stalwart`
   container:

   ```yaml
   - { name: submissions, containerPort: 465, hostPort: 465 }
   - { name: imaps, containerPort: 993, hostPort: 993 }
   ```

   The `sysctls` entry can stay; it is harmless without the front. In
   `internal/kustomization.yaml`, delete the `test` and `remove` operations for
   `containers/2`, or the overlay fails to build.

2. In `plan.ndjson`: replace the two `imaps` and `submissions` lines with the
   original shape, TLS from the first byte on every address:

   ```json
   {"@type": "upsert", "object": "NetworkListener", "matchOn": ["name"], "value": {"imaps": {"name": "imaps", "bind": {"[::]:993": true}, "protocol": "imap", "useTls": true, "implicitTls": true, "tlsDisableCipherSuites": {}, "tlsDisableProtocols": {}, "tlsIgnoreClientOrder": true, "tlsTimeout": 60000, "overrideProxyTrustedNetworks": {}, "socketBacklog": 1024, "socketNoDelay": true, "socketReuseAddress": true, "socketReusePort": true, "socketReceiveBufferSize": null, "socketSendBufferSize": null, "socketTosV4": null, "socketTtl": null}}}
   {"@type": "upsert", "object": "NetworkListener", "matchOn": ["name"], "value": {"submissions": {"name": "submissions", "bind": {"[::]:465": true}, "protocol": "smtp", "useTls": true, "implicitTls": true, "tlsDisableCipherSuites": {}, "tlsDisableProtocols": {}, "tlsIgnoreClientOrder": true, "tlsTimeout": 60000, "overrideProxyTrustedNetworks": {}, "socketBacklog": 1024, "socketNoDelay": true, "socketReuseAddress": true, "socketReusePort": true, "socketReceiveBufferSize": null, "socketSendBufferSize": null, "socketTosV4": null, "socketTtl": null}}}
   ```

3. Merge, then run `./bootstrap.sh` by hand on psl-vps as soon as the pods
   have rolled: it applies the deployed plan (now the rollback) and restarts
   them. Between the roll and that restart, 993 and 465 answer nothing: the
   front is gone and Stalwart still has the loopback listeners. (`PLAN_FILE`
   only previews; it cannot apply a plan that is not deployed.)
4. In `bootstrap.sh`, the 465 check can go back to `https://$H:465`, and the
   993 front check must go.
5. ⚠ **AND authd GOES BACK TOO, IN THE SAME CHANGE.** authd from PR 1 on
   refuses every person bind without the front's token, and has no setting
   that turns that off. Without the front nothing mints one, so a rollback
   that leaves authd's image alone signs nobody in. Pin the `authd`
   container's image back to the digest before PR 1's pin commit.
6. The `Imap.allowPlainTextAuth` and `MtaStageAuth.saslMechanisms` lines can
   stay: there is no cleartext IMAP or POP3 listener for the first to open, and on a
   real TLS 465 the second still offers PLAIN and LOGIN (no bearer
   mechanisms, which nothing of ours uses).

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

### Encryption faults: four more events

`store.decrypt-error`, `store.crypto-error`, `encryption.key-change` and
`encryption.gateway-bounced` are in the include list too. They carry no VERP
sender and no mailbox, so `interpretStalwartOperatorAlert`
(`apps/api/src/webhooks/stalwart.ts`) handles them apart from both other paths.
The per-recipient info events (`encryption.gateway-encrypted`,
`gateway-plaintext`) are not subscribed: they fire for every message.

| Stalwart event               | Means                                       | What to do                                                                 |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `store.decrypt-error`        | a stored blob cannot be decrypted           | blob key against the fingerprint above; never rotate or delete             |
| `store.crypto-error`         | an encrypt or decrypt on stored data failed | the same                                                                   |
| `encryption.gateway-bounced` | the gateway refused a recipient             | that recipient's key, or the outbound policy                               |
| `encryption.key-change`      | a new key waits for approval                | confirm it, then set the record's `status` over JMAP `x:ExternalPublicKey` |

Each is logged at error level as "Stalwart encryption alert" with the event
type, key id, cipher, the recipient's DOMAIN and the reason where Stalwart gave
them. If `OPS_ALERT_EMAIL` is set in the API's Doppler config the same is
emailed through the system sender, one email per event type per hour. A failed
send is logged and never makes the route answer 500: that would have Stalwart
replay the whole batch, delivery events included.

### Mailbox events: `auth.failed` and `limit.quota`

Two more events in the include list are about a mailbox, not a message. They
carry `accountName`, `remoteIp` and `listenerId` and no VERP sender, so
`apps/api/src/webhooks/stalwart-account.ts` handles them apart from the
delivery path; they never reach a customer's webhook endpoint.

| Stalwart event | What the API does                                                                    |
| -------------- | ------------------------------------------------------------------------------------ |
| `auth.failed`  | one row in `core.mailbox_auth_failures`: account, workspace, address, subnet         |
| `limit.quota`  | tells the workspace once per mailbox per UTC day (logs only until a template exists) |

⚠ **Failures for an account we do not host are dropped.** Scanners try random
usernames all day and Stalwart reports each one. An address that is not in
`authd.accounts`, or is hosted with no workspace (i10's own mailboxes), writes
nothing and counts as `ignored`.

⚠ **They are kept out of `core.identity_events` on purpose.** Every risk reader
there treats a row as the person's own sighting, so a failure filed there would
make an attacker's network look familiar to the owner and link unrelated
accounts that one brute-forcing address touched. Nothing reads
`mailbox_auth_failures` into the score yet; `mailboxAuthFailureSummary`
(`apps/api/src/risk/mailbox-auth.ts`) is the read.

`security.authentication-ban`, `security.too-many-attempts` and
`limit.blob-quota` are not subscribed: the first two fire off the failures
already seen, and the blob quota is a per-upload ceiling, not a full mailbox.
Both events are deduplicated on `authd.webhook_events` like everything else,
since each of the two nodes posts its own copy.

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

## The MTA hook: mailbox sends get the API's checks (B5, #380)

Mail sent from a mailbox (submission on 465, through `ses-relay`) used to skip
the checks an API send gets. `MtaHook mailboxgate` closes that: Stalwart POSTs
each authenticated submission to `apps/api` (`/internal/mta-hook`), which answers
with `admitSend` - **the function `acceptSend` calls for an API send**, so the
two paths cannot drift. For a mailbox it decides the risk hold (#170) and
nothing else: the API allowance never stops a mailbox (see below).

| Answer                    | When                                             | SMTP reply  |
| ------------------------- | ------------------------------------------------ | ----------- |
| accept                    | allowed, or the sender has no tenant (see below) | -           |
| reject                    | the workspace is held (`scope: all`)             | `550 5.7.1` |
| tempfail (Stalwart's own) | the API is down, slow, or could not decide       | `451 4.3.5` |

⚠ **AUTHENTICATED SUBMISSIONS ONLY, AND TWICE.** The plan's `enable` is
`!is_empty(authenticated_as) && local_port != 25 && local_port != 2525`, so the
hook is never consulted for inbound mail or for the send worker's relay (2525 has
no AUTH, so `authenticated_as` is empty there anyway; the port tests are the
second lock). The endpoint repeats it: a request with no `sasl.login` is
accepted untouched.

⚠ **A HOLD ONLY STOPS A MAILBOX WHEN ITS SCOPE IS `all`.** The score writes
`scope: api`; only staff write `all` (risk.md, "Holds": mailboxes are not
stopped by an automatic hold). An API send is stopped by either.

⚠ **ONLY A LOGIN WE CAN PLACE IS LIMITED.** The tenant is the owner of the
login's domain in `core.mailbox_domains()`, the key `core.mailbox_route` uses.
Logins are mailbox addresses, so this holds even for `MAIL FROM:<>`, which an
earlier draft waved through unchecked; the envelope sender is used only for a
login that is not an address. i10's own addresses have no owner, so they are
accepted untouched - staff mail never waits on a review.
`MtaStageAuth.mustMatchSender` (default true, not set here) keeps the sender
inside the login's own addresses as well.

⚠ **THE API ALLOWANCE NEVER STOPS A MAILBOX, AND A MAILBOX NEVER SPENDS IT.**
Mailbox mail is not a send for billing (mail-routing.md: "mailbox mail is
billed by seats and storage and is not a send at all"), so `admitSend` skips the
plan allowance and the free monthly line for it, and the hook records nothing:
recording would put mailbox mail in `core.meter_events`, which `flushUsage`
ships to Polar as `emails`. A workspace that has spent its API allowance still
sends its people's own mail. The H1 throttles (200 an hour, 1000 a day per
account) are the volume cap on 465. Decided by the user on 2026-11-06 (#380).

**Stage and counting.** The hook is consulted at `rcpt` only. The decision needs
the workspace and nothing else, so DATA would add nothing - and it would POST the
whole message (up to 40 MB) as JSON into the API process for every mailbox
send. RCPT also refuses before the client uploads a body. It is asked at **every**
RCPT TO, not the first: the docs do not say whether a refused recipient stays in
`envelope.to`, so skipping later ones on `to.length > 1` could wave one through
after a refusal. It counts **one message however many recipients**, as
`acceptSend` counts a payload and as the H1 throttles count; the answer does not
depend on the recipient and nothing is recorded, so asking again is harmless
(up to 50 asks a message, a few indexed reads each). The endpoint is
stage-agnostic - it needs only the sender - so adding `data` to `stages` later
cannot switch the check off.

**Failure mode: tempfail, 3 s.** `tempFailOnError` is true and `timeout` is 3000
ms. When the API is down, slow, mid-restart, or has the wrong secret, every
mailbox send answers `451 4.3.5` and the client retries - nothing bounces and
nothing is lost, but **nobody can send from a mailbox until the API is back**.
The alternative, skipping the hook on error, would let a held
workspace send freely for exactly as long as the API is down, which is also when
nobody is watching. A decision is a few indexed reads, so 3 s is generous; a
longer one only holds client connections open during an outage.

⚠ **`tempFailOnError` MUST STAY TRUE.** The endpoint answers every error with a
non-2xx status (503 unconfigured, 401 bad token, 400 unreadable body, 500
decision threw), and it is Stalwart's `tempFailOnError` that turns those into
a 451. Turn it off and every one of them becomes an accept. The protocol has no
tempfail action, which is why the endpoint does not try to send one.

⚠ **`STALWART_MTA_HOOK_SECRET` LIVES IN TWO PLACES, AND MUST MATCH.** Same
shape as `STALWART_WEBHOOK_SECRET` above: the Stalwart pod reads it for
`httpAuth` (`envFrom: secretRef i10-stalwart`) and the API pod compares it
(`i10-api`), two Doppler configs. Stalwart sends it as `Authorization: Bearer`;
the API compares it in constant time before reading the body. It is a plain
token, not base64-decoded. **A mismatch reads as an outage**: every mailbox send
tempfails. Look for `rejected an MTA hook call` in the API log and `mta-hook.error`
in Stalwart's.

To turn it on, in this order - the plan line is inert until `bootstrap.sh`
applies it, and applied before the secret exists it tempfails all mailbox mail:

1. Create `STALWART_MTA_HOOK_SECRET` (any long random string) in **both**
   Doppler configs, the same value.
2. Roll the API and restart Stalwart; env vars never update in a running pod.
3. Port-forward the API and check it: `POST /internal/mta-hook` with the bearer
   and `{"context":{"sasl":{"login":"a@b.c"}},"envelope":{"from":{"address":"a@b.c"}}}`
   answers `{"action":"accept"}` (an address on no hosted domain), and without
   the bearer answers 401.
4. `./bootstrap.sh --dry-run`: the only change should be
   `+ would create MtaHook mailboxgate`. Then `./bootstrap.sh`.
5. Send from a mailbox and check the API log shows no `could not decide`, then
   hold a test workspace with `scope: all` and check the send is refused `550`.

To turn it off, change `enable` to `{"match": {}, "else": "false"}` and re-apply
(the bootstrap cannot `destroy`).

⚠ **THE WIRE SHAPE IS FROM THE DOCS AND HAS NOT BEEN PROBED ON OUR SERVER.**
`apps/api/src/mail/mta-hook.ts` follows
[the MTA hooks page](https://stalw.art/docs/mta/filter/mtahooks/) (read
2026-11-06): the request is `{context, envelope, message}`, `context.sasl.login`
is present only after AUTH, `envelope.from.address` from MAIL FROM on. Step 5
above is the probe. If `sasl` is absent on an authenticated session, the hook
accepts everything silently, so **check the first real send is actually
decided** (a held workspace must be refused).

⚠ **1.0's SSRF GUARD FOR INTERNAL ADDRESSES (U8) IS UNCHECKED FOR THIS URL.** The
WebHook and the StoreLookup reach cluster addresses today; the hook goes to
`i10-api.i10-prod.svc.cluster.local` the same way, but that is an inference.
If it is blocked the symptom is `mta-hook.error` in Stalwart's log and `451` for
every mailbox send.

## Team inboxes: one role, and what is still to probe (B8, #382)

A team inbox (`support@`) is a row in the directory. `apps/api` writes
`authd.groups` and `authd.group_members`; authd already serves them as a
`groupOfNames` (so `filterRecipient` accepts the address) and as `memberOf` on
each member (`attrMemberOf`). Members reach it through their own sign-in:
shared folders over IMAP, a second account over JMAP.

The Sent copy is not Stalwart config: no setting copies a send-as-group message
into the group's Sent, and Sieve cannot (the submission script has no account).
`i10-team-sent` (a CronJob, `workloads/team-sent.yaml`) copies what members sent
as the address, over JMAP, and is idempotent by Message-ID.

⚠ **A GROUP CANNOT RECEIVE MAIL WITHOUT A ROLE, AND 1.0 GIVES IT NONE.**
Probed on prod on 2026-11-06 with `probe-team@i10.tech`: Stalwart created the
Group account on the first delivery, then refused that delivery with
`security.unauthorized` (`emailReceive`) and a 550, because
`Authentication.defaultGroupRoleIds` was empty. The plan adds the `i10 Group`
role, which grants `emailReceive` and nothing else, and makes it the default
group role. With that permission the message was stored in the group's mailbox.

⚠ **THE GROUP'S REGISTRY NAME IS THE LOCAL PART** (`probe-team`), as a user's
is, not the directory's full-address name. Two workspaces' `support@` share it;
`jmap-as` tells them apart by the exact `emailAddress`.

Also probed on 2026-11-06 and fine: the impersonation key may `Email/copy` from
a member into the group's `Sent Items`; `Email/query` takes `from` and `after`
with `inMailbox`; a member sees the group as `Shared Folders/<address>/...`
through `memberOf` alone (after #394, which made authd answer the read of a
group's DN that Stalwart resolves `memberOf` with); a member may send `From:`
the group address; destroying the Group account and then the directory row
leaves the address refused with 550.

⚠ **REMOVING A MEMBER'S DIRECTORY ROW DOES NOT REVOKE THEIR ACCESS.** Stalwart
refreshes memberships only when it looks the account up in the directory again,
and an open mail client may not cause that for hours: access was still there 15
minutes after the row was deleted. Clearing the group from the member's
`memberGroupIds` in the registry revoked it at once, so the API does that first
on every removal (`revokeGroup`) and changes the rows second.

## Automatic forwarding policy (#526)

Sieve-generated mail with a non-empty return path
(`source == 'autogenerated' && !is_empty(sender)`: Outlook Rules and Alerts, JMAP
mail rules, hand-written Sieve `redirect` and Sieve `notify`) is checked per
recipient in `MtaOutboundStrategy.route` by calling
`core.auto_forward_allowed(sender, rcpt)` on the `i10` Postgres store (role
`stalwart`). The envelope sender of such mail is the forwarding account's own
primary address, never the original sender or an SRS address, so it names the
workspace whose policy applies.

**Why branch 0 runs BEFORE `is_local_domain(rcpt_domain)`.** Previously (#524),
branch 0 sent every local domain to `'local'` and branch 1 sent autogenerated
mail with a sender to `'local'`. Because `is_local_domain(rcpt_domain)` matches
every customer domain i10 hosts, a stolen mailbox password could forward a
victim's mail to an attacker's own domain hosted on i10 and succeed locally.
Evaluating `core.auto_forward_allowed(sender, rcpt)` in branch 0 ahead of
`is_local_domain(rcpt_domain)` closes that cross-tenant loophole too:

- `workspace` (default): allowed only when `rcpt`'s domain is hosted for mail
  and currently owned by the forwarding account's workspace.
- `workspace_and_members`: the above, plus an exact match on a current member's
  verified Clerk sign-in email (`authd.user_emails` joined to `core.workspace_roles`).
- `anywhere`: any recipient address is allowed (routed to `'local'` if hosted on
  i10, or through `core.mailbox_route(sender_domain)` otherwise).
- `off`: all automatic forwards are refused.

A personal i10.tech mailbox (no workspace) has no policy to read, so every
automatic forward from it is refused. The owner chose this; how to allow it is
in docs/decisions/mail-routing.md, "Automatic forwards from personal i10.tech
mailboxes".

Vacation replies and other null-sender autogenerated messages (`is_empty(sender)`)
and all non-autogenerated mail short-circuit branch 0 without querying Postgres
and keep their exact existing routing.

⚠ **SES REFUSES AN ALLOWED EXTERNAL FORWARD OF OUTSIDE MAIL.** In `anywhere`
and `workspace_and_members`, a forward to an address i10 does not host leaves
through `core.mailbox_route(sender_domain)`, which is `ses-relay` in
production. SES checks the `From` header as well as the envelope, and a
forwarded message keeps its original `From`. Probed live 2026-11-27 with the
`i10-stalwart-smtp` credentials, envelope `MAIL FROM` on i10.tech, recipient
SES's mailbox simulator: `From` on i10.tech was accepted, while `From` on
gmail.com and on example.org were both refused with `554 Message rejected:
Email address is not verified`. Only forwards of mail whose `From` is already
an SES identity of ours get through. Internal forwards to a hosted domain are
delivered locally and never reach SES.

**The `auto-forward-refused` route.** Stalwart 1.2.0 has no `Reject` or `Discard`
`MtaRoute` variant (only `Mx`, `Relay`, and `Local`), and `MtaHook` runs on
inbound SMTP only (not Sieve-generated messages). Disallowed recipients are
routed to `MtaRoute` `auto-forward-refused`, an SMTP `Relay` pointing at
`auto-forward-refused.invalid` (RFC 2606 / RFC 6761 reserved NXDOMAIN). On both
the `edge` and `internal` nodes, outbound delivery skips MX lookup, resolves
`auto-forward-refused.invalid` to `NXDOMAIN` (`DnsError::RecordNotFound`), and
terminates with `Status::PermanentFailure` on the first attempt with zero
retries and zero outbound traffic. A `:copy` rule still keeps the original
message in the mailbox. (Sieve `redirect` defaults to `Notify::Default`, which
does not set `RCPT_NOTIFY_FAILURE`, so a DSN bounce is emitted when a script
explicitly sets `:notify "FAILURE"`, and `delivery.failed` is logged and sent to
the webhook in every case.)

⚠ **ROLLOUT ORDER IS LOAD-BEARING (FAIL-OPEN IF REVERSED).** In Stalwart 1.2.0,
if `sql_query('i10', 'SELECT core.auto_forward_allowed($1, $2)', [sender, rcpt])`
errors (function missing, permission denied, or Postgres unreachable), expression
evaluation aborts and `eval_strategy` looks up route `"default"`. Because no
`MtaRoute` named `"default"` exists, `Server::get_route_or_default` logs
`SmtpEvent::IdNotFound` and falls back to `MX_GATEWAY` - **failing open** and
delivering the forward directly over MX (bypassing both this check and
`ses-relay`).

Deploy strictly in this order:

1. Apply the API database migrations first (`auto_forwarding_setting` and
   `auto_forward_allowed`) so `identity.workspace_settings.auto_forwarding`,
   `authd.user_emails`, and `core.auto_forward_allowed(text, text)` exist and
   `EXECUTE` is granted to `stalwart` (and revoked from `PUBLIC` and `i10_api`).
2. Roll out the API so Clerk webhooks populate `authd.user_emails` and the
   console API serves the setting. Then fill `authd.user_emails` for users who
   existed before it: `bun run --filter @i10/api user-emails --instance prod`
   (a dry run), then again with `--apply`.
3. Apply `plan.ndjson` with `./bootstrap.sh --dry-run` followed by `./bootstrap.sh`
   (the plan upserts `MtaRoute` `auto-forward-refused` before updating
   `MtaOutboundStrategy`, so the route exists before any expression names it).
   No Stalwart pod restart is needed.
