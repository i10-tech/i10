# Running i10 locally, for real

The point of this setup is that the flow works end to end: you open
`https://dash.i10.localhost`, you are sent to `https://auth.i10.localhost`, you
sign in with a real Clerk development instance, and you land back on the console
with a session that came from a different origin. That last part is the whole
reason for the hostnames — `localhost:3000` and `localhost:3004` are **one
origin with two ports**, where cookies, `SameSite` and Clerk's `authorizedParties`
all behave differently from production. Every bug in that area is invisible
until there are two names.

## Once per machine

```bash
bun install
bun run dev:up       # postgres, redis, caddy, powerdns
bun run dev:hosts    # /etc/hosts entries (sudo)
bun run dev:trust    # trust Caddy's local CA (keychain prompt)
bun run dev:migrate  # apply migrations to the local database
```

Then, every day:

```bash
bun run dev:up
bun run dev
```

| URL                          | App     | Port |
| ---------------------------- | ------- | ---- |
| `https://dash.i10.localhost` | console | 3000 |
| `https://api.i10.localhost`  | api     | 3001 |
| `https://i10.localhost`      | web     | 3002 |
| `https://docs.i10.localhost` | docs    | 3003 |
| `https://auth.i10.localhost` | auth    | 3004 |

> ⚠ The auth app used to be on **3002, the same port as the web app**. Both are
> started by `turbo run dev`, so one of them lost the race and died — which is
> what "the local server is down" looked like. It is on 3004 now.

## Why Caddy and not Traefik

Traefik can do this, and production does route with Traefik — but the parity is
an illusion. Production routes with `IngressRoute` CRDs against pods; locally
there are no pods and no CRDs, so a local Traefik would be a file-provider
config that shares nothing with production except the binary's name.

What Caddy has and Traefik does not is `tls internal`: one directive that runs a
local certificate authority and issues a certificate per hostname with no
further configuration. Traefik needs certificates generated outside it
(`mkcert`) and referenced from a static file — the same work, plus a second
tool, for a config nobody will recognise. If we ever want the local proxy to
resemble production, the thing to reach for is k3d with the real IngressRoutes,
not Traefik-standalone.

## Why `.localhost` and not `.local`

`.local` is reserved for multicast DNS (RFC 6762). On macOS it is answered by
Bonjour, which does not consult `/etc/hosts` predictably and adds seconds of
delay when it fails to resolve. `.localhost` is reserved by RFC 6761 for exactly
this purpose, and every major browser resolves `anything.localhost` to the
loopback address with no configuration at all.

`dev:hosts` adds the entries anyway, because the operating system's resolver is
not a browser: `curl https://api.i10.localhost` and a server-side `fetch` from a
Next.js route both fail with NXDOMAIN without them, while the same URL works
perfectly in the address bar.

## Environment

The apps read `process.env`. Two ways to fill it:

**Doppler (preferred).** A `dev` config in the `i10` project, so the Clerk
development keys are shared and rotating one is one edit:

```bash
doppler setup --project i10 --config dev
doppler run -- bun run dev
```

**A local file.** Copy `dev/env.example` to `.env.development.local` at the repo
root and fill in the Clerk values. It is gitignored.

### What has to be real

Only Clerk. Everything else has a local default or degrades honestly.

| Variable                | Where it comes from                                        |
| ----------------------- | ---------------------------------------------------------- |
| `CLERK_SECRET_KEY`      | Clerk dashboard → your **development** instance → API keys |
| `CLERK_PUBLISHABLE_KEY` | the same page — `pk_test_…`                                |
| `CLERK_WEBHOOK_SECRET`  | Clerk → Webhooks → your endpoint → signing secret          |

> ⚠ `CLERK_PUBLISHABLE_KEY` IS NOT OPTIONAL IN PRACTICE, whatever `env.ts` says.
> `authenticateRequest` throws "Publishable key is missing" without it, the
> verifier reports `unavailable`, and every console page renders "Could not
> verify your session right now." It is declared optional so that a console
> variable cannot stop the send path booting — which is a different question
> from whether the console works.

In your Clerk development instance, set the paths so the redirect actually goes
somewhere:

- **Sign-in URL** `https://auth.i10.localhost/sign-in`
- **Sign-up URL** `https://auth.i10.localhost/sign-up`
- **After sign-in** `https://dash.i10.localhost`

And add `https://dash.i10.localhost` to `CONSOLE_ORIGINS`, which is the `azp`
allowlist — empty means Clerk checks nothing, and a token minted for any
application on the instance is accepted.

### Webhooks from Clerk

A tenant is provisioned by a Clerk webhook, so without one you sign in and land
on "Your workspace is still being created" for ever. Point a tunnel at the API:

```bash
bunx untun@latest tunnel http://localhost:3001
# then set the Clerk webhook endpoint to <tunnel>/webhooks/clerk
```

## The nameserver

PowerDNS runs against the same `pdns` schema the API writes, which is the whole
design — creating a delegated domain and publishing its zone are one
transaction. It is on 5354 — 53 needs root, and 5353 is mDNS's own port, which macOS already holds:

```bash
dig @127.0.0.1 -p 5354 SOA mail.example.com
```

## Resetting

`bun run dev:reset` removes the volumes, which is how you get a clean database
and a new CA. You will need `dev:migrate` again, and `dev:trust` again.
