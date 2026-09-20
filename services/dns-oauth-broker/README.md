# The one request the cluster is not allowed to make

`dash.cloudflare.com/oauth2/token` will not answer psl-vps. It answers a
**managed challenge** instead — `403`, `cf-mitigated: challenge`, an HTML
"Just a moment…" page — so the OAuth token exchange fails and the console
reports "That did not complete" with a ray id.

This Worker performs that one exchange from Cloudflare's own network, where the
same request is answered normally.

## Why it is the address, and not anything we send

Measured from psl-vps on 2026-09-20, POSTing to the token endpoint:

| Caller                                         | Result                            |
| ---------------------------------------------- | --------------------------------- |
| `curl`, default user agent                     | `403` · `cf-mitigated: challenge` |
| `curl -A i10/1.0`                              | `403` · challenged                |
| `curl --http1.1` (rules out an h2 fingerprint) | `403` · challenged                |
| forced IPv4 — `178.105.164.132`                | `403` · challenged                |
| forced IPv6 — `2a01:4f8:1c18:45fb::1`          | `403` · challenged                |
| the identical request from a residential line  | ordinary OAuth JSON               |
| **from a Cloudflare Worker**                   | **ordinary OAuth JSON**           |

Two things follow, and both are worth keeping written down:

- **No header, client or HTTP version fixes this.** The user-agent work in
  `apps/api/src/dns/user-agent.ts` was measured from a residential connection,
  where nothing is challenged — so it could never have reproduced the failure it
  was trying to fix. `i10/1.0` is still the right thing to send; it is simply
  not what was wrong.
- **It is only the dashboard host.** `api.cloudflare.com` — every zone read and
  every record write the publish path makes — answers the cluster fine, over
  both IPv4 and IPv6. Only the OAuth exchange is brokered, and that is why
  `BROKERED_HOSTS` in `apps/api/src/dns/oauth.ts` is keyed on the HOST rather
  than on the provider.

The exchange cannot move into the browser either: the token endpoint sends no
`Access-Control-Allow-Origin`, so a cross-origin POST from `dash.i10.tech` is
refused by the browser — quite apart from the PKCE verifier, which is derived
from the state secret and must not leave the server.

> ⚠ **A Worker is the shortest honest route, not a trick.** The request's
> destination is Cloudflare either way, so sending it from Cloudflare adds no
> third party to a call carrying a client secret — which is exactly what would
> be wrong with a rented proxy. The proper fix is still for Cloudflare to stop
> scoring our egress as a bot; see "If you would rather not run this" below.

## Deploying it

You need the Cloudflare account that owns the i10 OAuth client.

```bash
cd services/dns-oauth-broker && bunx wrangler deploy
```

Then give it the shared secret. Generate one, keep a copy — the API needs the
same value:

```bash
openssl rand -hex 32
```

```bash
cd services/dns-oauth-broker && bunx wrangler secret put BROKER_SECRET
```

> ⚠ `BROKER_SECRET` is never in `wrangler.jsonc` and never in git. It is the
> only thing standing between the public internet and an authenticated relay to
> an OAuth token endpoint.

Finally, point the API at it — in Doppler, both together:

```
DNS_OAUTH_BROKER_URL    = https://i10-dns-oauth-broker.i10-tech.workers.dev
DNS_OAUTH_BROKER_SECRET = <the same value>
```

Setting only one is refused at boot with a warning and the exchange goes out
directly, where it will keep being challenged. Setting neither is a supported
state and means "call Cloudflare directly" — correct for local development, and
correct again if Cloudflare ever exempts the cluster.

## Checking it works

Without the API, against the deployed Worker:

```bash
curl -s -X POST -H 'Authorization: Bearer <BROKER_SECRET>' \
  --data 'grant_type=authorization_code&code=probe&client_id=probe' \
  https://i10-dns-oauth-broker.i10-tech.workers.dev
```

A working broker answers Cloudflare's own
`{"error":"invalid_client", …}` — a real OAuth error, which is the proof that
the request reached the endpoint instead of a challenge page. `401` with an
`x-broker-error: unauthorized` header is the broker refusing you, not
Cloudflare; the header is the only thing that tells those two `401`s apart, and
the API reads it for the same reason.

## If this ever starts being challenged too

The Worker returns Cloudflare's `cf-ray` and `cf-mitigated` untouched, so the
API's existing diagnostics keep working through it and the console will say so
in the same words. That is deliberate: if the edge starts scoring Worker
subrequests to the dashboard, the failure looks exactly like the one this was
built for, and the evidence is already in the log.

## If you would rather not run this

The durable fix is for Cloudflare to stop challenging the cluster. i10 has a
registered OAuth client with them — the authorize step works and our redirect
URI is registered — so there is a channel. What support needs is the ray ids
from a failing exchange and the two egress addresses above. That removes this
Worker entirely: unset the two variables and the API goes back to calling the
token endpoint directly.
