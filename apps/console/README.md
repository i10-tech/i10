# The console

`dash.i10.tech`. Domains, DNS onboarding, the delivery log, API keys, webhooks,
contacts, broadcasts, templates, usage and billing.

The reasoning behind the shape of it — how it reaches its data, why the
navigation is split the way it is, and what onboarding does — is in
[`docs/decisions/console.md`](../../docs/decisions/console.md). This file is how
to run it.

---

## Looking at it, with nothing else running

```bash
bun install
bun --filter @i10/console dev:preview
```

Then open <http://localhost:3000>.

That is the whole setup. No database, no Redis, no Clerk instance, no AWS
credentials. Every screen renders from fixtures in
[`lib/preview.ts`](lib/preview.ts), and the fixtures are deliberately not all
healthy — there is a failed domain, a bounce, a complaint, a delayed message, a
revoked key, an unsubscribed contact and a sending meter that is over its
allowance, because those are the states worth reviewing.

**Preview mode cannot be turned on in production.** The flag is ANDed with
`process.env.NODE_ENV !== "production"`, which Next replaces with a literal at
build time — so in a production image the whole expression folds to `false` and
the bundler deletes every `if (PREVIEW)` block. The compiled `api()` goes
straight from its path guard to `fetch`; nothing in the build reads a fixture.
There is no variable anybody can set in a pod to change that.

The fixture _data_ is still emitted into the server chunk, unreferenced — a few
kilobytes of dead weight that Turbopack does not shake out. To re-check both
halves of that after a Next upgrade:

```bash
bun --filter @i10/console build
grep -c "if(.*PREVIEW" apps/console/.next/server/chunks/ssr/*.js   # expect 0
```

**It is off by default in development too.** `bun run dev` talks to a real API on
`localhost:3001`. A developer debugging a live query must never silently be
looking at fixtures, so turning it on is a different command.

### Things worth clicking in preview

| Where                           | What it shows                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `/domains/new`, type `acme.com` | Cloudflare detected, with a **Connect** button                                             |
| … type `acme.dev`               | GoDaddy — detected, but their API is gated, so delegation is offered instead               |
| … type `acme.shop`              | Wix — **delegation disabled**, with the reason, because their editor has no NS record type |
| … type `acme.net`               | A split nameserver set, mid-migration, warned about                                        |
| … type `acme.org`               | Nothing recognised — falls back to manual instructions                                     |
| `/domains/…` (the pending one)  | The DNS records table, per-record status, copy buttons, zone-file export                   |
| `/emails/…`                     | Sandboxed HTML preview, source, headers, and the event timeline                            |
| `/onboarding`                   | All five steps; it is reachable at any time, by anyone, forever                            |
| `/settings/usage`               | A meter over its allowance, and one feature that genuinely cannot be read                  |
| `⌘K` / `Ctrl-K`                 | The command menu                                                                           |

---

## Running it for real

The console is a thin client: it renders, and every byte of data comes from
`apps/api` over `/console/*`. So "running it for real" means running the API.

```bash
# 1. The API, with a database it can reach.
#    See apps/api — it needs DATABASE_URL, a Redis URL, Clerk keys and,
#    for the domain routes, AWS credentials and WEBHOOK_SECRET_KEY.
bun --filter @i10/api db:migrate
bun --filter @i10/api dev        # listens on :3001

# 2. The console.
bun --filter @i10/console dev    # listens on :3000
```

The console itself needs three variables:

| Variable                | What it is                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `API_BASE_URL`          | Where `apps/api` is. Defaults to `http://localhost:3001`.                                              |
| `CLERK_PUBLISHABLE_KEY` | Your Clerk instance. Without it the console renders unauthenticated and the API refuses every request. |
| `CLERK_SECRET_KEY`      | Same instance. Read from runtime env by Clerk's own default.                                           |
| `CLERK_SIGN_IN_URL`     | Points at `apps/auth`. Unset, Clerk silently falls back to its hosted Account Portal.                  |
| `CLERK_SIGN_UP_URL`     | Same.                                                                                                  |

**None of them carry a `NEXT_PUBLIC_` prefix, and that is not an oversight.**
Next replaces `NEXT_PUBLIC_*` textually at _build_ time — in server code too —
so a prefixed variable that is absent when `docker build` runs is compiled in as
`undefined` and no amount of setting it in the pod will bring it back. The image
is built once in CI and configured per environment by Doppler, so anything the
build cannot see must stay unprefixed and be read at request time.

---

## How it is put together

- **Server components by default.** Client components are the exception and each
  one earns it: a table that filters, a form that submits, a chart. The chrome —
  sidebar, workspace bar, usage rail — renders on the server and ships as
  markup.
- **Reads go through [`lib/api.ts`](lib/api.ts)**, which attaches the Clerk
  session as a bearer token. It is `server-only`; importing it from a client
  component is a build failure naming the file that did it.
- **Writes go through [`lib/actions.ts`](lib/actions.ts)** — server actions, so
  the session token never reaches the browser. They return a result rather than
  throwing, because a thrown error in a server action reaches the client with
  its message stripped in production, and the message is the part the person
  needs.
- **Filters and pagination live in the URL.** The pages are server-rendered, so
  state that lived in React would have nothing to fetch with — and it means a
  filtered view is a link somebody can paste into an incident channel.
- **Pagination is a cursor, never an offset.** `core.messages` is partitioned;
  `OFFSET 40000` makes Postgres produce and discard forty thousand rows on every
  request. It is also the only form that stays correct while rows are arriving.

## The design system

`packages/ui`. shadcn/ui components, Uber Base's motion values, and a monochrome
palette where **colour only ever means state** — delivered, bounced, complained,
pending. `--brand` is deliberately unset; focus and selection use the neutral
ring until somebody picks an accent.

Dark mode is the default and its canvas is true black, which is why elevation
here is a 1px hairline border and a slightly lifted surface rather than a
shadow. A shadow on black is invisible.
