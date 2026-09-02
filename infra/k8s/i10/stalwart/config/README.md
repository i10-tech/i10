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
