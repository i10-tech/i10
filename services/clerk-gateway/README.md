# The gateway in front of Clerk

`clerk.i10.tech` is the hostname encoded in our publishable key, so it is where
clerk-js and the Next.js SDK send every Frontend API (FAPI) request. This
Cloudflare Worker answers that hostname. It forwards what our own UI and Clerk's
server-side handshake need to Clerk, through Clerk's documented FAPI proxy
contract, and refuses everything else with a 404 before it reaches Clerk.

Why: `docs/decisions/sso.md` 1.4 (level L1, our gateway at the same name) and
1.5 (decided 2026-10-20, a Worker). In short: nobody should be able to do at
Clerk directly what our API owns (org admin, org creation, account deletion),
and managed accounts must be stopped at the door (#337). Our API's own gate
stays, so a gap here is not a gap in i10.

| File             | What it is                                                      |
| ---------------- | --------------------------------------------------------------- |
| `src/routes.ts`  | The allowlist and the explicit deny list, one table each        |
| `src/policy.ts`  | Pure pass/deny decision: path rules, `_method`, bodies, managed |
| `src/managed.ts` | The managed-account lookup (our API, #337) and its cache        |
| `src/forward.ts` | Clerk's proxy contract: headers in, `Set-Cookie`/`Location` out |
| `src/gateway.ts` | One request end to end, with everything side-effecting injected |
| `src/log.ts`     | The one structured line per request                             |
| `src/config.ts`  | The Worker's variables and secret, validated                    |

## What it does

**Default deny.** A request passes only if its method and path match an entry
in `ALLOW` in `src/routes.ts`. `DENY` names routes that must stay closed even if
an allow entry later overlaps them, and is checked first. Everything else is a
404 with `X-Clerk-Gateway: denied` and Clerk's error envelope, so clerk-js
parses it like one of Clerk's.

Notes on what is closed on purpose:

- **Account deletion** (`DELETE /v1/me`) goes through our API since #336
  (`DELETE /console/me/account`), which refuses the only owner of a workspace
  that still has other members.
- **i10 as an OAuth provider** is denied as a whole group
  (`oauth_provider_not_used`): `/oauth/*`, the consent routes and the
  `.well-known` discovery and JWKS documents. No OAuth applications exist on
  either instance (checked 2026-10-20). `apps/auth/app/oauth-consent` stays in
  the codebase but is unreachable through the gateway on purpose; the group
  comes back, reviewed, the day i10 becomes an OAuth provider.
- **Clerk's own UI pages** under `apps/console/app/(app)/reference/clerk/` call
  org admin, roles, org creation and account deletion routes, and break through
  the gateway. They are reference only.

**The method is the effective method.** clerk-js sends every PATCH, PUT and
DELETE as a `POST` with `_method=<METHOD>` in the query, and Clerk honours it.
The policy resolves it first, so `POST /v1/me?_method=DELETE` is `DELETE /v1/me`
and is refused. Two overrides, an override in another spelling, an override on
anything but POST, or `_method` in a form body are refused outright.

**Paths are matched as forwarded.** Anything that could make our string differ
from what Clerk's router resolves is refused: `%`, dot segments, `//`,
characters outside `A-Za-z0-9-._~@+/`. One trailing slash is stripped for
matching (clerk-js sends `/v1/me/backup_codes/`). Matching is case-sensitive, so
`/V1/ORGANIZATIONS` simply matches nothing. The query string never affects
routing, except `_method`.

**Bodies.** Form bodies (`application/x-www-form-urlencoded`) are buffered, up
to 64 KiB, so the policy can read them; the same bytes are forwarded. Uploads
(`multipart/form-data`, `application/octet-stream`) stream through unread and
only where an entry says `upload` (the profile photo). Any other non-empty body
is refused.

**Managed accounts (wired by #337).** Entries marked `guard: "self_service"`
ask the hook whether the session in `_clerk_session_id` is a managed account;
if so, 403 `managed_account`. `guard: "sign_in_create"` asks about the
`identifier`; a managed one gets 422 `sso_required` ("Continue with your
company's SSO"), unless `strategy=ticket`, which passes without a lookup. A
lookup that throws is a 503, never "not managed".

The lookup is our API's `POST /internal/identity/managed` (`{ identifier }` or
`{ sessionId }` in, `{ managed }` out), authenticated with
`Authorization: Bearer <I10_API_SECRET>`, the same value as the API's
`IDENTITY_GATEWAY_SECRET`. Answers are cached per isolate for 15 seconds;
failures never are. Anything but a 200 with a boolean, a timeout (3 s), or a
missing `I10_API_URL` / `I10_API_SECRET` throws, so the policy answers 503.
Telling our tickets from Clerk's other tickets (invitations, saved accounts) is
done behind the door, by the API: only a session bound through `POST
/sso/bind` passes its gate, and the sweeper revokes an unbound ticket session
after two minutes.

**Forwarding** (Clerk's guide at
clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi, and Clerk's own
implementation, `clerkFrontendApiProxy` in `@clerk/backend` `dist/proxy.mjs`):
method, path, query and body unchanged to `UPSTREAM_ORIGIN`, `redirect:
manual`; `Clerk-Proxy-Url: PROXY_URL`; `Clerk-Secret-Key`; `X-Forwarded-For`
set to `CF-Connecting-IP` alone (any incoming `X-Forwarded-For`, `Forwarded`,
`X-Real-IP` and `CF-*` headers are dropped); hop-by-hop headers stripped both
ways. Responses pass through as Clerk sent them, every `Set-Cookie` separately;
a `Location` pointing back at the upstream origin is moved onto the proxy, as
Clerk's own proxy does, and every other `Location` is untouched. A content
coding the client did not accept is dropped (the runtime then sends the body
uncompressed).

**Outage rule.** If Clerk cannot be reached, or sends no headers within
`UPSTREAM_TIMEOUT_MS`, the answer is 503 with `Retry-After: 5`,
`X-Clerk-Gateway: unavailable` and `service_unavailable`. Never a 401: clerk-js
ends the session on an unauthenticated token refresh, and an outage must not
sign anyone out. Clerk's own 5xx pass through unchanged. An unconfigured
gateway (no secret, or a key from the other instance) answers 503 to
everything.

**Logging.** One JSON line per request (`msg: "clerk-gateway"`): effective
method, route name, decision, reason, our status, Clerk's status, duration,
client IP, Cloudflare ray id, and for a refused request the path (never the
query). No headers, no query, no body, ever: those carry cookies, session
tokens, dev-browser tokens, tickets and passwords. The type in `src/log.ts` is
the whole vocabulary. The identity audit log (sign-ins, refusals, revocations) is the API's, in `identity.events`.

## Running it locally

The gateway can front the DEV instance (development instances can be proxied
without `proxy_url`). `env.local` in `wrangler.jsonc` points at
`https://frontend-api.clerk.dev` with `PROXY_URL=https://clerk.i10.localhost`;
Caddy serves that name (`dev/Caddyfile`).

```bash
bun run dev:up                     # Caddy picks up clerk.i10.localhost
cd services/clerk-gateway
doppler run --project i10 --config dev -- bun run local
```

⚠ The script is `local`, not `dev`, on purpose: a `dev` script would join
the root `turbo run dev`, which is capped at 10 persistent tasks and refuses to
start with an eleventh. The gateway is opt-in locally, so it stays out of it.

The secrets come from Doppler through the process environment:
`secrets.required` in `wrangler.jsonc` makes wrangler read `CLERK_SECRET_KEY`
and `I10_API_SECRET` (and nothing else) from it. Never write them to
`.dev.vars`. `I10_API_SECRET` must equal the API's `IDENTITY_GATEWAY_SECRET` in
the same Doppler config; locally the gateway asks the API at
`http://localhost:3001` (`I10_API_URL` in `env.local`).

Then start the apps against it, from the repo root:

```bash
CLERK_PROXY_URL=https://clerk.i10.localhost doppler run -- bun run dev
```

`CLERK_PROXY_URL` reaches `<ClerkProvider proxyUrl>` and
`clerkMiddleware({ proxyUrl })` in `apps/auth` and `apps/console`, and only when
it is set. In the browser's network panel every Clerk request now goes to
`clerk.i10.localhost`, and each one is a log line in the wrangler terminal.

Quick checks without the apps (`--resolve` because curl does not resolve
`.localhost` names; `bun run dev:hosts` adds them):

```bash
curl -sk --resolve clerk.i10.localhost:443:127.0.0.1 https://clerk.i10.localhost/v1/environment -o /dev/null -w '%{http_code}\n'   # 200
curl -sk --resolve clerk.i10.localhost:443:127.0.0.1 -X POST https://clerk.i10.localhost/v1/organizations -D - -o /dev/null | grep -i 'x-clerk-gateway'   # denied
```

`bun run test`, `bun run lint` and `bun run check-types` in this directory, or
from the root through turbo.

## Production rollout, in order

Nothing below has been done. Each step is manual and in this order.

1. **Ask Clerk support the P8 question** in `docs/decisions/sso.md` 1.5 and wait
   for the answer. Record it in `sso.md` (1.5 and the P8 row of Part 5). If the
   answer is that a whole hostname cannot be a `proxy_url`, or that Clerk keeps
   serving `clerk.i10.tech` some other way that we cannot close, stop here.

2. **Give the Worker the production secrets**, piped so they are never
   printed. The API must already run with `IDENTITY_GATEWAY_SECRET` set
   (Doppler `prod`), or every managed-account lookup answers 503:

   ```bash
   cd services/clerk-gateway
   doppler secrets get CLERK_SECRET_KEY --project i10 --config prod --plain \
     | bunx wrangler secret put CLERK_SECRET_KEY
   doppler secrets get IDENTITY_GATEWAY_SECRET --project i10 --config prod --plain \
     | bunx wrangler secret put I10_API_SECRET
   ```

   Check the lookup end to end before going on: a sign-in attempt for an
   identifier that is not managed must reach Clerk (not a 503 with
   `X-Clerk-Gateway: unavailable`).

3. **Deploy it, on `workers.dev` only** (no route is configured):
   `bunx wrangler deploy`. Check `GET https://i10-clerk-gateway.<account>.workers.dev/v1/environment`
   is 200, and `POST .../v1/organizations` is a 404 with `X-Clerk-Gateway:
denied`. Whether `/v1/environment` and `/v1/client` already answer here,
   before `proxy_url` is set, tells you whether step 5's window is an outage or
   not; note it.

4. **Rehearse the proxy check against `workers.dev`.** Deploy once with the
   Worker's own URL as its proxy URL, check it, and put it back:

   ```bash
   bunx wrangler deploy --var PROXY_URL:https://i10-clerk-gateway.<account>.workers.dev
   # POST https://api.clerk.com/v1/proxy_checks (production secret key)
   #   {"domain_id": "<prod domain id>", "proxy_url": "https://i10-clerk-gateway.<account>.workers.dev"}
   bunx wrangler deploy
   ```

   The domain id comes from `GET https://api.clerk.com/v1/domains`. This proves
   the secret, the forwarding and `X-Forwarded-For` end to end without touching
   `clerk.i10.tech`. If Clerk refuses it only because the URL is not on our
   domain, go on; the real check is step 6.

5. **Move `clerk.i10.tech` to the Worker, as a Custom Domain.** In the
   Cloudflare dashboard: DNS, delete the `clerk` CNAME to
   `frontend-api.clerk.services`; then Workers, `i10-clerk-gateway`, Settings,
   Domains & Routes, add the custom domain `clerk.i10.tech`. Cloudflare creates
   the record and the certificate.

   > ⚠ A CUSTOM DOMAIN, NOT A ROUTE. A route runs a Worker in front of an
   > existing proxied DNS record and its origin, and the only origin here would
   > be Clerk's own CNAME: orange-clouding it sends our traffic into Clerk's
   > Cloudflare-for-SaaS hostname, and anything the Worker passes on with
   > `fetch(request)` would reach Clerk directly, without the proxy headers. A
   > custom domain makes the Worker the origin: nothing behind it, nothing to
   > fall through to.

   From here until step 6 is done, requests reach Clerk with a `Clerk-Proxy-Url`
   it has not been told about. Do steps 5 and 6 together, at a quiet hour.

6. **Validate and switch Clerk over:**

   ```text
   POST  https://api.clerk.com/v1/proxy_checks
         {"domain_id": "<prod domain id>", "proxy_url": "https://clerk.i10.tech"}
   PATCH https://api.clerk.com/v1/domains/<prod domain id>
         {"proxy_url": "https://clerk.i10.tech"}
   ```

   The check must answer `successful: true` before the PATCH.

7. **Verify**, against the issue's "done when": sign-in (password, email code,
   passkey, Google, GitHub), sign-up, a token refresh (leave a console tab open
   for two minutes), switching workspaces, accepting an invitation from Clerk's
   email, the step-up dialog, the account page. Then: a refused route answers
   404 with `X-Clerk-Gateway: denied` and never shows in Clerk's logs; Workers
   Logs show one `clerk-gateway` line per request with the real client IP.

8. **Delete the leftover `accounts.i10.tech` CNAME** at Cloudflare (still
   published on 2026-10-19, see sso.md 1.4). Check
   `dig +short accounts.i10.tech @byron.ns.cloudflare.com` is empty.

9. **Record it** in `sso.md`: the date, the proxy check result, and the P8 answer.

The apps need no change for production: `CLERK_PROXY_URL` stays unset, because
the gateway answers the host the publishable key already names.

### Rolling back

- **A policy or code bug:** `bunx wrangler rollback` to the previous version.
  The hostname, the secret and Clerk's `proxy_url` stay as they are.
- **Back to Clerk directly:** `PATCH /v1/domains/<id>` with
  `{"proxy_url": null}`, remove the custom domain from the Worker, and recreate
  `clerk CNAME frontend-api.clerk.services` (DNS only, grey cloud), then use
  "Verify configuration" on Clerk's Domains page so Clerk reissues its
  certificate. Expect minutes of errors while the certificate is issued.

## Adding an allowlist entry safely

1. Find the exact call: the clerk-js resource method or SDK behaviour, and the
   FAPI route it produces. Confirm the path from clerk-js itself (its
   `_basePost` / `_fetch` calls) and from Clerk's FAPI spec, not from memory;
   remember PATCH, PUT and DELETE arrive as `POST ?_method=`.
2. Add one entry to `ALLOW` in `src/routes.ts`: a stable `name`, the effective
   `method`, the `path` with `:param` segments (add a kind to `PARAMS` if a new
   id prefix appears), and a `why` naming the call site. Use `guard:
"self_service"` for anything that changes the account itself, so managed
   accounts stay refused.
3. If it sits next to a `DENY` entry, make sure it does not overlap: the test
   "never overlaps the explicit deny list" fails if it does, and the deny entry
   wins regardless.
4. `bun test`: every entry is exercised automatically. Add a policy test if the
   entry needs a body rule or a guard.
5. If the route is one of the ones `DENY` names, do not add it: the decision to
   open it belongs in `sso.md` first.
