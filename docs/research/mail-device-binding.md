# Locking a mail sign-in to one device

**Status:** research, probed on real devices on 2026-11-21. The design in section 6 is a proposal for #383 (I10-62), not a decision. Section 9 records the mail front (#383 PR 1, `services/authd/cmd/mailfront`): its probes against Stalwart v1.1.0 and its scale measurements.

**Why this exists.** On 2026-11-21 the owner bent the one-password rule (see `mail-one-password.md`): i10 may store a hashed, per-device, revocable mail credential, the way it stores API keys. Normal email-and-password users keep signing in to IMAP with their Clerk password. SSO users and people who signed up with Google or GitHub get a **device code**. The code is minted on dash.i10.tech after a full sign-in. It dies if it is not used within 5 to 10 minutes. Once used, it works only on that one device: not on a second device, and the person can never type it in again anywhere.

The hard part is the last sentence. A mail app does not sign in once. It stores the password and sends it again on every connection, so the server cannot tell a person typing from the app reconnecting. "Locked to one device" therefore has to come from something the device holds and cannot hand over. This document records what each mail app and Apple's platform actually allow, measured on real hardware.

**Evidence tags:** `[probe]` measured on a real device during this session; `[doc]` read in Apple's `device-management` schema repository; `[strings]` read from the macOS system library cache (not documented, may change).

---

## 1. The short answer

| Device                | What locks the code to it                                                                                                                                                                                                           | Setup                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| iPhone, iPad          | **A sealed code.** It is delivered encrypted to a key the phone made, through Apple's over-the-air enrollment. Nobody ever sees it, and iOS has no screen that reveals it. Apple signs the device's identity (model, serial, UDID). | One enrollment            |
| Mac (Apple Mail)      | **A Secure Enclave key** that Apple attests. Mail signs in with it (`AUTHENTICATE EXTERNAL`), and the key cannot be exported, even by the owner.                                                                                    | One enrollment + 2 clicks |
| Thunderbird           | **A TLS client certificate**, sent automatically.                                                                                                                                                                                   | Certificate import        |
| Outlook, Android apps | Not probed yet.                                                                                                                                                                                                                     |                           |

Nothing here needs MDM or a supervised device. Every profile was installed by hand. `[probe]`

---

## 2. How it was measured

A throwaway mail server on the owner's Mac, reachable from the LAN through `*.192-168-1-45.sslip.io` names, so that each test account had its own host name (and so its own TLS SNI):

- A Go IMAP and SMTP server that answers just enough of each protocol for Mail to treat an account as working. It logs the TLS ClientHello, any client certificate, the SNI, the IMAP `ID`, the SMTP `EHLO` and the auth mechanism. It asks for a client certificate but does not require it on one port, and requires it on another. It speaks implicit TLS and STARTTLS on the same port (it greets in plain text when the client stays silent).
- A throwaway certificate authority, name-constrained to the probe's own names, so it could never vouch for a real site.
- step-ca (Smallstep 0.30.2) with an ACME provisioner for Apple's `device-attest-01` challenge and a SCEP provisioner, behind an HTTPS front the devices already trusted.
- An over-the-air enrollment endpoint (section 4).

The probe's source is in `docs/research/mail-device-binding/probe/` for the next round (Outlook, Android).

---

## 3. What each mail app does with a client certificate

### Thunderbird `[probe]`

Sends its certificate automatically, both when the server asks and when it requires one. Offers SASL `EXTERNAL`, so it can sign in with the certificate and no password.

### Apple Mail on macOS 27.3 (Mail 16.0) `[probe]`

- **Reading (IMAP):** sends a certificate only when **Authentication = External (TLS Client Certificate)** _and_ a certificate is chosen. The choice is Server Settings > Advanced IMAP Settings > TLS Certificate, or a keychain identity preference for the host set locally (`security set-identity-preference`). With both, Mail uses `AUTHENTICATE EXTERNAL`. With a Secure Enclave key it works the same: the certificate the device got through ACME was presented and signed in.
- **Sending (SMTP):** never sends a certificate, over implicit TLS or STARTTLS, even with Authentication = External in its settings.
- **Apple prefers `EXTERNAL` whenever a server advertises it**, even with no certificate in hand, and then fails. A server must advertise `AUTH=EXTERNAL` only after a certificate arrived in the handshake.
- The account check when saving settings runs in a separate process (`Mac OS X accountsd`), which a keychain prompt can hold for many seconds. Handshake timeouts must allow for that.

### iPhone Mail on iOS 27.2 `[probe]`

- **Never sends a client certificate**, even with an identity installed by the same profile and the server listing the issuing CA.
- Uses **STARTTLS on any port other than 993**. It connects and stays silent until the server greets it in plain text; a server that waits for a ClientHello sees a dead connection.
- Signs in with `AUTHENTICATE PLAIN`.

### What apps reveal about themselves `[probe]`

| App                  | IMAP `ID`                                                                                                      | SMTP `EHLO`        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| Mac Mail             | `"name" "Mac OS X Mail" "version" "16.0 (3901.300.60)" "os" "Mac OS X" "os-version" "27.3 (26C5047e)"`         | `smtpclient.apple` |
| macOS account checks | `"name" "Mac OS X accountsd" "version" "113 (113)"`                                                            | `smtpclient.apple` |
| iPhone Mail          | `"name" "com.apple.email.maild" "version" "3901.200.41" "os" "iOS" "os-version" "27.2 (24B5089g)" "event" ...` |                    |

- iOS adds an `event` field: `"user-initiated"` on a pull-to-refresh, `"back-fill"` or `NIL` otherwise. That is the closest any protocol gets to "a person did this" versus "the app did this".
- The TLS ClientHello fingerprint changed between two connections from the same iPhone, so a TLS fingerprint cannot identify a device.

---

## 4. Apple over-the-air enrollment, step by step `[probe]`

This is Apple's documented "Profile Service" flow, older than MDM and still supported on iOS 27.2 and macOS 27.3. It worked on an iPhone (`iPhone17,2`) and a MacBook Pro (`MacBookPro18,3`).

1. **The person opens a link** on dash.i10.tech and installs a small profile of type `Profile Service`. It holds a URL, a one-time challenge and the list of device attributes to send.
2. **The device sends its attributes, signed by Apple.** It POSTs a CMS `SignedData` (User-Agent `Profile/1.0`) whose signer certificate is issued by **Apple iPhone Device CA**, chaining to **Apple Root CA**, on the Mac too.
   - iPhone sent `UDID`, `SERIAL`, `PRODUCT`, `VERSION` and the challenge. It did **not** send `DEVICE_NAME` although it was asked.
   - The Mac also sent `DEVICE_NAME` ("<owner>'s MacBook Pro"), `MODEL` and `MODELNUMBER`.
3. **We answer with a SCEP-only profile.** The device makes its own key and enrolls it through SCEP.
   - Encrypting the final profile straight to the Apple device certificate **fails** ("Profile Installation Failed").
   - Putting anything besides the SCEP payload in this answer (an ACME payload, for example) **fails** with "The enrollment server did not provision a valid identity certificate", and the device never calls the SCEP server.
4. **The device POSTs again, signed with its new SCEP key.** Do not rely on this request echoing `CHALLENGE` or `SERIAL`: Apple's sample of it carries only `UDID`, `VERSION` and `MAC_ADDRESS_EN0` `[doc]`. Find the enrollment from the certificate we issued instead, which in production means the certificate a per-enrollment SCEP challenge allowed. Whether iOS 27 and macOS 27 echo them was not recorded during the probe.
5. **We answer with the real profile, encrypted to that key** (`EncryptedPayloadContent`, CMS enveloped, AES-256-CBC). Only that device can open it. It held the mail account with the code and an ACME payload, and installed.

Results:

- **The code is never shown.** iOS shows a profile-installed account's password only as "Password: Set". `[probe]`
- **A Secure Enclave key, attested by Apple, on both devices.** The ACME payload (`HardwareBound`, `Attest`, `ECSECPrimeRandom` 384) passed step-ca's `device-attest-01` and a certificate was issued. The payload's `ClientIdentifier` and its `Subject` CN must both be **exactly the device's serial number**, or finalize fails with "CSR Subject Common Name does not match identifiers exactly". `[probe]` The ACME payload allows manual install and needs no supervision, on iOS 16+ and macOS 13.1+ (hardware-bound keys need macOS 14 on Apple silicon or T2). `[doc]`
- **Stolen Device Protection.** With its delay set to "Always", step 1 needed the security delay (about an hour). With the default, "Away from familiar locations", it should be Face ID only at home or work (not yet measured).

---

## 5. What cannot be automated on a Mac

Mac Mail needs Authentication = External and a chosen certificate. Every way to set them from outside was tried:

| Route                                                                 | Result                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail profile payload (`com.apple.mail.managed`)                       | The schema and the installer accept only `EmailAuthNone`, `EmailAuthPassword`, `EmailAuthCRAMMD5`, `EmailAuthNTLM`, `EmailAuthHTTPMD5`. There is no External value and no certificate key. `[doc]` `[strings]`                                  |
| Identity Preference payload (`com.apple.security.identitypreference`) | Installs, but Mail ignores it, both for an OS-made key (SCEP, non-exportable) and for a Secure Enclave key (ACME). Only a preference set locally works. `[probe]`                                                                               |
| Mail's AppleScript                                                    | The dictionary has `authentication` with an `external` value, but setting it did not apply: the account read back `none` and kept signing in with the password. Creating an account by script also returns success and saves nothing. `[probe]` |
| Mail's account database                                               | Behind macOS privacy protection (Full Disk Access). Not pursued.                                                                                                                                                                                |

macOS's account-setup layer does model it (`IAAuthSchemeExternal`, `IAMailTLSCertificate`, `IAMailOutgoingTLSCertificate`) `[strings]`, but nothing reachable from a profile writes them.

So a Mac is **one enrollment plus two clicks**: Server Settings > Authentication > External, then Advanced IMAP Settings > TLS Certificate > the i10 key. A small i10 helper app with Full Disk Access is the only route to a true one tap, and it is not worth that permission for two clicks.

---

## 6. Proposed design for #383

**Who gets what**

- **Normal users:** the Clerk password, unchanged. Device codes are available to them too.
- **Google and GitHub sign-ups:** device codes first, "or set a password" second.
- **SSO users:** device codes by default, on every identity provider, with no admin setup. The existing Okta OIDC and LDAP pass-through lanes stay as an admin opt-in. The console must say that the OIDC lane makes mail sign-in skip MFA, because the provider needs a password-only policy for it.

**Minting** (dash.i10.tech, after a full sign-in and a fresh step-up)

- The person picks a mailbox and starts "add a device".
- Apple devices go through the enrollment in section 4. We learn the model and serial from Apple's signature (and the device name on a Mac). The code is generated server-side, sealed to the device and never displayed.
- Other apps get the code on screen once, valid for 10 minutes until first use.

**Storing:** a keyed hash of the code, per device, with the device's attested identity: serial, model, and for Secure Enclave keys the certificate's fingerprint.

**At sign-in (authd)**

- **iPhone and iPad:** the code, as a password.
- **Mac:** reading mail requires the device's Secure Enclave certificate (`EXTERNAL`). The code alone is refused, so a code dug out of Keychain Access is useless on another Mac. Until the two clicks are done the account does not connect, so nobody is half-protected by accident.
- **Thunderbird:** the certificate.
- **Sending from a Mac:** Mail sends no certificate on SMTP. A send with the code is accepted only while that device has a certificate-verified IMAP session open (or had one within a few minutes) from the same address.

**Naming:** from Apple's signed attributes (model, and the Mac's name) and the IMAP `ID`, editable by the person.

**Revoking:** delete the device row and raise `credential_epoch`. Every path that removes access (suspension, deprovision, SCIM, Okta Universal Logout) must also end that person's device codes (see the cache-revocation rule in `services/authd/README.md`).

That stops new sign-ins only. Stalwart never ends a session that has already signed in `[probe]`. Measured 2026-11-21 on a local Stalwart v1.1.0 (the version prod runs), with an IMAP session idling, a second IMAP session issuing commands and an SMTP session on 465, all signed in before the change:

| Change made through the admin API              | New sign-in | Open IMAP: IDLE push of new mail, SEARCH, FETCH | Open SMTP: send |
| ---------------------------------------------- | ----------- | ----------------------------------------------- | --------------- |
| Password changed                               | refused     | still works                                     | still sends     |
| `InvalidateCaches` action                      | works       | still works                                     | still sends     |
| `authenticate` and `emailSend` permissions off | refused     | still works                                     | still sends     |
| Account deleted                                | refused     | FETCH of existing mail works, LIST hangs        | still sends     |

The admin API has no action that ends a session. Nothing caps how long an IMAP session lives: `authenticatedTimeout` and `idleTimeout` are both 30 minutes of inactivity, and a client that renews IDLE is never idle. An SMTP session lasts up to `maxDuration` (10 minutes, 30 on 465 in our plan). With the LDAP directory prod uses, Stalwart learns even less, because it hears from authd only when a login happens. Stalwart also knows only the account, never the device, so revoking one of a person's devices cannot be expressed to it at all.

So revocation lives in the front (below). The front knows which device each connection belongs to: the certificate at the TLS handshake on a Mac or in Thunderbird, and the code in `AUTHENTICATE` or `LOGIN` on an iPhone, which it sees because it terminates TLS. A revoke publishes the device id. Every front instance closes that device's connections, and authd refuses its next sign-in. Account-wide revocations (suspension, deletion, payment hold, SSO-required) go out the same way with the account id. Those have the same hole today, without any device codes involved.

**Needed in the stack**

- **Stalwart to carry the client certificate to authd.** Today authd gets only an LDAP bind (address and password). A front for IMAP and SMTP that terminates TLS, checks the certificate and hands the connection to Stalwart over PROXY protocol is the likely shape. Stalwart supports PROXY v2, including its SSL extension. The front is also where revocation happens, because only the front can close a connection that has already signed in (see Revoking).
- A SCEP and ACME (`device-attest-01`) service, or step-ca run as one.
- An enrollment endpoint in the API.

---

## 7. Lanes we know work and are not building

Kept so nobody re-probes them. Device codes cover each one.

- **Entra password grant (ROPC).** Works under Security Defaults for a user with no MFA registered: `200`, about 6.7 s cold. A wrong password answers `AADSTS50126`. A lock answers a distinct `AADSTS50053` and then refuses the right password too; it cleared in about 60 s. From a familiar address the lock came at the 15th distinct failure after a success. Dies the moment MFA applies to the user, which is the default. A user with MFA registered was never probed. (#383 comments, 2026-11-07)
- **Thunderbird OAuth (Stalwart's own issuer).** A mail-scoped token is proven: a client registered with scope `urn:ietf:params:oauth:scope:mail` signed in to IMAP with XOAUTH2 and to SMTP (`235`). Stalwart's OAuth can be finished on someone's behalf (`POST /api/auth` `authCode` then `authConsent`, then `/auth/token`), with the secret checked by an authd bind. Covers Thunderbird only. (2026-11-07)
- **Google Secure LDAP (#400).** The only supported way to check a Google Workspace password server-side. It needs Cloud Identity Premium or Workspace Business Plus, Enterprise or Education, plus a per-tenant client certificate. Never probed: i10.tech is on Cloud Identity Free, which has no Secure LDAP.

---

## 8. Open questions

- **Outlook** on Mac and iPhone, and the **Android** mail apps (Gmail, Samsung): do they send client certificates, and what do they put in IMAP `ID`?
- **Per-app VPN for the iPhone.** The Mail payload has `VPNUUID`. If a manually installed profile can route only the Mail account through an IKEv2 tunnel that signs in with the Secure Enclave key, the server could accept that account only from the tunnel, and even a jailbroken copy of the code would be useless. Apple usually reserves per-app VPN for managed devices.
- **Stolen Device Protection on the default setting:** does enrollment at a familiar location need only Face ID?
- **Code visibility on a Mac:** is a profile-installed Mail password readable in Keychain Access or the Passwords app? The proposal does not depend on it, because Mac reading requires the certificate.
- **Renewal:** SCEP and ACME certificates expire. A device must renew before expiry without a person repeating enrollment.

## 9. The mail front, probed and measured (2026-11-21)

Everything here is from a throwaway local setup, never the cluster or a real account: Stalwart `v1.1.0-alpine` with its store in a scratch Postgres 18 (internal directory, two test accounts), a second scratch database migrated with `apps/api/drizzle` for the `authd` schema, a CA name-constrained to `*.i10.test`, and the front in Stalwart's network namespace as uid 65532 with every capability dropped and `net.ipv4.ip_unprivileged_port_start=0`, as in the pod.

### Mail front probes

| Question                                             | Answer                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PROXY v2 with the SSL TLV on a listener with no TLS  | Treated as TLS. IMAP greets with `AUTH=PLAIN AUTH=OAUTHBEARER AUTH=XOAUTH2` and accepts LOGIN; SMTP offers `AUTH PLAIN LOGIN XOAUTH2 OAUTHBEARER` and answers `235`.                             |
| The same without the TLV                             | IMAP: `LOGINDISABLED`, "LOGIN is disabled on the clear-text port". SMTP: no AUTH, `503 5.5.1 AUTH not allowed`.                                                                                  |
| `remote_ip`                                          | The client's: `remoteIp = 203.0.113.7` in `smtp.ehlo` and `auth.success`.                                                                                                                        |
| `local_port`                                         | The header's destination port, not the bind: `localPort = 465`, and with a header naming 4999, `localPort = 4999` and a `local_port == 465` mechanism rule stopped applying.                     |
| STARTTLS on the plaintext listeners                  | Not offered.                                                                                                                                                                                     |
| Two binds on one port in one namespace               | Pod IP `:993` (front) and `127.0.0.1:993` (Stalwart) both listen. With Stalwart on `[::]` (`SO_REUSEADDR`, `SO_REUSEPORT`), the front gets `EADDRINUSE` and waits.                               |
| UNAUTHENTICATE                                       | Advertised after sign-in. `UNAUTHENTICATE` then `LOGIN` as a second account works on one connection. Through the front, the second LOGIN closes the connection before its OK reaches the client. |
| A second SMTP AUTH                                   | `503 5.5.1 Already authenticated.`                                                                                                                                                               |
| IMAP `AUTHENTICATE LOGIN`                            | `BAD Unsupported mechanism 'LOGIN'`. Only PLAIN, OAUTHBEARER and XOAUTH2.                                                                                                                        |
| PLAIN with an authzid naming someone else            | Stalwart signed in as the authcid. The front cancels such an exchange anyway.                                                                                                                    |
| The front's re-written LOGIN (two LITERAL+ literals) | Accepted.                                                                                                                                                                                        |
| A full session through the front                     | LOGIN, SELECT, IDLE; a message sent over SMTP AUTH reached the idling session's push 8 ms after `250 Message queued`; FETCH read its subject.                                                    |

**Closing on revocation.** One IMAP session in IDLE and one signed-in SMTP session, then one change to the account's row in Postgres (the time includes `docker exec psql`):

| Change                    | IMAP IDLE closed after | SMTP closed after |
| ------------------------- | ---------------------- | ----------------- |
| `suspended_at = now()`    | 582 ms                 | 582 ms            |
| `credential_epoch + 1`    | 537 ms                 | 537 ms            |
| `payment_hold_at = now()` | 610 ms                 | 611 ms            |
| `active = false`          | 542 ms                 | 542 ms            |

**Latency.** TLS handshake plus LOGIN round trip, 300 sequential samples, twice: straight to Stalwart's own TLS listener vs through the front (whose path adds the login lookup):

| Round | Direct p50 | Direct p95 | Front p50 | Front p95 |
| ----- | ---------- | ---------- | --------- | --------- |
| 1     | 20.2 ms    | 23.3 ms    | 21.0 ms   | 23.8 ms   |
| 2     | 21.0 ms    | 26.1 ms    | 23.0 ms   | 39.2 ms   |

Most of the 20 ms is the internal directory's password hash. The front adds about 1 to 2 ms at the median.

**TLS.** Identical on both: TLS 1.0 and 1.1 refused; TLS 1.2 only `ECDHE-RSA-AES256-GCM-SHA384`, `ECDHE-RSA-CHACHA20-POLY1305`, `ECDHE-RSA-AES128-GCM-SHA256`; all three TLS 1.3 suites; group X25519MLKEM768. Only the preferred signature scheme differs (`rsa_pss_rsae_sha512` from Stalwart, `_sha256` from Go), which the client negotiates.

### Mail front scale

Raw numbers: `mail-device-binding/sweep-db-2026-11-21.csv`, `mail-device-binding/sweep-per-account-2026-11-22.csv` and `mail-device-binding/front-scale-2026-11-21.csv`. Rerun them with `TestSweepQueryScale` (services/authd/internal/mailfront, against `mail-device-binding/sweep-seed.sql`) and `mail-device-binding/mailfront-scale`.

**The seed** (`mail-device-binding/sweep-seed.sql`). 500,000 `authd.accounts` rows across 20,000 tenants, one hosted, verified domain each (25 accounts a domain); 500 SSO connections requiring SSO on their domain, 2,500 `required_exempt` rows, 5,000 managed accounts, and a few hundred suspended and payment-held rows. That is ten times the largest live set measured. Postgres 18.7, 8 cores, default settings, everything cached (no block was read from disk).

**What the sweep costs the database.** One query per second for N distinct accounts. "Clustered" is 25 live accounts a domain (a company), "spread" one domain each (the worst case). "Core share" is the server's execution time per second as `EXPLAIN (ANALYZE)` reports it, so above 100% one sweep cannot finish in its second (the sweeper then waits five times the query, see the README). p50 and p95 are client wall time (the Go front's own call) over 60 runs unless the runs column says fewer: a size whose runs passed two minutes stopped there. "Current" is the schema before this PR (measured 2026-11-21); "migrated" is the same seed after this PR's two migrations, `20261121202659_domain_lower_name_indexes` and `20261121202814_mailbox_domain_settings_by_name` (measured 2026-11-21).

| Schema   | Distribution | Live accounts | Domains | p50     | p95              | Core share at 1 Hz |
| -------- | ------------ | ------------- | ------- | ------- | ---------------- | ------------------ |
| current  | clustered    | 10            | 1       | 15.6 ms | 16.7 ms          | 1.4%               |
| current  | clustered    | 100           | 4       | 57.6 ms | 62.2 ms          | 5.5%               |
| current  | clustered    | 1,000         | 40      | 546 ms  | 572 ms           | 54%                |
| current  | clustered    | 10,000        | 400     | 5.5 s   | 5.6 s (21 runs)  | 598%               |
| current  | clustered    | 50,000        | 2,000   | 28.4 s  | 28.5 s (4 runs)  | 2,800%             |
| current  | spread       | 1,000         | 970     | 20.6 s  | 20.8 s (5 runs)  | 2,000%             |
| migrated | clustered    | 100           | 4       | 2.2 ms  | 3.2 ms           | 0.2%               |
| migrated | clustered    | 1,000         | 40      | 14.1 ms | 15.1 ms          | 1.3%               |
| migrated | clustered    | 10,000        | 400     | 125 ms  | 158 ms           | 17%                |
| migrated | clustered    | 50,000        | 2,000   | 688 ms  | 865 ms           | 62%                |
| migrated | spread       | 100           | 100     | 14.0 ms | 17.2 ms          | 1.2%               |
| migrated | spread       | 1,000         | 974     | 125 ms  | 131 ms           | 12%                |
| migrated | spread       | 10,000        | 7,978   | 1.02 s  | 1.08 s           | 100%               |
| migrated | spread       | 50,000        | 18,563  | 2.67 s  | 3.01 s (43 runs) | 253%               |

- **Why "current" is so slow.** `core.mailbox_domain_refused` is `SECURITY DEFINER`, so it is never inlined, and `core.mailbox_domain_settings(p_name)` joined every row of `core.domains` to `name_holders(p_name)` without filtering `d` by the name. Each call was about 14 ms and 930 buffer hits at 20,000 domains, growing with the number of domains. A bind pays it once; a sweep paid it per account until it was changed to judge each (tenant, domain) once (`projection.SweepQuery`). The spread rows at 10,000 and 50,000 were not run on the current schema: at about 21 ms a domain they would take minutes per sweep.
- **What the migrations change.** An index on `lower(name)` for `core.domains` and `core.join_domains` (declared in the Drizzle schema), and `AND (p_name IS NULL OR lower(d.name) = lower(p_name))` inside `core.mailbox_domain_settings` (a custom migration). A call drops to about 0.3 ms, and every authd bind gets cheaper with it. The migrated rows above replace an earlier scratch-database run of the same SQL (within 10% of it from 1,000 accounts up; the 10 and 100 rows, at 1 to 3 ms, moved by up to 17%).
- **The per-account part alone** (`sweep-per-account-2026-11-22.csv`, measured 2026-11-22 on the migrated seed, clustered, 60 runs each): the sweep query with the domain verdict replaced by a constant, timed inside the server (a PL/pgSQL loop, so neither EXPLAIN's instrumentation nor the id transfer is counted), next to the full query timed the same way.

  | Live accounts | Per-account part p50 | Full query p50 | Per-account core share at 1 Hz |
  | ------------- | -------------------- | -------------- | ------------------------------ |
  | 1,000         | 2.5 ms               | 7.0 ms         | 0.3%                           |
  | 10,000        | 29.5 ms              | 71.7 ms        | 3.0%                           |
  | 50,000        | 163 ms               | 415 ms         | 16%                            |

  Timed this way the full query is 41 to 67% of what `EXPLAIN (ANALYZE)` reports for it, so the core shares in the main table are an upper bound.

- **Several fronts multiply it.** Each front sweeps its own connections. Two fronts with the same accounts double the load, and N fronts with disjoint accounts add up to about one front with all of them. Today there is one (the edge node).
- **Through PgBouncer** (transaction pooling, as in production) each sweep holds one server connection for the length of the query. At 1 Hz that is one pooled connection busy for the "core share" of the time. Each query also sends the id array once: about 1.5 MB a second at 50,000 ids. The pool is `pool_max_conns=4` per front.

**What the sweep costs the front.** The real binary on Linux with N idle signed-in IMAP connections in IDLE against a fake upstream, sampled from `/proc` over 30 idle seconds with the sweep running every second.

| Idle connections | RSS      | RSS per connection | CPU (one core) | Sweep in-process p50 |
| ---------------- | -------- | ------------------ | -------------- | -------------------- |
| 0                | 10.0 MiB | -                  | 0.03%          | -                    |
| 100              | 19.8 MiB | 99 KiB             | 0.26%          | 0.17 ms              |
| 1,000            | 80.7 MiB | 72 KiB             | 0.66%          | 1.15 ms              |
| 10,000           | 609 MiB  | 61 KiB             | 2.06%          | 9.9 ms               |

The per-connection figure includes Go's GC headroom. Taking the pre-auth buffers out of an idle session and halving the copy buffers moved it from 72 to 61 KiB at 10,000. Most of the rest is `crypto/tls`'s per-connection buffers and two goroutine stacks. The front's container is sized from this: 512 MiB, `GOMEMLIMIT=450MiB`, and at most 6,000 connections.

**The knee (5% of one core).**

- **Database, today's schema:** about 4 live domains, roughly 100 clustered accounts. The cost grows with live domains times the size of `core.domains`. Production has few domains today, so this is cheap now and grows with every customer.
- **Database, with this PR's migrations:** about 3,000 clustered or 400 spread live accounts by `EXPLAIN` time; about 7,000 clustered by in-server time.
- **Database, per-account part alone:** about 15,000 live accounts (in-server time).
- **Front:** CPU stays under 5% past 10,000 connections; memory is the limit (61 KiB a connection).

**A design change is needed well before 50,000.** Re-reading every live account every second cannot reach 50,000 accounts on one database core: the per-account part alone is 16% of a core there, and the whole query 42 to 62% clustered and over 250% spread. The shape that scales re-checks only the accounts whose access changed. The API appends a row to a change log (or sends a NOTIFY) in every transaction that removes access: the gate columns, `required_domains`, `required_exempt`, managed accounts, a domain's hosting. Each second the front reads the log past its last position, an index range scan that costs next to nothing when nothing changed, and re-checks only those accounts with the full gate. A full sweep every few minutes stays as the backstop for a missed write. Until then: land the migration, keep the 1 Hz sweep, and let the duty-cycle cap stretch the window rather than load the database.

**A sign-in surge** (measured 2026-11-22, `mail-device-binding/front-storm-2026-11-22.csv`). Every client of a full front reconnecting at once, as after a restart: 6,000 IMAP clients through the real front (Linux, migrated seed, the 500 SSO-required tenants skipped with `mailfront-scale -domain-offset 600`), against the fake upstream, with each client's TLS handshake plus LOGIN timed. The per-address cap was raised, since every test client shares one address; everything else is the default.

| Dialing at once | `pool_max_conns` | `MAILFRONT_MAX_PREAUTH` | Signed in                       | Sign-in p50 | p95    | max    |
| --------------- | ---------------- | ----------------------- | ------------------------------- | ----------- | ------ | ------ |
| 64 (steady)     | 4                | 2000                    | 6,000                           | 25 ms       | 39 ms  | 105 ms |
| 6,000           | 4                | 2000                    | 2,000 (4,000 refused at accept) | 946 ms      | 1.09 s | 1.10 s |
| 6,000           | 4                | 6000                    | 6,000                           | 2.56 s      | 2.93 s | 3.10 s |
| 6,000           | 8                | 6000                    | 6,000                           | 2.02 s      | 2.32 s | 2.40 s |

No lookup timed out in any run and the front logged no error. The pre-auth cap is what keeps a surge inside the 3 s lookup timeout: with it the slowest sign-in took 1.1 s, and without it 3.1 s, at the edge. A bigger pool helps less than the cap does. So the defaults stay, and refused clients retry on their own timers. Before this run, refusals at accept were not logged at all; the front now reports them once per 10 seconds with a count per cap (a rerun logged `"refused":{"max_preauth":3974}`, exactly the clients that failed). No jitter was added to the shutdown close: with one Stalwart pod on the node, the new front is not listening until the old pod is gone, so a staggered close would only make some clients wait longer for the same reconnect.

**The pass-through maximum age** (measured 2026-11-22). A session signed in through a company's own directory or OIDC provider is closed at `MAILFRONT_PASSTHROUGH_MAX_AGE` (default 15 minutes), at a random point in its last tenth, because a revocation in that directory never reaches i10. With a 1-second age, a 50 ms sweep and three clients that reconnect the moment they are dropped, the real server code saw 93 sign-ins in 30 seconds: 1.033 per connection per max-age period, against the 1.026 the jitter predicts. At the default that is about 4.2 reconnects an hour per open connection: about 4.2, 12.6 and 21 directory sign-ins an hour on the LDAP lane for a client holding 1, 3 and 5 connections (iPhone Mail with push, Apple Mail on a Mac, Thunderbird's default connection cache; the counts are typical figures, not measured), and about 4 token calls an hour per person on the OIDC lane, whose credential cache answers the other connections. The services/authd README has the table.

### The bind token, probed (2026-11-23)

The review rounds' attacks, rerun against the bind token design (services/authd README, "The bind token"). A throwaway local stack, never the cluster or a real account: Stalwart `v1.1.0-alpine` with its store in a scratch Postgres 18, **authd from this branch as its LDAP directory** (`Authentication.directoryId`, bind-auth mode) against a scratch `i10` database migrated with `apps/api/drizzle` and two seeded accounts (`alice@i10.test`, `bob@i10.test`, both with the right password per a fake Clerk), the front in Stalwart's network namespace, and one throwaway key shared by both. Stalwart was configured with the deploy patch's plan lines, including the two bearer lines below. The probe is `TestLiveProbe` (services/authd/internal/mailfront/live_probe_test.go, skipped unless `MAILFRONT_LIVE_PROBE=1`), run inside the namespace so it can also reach Stalwart's loopback listeners directly. Every subtest passed.

| Probe                                                                                                                                                  | Answer                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary IMAP session through the front                                                                                                             | Greeting `AUTH=PLAIN` only; LOGIN `OK`, SELECT, APPEND, FETCH, IDLE and LOGOUT all `OK`. authd logged `bind succeeded`, source `clerk`, and the bind password it received began `i10mf1.`.                                                                                   |
| An ordinary SMTP submission through the front                                                                                                          | EHLO `250-AUTH PLAIN LOGIN`; AUTH LOGIN `235`; MAIL, RCPT, DATA `250 Message queued`.                                                                                                                                                                                        |
| **Round 3**: signed in as alice, then pipelined `b SELECT INBOX`, `c SEARCH BEFORE {14+}` + `x {99999999}` CRLF, `d UNAUTHENTICATE`, `e LOGIN bob ...` | `c BAD Failed to parse date 'x {99999999}...'`, `d OK UNAUTHENTICATE completed`, **`e NO [AUTHENTICATIONFAILED] Authentication failed`**. The scanner was blinded as in review; the LOGIN reached authd with bob's raw password and authd refused it (`bind_token_missing`). |
| **Round 2**: signed in as alice, then `* UNAUTHENTICATE`, `* LOGIN bob ...` (and the same under `+`)                                                   | `* OK UNAUTHENTICATE completed`, then `* NO [AUTHENTICATIONFAILED]` (and `+ NO [AUTHENTICATIONFAILED]`): refused by authd.                                                                                                                                                   |
| **Round 1**: `a NOOP x{N}` with a hidden `LOGIN bob` as the N bytes                                                                                    | `* BYE Invalid command.` from the front; the connection is closed and nothing reaches Stalwart.                                                                                                                                                                              |
| Straight to Stalwart's loopback 993 (with the SSL TLV), no front                                                                                       | alice's right password, raw: `NO`. alice's password behind a valid token for **bob**: `NO`. Behind alice's own token: `OK`.                                                                                                                                                  |
| SMTP through the front: a second AUTH as bob after alice's                                                                                             | `503 5.5.1 Already authenticated.` (Stalwart's own answer).                                                                                                                                                                                                                  |
| Round 3 with Stalwart's recovery admin as the second LOGIN                                                                                             | `e OK [CAPABILITY ...]`, then `f OK NOOP completed`, and the connection stayed open. The recovery admin never reaches authd, so the token cannot stop it, and the blinded scanner did not see it. Outside the design, on purpose (README, "Outside the token design").       |

**Bearer sign-ins, as defence in depth.** Stalwart accepts OAUTHBEARER and XOAUTH2 only on a TLS connection (`common/src/auth/sasl.rs:83`) and checks them without authd. Probed on Stalwart's loopback listeners:

| Setting                                                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMAP with the SSL TLV (before)                                                                  | `AUTH=PLAIN AUTH=OAUTHBEARER AUTH=XOAUTH2`.                                                                                                                                                                                                                                                                                                                                                                                              |
| IMAP without the TLV, `Imap.allowPlainTextAuth` off (the default)                               | `LOGINDISABLED`; LOGIN "LOGIN is disabled on the clear-text port."; every AUTHENTICATE `NO [PRIVACYREQUIRED] Cannot authenticate over plain-text.`                                                                                                                                                                                                                                                                                       |
| IMAP without the TLV, `Imap.allowPlainTextAuth: true` (adopted)                                 | Greeting and CAPABILITY `AUTH=PLAIN` only. LOGIN and AUTHENTICATE PLAIN with alice's token: `OK`. XOAUTH2 and OAUTHBEARER: `NO [PRIVACYREQUIRED] OAUTHBEARER and XOAUTH2 require a TLS connection.` The full session through the front (row 1 above) ran on this setting. In Stalwart's IMAP the TLS flag decides only the auth capability, the bearer gate and STARTTLS (read in `crates/imap`), and the front answers STARTTLS itself. |
| SMTP with the TLV, default `saslMechanisms`                                                     | `AUTH PLAIN LOGIN XOAUTH2 OAUTHBEARER`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| SMTP with the TLV, `saslMechanisms` `[plain, login]` on `local_port == 465 && is_tls` (adopted) | `AUTH PLAIN LOGIN`; PLAIN with a token `235`; AUTH XOAUTH2 and OAUTHBEARER `554 5.7.8 Authentication mechanism not supported.`                                                                                                                                                                                                                                                                                                           |

SMTP keeps the TLV because without it Stalwart offers no AUTH at all (the table above, "The same without the TLV"). The IMAP setting is global, so it would also allow plaintext LOGIN on any other cleartext IMAP or POP3 listener (POP3 reads the same flag); the plan has none.

**Stalwart's HTTP Basic auth cache** (read, not probed; for the Bulwark JMAP proxy PR). A successful Basic sign-in is cached keyed on the `Authorization` header value (`crates/http/src/auth/authenticate.rs:43-68` reads it, 112-126 writes it). A password sign-in has no expiry of its own (`common/src/auth/authentication.rs:53-63`), so the entry lives for `OidcProvider.accessTokenExpiry`, default 3,600,000 ms, one hour, and at least ten minutes (`registry/src/schema/structs_impl.rs:53639` and `:53755`). Each cached request still checks the account's revision inside Stalwart and drops the entry when it changed; whether an authd-side revocation moves that revision was not probed. Until it is, assume a revoked person keeps an HTTP session for up to an hour.

**Found on the way, before this PR:** authd at `AUTHD_LOG_LEVEL=debug` logs every LDAP packet in hex through the LDAP library's logger (`cmd/authd/main.go:59`), and a BindRequest's hex holds the password, the service bind secret included. Production runs `info`. The README's configuration table now says so.

---

## Sources

- Apple, `apple/device-management`, branch `release`, read 2026-11-21: `mdm/profiles/com.apple.mail.managed.yaml`, `com.apple.security.acme.yaml`, `com.apple.security.identitypreference.yaml`, and the `mdm/profiles` listing.
- Stalwart docs, read 2026-11-21: telemetry webhooks (`auth.success`, `auth.failed` carry `remoteIp` and a session `spanId`), the event reference (`imap.id` exists), and the reverse proxy page (PROXY v2 with the SSL extension).
- `mail-one-password.md` and the #383 comments for the lanes in section 7.
- Stalwart docs, read 2026-11-21: the reverse proxy page (dedicated loopback listeners, `overrideProxyTrustedNetworks`, "Every connection from those networks must carry the header, or it is dropped", "Listener changes take effect after a restart").
