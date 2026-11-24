# Microsoft Exchange support (#517)

**Status:** design for approval, 2026-11-23. Nothing here is built. The probes in section 2 ran on a throwaway loopback Stalwart v1.2.0 and are recorded so that each PR in section 9 can rerun them.

**What this is for.** Stalwart 1.2.0 (released 2026-11-23) serves MAPI over HTTP, Exchange Web Services (EWS), Exchange ActiveSync (EAS) and Autodiscover. With them, classic Outlook, Apple's Exchange accounts and the Exchange accounts on phones connect as they would to Exchange. #517 asks for full support: companies leaving Exchange or Microsoft 365 keep their Outlook. Three things stop us from just switching it on:

- every Exchange sign-in would be refused, because all of it is served on Stalwart's HTTP listener, which the mail front does not cover, and authd refuses every person bind without the front's bind token;
- revocation would lag by up to an hour, through Stalwart's HTTP auth cache and requests that stay open;
- Autodiscover is per customer domain, which touches our DNS and our certificates.

**Evidence tags.** `[probe]`: measured in this session (section 2). `[src]`: read in Stalwart's source at tag `v1.2.0` (commit `b2d3df9a`), paths under `crates/`. `[doc]`: Stalwart's documentation, read 2026-11-23. `[apple]`: Apple's `device-management` repository, branch `release`. `[unproven]`: not measured, and the PR that depends on it must measure it first.

---

## 1. Decisions in one table

| Question                             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the HTTP front runs            | A third listener in the existing `mailfront` binary, in both Stalwart pods, behind Traefik. Not a new binary, not a Traefik middleware.                                                                                                                                                                                                                                                                                                 |
| What it attributes                   | **Each request**, never the connection. Only HTTP Basic is accepted from clients. Bearer, NTLM and Negotiate are answered `401` with a Basic-only challenge and never forwarded.                                                                                                                                                                                                                                                        |
| How the bind token gets in           | The front rebuilds the `Authorization` header from scratch: the row's primary address, then the password behind a token for that row's user id. Nothing the client typed in the login reaches Stalwart.                                                                                                                                                                                                                                 |
| Stalwart's HTTP auth cache           | Left on, made unreachable: every header Stalwart ever caches was built by the front, and the front stops sending it when access is removed. `accessTokenExpiry` goes to its minimum (10 minutes) as defence in depth.                                                                                                                                                                                                                   |
| A new bind token kind                | `i10hf1.`, its own MAC label, 10-minute lifetime, re-minted by the front every 5 minutes. authd's current token is capped at 65 s, which would cost two real directory binds a minute per phone on the LDAP pass-through lane.                                                                                                                                                                                                          |
| Long-lived requests                  | Every request in flight is in the sweep's registry under its account's Grant, so the sweep that closes IMAP connections cancels it within a second: EAS Ping and Sync waits, EWS streaming, MAPI NotificationWait, JMAP EventSource and WebSocket.                                                                                                                                                                                      |
| What the front refuses               | Every path outside an allowlist (the admin API `/api`, `/login`, `/auth`, OAuth discovery, `/scim`, `/metrics`, the WebUI), any login containing `%` (master-user impersonation), a login without `@`, and any login the projection does not know (so Stalwart's recovery admin can never sign in over the public HTTP path). Exchange and DAV paths for a Free account.                                                                |
| The bar                              | A person on a hosted domain types their address and their usual password into classic Outlook, Outlook for Mac, iPhone Mail or an Android Exchange account, and nothing else: no server, port or protocol, and no certificate or "allow this website" warning. Section 4 is designed to that bar, client by client.                                                                                                                     |
| Autodiscover DNS                     | Every hosted domain gets `autodiscover.<domain> CNAME autodiscover.i10.tech`, published automatically where we hold DNS credentials. That name is the only lookup every client tries and that we can serve silently. `_autodiscover._tcp` SRV is **not** published: Outlook and Outlook for Mac warn on it, Android never reads it, and it would only turn a broken setup into a warning.                                               |
| Certificates                         | A publicly trusted certificate for `autodiscover.<domain>` on every hosted domain, from day one, because both Outlooks warn on every redirect (SRV or HTTP) and the CNAME without a certificate fails TLS. cert-manager HTTP-01, one `Certificate` and one route per domain, written by a reconciler with its own ServiceAccount, never the API pod.                                                                                    |
| Readiness                            | The console says "Outlook and phones: ready" for a domain only after i10 checked it itself: the CNAME resolves to us, the certificate is served and chains to a public root, the front answers, the domain's own website does not break the first lookup, and Microsoft 365 does not claim the domain. Until then, no user is told to set up.                                                                                           |
| Apple devices                        | Typing the address and password works (section 4). The device-code enrollment (#383) stays the path for SSO accounts without a password lane: it installs `com.apple.eas.account` (iPhone) or `com.apple.ews.account` (Mac) with the host set, and the front pins the code to the ActiveSync `DeviceId` it was first used with.                                                                                                         |
| Webmail                              | No Bulwark. The front covers JMAP with its EventSource and WebSocket pushes for direct JMAP clients and for i10's own webmail later, and nothing in it is shaped around a particular webmail.                                                                                                                                                                                                                                           |
| Two settings 1.2.0 gets wrong for us | `Calendar.shareFreeBusy` defaults to **on** in 1.2.0 and, with no Stalwart tenants (an Enterprise feature), lets every account on the server read every other account's free/busy, across customers `[probe]`. It must be `false` in `plan.ndjson` **before** the 1.2.0 upgrade, Exchange or not. `Sharing.allowDirectoryQueries` stays `false` (it is already the default), or Outlook's address book lists every customer's accounts. |
| Migration                            | Vandelay, as a Kubernetes Job per mailbox: import from Graph or EWS with the customer's consented token into an archive, export over JMAP with an admin API key and `--account-name`. The export has to reach the public URL, which the Job meets with a pod-local TLS shim (section 7).                                                                                                                                                |

---

## 2. Probes

**Setup.** The official image as CI pushed it before the tag was attached: `stalwartlabs/stalwart@sha256:9a49079d411864567b7cf2506bcf22d3e0f6608ed335e9cc5ea9ed4e86823576` (`stalwart --version`: `1.2.0`; label `org.opencontainers.image.revision=b2d3df9a`). Published on `127.0.0.1:18080` only, RocksDB store (`exchange-support/probe/stalwart-config.json`), `STALWART_RECOVERY_ADMIN`, `STALWART_PUBLIC_URL=http://mail.probe.test:18080`. Exchange enabled with `x:Exchange/set {"enable": true}` and `ReloadSettings`. Two internal accounts (`alice`, `bob` on `probe.test`), then an LDAP directory: glauth v2.5.4 on an internal Docker network with no published port (`exchange-support/probe/glauth.cfg`), set as `Authentication.directoryId` with `bindAuthentication: true`, as in prod (per-domain directories are Enterprise, `common/src/auth/authentication.rs:815-829` `[src]`), holding `carol` and `dave` on `ldap.test` and `erin` on `other.test`. Every script is in `docs/research/exchange-support/probe/`, raw outputs in `results/`. Both containers and the network were removed afterwards.

### 2.1 Authentication and login forms

`ews.sh <user:pass> [impersonate]` posts a `GetFolder(inbox)`.

| Request                                                                                                                                                   | Answer                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Every Exchange path without credentials (`/EWS/Exchange.asmx`, `/mapi/emsmdb/`, `/mapi/nspi/`, `/Microsoft-Server-ActiveSync`, `/OAB/`, POX Autodiscover) | `401`, `WWW-Authenticate: Basic realm="Stalwart Server"` only.                               |
| `/api/schema` without credentials                                                                                                                         | `401`, `Bearer ... resource_metadata=...`: the admin API is on the same listener.            |
| `/login`                                                                                                                                                  | `200`: the WebUI login page is on the same listener.                                         |
| `alice@probe.test`                                                                                                                                        | `200`, `NoError`.                                                                            |
| `PROBE\alice@probe.test`                                                                                                                                  | `200`. Everything up to the last backslash is dropped.                                       |
| `PROBE\alice@probe.test` on `/jmap/session`                                                                                                               | `200`. The relaxed decoding applies to JMAP and DAV too while Exchange is on (also `[doc]`). |
| `alice@probe.test%bob@probe.test` with bob's password                                                                                                     | `403`: bob lacks the `impersonate` permission.                                               |
| `bob@probe.test%admin` with the **recovery admin's** password                                                                                             | **`200`, signed in as bob.** The recovery admin impersonates any account over HTTP.          |
| EWS `ExchangeImpersonation` header, alice naming bob                                                                                                      | `500`, `ErrorImpersonationDenied`, "The account does not have permission to impersonate."    |
| A wrong password                                                                                                                                          | `401` with `Connection: close`.                                                              |

Source: the Exchange decoding (`http/src/auth/authenticate.rs:199-229`: Windows-1252 fallback, `DOMAIN\` stripped, `account%master` kept), the recovery admin's master path (`common/src/auth/authentication.rs:144-194`), master users needing `Impersonate` (`:333-352`), `Impersonate` granted to superusers only (`common/src/auth/permissions.rs:299-302`), the EWS header check (`exchange/src/ews/impersonation.rs:57-67`) `[src]`.

**Design consequence.** The front must refuse `%` itself: the recovery admin is checked before any directory, so the bind token never sees it. It must also never forward a login the projection does not know, which the IMAP front does (`services/authd/README.md`, "Outside the token design"), because over HTTP there is no session for a scanner to watch afterwards.

### 2.2 Switching accounts on one connection

`keepalive.sh`: three EWS requests on one TCP connection (`curl --next`, `num_connects` 1, 0, 0).

| Request on the reused connection | Inbox `FolderId`   | Status |
| -------------------------------- | ------------------ | ------ |
| 1, as alice                      | `AQEBAAA=`         | 200    |
| 2, as bob                        | `AQECAAA=` (bob's) | 200    |
| 3, as alice again                | `AQEBAAA=`         | 200    |

HTTP has no signed-in connection: each request is its own sign-in, and a client switches accounts by changing the header. This is the HTTP form of the IMAP attack class, and it decides the shape of the front: **attribution is per request.** Stalwart's per-account state is bound to the account the request signed in as, so a second account cannot borrow the first one's:

- MAPI over HTTP: the `MapiContext` cookie carries an account id and is refused (`ContextNotFound`) for any other (`exchange/src/mapi/http.rs:215-227`) `[src]`.
- EWS subscriptions: looked up by (account, id) (`exchange/src/ews/notify/mod.rs:301-308`) `[src]`. `[probe]`: carol presenting dave's subscription id got `ErrorInvalidSubscription`.
- EAS devices: keyed by (account, `DeviceId`) (`exchange/src/eas/mod.rs:154-156`) `[src]`. The `User=` query parameter must be present but does not choose the account (`exchange-proto/src/eas/http.rs:283-285`) `[src]`.

### 2.3 Stalwart's HTTP auth cache with an LDAP directory

`ldapcache.sh`, as dave on `ldap.test`. glauth was restarted after each change to its file, because its hot reload did not follow an in-place edit (the first run's numbers are discarded for that reason). "Binds" counts glauth's `Bind request ... cn=dave` lines.

| Step                                | Same header as at sign-in | Binds  |
| ----------------------------------- | ------------------------- | ------ |
| Sign in                             | 200                       | +1     |
| Same header again                   | 200                       | **+0** |
| Password changed in the directory   | **200**                   | +0     |
| The new password, new header        | 200                       | +1     |
| dave **deleted** from the directory | **200**                   | +0     |
| `x:Action` `InvalidateCaches`       | 401                       | +0     |

A changed password and a deleted account both stayed signed in, with no bind at all, until the server-wide `InvalidateCaches`. That matches the source: the cache is keyed on the `Authorization` value (`http/src/auth/authenticate.rs:50-77`), lives `min(expires_in, accessTokenExpiry)` (`:126-141`, default one hour, `registry/src/schema/structs_impl.rs:56333-56339`), and a hit only re-checks the account's revision inside Stalwart, which an LDAP directory never moves. `InvalidateCaches` clears every entry for every account (`common/src/cache/http_auth.rs:131-134`), so it is no tool for revoking one person. For contrast, on the internal directory a password change dropped the cached header at once `[probe]`, because there the revision moves.

### 2.4 Long-lived requests across a revocation

`revoke.sh <mode>` holds three requests open as dave: an EAS Ping (`eas.py`, heartbeat 120 s, after FolderSync and an inbox Sync), an EWS `GetStreamingEvents` (connection timeout 3 minutes) and a JMAP EventSource. Six seconds later dave is deleted from the directory. Four seconds after that, an EWS `CreateItem` into dave's inbox is sent with dave's original header.

| What happened                          | `directory`: dave deleted                                              | `invalidate`: deleted, then `InvalidateCaches`       |
| -------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `CreateItem` with the old header, +4 s | **Success**: written after the revocation                              | 401                                                  |
| A new header form (`X\dave@ldap.test`) | 401                                                                    | 401                                                  |
| `GetFolder` with the old header, +80 s | **Success**, `TotalCount` 1 (reads what it wrote)                      | 401                                                  |
| EAS Ping                               | Ended at the write with status 2 (changes), then FolderSync 200        | **Held 120 s** to its heartbeat (status 1), then 401 |
| EWS stream                             | Delivered the `CreatedEvent` (19:46:17Z), keep-alives, closed at 180 s | **Held 180 s** with keep-alives                      |
| JMAP EventSource                       | Pushed the `StateChange`, then pinged until curl gave up at 200 s      | **Pinged until 200 s**                               |

Nothing in Stalwart ends a request that is already open. JMAP's EventSource and WebSocket re-read only Stalwart's own copy of the account at each event (`jmap/src/api/event_source.rs:130-142`, `jmap/src/websocket/stream.rs:97-108`) `[src]`, and the Exchange waits re-check nothing. So the front must end them, and its own registry is the only thing that can. Not probed: whether a held stream keeps delivering new events after `InvalidateCaches` (nothing wrote to the mailbox in that run). The design does not depend on it.

### 2.5 Free/busy and the address book across customers

`freebusy.sh`: dave (`ldap.test`) books 10:00 to 11:00Z, then erin (`other.test`, standing in for another customer) and carol (dave's colleague) ask EWS `GetUserAvailability` for dave.

| `Calendar.shareFreeBusy` | erin (another domain) | carol (same domain) |

| Mail rules and Sieve: forwarding and redirecting outside | off, **with the upgrade** (section 11)          | `[unproven]` which settings do it for both `x:MailRule` actions and users' own scripts (for example the Sieve interpreter's redirect limits); PR 1 finds and probes them. |
| -------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, the 1.2.0 default                                | **`Busy` 10:00 to 11:00**, `MergedFreeBusy` set | the same                                                                                                                                                                  |
| `false`                                                  | `ErrorNoFreeBusyAccess`                         | `ErrorNoFreeBusyAccess`                                                                                                                                                   |

The subject was not returned. The busy times were. The default is `true` (`registry/src/schema/structs_impl.rs:9877`) and with no tenants it covers "every account on the server" `[doc]`; tenants are behind the `enterprise` feature (`common/src/auth/access_token.rs:588-591`) `[src]`. `shareFreeBusy` is new in 1.2.0 and applies to JMAP and CalDAV availability as well, so **the 1.2.0 upgrade itself turns it on**. With `allowDirectoryQueries` false (the default, `structs_impl.rs:64759-64765`), erin's `ResolveNames("dave")` returned `ErrorNameResolutionNoResults` `[probe]`.

### 2.6 Autodiscover

| Request                                                                   | Answer                                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| POX, anonymous                                                            | 401 Basic                                                                                                                                             |
| POX as alice, `X-MapiHttpCapability: 1`                                   | `mapiHttp` with `/mapi/emsmdb/?MailboxId=<guid>@probe.test` and `/mapi/nspi/...`, plus IMAP 993, POP3 995 and SMTP 465 from `SystemSettings.services` |
| POX as alice, asking for bob's address                                    | Error 500, "The email address can't be found."                                                                                                        |
| Mobile sync schema as alice                                               | `MobileSync` URL `.../Microsoft-Server-ActiveSync`                                                                                                    |
| JSON v2, anonymous, for dave, a non-existent address and a foreign domain | The same fixed URL for all three: no existence oracle                                                                                                 |
| Session URLs (JMAP, and Autodiscover's) with a different `Host` header    | Always built from `STALWART_PUBLIC_URL`, never from `Host`                                                                                            |

### 2.7 Autodiscover as each client asks for it

`autodiscover.sh` sends every form an Exchange client uses, with `Host: autodiscover.customer-domain.test` as it would arrive on a customer's `autodiscover` name. It runs against a fresh Stalwart 1.2.0 (same image) with `STALWART_PUBLIC_URL=https://mail.i10.test` and one internal account, `someone@customer-domain.test`, which also has the alias `sales@`. (`.example` was refused as a domain name, "Invalid domain name", so the probe uses `.test`.) Raw output: `results/autodiscover.txt`.

| #   | Request (client)                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | POX, Outlook schema, no credentials (classic Outlook's first try)                                                                                                | `401`, `WWW-Authenticate: Basic realm="Stalwart Server"`                                                                                                                                                                                                                                                    |
| 2   | POX with `X-MapiHttpCapability: 1` (classic Outlook), at `/autodiscover/autodiscover.xml`, `/Autodiscover/Autodiscover.xml` and `/AutoDiscover/AutoDiscover.xml` | All three the same: `Action settings`, `Protocol Type="mapiHttp"`, `https://mail.i10.test/mapi/emsmdb/?MailboxId=<guid>@customer-domain.test` and `/mapi/nspi/...`, plus IMAP, POP3 and SMTP on `mail.i10.test` (POP3 because this probe kept Stalwart's default `services`; prod lists only IMAP and SMTP) |
| 3   | POX without the MAPI header (EWS clients that use POX)                                                                                                           | `EXCH` and `EXPR` with `EwsUrl` and `ASUrl` `https://mail.i10.test/EWS/Exchange.asmx`                                                                                                                                                                                                                       |
| 4   | POX for the alias `sales@`, signed in as `someone@`                                                                                                              | Settings for the same mailbox, `AutoDiscoverSMTPAddress` `sales@customer-domain.test`                                                                                                                                                                                                                       |
| 5   | POX with `SOMEONE@Customer-Domain.test` as the login and the address                                                                                             | Same as row 2, address normalised to `someone@customer-domain.test`                                                                                                                                                                                                                                         |
| 6   | Mobile sync schema (iPhone and Android), with an iPhone User-Agent                                                                                               | `MobileSync`, `https://mail.i10.test/Microsoft-Server-ActiveSync`                                                                                                                                                                                                                                           |
| 7   | JSON in the query form Microsoft redirects an iPhone to: `?Email=...&Protocol=ActiveSync&RedirectCount=1`                                                        | `200`, `{"Protocol":"ActiveSync","Url":"https://mail.i10.test/Microsoft-Server-ActiveSync"}`, with no credentials                                                                                                                                                                                           |
| 8   | JSON v1.0 path form (Outlook for Mac), `Protocol=AutodiscoverV1`, `Ews`, `ActiveSync`                                                                            | `200` each. **`AutodiscoverV1` answers `https://mail.i10.test/autodiscover/autodiscover.xml`**, a different host from the one asked                                                                                                                                                                         |
| 9   | SOAP `GetUserSettings` at `autodiscover.svc`                                                                                                                     | `NoError`, `ExternalEwsUrl` `https://mail.i10.test/EWS/Exchange.asmx`                                                                                                                                                                                                                                       |
| 10  | `GET` with credentials                                                                                                                                           | Error `600`, "Invalid Request"                                                                                                                                                                                                                                                                              |
| 11  | `someone@` asking for `bob@`'s settings                                                                                                                          | Error `500`, "The email address can't be found."                                                                                                                                                                                                                                                            |

What this proves: Stalwart serves every request form all four target clients send, on any host name, with endpoints that are always on the public URL's host. What it changes: row 8 is why the front answers JSON Autodiscover itself (4.3). What it cannot prove: what each client does with these answers. That needs the real clients, which are in PR 5 and marked `[unproven]` in section 4. Not probed here: TLS and certificates. The probe is plain HTTP on loopback, and Traefik terminates TLS in production.

---

## 3. The HTTP front

### 3.1 Where it runs, and why there

```
client ─TLS─▶ Traefik :443 ──HTTP/1.1──▶ podIP:8090  mailfront (http listener) ──HTTP──▶ 127.0.0.1:8081  Stalwart `exchange` listener
                (wildcard, plus one         (NetworkPolicy:                            (new loopback listener,
                 autodiscover.<domain>       Traefik only)                              trusts X-Forwarded-For from loopback)
                 certificate per domain)

in-cluster callers (API with x:ApiKey, apply hook) ──▶ :8080 Stalwart `http`, unchanged, no longer reachable from Traefik
```

A third listener in `cmd/mailfront`, in both Stalwart pods (edge and internal):

- **It shares everything the boundary needs, and nothing else.** The registry, the sweep (`internal/mailfront/sweep.go`), `admit` and `Grant` (`grant.go`), `projection.AccountByLogin`, the `mailfront` database role and the bind token key are what IMAP already uses. A second binary would run a second sweep over the same accounts: the sweep's cost adds up per front (`docs/research/mail-device-binding.md`, "Mail front scale"). A revocation also has to close a person's IMAP and Exchange sessions together, which one registry does by construction.
- **The threat profile is the one the front was split from authd for**: bytes from anyone, before sign-in, in a process that holds no Clerk key, no `AUTHD_API_SECRET` and no LDAP secret. Go's `net/http` and `httputil.ReverseProxy` do the parsing. The front writes no parser of its own for HTTP, SOAP, WBXML or MAPI.
- **Not a Traefik `forwardAuth`.** It could rewrite the header at the start of a request, but it cannot end a request that is already open, and 2.4 shows that a revocation needs exactly that.
- **TLS stays at Traefik**: 443 on psl-vps is Traefik's, and Traefik already holds the wildcard and is where cert-manager's certificates are served. The front speaks plain HTTP to Traefik inside the pod network, as Stalwart's 8080 does today.
- **A new loopback Stalwart listener** (`exchange` on `127.0.0.1:8081`) instead of putting the front in front of 8080. 8080 keeps serving the API's `x:ApiKey` calls and the apply hook, which must not depend on the front. Traefik loses access to it, and Bulwark's entry goes with Bulwark (`stalwart-http-clients` in `networkpolicy.yaml`), so the only way from the internet to Stalwart's HTTP is through the front.
- **JMAP for any client, not for one webmail.** The front serves JMAP, its EventSource and its WebSocket to whatever JMAP client signs in with Basic, and closes them on revocation like every other request. i10's own webmail, when it is built on JMAP through the API, is one more such client and needs nothing of its own here. `Http.clientIpSource: xForwardedFor` with one hop is kept, and the front writes exactly one `X-Forwarded-For` value.

⚠ Stalwart skips its endpoint access check for loopback peers (`http/src/request.rs:145-150`) `[src]`. Every request from the front arrives from loopback, so that check never applies to it. The front's allowlist (3.4) replaces it, which is one more reason the allowlist is not optional.

**Routing between the two nodes.** EWS subscriptions live in the memory of the node that created them `[doc]`, and Apple Calendar resubscribes only after about three minutes `[doc]`. The Exchange paths (`/EWS`, `/mapi`, `/Microsoft-Server-ActiveSync`, `/OAB`, `/autodiscover`) go to a Service that selects the edge pod only, and JMAP to both, as today. Spreading Exchange over both nodes needs cookie affinity through Traefik, unprobed (section 11, question 4).

### 3.2 Attribution, per request

For every request:

1. **Path and method allowlist** (3.4). Anything else gets `404` from the front and is never forwarded.
2. **Anonymous paths** (JSON Autodiscover, `/mail/config-v1.1.xml`, `/.well-known/autoconfig/`, `/.well-known/mta-sts.txt`) are forwarded with any `Authorization` removed. On every other allowed path, a request with no `Authorization` gets the front's own `401` with `WWW-Authenticate: Basic realm="i10"` and nothing else: Outlook and the Apple clients fail on a challenge that offers a scheme they cannot complete `[doc]`.
3. **Only `Basic`.** `Bearer`, `NTLM`, `Negotiate` or anything else gets the same `401` and is not forwarded. A bearer token is checked by Stalwart alone, so it would sign in without a bind token, as on IMAP.
4. **Decode as Stalwart does in Exchange mode, then refuse where the two could differ.** Base64, then UTF-8, else Windows-1252 (`authenticate.rs:200-203`), split at the first `:`, drop up to the last `\`, trim, lowercase. Refused with `401`: a login containing `%`, one without `@` (Stalwart would add its default domain), an empty login or password, any control character, and a header longer than 8 KiB.
5. **Look the login up** with `projection.AccountByLogin` (primary address, as authd's `filterLogin` does), then `admit()` from `grant.go`. On an Exchange or DAV path, a Free account is refused here with `403` (section 11), and so is an account the gate refuses. No row, or a row the gate refuses: `401` from the front, nothing forwarded. That is how a Stalwart recovery admin login ends. A failed lookup: `503` with `Retry-After: 30`, so clients retry instead of asking for a password ("the one rule", `services/authd/README.md`).
6. **Rebuild the header.** `Authorization: Basic base64(utf8(<the row's primary address> ":" <i10hf1 token for the row's user id> "." <password>))`. The client's login spelling never reaches Stalwart, only an address the front read from the row.
7. **Forward** with Go's reverse proxy, flushing at once (`FlushInterval: -1`), because EWS streaming sends each notification as part of one long response `[doc]`.

**The attribution cache.** Steps 4 to 6 run once per credential, not once per request. The key is an HMAC under a per-process key of the client's raw `Authorization` value. The value is the Grant, the rebuilt header and when it was minted. A hit costs no database query. An entry is:

- registered in the sweep registry, so the sweep that revokes the account deletes the entry and cancels its requests (3.3);
- re-minted (a new token, so a new header) every 5 minutes;
- dropped after 10 minutes unused, and at the Grant's `Until` for a pass-through account (`MAILFRONT_PASSTHROUGH_MAX_AGE`, as on IMAP);
- dropped when Stalwart answers `401` to the header it built (a wrong password), so the next request looks the login up again.

This adds no attack surface. A client cannot reach an entry without sending the exact `Authorization` value that made it, and the upstream request still carries the client's password, which authd checks at Stalwart's bind.

### 3.3 Stalwart's HTTP auth cache and the new token

**Why the cache is no longer a revocation hole.** 2.3 shows a cached header outliving a deleted account. Behind the front, every `Authorization` value Stalwart has cached was built by the front, carries a token for one user id, and is sent only by the front, only while that user's Grant is live. After a revocation the front never sends it again, and no client can produce it, because the token's MAC key is in the front. The cached entry becomes unreachable state. `OidcProvider.accessTokenExpiry` is still set to its minimum, 10 minutes (validated at `registry/src/schema/structs_impl.rs:56218-56226`), as defence in depth against a front bug. Nothing in i10 uses Stalwart-issued OAuth tokens (the API uses `x:ApiKey`), so nothing else is affected.

**Why the 60-second token does not fit HTTP.** authd refuses a token whose expiry is more than `TTL + skew` = 65 s away (`internal/bindtoken/bindtoken.go:197`). Stalwart binds only on a cache miss, and the front cannot see a miss. So with the IMAP token the front would have to re-mint about every 30 s or risk Stalwart binding with an expired token after evicting the entry, which answers `401` and makes the client prompt. Each re-mint is a new header, so a cache miss and a bind. On the Clerk lane that bind is answered from authd's credential cache. On the LDAP pass-through lane authd caches nothing (`verify.CacheLimit`), so it would be a real bind to the customer's Active Directory twice a minute per phone. That is 120 an hour, against 4.2 an hour per IMAP connection today.

**So: a second token kind for the HTTP front.**

| Kind      | Prefix    | MAC domain label                  | Lifetime | Re-minted        |
| --------- | --------- | --------------------------------- | -------- | ---------------- |
| IMAP/SMTP | `i10mf1.` | `i10-mailfront-bind-token/v1\x00` | 60 s     | once per sign-in |
| HTTP      | `i10hf1.` | `i10-httpfront-bind-token/v1\x00` | 10 min   | every 5 min      |

`Unwrap` takes the kind from the prefix and applies that kind's cap. The label keeps either kind from ever verifying as the other. The longer life costs little: a token only travels over loopback inside the pod, and replaying one still needs the password behind it. What it buys: about 12 binds an hour per active credential. On the LDAP lane that is 12 directory sign-ins an hour per device, which a company can trade against its window by raising `MAILFRONT_PASSTHROUGH_MAX_AGE`, as on IMAP.

### 3.4 What it forwards, and what it refuses

| Path (case-insensitive where Stalwart is)                                                                | Methods       | Auth  | Notes                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `/EWS/Exchange.asmx`                                                                                     | POST          | Basic | Streaming responses flushed at once                                                                                |
| `/mapi/emsmdb/`, `/mapi/nspi/`                                                                           | POST          | Basic | Cookies `MapiContext`, `MapiSequence` passed (`exchange-proto/src/mapi/http.rs:317-318`)                           |
| `/Microsoft-Server-ActiveSync`                                                                           | POST, OPTIONS | Basic | Query parsed for `DeviceId`/`DeviceType` (section 5)                                                               |
| `/OAB/...`                                                                                               | GET           | Basic | Empty while `allowDirectoryQueries` is off `[doc]`                                                                 |
| `/autodiscover/autodiscover.xml`, `/autodiscover/autodiscover.svc`                                       | POST          | Basic | Anonymous POX gets the front's 401                                                                                 |
| `/autodiscover/autodiscover.json...`, both forms                                                         | GET           | none  | **Answered by the front itself** (4.3): `AutodiscoverV1` names the host the request came to, never `mail.i10.tech` |
| `/jmap/`, `/jmap/session`, `/jmap/upload/`, `/jmap/download/`, `/jmap/eventsource/`, `/.well-known/jmap` | as JMAP needs | Basic | Any JMAP client, i10's own webmail later                                                                           |
| `/jmap/ws`                                                                                               | GET + Upgrade | Basic | The upgraded connection stays in the registry for its life                                                         |
| `/dav/...`, `/.well-known/caldav`, `/.well-known/carddav`                                                | DAV methods   | Basic | Ships with Exchange (section 11); refused for Free accounts                                                        |
| `/calendar/rsvp`                                                                                         | GET           | none  | The iTIP RSVP page, which ships with Exchange (section 11)                                                         |
| `/mail/config-v1.1.xml`, `/.well-known/autoconfig/...`, `/.well-known/mta-sts.txt`                       | GET           | none  | Moved from the direct Traefik routes, so every public byte to Stalwart passes one place                            |

**Refused, 404 from the front, never forwarded:** `/api/...` (the management API), `/login`, `/device`, `/auth/...` (Stalwart's OAuth endpoints), `/.well-known/oauth-*`, `/.well-known/openid-configuration`, `/scim`, `/form`, `/metrics`, `/healthz`, `/logo`, the WebUI's assets and application prefixes, and everything not listed.

**Headers.** The client's `Authorization`, `Forwarded`, `X-Forwarded-*` and `X-Real-IP` are removed. `X-Forwarded-For` is set to the one client address, taken from the last hop Traefik wrote (the front accepts connections from Traefik only). Only the three cookies above go upstream. `Upgrade` is passed only on `/jmap/ws`. Other headers pass. No header but `Authorization` chooses the account: the rest only reach handlers for the account the bind proved (2.2), and EWS's `ExchangeImpersonation` needs a permission no i10 role has (2.1).

### 3.5 Ending requests on revocation

Every request in flight is added to the registry under its entry's Grant. Its close function cancels the request's context, which aborts the upstream request (Stalwart sees the disconnect), and closes the downstream connection (`panic(http.ErrAbortHandler)`, which `net/http` turns into a closed connection). The sweep already runs once a second, closes on every reason in `grant.go` (gate refusal, `credential_epoch`, `clerk_updated_at`, route change, row gone) and on the pass-through max age, and adds nothing to the database when no request is open.

| Long-lived request              | How long Stalwart holds it                                                             | Closed by                           |
| ------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| EAS Ping, and Sync with Wait    | Up to `maxHeartbeat`, default and maximum 59 min `[src]` `structs_impl.rs:36521-36531` | the sweep, within its interval      |
| EWS `GetStreamingEvents`        | The client's timeout, capped at the heartbeat and at 30 min `[doc]`                    | the sweep                           |
| MAPI over HTTP NotificationWait | At most 5 min `[doc]` `[unproven]`                                                     | the sweep                           |
| JMAP EventSource                | Indefinitely (2.4)                                                                     | the sweep                           |
| JMAP WebSocket                  | Indefinitely                                                                           | the sweep (the hijacked connection) |

After the close, the client's next request finds no entry (the sweep deleted it), looks the login up, is refused by the gate and gets `401`, which is what authd's `invalidCredentials` gives an IMAP client in the same case.

`[unproven]` That Traefik aborts the client's response when the front closes its connection mid-response, for HTTP/1.1 and HTTP/2 clients alike. PR 2 measures it with the probe in 2.4. If Traefik turns out to hold the client's side open, the fallback is TLS passthrough for the Exchange host names, with the front terminating TLS itself.

`[unproven]` Traefik's timeouts for an hour-long Ping: its entry point's read timeout applies to reading the request (a Ping body is small), and its idle timeout must exceed `maxHeartbeat`, or devices fall back to frequent reconnects `[doc]`. PR 2 checks the psl repo's Traefik values.

## 4. Autodiscover: the address and the password, and nothing else

**The bar** (owner, 2026-11-23): a person on a hosted domain, say `someone@customer-domain.example`, opens classic Outlook, Outlook for Mac, iPhone Mail (Exchange account) or an Android Exchange account. They type their address and their usual password, and everything configures itself, with no server names, ports or protocol choices, and no certificate or "allow this website to configure" warnings.

### 4.1 What the bar rests on

- **One lookup is both universal and silent: `https://autodiscover.<domain>/autodiscover/autodiscover.xml`, under a certificate for that exact name.** Every client below tries it. Both of the other lookups we could serve give a warning in both Outlooks:
  - the HTTP redirect method, where classic Outlook asks "Allow this website to configure ... server settings?" (Microsoft, KB 2480582);
  - the SRV record, which shows the same prompt in classic Outlook (`[unproven]` on current builds; reported widely, and hosted Exchange providers document it);
  - any Autodiscover redirect in Outlook for Mac, which asks "Outlook was redirected to the server ... Do you want to allow this server to configure your settings?" (Microsoft, KB 3206915).

  Android does not read SRV at all (4.2). So the CNAME and a per-domain certificate are the design itself, not a later phase.

- **The root-domain lookup is the customer's website, not ours.** Every client tries `https://<domain>/autodiscover/autodiscover.xml` early. A website without a valid certificate for the bare domain makes classic Outlook show a certificate alert, and makes some phones give up and ask for server settings (Practical365, "Fixing Autodiscover root domain lookup issues"). i10 cannot fix that, so it checks it and tells the admin (4.4).
- **Classic Outlook and the iPhone ask Microsoft first.** Outlook 2016 and later try "Direct Connect to Microsoft 365" before any of our records (Microsoft, "Unexpected Autodiscover behavior"). It intercepts setup with a Microsoft sign-in window ("Tell us the account you want to use to open autodiscover.xml") when the domain is still verified in a Microsoft 365 tenant, or when a Microsoft account, personal ones included, uses the same address (OVHcloud's hosted Exchange documentation, which hits the same problem). i10 checks the first and tells the person about the second (4.4).
- **"Their usual password" holds for Clerk accounts.** For an account an SSO connection manages, it holds only on a pass-through lane: the company's LDAP directory, or an OIDC provider with a password grant (`services/authd/README.md`). An Entra or Google Workspace connection has no lane, so its people have no password an Exchange client can send, and they need a device code. That falls short of the bar, which is open question 9.

### 4.2 Each client, in the order it looks

| Client                                                                               | What it looks up, in order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Silent path                                                                                         | Paths that warn or stall                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Classic Outlook for Windows** (2016, 2019, 2021, LTSC 2024, Microsoft 365 apps)    | Microsoft's list: Direct Connect to Microsoft 365 (16.0.6741 and later); the SCP in Active Directory (domain-joined machines only); HTTPS root domain; **HTTPS `autodiscover.<domain>`**; a local XML file (only if configured); the HTTP redirect method; the SRV record; the cached URL from an earlier profile (Microsoft, "Unexpected Autodiscover behavior"). Then a Windows credential prompt with the address filled in, where the person types the password.                                                                                                                                                                                                                                                                    | Step 4: POX to `autodiscover.<domain>` (2.7, rows 1 to 5).                                          | Direct Connect intercept (Microsoft 365 tenant or Microsoft account with that address). Root domain with a bad certificate (certificate alert, `[unproven]` exact dialog) or one that answers `401` (a password prompt for the website). HTTP redirect and SRV (redirect prompt), reached only if step 4 failed. |
| **Outlook for Mac**                                                                  | JSON Autodiscover first, then the POX form it points to `[doc]`. Whether it asks Microsoft first, and its exact host order, are `[unproven]`. The App Store build refuses on-premises accounts unless activated with a Microsoft 365 licence `[doc]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | JSON and POX on `autodiscover.<domain>`, with `AutodiscoverV1` answered on the **same host** (4.3). | Any redirect to another Autodiscover server (KB 3206915). Stalwart's own JSON answer names `mail.i10.tech` (2.7, row 8), so the front answers JSON itself. Without a licence, the account cannot be added at all.                                                                                                |
| **iPhone and iPad Mail** (Exchange account)                                          | After the address, iOS may ask "Sign in to your '<domain>' Exchange account using Microsoft?" with **Configure Manually** and **Sign In** (Ivanti's analysis of iOS 11; `[unproven]` whether iOS 27 asks for a domain Microsoft does not know). **Sign In**: iOS asks `outlook.office365.com`'s JSON Autodiscover, and for a mailbox not in Microsoft 365, Microsoft answers `302` to `https://<the domain's autodiscover host>/autodiscover/autodiscover.json?Email=...&Protocol=ActiveSync&RedirectCount=1` (Ivanti). iOS then expects an OAuth challenge. **Configure Manually**: the password, then POX in the mobile sync schema, on the root domain and on `autodiscover.<domain>` (`[unproven]` order and whether SRV is tried). | POX mobile sync on `autodiscover.<domain>` (2.7, row 6). The JSON query form also answers (row 7).  | The Microsoft question itself. On the Sign In path, our `401` offers only Basic, and whether iOS then falls back to a password field is `[unproven]`. A bad root-domain certificate (some phones stop and ask for a server). The enrollment profile (section 5) avoids all of this.                              |
| **Android Exchange** (Gmail, Samsung Email; AOSP Exchange)                           | `https://<domain>/autodiscover/autodiscover.xml`, then `https://autodiscover.<domain>/autodiscover/autodiscover.xml`. It follows an HTTPS `302`, and never reads SRV: "this would require additional DNS lookup services that are not currently available" (AOSP `EasAutoDiscover.java`). Gmail's current client is `[unproven]` to match AOSP. It needs a certificate from a public authority `[doc]`.                                                                                                                                                                                                                                                                                                                                 | POX mobile sync on `autodiscover.<domain>` (2.7, row 6).                                            | A bad root-domain certificate (Practical365). `[unproven]`: whether Gmail shows its "remote security administration" screen when Stalwart answers `Provision` with a policy that requires nothing `[doc]`. That is a device probe in PR 5.                                                                       |
| macOS Mail, Calendar, Contacts (Exchange account; not on the owner's list, included) | "Sign in to your Exchange account using Microsoft?", where the user must choose **Configure Manually** `[doc]`, then Autodiscover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `autodiscover.<domain>` (2.7, rows 3 and 9).                                                        | The Microsoft question. The enrollment profile avoids it.                                                                                                                                                                                                                                                        |

### 4.3 What i10 publishes and serves for every hosted domain

**DNS**, in `receivingRecordsFor` (`apps/api/src/domains/records.ts`) beside the MX and the `_imaps._tcp` / `_submissions._tcp` SRV records. It lives in the customer's parent zone, and the DNS publisher writes it where we hold a credential:

```
autodiscover.<domain>.  CNAME  autodiscover.i10.tech.
```

Nothing else:

- **No `_autodiscover._tcp` SRV.** It warns in both Outlooks, Android never reads it, and it would only turn a broken CNAME into a prompt, hiding the fault the readiness check (4.4) should report.
- **Nothing at the apex.** It is the customer's website.

A domain that already has `autodiscover` pointing at `autodiscover.outlook.com` (a Microsoft 365 customer) is a conflict, which the publisher already refuses to overwrite silently (`apps/api/src/dns/publish.ts`). The console shows it, and the customer confirms at cutover (section 7).

**Certificates.** A publicly trusted certificate for `autodiscover.<domain>` on every hosted domain, from Let's Encrypt through cert-manager with HTTP-01 (`letsencrypt-prod`, the issuer of the wildcard):

- A reconciler CronJob with its own ServiceAccount and a Role limited to `certificates.cert-manager.io` and Traefik `IngressRoute` in `i10-prod` creates the `Certificate` once the CNAME resolves to us, and adds the name to the front's route once it is issued. The API pod never gets write access to routes, which would let it route any host anywhere.
- Renewal is cert-manager's. One certificate per registered domain every 60 days is far inside Let's Encrypt's 50 per registered domain per week.
- Port 80 on `autodiscover.<domain>` serves the ACME challenge and nothing else. Outlook's HTTP redirect step turns a redirect there into a prompt. `[unproven]` that the psl repo's Traefik does not redirect port 80 to HTTPS for these hosts globally.
- Before its certificate exists, Traefik presents its default certificate for that name, and the clients warn about the mismatch. The readiness check (4.4) keeps anyone from being told to set up in that window. `[unproven]` whether Traefik can refuse the handshake for those names instead (`sniStrict`) without changing the psl repo's shared default.

**What the front answers on `autodiscover.<domain>`**, proved against Stalwart in 2.7:

| Request                                                                                                                    | Answered by                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POX, Outlook and mobile sync schemas, any capitalisation of the path                                                       | Stalwart, through the front. It ignores the `Host` and builds every URL from `STALWART_PUBLIC_URL` (rows 2 to 6).                                                                                                                                                                                                                                                                                    |
| POX without credentials                                                                                                    | The front: `401`, `WWW-Authenticate: Basic realm="i10"`, which is what makes the client ask for the password (row 1).                                                                                                                                                                                                                                                                                |
| SOAP `autodiscover.svc`                                                                                                    | Stalwart (row 9).                                                                                                                                                                                                                                                                                                                                                                                    |
| JSON, both the path form (`/autodiscover.json/v1.0/<address>?Protocol=...`) and the query form (`?Email=...&Protocol=...`) | **The front itself**, with no Stalwart call: `AutodiscoverV1` gives `https://<the request's host>/autodiscover/autodiscover.xml`; `Ews` and `ActiveSync` give the `mail.i10.tech` endpoints. Stalwart's own `AutodiscoverV1` names `mail.i10.tech` (row 8), another server, which is what Outlook for Mac warns about. The answer is fixed, so it reveals nothing about which addresses exist (2.6). |
| `GET` with credentials                                                                                                     | Stalwart's error `600` (row 10), which is harmless.                                                                                                                                                                                                                                                                                                                                                  |

The endpoints in every answer are on `mail.i10.tech`, under the wildcard. A client connects to them as protocol endpoints, not as an Autodiscover redirect, which is how every hosted Exchange is laid out (`[unproven]` for Outlook for Mac). `STALWART_PUBLIC_URL` is set to `https://mail.i10.tech` explicitly (PR 4).

### 4.4 Readiness: i10 checks before anyone is told to set up

The console shows a domain as "Outlook and phones: ready" only when checks 1 to 3 pass. It runs them when the domain is added, every hour, and on demand:

1. **DNS:** `autodiscover.<domain>` resolves through the CNAME to `autodiscover.i10.tech`, from public resolvers.
2. **TLS:** a handshake with SNI `autodiscover.<domain>` presents a certificate for that name that chains to a public root.
3. **The front:** an anonymous POX `POST` there answers `401` with the front's own `Basic realm="i10"`. That proves nothing in between (a customer's proxy, Cloudflare's orange cloud) answers in its place.

Checks 4 and 5 cannot block readiness, because they are about the customer's systems. They warn the admin, with the fix:

4. **The root domain:** a `POST` to `https://<domain>/autodiscover/autodiscover.xml`, with a 10-second timeout.
   - Fine: no address, connection refused, or a valid certificate and any answer other than `401`.
   - Warned: a certificate that does not match or is not trusted ("Outlook will show a certificate warning and some phones will ask for server settings: give the website a valid certificate, or have it redirect `/autodiscover/` to `https://autodiscover.<domain>/autodiscover/autodiscover.xml`"; whether Outlook follows that redirect silently is `[unproven]`); a `401` (Outlook asks for a password for the website); slower than 10 s (setup appears to hang).
5. **Microsoft 365:** Microsoft's public realm lookup for the domain, with a fixed local part and never a person's address (`https://login.microsoftonline.com/getuserrealm.srf?login=autodiscover-check@<domain>&json=1`). `NameSpaceType` `Managed` or `Federated` means a tenant still claims the domain, and Outlook will open a Microsoft sign-in instead of finding i10. The fix is to remove the domain from that tenant, which is a step of the cutover (section 7). `[unproven]` that this is the signal Direct Connect uses. The other trigger, a personal Microsoft account with the same address, can only be checked per person. The person's own "Add to Outlook" page offers it as a check they start, saying that it asks Microsoft about their address, with the fix: change that Microsoft account's sign-in address (OVHcloud's documentation). Outlook's registry value `ExcludeExplicitO365Endpoint` is the last resort, for machines an IT department manages.

### 4.5 What the console tells people

On each mailbox, one page, "Set up on a device", without server names:

- **Classic Outlook on Windows:** "Choose File, Add account, type your address, then your password." One line, shown only if check 5 warned: what the Microsoft sign-in window means and what to do.
- **iPhone and iPad:** "Settings, Mail, Accounts, Add Account, Microsoft Exchange. Type your address. If it asks whether to sign in using Microsoft, choose Configure Manually, then type your password." The Configure Manually line stays only until PR 5's device probe shows whether iOS still asks for a domain Microsoft does not know, and whether Sign In works without it. Beside it, "Or install the i10 profile", the enrollment of section 5, which needs no typing at all.
- **Android:** "Add an Exchange account in Gmail or Samsung Email, type your address and your password."
- **Outlook for Mac:** the same as Windows, with "needs a Microsoft 365 subscription activated in Outlook" stated up front.

**The clients that cannot work**, and why, on the same page:

- **The new Outlook for Windows** (the "New Outlook" toggle, and the default mail app on recent Windows) does not support on-premises Exchange accounts at all (Microsoft, "supported account types", quoted in Stalwart's 1.2.0 announcement). It does offer to add the account as IMAP, but then Microsoft's cloud connects to i10 on the person's behalf, keeps the password, and every message passes through Microsoft (heise and c't, 2023, cited by Stalwart).
- **Outlook for iPhone and Android** reach mailboxes outside Microsoft 365 through a Microsoft cloud service, which needs a hybrid Exchange Online setup `[doc]`.

Draft copy: "The new Outlook for Windows and the Outlook app for iPhone and Android can't connect to i10. Microsoft built them to work through Microsoft's own cloud. If they offer to add your account another way, for example as IMAP, choose not to: Microsoft's servers would keep your password and read your mail for you. Use classic Outlook (turn off New Outlook at the top of the window), or your phone's own Mail app." Whether i10 should also refuse IMAP sign-ins that come from Microsoft's sync service is open question 10.

---

## 5. Device codes (#383) and Exchange accounts

**iPhone and iPad.** The enrollment in `docs/research/mail-device-binding.md` section 4 ends with an encrypted profile. For an Exchange account its payload is `com.apple.eas.account` with `EmailAddress`, `Host: mail.i10.tech`, `SSL: true`, `UserName` and `Password` (the sealed device code), and `OverridePreviousPassword` on re-enrollment `[apple]`. `Password` is documented "only with encrypted profiles" `[apple]`, which the enrollment already does. The code is never shown, as for IMAP.

**Pinning the code to the device.** Every EAS request names its device: `DeviceId` and `DeviceType` in the query, in plain form (`Cmd=...&DeviceId=...`) or base64 (`exchange-proto/src/eas/http.rs:211-223`) `[src]`. The front parses both forms (a small, fuzzed parser of a query string, not of the body). On the first request with a device code, the front records the `DeviceId` against the code's device row, through the API, since the front holds no write grant. From then on, the code is refused (`401`) with any other `DeviceId`, and on every path but `/Microsoft-Server-ActiveSync`. So a code copied off the phone does not work in Outlook, over IMAP or over EWS, and a second phone sends a different `DeviceId`.

⚠ **A `DeviceId` is the client's claim.** Pinning stops a code being reused by an honest second device or app. It does not stop someone who extracts the code from a jailbroken phone and also sends that phone's `DeviceId`. The strong binding is the one the IMAP design wanted and iPhone Mail refused: a client certificate. **Unlike IMAP, Apple's EAS payload has one**: `PayloadCertificateUUID`, "the certificate payload ... to use for the identity credential" `[apple]`. `[unproven]`, and the next probe for #383: whether it accepts the hardware-bound ACME identity (`com.apple.security.acme`, `HardwareBound`), and whether iOS presents it to `mail.i10.tech`. If it does, Traefik requests a client certificate on that host (`RequestClientCert`) and passes it to the front (`passTLSClientCert`), and the front requires the enrolled certificate for that device's code. That is the Secure Enclave binding the Mac already has for IMAP.

**Revoking a device** deletes its row and raises `credential_epoch`, as for IMAP, so the sweep closes the device's open Ping within a second (3.5). Stalwart's own EAS device registration is left alone: removing it would only make a revoked device set up again after it has been refused anyway.

**Mac.** The Exchange account is EWS, configured by `com.apple.ews.account`, which has `Host`, `UserName` and `Password` ("only with encrypted profiles") and a certificate identity (`AuthenticationCertificateUUID`, macOS 10.11, and `PayloadCertificateUUID`, 10.12) `[apple]`. EWS sends no `DeviceId`, so a Mac's Exchange code cannot be pinned the way an iPhone's is. `[unproven]` that macOS presents that identity to the EWS host, and whether a hardware-bound ACME key can be it. Until that is probed, a Mac uses IMAP with its Secure Enclave key, as #383 designed. Offering a Mac an Exchange account is open question 2.

**Android, later.** Gmail and Samsung Email send a per-install `DeviceId` and a `DeviceType` (for example `Android`). The code is shown once, as for "other apps" in #383, and pinned on first use the same way. Android's Exchange setup also offers a client certificate from the system KeyChain `[unproven]`, which could become the same certificate binding.

**Outlook for Windows** cannot carry a device code in a profile. A person whose password is their Clerk password signs in with it. An SSO person needs a code, shown once and pinned to the first MAPI `MailboxId` and client, which is weaker than EAS (no device identifier at all) `[unproven]` what Outlook's MAPI requests carry that could identify a machine (open question 2).

---

## 6. Stalwart configuration

Lines for `infra/k8s/i10/stalwart/config/plan.ndjson`, in the stored shape. The ones marked "with the upgrade" ship with the 1.2.0 image bump whether or not Exchange is on.

| Object / setting                                                                                 | Value                                                   | Why                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Calendar.shareFreeBusy`                                                                         | `false`, **with the upgrade**                           | 2.5: on by default, server-wide without tenants.                                                                                                              |
| `Sharing.allowDirectoryQueries`                                                                  | `false` (the default, written down)                     | Otherwise Outlook's address book (NSPI, OAB) lists every account on every customer's domains `[doc]`.                                                         |
| Role permissions (`sysMailRule*`, `sysBlockedSender*`, `sysSafeSender*`, `sysCalendarSettings*`) | added to `i10user` and `i10group`, **with the upgrade** | The upgrade notes require it `[doc]`. `i10user` inherits built-in `b`; whether that picks them up without `STALWART_UPDATE_ROLE_PERMISSIONS` is `[unproven]`. |
| `Exchange.enable`                                                                                | `true`, in the PR that turns Exchange on                | One switch for all of it `[doc]`. It also relaxes HTTP Basic decoding everywhere (2.1), which the front's own decoding makes harmless.                        |
| `Exchange.ewsVersion`                                                                            | `exchange2016` (default)                                | Changes only the reported version `[doc]`.                                                                                                                    |
| `Exchange.maxRequestSize`                                                                        | `67108864` (64 MiB)                                     | Above `Email.maxMessageSize` (50 MB) plus EWS's base64 third `[doc]`.                                                                                         |
| `Exchange.maxObjectSize`                                                                         | `262144` (default)                                      | Counts towards the account's quota `[doc]`.                                                                                                                   |
| `Exchange.maxDevices`                                                                            | `8`                                                     | Default 16. Devices idle 7 days are replaced on their own `[doc]`, so 8 is enough per person and halves the worst-case Ping load.                             |
| `Exchange.maxHeartbeat`                                                                          | `3540000` (default, 59 min)                             | Longer heartbeats mean fewer requests per device `[doc]`. The front ends them on revocation regardless.                                                       |
| `Jmap.maxConcurrentRequests`                                                                     | `32` (already)                                          | Every waiting Ping holds a slot until it answers, and a device does not end its previous wait `[doc]`.                                                        |
| `OidcProvider.accessTokenExpiry`                                                                 | `600000` (the minimum)                                  | Defence in depth for the HTTP auth cache (3.3).                                                                                                               |
| `NetworkListener` `exchange`                                                                     | `127.0.0.1:8081`, protocol `http`, no TLS               | The front's upstream. A listener change needs a restart (`config/README.md`).                                                                                 |
| `SystemSettings.services`                                                                        | stays `imap`, `smtp`                                    | Autodiscover lists these as the IMAP and SMTP fallback (2.6). POP3 must not come back.                                                                        |
| `STALWART_PUBLIC_URL`                                                                            | `https://mail.i10.tech` (pod environment)               | Every advertised URL (4.3).                                                                                                                                   |

**Not offered:**

- **Public folders and archive mailboxes**: Stalwart has neither `[doc]`.
- **Impersonation**: needs the `impersonate` permission, superusers only (2.1). No i10 role gets it.
- **Delegates and shared mailboxes**: Outlook's delegates become ordinary Stalwart shares, and shared mailboxes come from group membership (Autodiscover lists up to 16 groups) `[doc]`. Both stay inside what the person can already reach over JMAP and IMAP. Team inboxes (`authd.groups`) appear in Outlook automatically. The console's share rules still need a check that a share cannot cross workspaces (open question 5).
- **Mobile device management**: Stalwart answers a policy request with an empty policy and has no remote wipe `[doc]`. The console must not suggest otherwise.

---

## 7. Migration with Vandelay

Vandelay copies one account at a time: an importer fills a local SQLite archive, and an export writes it to a JMAP server `[doc]`. Repeated runs copy only what changed, which gives the usual shape: a bulk copy days ahead, then a short final run at cutover `[doc]`.

**Where it runs.** A Kubernetes Job per mailbox, started by the API, in a namespace policy that allows egress to the internet only (no cluster ranges, no link-local), because an on-premises EWS URL is the customer's choice, as authd's egress guard treats theirs.

**Reading the source.**

- **Microsoft 365**: the Graph importer (mail, calendars, contacts, OneDrive) `[doc]`. i10 registers one multi-tenant Entra application. The customer's admin grants admin consent to the application permissions `Mail.Read`, `Calendars.Read`, `Contacts.Read` and, if wanted, `Files.Read.All`. The API obtains app-only tokens with client credentials and runs each Job with `--access-token --user <upn>`. ⚠ A token passed this way is not renewed during the run `[doc]`, and app-only tokens last about an hour, so a large mailbox takes several runs. That is what repeated runs are for, and the Job loops until an import finds nothing new.
- **Exchange on premises**: the EWS importer, with an admin account that has Full Access on the mailboxes and `--mailbox`, or Entra client credentials where the server is hybrid `[doc]`. Basic only over `https` `[doc]`. NTLM is not among its methods `[doc]`, so an Exchange that accepts only NTLM cannot be read (open question 7).

**Writing to i10.** The export with an admin `x:ApiKey` bearer and `--account-name <address>` writes into another account `[doc]`. ⚠ Vandelay follows the URLs the JMAP session advertises `[doc]`, and Stalwart builds them from the public URL whatever the request's host (2.6). So the export would leave the cluster for `https://mail.i10.tech`, reach the front, and be refused for its bearer token. The Job therefore runs a small TLS shim on `127.0.0.1:443` inside the pod, with `hostAliases` mapping `mail.i10.tech` to `127.0.0.1` and a certificate from a CA made for that Job alone (Vandelay trusts it through `SSL_CERT_FILE`). The shim forwards to `i10-stalwart:8080`, which the Job's NetworkPolicy admits. The admin key lives in the Job's Secret, never in the front. `[unproven]` that Vandelay reads `SSL_CERT_FILE`.

**Cutover, per domain**, in the console: final import and export for every mailbox; replace the `MX` and the `autodiscover` record (the conflict flow, 4.3); remove the domain from the old Microsoft 365 tenant, because classic Outlook asks Microsoft 365 first and would keep finding the old mailbox `[doc]`. For machines that keep finding it, the console documents `ExcludeExplicitO365Endpoint` and `ExcludeLastKnownGoodUrl` `[doc]`. Outlook builds a new profile, and the cached-mode download starts again from i10.

---

## 8. Revocation and caches

The rule in `services/authd/README.md`: every access-removing path must invalidate every cache. With Exchange on, these hold access:

| Session or cache                                                 | Where                              | Lives                                                      | Closed by                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stalwart HTTP auth cache                                         | Stalwart, keyed on `Authorization` | `min(accessTokenExpiry, ...)`, 10 min after PR 4 (2.3)     | Unreachable: only the front builds those headers, and it stops (3.3).                                                                                                                                                     |
| The front's attribution cache                                    | mailfront, per process             | 10 min unused, re-minted every 5 min                       | The sweep, within a second (3.2).                                                                                                                                                                                         |
| An open EAS Ping or waiting Sync                                 | Stalwart, a held request           | Up to 59 min (2.4)                                         | The sweep cancels it (3.5).                                                                                                                                                                                               |
| An open EWS streaming response                                   | Stalwart                           | Up to 30 min (2.4)                                         | The sweep.                                                                                                                                                                                                                |
| MAPI over HTTP NotificationWait                                  | Stalwart                           | Up to 5 min                                                | The sweep.                                                                                                                                                                                                                |
| JMAP EventSource and WebSocket                                   | Stalwart                           | Indefinitely (2.4)                                         | The sweep.                                                                                                                                                                                                                |
| MAPI session (`MapiContext`)                                     | Keep (in-memory store)             | `EXPIRATION_MS` + 60 s (`exchange/src/mapi/session.rs:19`) | Nothing needed: every request still authenticates (2.2), and a revoked one never reaches it.                                                                                                                              |
| EWS subscription                                                 | Stalwart node memory               | Until restart or its timeout                               | Nothing needed: a subscription is only read by a request signed in as its account (2.2).                                                                                                                                  |
| EAS device registration and sync state                           | Stalwart store                     | Until replaced after 7 idle days                           | Nothing needed for access, as above. A revoked i10 device row is what refuses it.                                                                                                                                         |
| authd credential cache                                           | authd                              | 2 h, 15 min on OIDC, none on LDAP                          | Unchanged: the projection lookup, `credential_epoch`, `clerk_updated_at`.                                                                                                                                                 |
| A token held by a client (Stalwart OAuth, app password, API key) | Stalwart                           | -                                                          | None can be minted: OAuth endpoints are refused at the front (3.4), bearer is refused, and `i10user` cannot create app passwords or keys. A wrapped password never parses as one (`common/src/auth/credential.rs:35,68`). |
| A directory-side change on a pass-through lane                   | the customer's directory           | -                                                          | `MAILFRONT_PASSTHROUGH_MAX_AGE` on the entry and its requests, as for IMAP.                                                                                                                                               |
| Device code pinned to a `DeviceId`                               | API, device row                    | Until revoked                                              | Revoking deletes the row and raises `credential_epoch`.                                                                                                                                                                   |
| Offline copies on the client (Outlook's cached mode, the phone)  | the device                         | -                                                          | Out of reach without MDM, which Stalwart does not offer. The console says so when access is removed.                                                                                                                      |

Every access-removing path already moves the projection row, `credential_epoch` or `clerk_updated_at`. The HTTP front reads the same gate as IMAP, so **no new revocation path is needed**. A path added later that does not move one of those would miss IMAP and Exchange alike.

---

## 9. PR plan

Each PR ships alone and leaves production working. No user is told about Exchange until PR 5, when Autodiscover can meet the bar.

1. **Settings for the 1.2.0 upgrade** (with or just before the image bump): `Calendar.shareFreeBusy: false`, `Sharing.allowDirectoryQueries: false` written down, the new role permissions, automatic forwarding and redirecting to outside addresses off for mail rules and users' own Sieve scripts (section 11), `Exchange.enable` left `false`. _Proves:_ the freebusy probe (2.5) against the upgraded prod plan in a local stack answers `ErrorNoFreeBusyAccess`, a mail rule that forwards outside is refused, and IMAP, SMTP and JMAP behave as before.
2. **The HTTP front** (`services/authd`): the listener, allowlist, Basic decoding, attribution cache, the `i10hf1.` token in `bindtoken` and authd, registry and sweep integration, the front's own JSON Autodiscover answer, and the plan gate (Free accounts refused on Exchange and DAV paths, which needs the plan in the projection, so `db-guard` applies). Stalwart's `exchange` loopback listener. Not yet routed by Traefik. _Proves:_ the probes of 2.1, 2.2, 2.4 and 2.7 rerun through the front in the Docker stack of `mail-device-binding.md` section 9: `%` logins, unknown logins and bearer tokens refused before Stalwart; an account switch on a reused connection attributed per request; an EventSource and a WebSocket closed within the sweep interval of a `suspended_at`; `AutodiscoverV1` answered on the request's host. Fuzzing of the Basic decoder against a port of Stalwart's.
3. **JMAP through the front**: Traefik routes for JMAP (API, upload, download, EventSource, WebSocket), `stalwart-http-clients` without Traefik and without Bulwark, autoconfig and MTA-STS moved behind the front. _Proves:_ a direct JMAP client signs in for a Clerk account and for an SSO account on a pass-through lane, and its EventSource and WebSocket close on revocation through Traefik (3.5). This is the point where Traefik's handling of a mid-response close is measured.
4. **Exchange and DAV on, edge node, not yet announced**: `Exchange.enable`, the limits in section 6, `accessTokenExpiry`, `STALWART_PUBLIC_URL`, the Exchange and DAV paths routed to the edge pod, free/busy shares between members of a workspace (section 11). _Proves:_ exchangelib (EWS), `eas.py` (EAS), a MAPI `Connect` and a CalDAV client sign in through the front with a hand-entered server; the 2.4 table reruns with every row closed within a second; a Free account is refused; a workspace colleague's free/busy is visible and another workspace's is not; scale: a sweep with 10,000 open Pings measured as in "Mail front scale".
5. **Autodiscover for every hosted domain**: the `autodiscover` CNAME in `receivingRecordsFor` and the publisher, the certificate reconciler with its own Role, cert-manager and route objects, the readiness checks of 4.4, and the console's setup page with the unsupported-client copy of 4.5. _Proves_, on real clients against a test domain, each with only the address and the password typed:
   - classic Outlook (LTSC 2024): its "Test E-mail AutoConfiguration" log shows the `autodiscover.<domain>` step succeeding with no prompt;
   - Outlook for Mac with a licence;
   - iPhone Mail: record whether the Microsoft question appears for a domain Microsoft does not know, and whether **Sign In** works;
   - Gmail and Samsung Email on Android: record whether a security-administration screen appears.

   Also, a domain whose website has a mismatched certificate and a domain claimed by a Microsoft 365 test tenant, to confirm that checks 4 and 5 predict what the clients do. Every `[unproven]` in section 4 is settled here or the design changes.

6. **Exchange accounts on iPhone by profile**: `com.apple.eas.account` from the enrollment, `DeviceId` pinning in the front, for SSO accounts without a password lane. _Proves:_ on a real iPhone, push mail through Ping, the code refused from a second device and over IMAP and EWS, and a revoked device's Ping closed within a second. Also probes `PayloadCertificateUUID` with a hardware-bound key.
7. **Migration Jobs**: the Entra application, the consent flow, the Job template with the TLS shim, console progress and the cutover steps (including removing the domain from the old tenant, which check 5 then confirms). _Proves:_ a Microsoft 365 test tenant mailbox (mail, calendar, contacts) is copied, a second run copies only new items, and Outlook opens the migrated mailbox after cutover with no Microsoft sign-in.

Device codes for Android follow PR 6.

---

## 10. Open questions for the owner

Questions 1 to 8 of the first draft are answered or defaulted in section 11. These are new:

9. **SSO accounts without a password lane.** On an Entra or Google Workspace connection there is no password an Exchange client can send (4.1), so those people cannot meet "type your usual password". Accept device codes for them (iPhone by profile, a one-time code elsewhere), or build a lane? Entra's password grant works only while MFA does not apply (`services/authd/README.md`, "Lanes we are not building").
10. **IMAP from Microsoft's cloud.** The new Outlook and the Outlook mobile apps add an i10 account as IMAP through Microsoft's servers, which keep the password. Should the IMAP front refuse sign-ins from Microsoft's sync service (by source network, `[unproven]` that it is identifiable), or only warn in the console?
11. **The per-person Microsoft account check** (4.4, check 5) sends that person's address to Microsoft when they start it. Offer it, or only describe the symptom and the fix?
12. **The iPhone "Sign in using Microsoft?" question.** If PR 5 shows iOS still asks it for our domains, the setup text has to name a button, which falls short of the bar. Accept that, or lead iPhone users to the profile, which asks nothing?

---

## 11. Owner decisions (2026-11-23)

These answer section 10's first eight questions and override the design where they differ.

- **No Bulwark.** i10 will build its own webmail later, on JMAP through our API. The Bulwark JMAP proxy is out of scope. The front covers JMAP, its EventSource and its WebSocket for direct JMAP clients and the future webmail (3.1, PR 3), and Bulwark's access to Stalwart is removed.
- **"Just works", with no prompt.** A person types only their address and their usual password into classic Outlook, Outlook for Mac, iPhone Mail or an Android Exchange account, and sees no server, port, protocol, certificate warning or "allow this site to configure" prompt. Section 4 is designed to this: an `autodiscover.<domain>` CNAME and a per-domain certificate on every hosted domain, no SRV record, the front answering JSON Autodiscover on the request's own host, and readiness checks before anyone is told to set up. Exchange is not announced until all of it is in place (PR 5). The device profile stays the path for iPhone and Mac accounts that cannot use a password (question 9).
- **Free/busy within a workspace: yes.** `shareFreeBusy` stays off server-wide. i10 shares free/busy between members of the same workspace, never across workspaces. It is built with the Exchange PRs (PR 4).
- **Every paid plan.** Exchange (Outlook, phone Exchange accounts, calendars, contacts) is included in paid mailboxes. Free mailboxes keep IMAP and SMTP only. The front refuses Exchange and DAV paths for a Free account (PR 2).
- **CalDAV, CardDAV and the RSVP page ship with Exchange**, behind the same front and so under the same revocation (3.4, PR 4).
- **Mail rules:** on for everyone, but automatic forwarding or redirecting to outside addresses is off, and that applies to users' own Sieve scripts too. This is decided in the Stalwart 1.2.0 upgrade (PR 1).

Defaults for the remaining first-draft questions, until the owner says otherwise:

- **Question 2:** offer device codes in Outlook and Mac EWS accounts with the first-use pin, and say plainly in the console that the binding is weaker there than on an iPhone.
- **Question 3:** keep Outlook for Mac in the supported list, with a note that Microsoft requires a Microsoft 365 licence for it.
- **Question 4:** edge node only; probe cookie affinity when load calls for it.
- **Question 5:** refuse a share whose grantee is in another workspace.
- **Question 7:** require Basic or OAuth on the source Exchange server; Microsoft 365 goes through Graph, which covers most customers.

### Owner decisions on questions 9 to 12 (2026-11-24)

- **Question 9, SSO accounts with no password lane** (Entra, Google Workspace): they use device codes (#383), one per device. No new password lane.
- **Question 10, Microsoft's cloud sync service** (the new Outlook for Windows and the Outlook mobile apps adding an i10 mailbox over IMAP): allow it. The console warns the person that Microsoft then holds their password and sees their mail, and points them to classic Outlook or the phone's own Mail app.
- **Question 12, iPhone setup: offer every path, and they must all work.** The default the console shows is the best one, the device profile: one tap, no questions, bound to that iPhone. Manual Exchange setup through Apple's "Sign in using Microsoft?" sheet must also work and is documented, naming the button. Device codes are an option on every path.
- **Question 11, the per-person Microsoft account check:** open. The owner asked how a personal Microsoft account can share an i10 address; the answer is in the PR thread.
