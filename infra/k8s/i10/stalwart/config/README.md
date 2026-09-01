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

## First boot

`config.json` is always present here, so Stalwart never enters bootstrap mode —
an unreachable DataStore makes it exit rather than serve a setup wizard. The
first administrator therefore comes from recovery mode:

1. Start the pod with `STALWART_RECOVERY_MODE=1` and `STALWART_RECOVERY_ADMIN`
   (`username:password`) sourced from Doppler.
2. `stalwart-cli apply --file plan.ndjson` against the recovery listener.
3. Restart **without** the recovery variables.

⚠ `STALWART_RECOVERY_ADMIN` is a backdoor. Remove it from the environment before
the server restarts normally; the docs are explicit that it must not remain set
on a production deployment.

## The database

`config.json` points at database `stalwart`, not `i10`. The CNPG cluster
bootstraps only `i10`, so the `stalwart` database and its role are created by
`database.yaml` in the parent directory. Stalwart owns its own database
deliberately: it manages its own schema, migrates it on upgrade, and must never
share a migration surface with the transactional product.
