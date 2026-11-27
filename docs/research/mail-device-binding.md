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

**A design change is needed well before 50,000.** Re-reading every live account every second cannot reach 50,000 accounts on one database core: the per-account part alone is 16% of a core there, and the whole query 42 to 62% clustered and over 250% spread. The shape that scales re-checks only the accounts whose access changed, with a slow full sweep as the backstop. That is built now; see "Change-driven re-check" below.

### Change-driven re-check (measured 2026-11-24)

The front no longer re-reads every live account every second (services/authd README, "The sweep"). A statement-level trigger on every table the gate reads writes the keys it touched to `authd.access_changes`; each second the front reads what committed since its last read, by snapshot (`txid >= pg_snapshot_xmax(prev)` UNION ALL `txid = ANY (pg_snapshot_xip(prev))`, exactly the rows not visible in the previous snapshot), and re-checks only the connections that names plus every connection that signed in since the last poll. The full sweep runs once a minute as the backstop, in its own loop, and as soon as it may when a poll cannot tell whom its changes name.

Raw numbers: `mail-device-binding/sweep-db-2026-11-24.csv` (the full sweep, before and after, rerun on one machine and seed), `poll-2026-11-24.csv`, `trigger-writes-2026-11-24.csv`, `revocation-latency-2026-11-24.csv`, and every plan in `change-driven-plans-2026-11-24.txt`. Rerun them with `TestSweepQueryScale`, `TestChangeDrivenPollScale` and `TestRevocationLatency` (services/authd/internal/mailfront). Seed: `sweep-seed.sql` as above, on `ghcr.io/cloudnative-pg/postgresql:18.6-standard-bookworm` in a 1 GiB container (`apps/api/scripts/scale/cli.ts up --scratch dev`), direct connection, 8 cores, everything cached. "Before" ran as `authd` on main (608be608); "after" as `mailfront` with this change's two migrations. The sweep query is the same statement in both, so its buffers match row for row; the time differences between the two runs are noise.

**What the front costs the database, before and after.** "Before" is the 1 Hz full sweep. "After" is the full sweep once a minute plus the poll every second, at 0, 10 and 100 changed accounts a second. The poll's share is the log read plus the re-check of every changed account as if each one had a live connection, the worst case; at 10 live accounts that overstates it.

| Distribution | Live accounts | Before: full sweep at 1 Hz | After: backstop at 1/60 Hz | After, 0 changes/s | After, 10 changes/s | After, 100 changes/s |
| ------------ | ------------- | -------------------------- | -------------------------- | ------------------ | ------------------- | -------------------- |
| clustered    | 10            | 0.03%                      | 0.001%                     | 0.01%              | 0.31%               | 1.2%                 |
| clustered    | 100           | 0.1%                       | 0.003%                     | 0.01%              | 0.31%               | 1.2%                 |
| clustered    | 1,000         | 1.0%                       | 0.02%                      | 0.03%              | 0.32%               | 1.2%                 |
| clustered    | 10,000        | 9.4%                       | 0.18%                      | 0.19%              | 0.49%               | 1.4%                 |
| clustered    | 50,000        | 56%                        | 1.1%                       | 1.1%               | 1.4%                | 2.3%                 |
| spread       | 10            | 0.3%                       | 0.003%                     | 0.01%              | 0.31%               | 1.2%                 |
| spread       | 100           | 1.6%                       | 0.03%                      | 0.03%              | 0.33%               | 1.2%                 |
| spread       | 1,000         | 13%                        | 0.24%                      | 0.25%              | 0.55%               | 1.4%                 |
| spread       | 10,000        | 148%                       | 2.4%                       | 2.4%               | 2.7%                | 3.6%                 |
| spread       | 50,000        | 367%                       | 4.2%                       | 4.2%               | 4.5%                | 5.3%                 |

Core share is `EXPLAIN (ANALYZE)` execution time per second, as above. The backstop column is the after run's full sweep (for example 645 ms clustered and 2.49 s spread at 50,000) over 60 seconds. The before run's p50 at 50,000 was 601 ms clustered and 3.21 s spread; the earlier 2026-11-21 run on another machine measured 688 ms and 2.67 s.

**The poll** (`poll-2026-11-24.csv`, 59 polls a second apart for each rate, with a writer committing that many single-row account changes a second, each in its own transaction; the log pre-filled with an hour of rows at 100 a second, 360,000, the most it holds at that rate). Rerun after the review fixes to the poll's statement, on `pgvector/pgvector:pg18` in a 1 GiB container with the same seed, through Docker's port forwarding, so the wall times are higher than the first run's 2.0 to 2.8 ms p50; buffers and in-server times are what carry over.

| Changes a second | Rows a poll | Log read p50 / p95 (wall) | Log read buffers | Log read in-server | Re-check of that many accounts, p50 / p95 | Re-check in-server | Core share at 1 Hz |
| ---------------- | ----------- | ------------------------- | ---------------- | ------------------ | ----------------------------------------- | ------------------ | ------------------ |
| 0                | 0           | 5.3 / 14.4 ms             | 2                | 0.09 ms            | none                                      | none               | 0.009%             |
| 10               | 10          | 4.6 / 7.8 ms              | 3                | 0.34 ms            | 5.8 / 8.1 ms (240 buffers)                | 1.7 ms             | 0.20%              |
| 100              | 101         | 5.4 / 11.5 ms             | 4                | 0.38 ms            | 14.3 / 18.6 ms (2,407 buffers)            | 11.8 ms            | 1.2%               |

The log read is one `Index Scan using access_changes_txid_idx` from the previous snapshot's xmax, plus one index lookup per transaction that snapshot listed as in progress (`txid >= pg_snapshot_xmax(prev)` UNION ALL `txid = ANY (pg_snapshot_xip(prev))`, the exact complement of "visible in prev"): 4 buffers for 100 rows, whatever the log holds. Its wall time is the round trip. Written as an OR of the two, the same predicate was planned as a sequential scan of the whole log (13 ms, 3,366 buffers over 360,100 rows), which is why it is a UNION ALL. **A long writing transaction elsewhere no longer costs a re-read**: with one held open while 100,000 changes committed behind it, the read took 9 buffers and 0.05 ms in the server (plan 2 in the plans file), where the first version of the statement, which scanned from the snapshot's xmin, took 1,039 buffers and 7.4 ms on the same data. A burst of more than 10,000 changes in one read makes that poll ask the sweep loop for a full sweep and carry on at its own interval, instead of re-checking everyone itself.

The poll's queries are timed without the wait for a pooled connection, so the duty cycle (`nextWait`) paces on the database's time only. The full sweep now also returns each account's mail domain as the gate derives it (`lower(split_part(email, '@', 2))`); it reads that from the `live` step, which already computed it, so it adds no work. Measured as a separate expression it would have been about 12 ms at 50,000 accounts (0.25 µs a row, same buffers); the backstop's figures above are from before this change and were not rerun.

**What the triggers add to writes** (`trigger-writes-2026-11-24.csv`, `EXPLAIN (ANALYZE, BUFFERS, WAL)` inside a transaction that rolls back, median of 6, with the `UPDATE` trigger enabled and disabled):

| Write                                                                 | Without | With    | Trigger | Log rows |
| --------------------------------------------------------------------- | ------- | ------- | ------- | -------- |
| One account (`suspended_at`)                                          | 0.11 ms | 0.28 ms | 0.20 ms | 1        |
| 10,000 accounts in one statement (`payment_hold_at`)                  | 159 ms  | 364 ms  | 209 ms  | 10,000   |
| One domain (`hosts_mailboxes`)                                        | 1.24 ms | 1.51 ms | 0.27 ms | 1        |
| 10,000 domains, only ignored columns (`dns_checked_at`, `updated_at`) | 153 ms  | 460 ms  | 322 ms  | 0        |

A single-row write pays about 0.2 ms, once per statement. The bulk cost is the comparison of the old and new images as `to_jsonb(row) - ignored`, which is proportional to the rows and their width (`core.domains` rows carry DKIM keys); the 10,000-row domain update logged nothing, which is the point of the comparison, but still paid for it. None of these tables is written per message or per sign-in; the bulk writers are billing (payment holds), SSO mirrors and the domain re-check, none on a request path.

**Revocation latency for every path** (`revocation-latency-2026-11-24.csv`). For each of the 43 paths in `gatePaths` that revokes access (every gate column of `authd.accounts`, `authd.managed_accounts`, `authd.required_domains`, `authd.required_exempt`, `core.domains` and `core.join_domains`, and their inserts and deletes), with the real `Sweeper.Run` at its production settings (poll every second, backstop every minute), three runs each, committed at three different points of the poll's second, from `COMMIT` returning to the connection closing. On the small test scratch, not the seed: the time is the poll interval, and the poll and re-check cost a few milliseconds even at 50,000 live accounts (above).

| Table                    | Paths | Fastest | Slowest |
| ------------------------ | ----- | ------- | ------- |
| `authd.accounts`         | 13    | 145 ms  | 850 ms  |
| `authd.managed_accounts` | 4     | 150 ms  | 858 ms  |
| `authd.required_domains` | 4     | 154 ms  | 882 ms  |
| `authd.required_exempt`  | 4     | 164 ms  | 861 ms  |
| `core.domains`           | 10    | 129 ms  | 845 ms  |
| `core.join_domains`      | 8     | 167 ms  | 854 ms  |

The bound is one poll interval plus one poll, about 1.0 s: no path took longer than 882 ms in 129 runs (rerun after the review fixes to the poll). The paths that only re-check (a display name, a pass-through version, a source change on an exemption) and the ones the triggers ignore are in `gatePaths` too, and `TestEveryGateInputReachesThePoll` checks each of the 60 against the real database on every CI run.

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

## 10. PR 2: the device store and verification (design, 2026-11-25)

PR 2 adds the device store, teaches authd to accept a device code as the password, and makes the front attribute and close connections per device. It does not enroll anything: enrollment is PR 4, the CA is PR 3, the console is PR 5. Until PR 4, a device is created only by the API's store function, which a test or an operator script calls.

This is revision 3. Revision 2 folded in an independent adversarial review of revision 1, which (2026-11-25) found one CRITICAL (the device lane skipped `gate.RouteOf`, so a code minted before SSO was required, or left by a deleted connection, kept working) and five HIGH findings (a disabled connection, revocation paths that skip already-suspended rows or have no transaction, Okta hook replays and actor fallback, a mint racing a revocation, near-miss codes reaching the identity provider).

Revision 3 folds in a second independent review (2026-11-25), of revision 2: a connection's `active` flag must not depend on a domain proof the mirror cannot see change, and needs a safe rollout; Okta `application.*` events fire for every app in the customer's Okta, not only i10's; a mint must also lose against a revocation that only raises the epoch; a device must stay in the workspace it was minted in; user-wide OIDC and SAML logout must find a person with no open browser session; `name` collides with the coverage test; and the non-RLS allowlist belongs in CI, not in every process's startup.

### What ships in PR 2 and what waits

| Piece                                                         | PR 2                                              | Later                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Device table, keyed hash of the code, attested identity       | yes                                               | PR 4 fills serial and model from Apple's signature; PR 3 the certificate fingerprint  |
| Minting a code (server-side, returned once to the caller)     | the API store function and an operator script     | PR 4 calls it from enrollment and seals the code; PR 5 adds the console and HTTP API  |
| iPhone and iPad: the code as the IMAP and SMTP password       | yes, end to end                                   |                                                                                       |
| Mac: reading with the Secure Enclave certificate (`EXTERNAL`) | no: a `macos` device's code is refused everywhere | PR 3, with the CA the front trusts; the bind token gains the protocol and certificate |
| Mac: sending with the code while a certificate session lives  | no (same refusal)                                 | PR 3                                                                                  |
| Per-device attribution and closing in the front               | yes                                               |                                                                                       |
| Every access-removing path ends or holds device codes         | yes                                               | PR 5 adds the console's per-device revoke on top of the same store function           |
| A schema-wide RLS allowlist check, run in CI                  | yes (below)                                       |                                                                                       |
| Thunderbird, Outlook, Android, on-screen codes, ActiveSync    | no                                                | later; `platform` is a CHECK list, and an ActiveSync DeviceId column comes with #523  |

Each PR stays shippable alone: after PR 2, nothing in production creates a device except the operator script, and every existing sign-in works as before. authd starts without `MAIL_DEVICE_CODE_KEYS`; every device bind is then `unavailable`.

### The code

`i10dc1.<device id>.<secret>`: the row's UUID as 32 lowercase hex digits, and 32 random bytes as 43 characters of unpadded, strict base64url. Exactly 83 characters. One Go parser shared by authd and the front (`internal/devicecode`), one TypeScript minter, and shared test vectors for both.

**The prefix is reserved.** After the bind token, any password starting `i10dc` goes to the device lane. One that does not parse exactly is refused there (`device_code_malformed`), so a truncated or mistyped code never reaches Clerk or a company's directory, and never spends a failure-budget slot.

**Stored:** `HMAC-SHA256(key, "i10/mail-device-code/v1" 0x00 | 16 bytes of the id | 32 bytes of the secret)` and the key's id (`code_kid`, CHECK 0 to 255), never the code. The ring is `MAIL_DEVICE_CODE_KEYS` (`<id>:<base64 of at least 32 bytes>`, comma-separated), held by the API (mints) and authd (verifies), never by the front. API keys use plain SHA-256, which is enough for a 256-bit secret; the owner asked for a keyed hash here, and it costs one more secret. A missing ring or an unknown `code_kid` is `unavailable` at ERROR, never `invalidCredentials`: an iPhone would ask its owner for a code they have never seen.

**Verified:** by authd, after the bind token and the account row: read by primary key, then `hmac.Equal`. Not cached.

### The table, `authd.mail_devices`

| Column                                                   | Notes                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` uuid primary key                                    | generated inside the store function only (`uuidv7()`), never supplied by a caller, so a deleted device can never come back under its old id                                                                                        |
| `clerk_user_id` text not null                            | FK to `authd.accounts(clerk_user_id)` **ON DELETE CASCADE, ON UPDATE NO ACTION**: every permanent end of an account takes its devices with it, and a person id can never move under a device                                       |
| `email` text not null                                    | the mailbox address at mint, lowercase CHECK; a sign-in is refused unless it equals the account's address now                                                                                                                      |
| `tenant_id` uuid                                         | the account's workspace at mint. A sign-in is refused unless it is the account's workspace now (null-safe), so a domain that moves to another workspace does not carry devices with it. Scopes every revocation and PR 5's listing |
| `platform` text not null                                 | CHECK in (`ios`, `ipados`, `macos`)                                                                                                                                                                                                |
| `device_name`, `model`, `serial` text                    | attested identity and the editable name                                                                                                                                                                                            |
| `cert_sha256` bytea                                      | the Secure Enclave certificate's fingerprint, null until PR 3; a partial unique index where not null                                                                                                                               |
| `code_hash` bytea not null, `code_kid` smallint not null | the keyed hash                                                                                                                                                                                                                     |
| `created_by` text not null, `created_at` timestamptz     |                                                                                                                                                                                                                                    |
| `first_used_at`, `last_used_at` timestamptz              | CHECK both null or both set. An unused code dies 10 minutes after `created_at`; a used one after 90 days without a sign-in                                                                                                         |

`fillfactor` 85. An index on `clerk_user_id`; partial indexes for the prune (`created_at where first_used_at is null`, `last_used_at where last_used_at is not null`). The migration starts with `SET LOCAL lock_timeout = '5s'` (the FK takes a lock on `authd.accounts`).

**Grants:** the API gets DML through the schema's default privileges. authd gets SELECT through the defaults and UPDATE on `first_used_at` and `last_used_at` only. The front gets SELECT on `id`, `clerk_user_id`, `email`, `tenant_id` and `platform` only: no hash, no serial, no name.

**The access-change log:** the four statement triggers, kind `account`, key `clerk_user_id`, ignoring `first_used_at`, `last_used_at`, `device_name`, `model`, `serial`, `created_by` and `cert_sha256` (PR 3 un-ignores it when the front reads it). The front's re-check never reads those columns: the clock rules are bind rules (an open session already passed them at its bind, and `first_used_at` is set by that bind). A revoke is a DELETE, which logs the person, and the next poll closes that device's connections. `gateLogs` and `gatePaths` get the table's rows.

### At sign-in (authd)

```
DN -> bind token (covers the device id) -> account row -> gate.Refusal (RowRefusal and RouteOf's refusal)
   -> password starts "i10dc"?  yes -> device lane, never the resolver, the cache or the failure budget
                                no  -> today's path, unchanged
```

**The whole gate applies, `RouteOf` included.** Every hold the row shows refuses a device code exactly as it refuses a password, and devices resume when the hold lifts. `RouteOf`'s refusals apply too: `sso_required` (an account on a domain that requires SSO and that SSO does not manage yet) and `managed_no_connection`. Entra and Google Workspace accounts are managed with a live connection, so `RouteOf` lets them through; it was only the pass-through verifier, which the device lane never calls, that had nothing to ask. Revision 1 skipped `RouteOf` and was wrong.

**New gate input: the connection is active.** `authd.passthrough_versions` gains `active`, the connection's status is `active`, written by `mirrorPassthrough` in the statement that already bumps `version` (every status change runs it, in the connection's own transaction). `RouteOf` refuses a managed account whose connection says `active = false` (`connection_inactive`): it holds device codes while a connection is disabled, and closes open sessions through the table's existing `connection` trigger.

- **Status only, not the domain proof.** A proof that comes from `/domains` (a sending domain deleted, transferred or displaced) does not reach `mirrorPassthrough` in a transaction today; it lands at the next Team page read or the nightly sync. A flag that read the proof would look authoritative while lagging. The device's mailbox is gated by `core.mailbox_domain_refused` either way. That proof lag is a separate, pre-existing gap for the pass-through lane too.
- **Nullable, no default, NULL refuses nothing.** An API pod from before this PR, still running during the rollout, writes rows without the column and so leaves today's behaviour. The migration upserts a row for every connection (many have none today, read as version 0).

**The device lane**, in order:

1. Parse (refuse `device_code_malformed`). The per-DN throttle applies, as on today's path.
2. Read the row by id (database error: `unavailable`). Refuse when there is no row, `clerk_user_id` differs from the DN's, `email` differs from the account's, `tenant_id` is distinct from the account's, the platform is `macos` (PR 3), the key id is unknown (`unavailable`), or `hmac.Equal` fails.
3. Only after the hash matched: if `first_used_at` is null, `UPDATE ... SET first_used_at = coalesce(first_used_at, now()), last_used_at = coalesce(last_used_at, now()) WHERE id = $1 AND (first_used_at IS NOT NULL OR created_at > now() - interval '10 minutes') RETURNING id`; no row means the code expired unused. The `coalesce` lets Apple Mail's simultaneous first connections all pass. Refuse a used code idle past 90 days, by the server's clock (`now()`), as `locked_until` is. Touch `last_used_at` at most once a day (`WHERE last_used_at < now() - interval '1 day'`; no row is a concurrent touch, not a refusal).

**The bind token binds the device.** The front parses the password with the same function and puts the device id it parsed (or nothing) into the MAC, length-prefixed, under a new label. authd recomputes it with the id it parsed, so the front can never credit a connection to one device while authd verified another. The prefix becomes `i10mf2.`; front and authd are one image in one pod, so they switch together.

### In the front

`Grant` gains the device id. The re-check reads the device rows of the connections that have one by `id = ANY($n)` in the same statement as their accounts, and `gate.DeviceRefusal` (one function, used by authd's bind and by the front, the clock rules being bind-only) closes a connection whose row is gone or no longer matches: `device_revoked`, `device_mismatch`. Everything that closes an account session closes a device session; a device session reconnects with the code it holds when only the epoch or `clerk_updated_at` moved. It is not a pass-through session, so `PassthroughMaxAge` does not apply; it has its own, 24 hours plus up to an hour of jitter (`device_max_age`), so a session that never reconnects still re-binds daily and keeps `last_used_at` ahead of the 90-day prune. `bindtoken.Unwrap` returns the device id its MAC covered, and the bind uses exactly that one; the front records the device id per sign-in attempt, so a retried attempt cannot carry a stale one into `admit`. The re-check returns one row per account with that account's devices beside it, never one row per device.

### Revocation: hold versus delete

The owner's rule (2026-11-21): block when access can come back on its own, delete when the person-to-device or person-to-mailbox link breaks or may be compromised. Every delete is scoped to the workspace it comes from (`tenant_id`), so leaving one workspace never touches a mailbox another hosts.

| Path                                                                                                                            | Device codes                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment hold, Clerk lock, deletion grace, domain hosting off, SSO required, connection disabled or proof lapsed                 | **held** by the gate                                                                                                                                                                                                                                                                                                                                             |
| An admin suspends one mailbox (`lifecycle.ts`, KEEP)                                                                            | **held**; resume restores them                                                                                                                                                                                                                                                                                                                                   |
| Device revoke (the store function; PR 5's console)                                                                              | **deleted**                                                                                                                                                                                                                                                                                                                                                      |
| Member leaves or is removed; directory, SCIM or Google deprovision; `closeMailbox`                                              | **deleted** inside `directoryMailStore.suspend`'s transaction, BEFORE its "already suspended" early return, by an explicit `endDevices` option (false only for the admin's KEEP suspend). `releaseManaged` deletes too                                                                                                                                           |
| Workspace deleted (`suspendWorkspace`), domain removed (`suspendDomain`)                                                        | **deleted** for every matching account, suspended before or not, in one transaction with the suspension                                                                                                                                                                                                                                                          |
| Okta Universal Logout; OIDC back-channel and SAML logout that name the user, not one session                                    | **deleted**, with the epoch raise, in one transaction. OIDC and SAML resolve the person with `identityBySubject`, as Universal Logout does, so a person with no open browser session (a phone on IMAP, the browser closed) is still found. A SAML connection keyed on an attribute rather than the subject cannot resolve a user-wide logout; documented         |
| Okta event hook `user.lifecycle.suspend`, `deactivate`, `delete.initiated`, `user.session.clear`, `user.account.reset_password` | **deleted**, with three guards: a `User` target only (never the actor fallback); each event deleted once (its `uuid` in the replay cache, as Universal Logout does); and only devices created before the event's `published` time plus 60 seconds of skew, where `published` must be finite and within the hook's 6-hour window and no more than 2 minutes ahead |
| Okta `application.user_membership.remove`, `application.lifecycle.deactivate`                                                   | **deleted** (for the user, or for the connection's managed accounts) only when the event's `AppInstance` target is this connection's app; any other app raises the epoch only, as today. Okta sends these for every app in the customer's org                                                                                                                    |
| Okta `update_password`, `user.account.lock`; a Clerk password change                                                            | **kept**. Separate, sealed credentials. An Okta lock neither holds nor deletes them (it only raises the epoch), so a stranger's ten wrong guesses cannot wipe a person's phone. Clerk sends no distinct password-change event, so PR 5 should offer "sign out my mail devices" beside a password change                                                          |
| Clerk ban (`projection/writer.ts`)                                                                                              | **deleted** in `applyUser`'s transaction (the gate refuses meanwhile)                                                                                                                                                                                                                                                                                            |
| Clerk primary address changed, or the account's workspace changed                                                               | devices whose address or workspace no longer match **deleted** in `applyUser`'s transaction (the bind already refuses them)                                                                                                                                                                                                                                      |
| Account deleted, mailbox purged, directory drop                                                                                 | **deleted** by the FK cascade                                                                                                                                                                                                                                                                                                                                    |
| Mailbox reassign                                                                                                                | does not exist (one person, one mailbox); the FK and the `email` check refuse a reused address                                                                                                                                                                                                                                                                   |

**A mint cannot race a revocation.** The mint takes the `credential_epoch` its caller saw (PR 4 and PR 5 read it with the dash session; the operator script reads it first), locks the account row (`SELECT ... FOR NO KEY UPDATE`), and refuses when the gate refuses or the epoch moved; then it inserts. Every revocation above writes `authd.accounts` in the transaction that deletes the devices, accounts first and devices second: a hold sets its column, an epoch-only revocation (the logouts, the Okta hooks) raises the epoch, `releaseManaged` raises it too, and `suspendWorkspace` and `suspendDomain` write every matching row (`suspended_at = coalesce(suspended_at, $at)`), already-suspended ones included, so a concurrent resume cannot slip between the suspension and the delete. So a mint either commits first and its device is deleted, or waits and sees the moved epoch.

**The prune** (hourly, the retention job) deletes unused codes past 10 minutes and used ones idle past 90 days, 1,000 rows per transaction, so one run never logs more than the front's per-poll limit.

### The tenant boundary outside RLS

The API refuses to start when a `core` or `identity` table has no RLS (`assertRlsSubject`, apps/api/src/db/client.ts). `authd` has none on purpose (authd and the front read across workspaces) and is not checked, so a new `authd` table is never a decision anyone writes down. PR 2 adds a CI check over every schema: a table without RLS must be on an explicit allowlist with its reason (the `authd` tables, `pdns`, Drizzle's journal), and the migrations job runs it as `i10_api` against the migrated database, so a missing entry fails the PR. It is not added to the startup check: every API process and CronJob runs that at start, and during a rollout or a rollback an old process with an older allowlist would refuse to start beside a table a newer migration added. The startup check widens only where a failure is a real hole in every version: SECURITY DEFINER functions executable by PUBLIC, in every application schema. Every API read of `authd.mail_devices` goes through one store module that takes the tenant, with a DB test that one workspace cannot list or revoke another's devices.

## 11. PR 3: the device CA and the Mac lane (design, 2026-11-25)

PR 3 runs a certificate authority for devices, teaches the front to read a Mac's Secure Enclave certificate on 993 and sign it in with `AUTHENTICATE EXTERNAL`, and lifts PR 2's `device_platform_refused` for `macos` under the section 6 rules. It enrolls nothing: PR 4's enrollment service is what puts the ACME and SCEP payloads on a device. Until then a Mac's key is bound only by an operator, for a probe.

This is revision 5. Revision 1 went through an independent adversarial review (2026-11-25), which found one CRITICAL (step-ca drops webhook secrets written in `ca.json`, so HMAC webhook authentication cannot be configured without its admin database) and six HIGH findings (`provisionerName` absent from most webhook bodies; stale SMTP liveness after a key change; bind token v3 not separating `EXTERNAL` from a password; SCEP's default template putting the CN into a DNS SAN; the ACME binding transaction violating a CHECK, inverting the lock order and bricking on step-ca's retry; dual-stack clients splitting IMAP and SMTP across address families). A second independent review (2026-11-25) of revision 2 found one CRITICAL (Bun 1.4.2 cannot read a TLS client certificate, so the mutual-TLS fix could not be built) and five HIGH (a stolen intermediate key could pose as step-ca and bind a key during an enrollment; the per-serial permit index blocked re-enrollment for a day; SCEP permits cannot name a device row that does not exist yet; malformed `i10dc` passwords fitted no token mode; the certificate session cap leaked onto password sessions). Separately, reading Stalwart v1.2.0 showed that it turns **every** failed LDAP bind into an authentication failure, so authd's `unavailable` never reaches a client as a temporary error. A third independent review (2026-11-25) of revision 3 found three blocking issues: the front's SMTP `454` could not be sent where revision 3 put it (by `AUTH LOGIN`'s password step the verb is already with Stalwart, whose cancel answer is a permanent `501`); URL-path hook tokens leak through step-ca's unauthenticated `GET /provisioners` and its error logs; and the threat statement claimed a separation the cluster does not have. A fourth review (2026-11-25, of revision 3, resumed after a quota stop) confirmed those and added the rules in "Revision 5 rules" at the end of this section, which override anything above they contradict. All are folded in.

### What was read, not assumed

- **step-ca v0.30.2** is the current release (2026-03-23; read at the tag, `/tmp/stepca-src`).
  - An ACME provisioner runs `ENRICHING` and `AUTHORIZING` webhooks (`authority/provisioner/acme.go:330`); a SCEP provisioner runs `SCEPCHALLENGE`, `AUTHORIZING` and `NOTIFYING` (`scep.go:126`, `:192`, `:424`). **ACME has no `NOTIFYING`.**
  - An `AUTHORIZING` request carries the certificate about to be signed (template: subject, SANs, extensions), the public key as SubjectPublicKeyInfo DER, `notBefore`/`notAfter`, and for `device-attest-01` the attested `permanentIdentifier`, the serial (`authority/tls.go:1063`). It runs before signing. It carries **no provisioner name and no SCEP transaction id**; only `SCEPCHALLENGE` sets `provisionerName` (`scep.go:160`).
  - Webhook URLs must be `https` (`webhook.go` `Validate`). The request is retried once on a transport error or a 5xx.
  - ⚠ **`Webhook.Secret`, `BearerToken` and `BasicAuth` are `json:"-"`** (`webhook.go:140`). They are filled only from the admin database (`provisioners.go:570`), so a secret written in `ca.json` is silently dropped and the HMAC is computed under an empty key. Running the admin database would add the remote management surface this design refuses. The webhook `url` is plain JSON (`webhook.go:136`), so each webhook carries a secret **in its URL path** instead (below).
- **Bun 1.4.2 cannot read a TLS client certificate:** `https.Server` is `http.Server`, request sockets are not `TLSSocket`s, `getPeerCertificate()` is missing, and `Bun.serve` exposes no peer certificate and does not reload `tls` (`bun-types` `nodejs-compat.mdx:52`, `serve.d.ts`). Mutual TLS to the API is therefore not an option.
- ⚠ **Stalwart v1.2.0 flattens every failed bind.** Its LDAP user bind returns `success().is_ok()` (`crates/directory/src/backend/ldap/lookup.rs:371`), so any non-success result, `unavailable` and `busy` included, becomes `AuthEvent::Failed`: SMTP `535 5.7.8 Authentication credentials invalid` (`crates/smtp/src/inbound/auth.rs`), IMAP `NO [AUTHENTICATIONFAILED]`. Only an error Stalwart raises itself gets SMTP `454`. So **authd's "our faults are unavailable, never invalid credentials" stops at Stalwart** for every lane, PR 1's and PR 2's included (a pre-existing gap, filed separately). Inside PR 3, any refusal that must look temporary to the client is answered by the front, before forwarding.
  - SCEP's default template copies the CN into a DNS SAN (`scep/authority.go:269`), and ACME canonicalises the CN into the CSR's DNS names (`acme/order.go:554`), so both provisioners need templates of their own.
  - `NOTIFYING`'s errors are discarded (`scep/api/api.go:420`): a failed notification still hands the device its certificate. The SCEP transaction id is the client's choice (`:379`).
  - Leaf lifetimes are not clamped to the intermediate's (`cas/softcas/softcas.go:83`).
  - A certificate without step-ca's provisioner extension falls to the `noop` provisioner, which allows `/renew` and `/rekey` without any webhook (`authority/authorize.go:317`). ACME certificates with `disableRenewal` and SCEP certificates are refused there, as long as `disableSmallstepExtensions` stays off.
  - ACME without external account binding (Apple's payload has none) writes accounts, orders and unredeemed nonces to its database with no expiry (`acme/db/nosql/*.go`).
- **Apple's ACME payload has no renewal key** (`com.apple.security.acme.yaml`): a manually installed payload is never renewed, and a new one makes a new key. `Attest` works only on Apple silicon (ignored on T2, must be false before it), so **only Apple silicon Macs** can pass `device-attest-01`.
- **`mail.i10.tech` is dual-stack** (A and AAAA, 2026-11-25).

### The binding is the key, not the certificate

`authd.mail_devices.cert_sha256` (PR 2, all null in production, read by no production code) is renamed `cert_key_sha256`: SHA-256 of the certificate's SubjectPublicKeyInfo DER, 32 bytes (CHECK), unique where not null.

1. **It is known before issuance.** The ACME `AUTHORIZING` webhook sees the public key and the attested serial and binds the key in the transaction that says yes. ACME never reports a fingerprint.
2. **The CA's signature is never the authority.** The front honours a certificate only when its key is bound to a live device row. A certificate for an unbound key opens nothing, and so does one minted with a stolen CA key: the key it names is unbound, or bound and held only by a Secure Enclave, and the TLS handshake proves possession.
3. **Revocation is a row change.** Delete the row, or change or clear the key, and the access-change log closes that device's sessions at the next poll. No CRL, no OCSP; expiry revokes nothing.

### The CA

- **step-ca 0.30.2**, image pinned by digest, one replica in `i10-prod` (`Recreate`), badger on a `psl-zfs` volume (ACME accounts, orders and nonces; nothing is needed after an enrollment, so the volume may be wiped). Non-root, read-only root file system, no capabilities. No admin database (`enableAdmin` off).
- **Two provisioners and nothing else.** No JWK, OIDC, X5C or admin provisioner, no remote management, `disableRenewal` on both, `disableSmallstepExtensions` never set.
  - `apple`: ACME, `device-attest-01` only, attestation format `apple`. Its own template: subject `CN=<serial>` only, the permanent identifier SAN only (never the CSR's DNS names), `clientAuth` only, lifetime below. An `AUTHORIZING` webhook.
  - `apple-scep`: SCEP, an RSA decrypter. Its own template: subject CN only, **no SANs**, `digitalSignature` and `keyEncipherment`, an explicit EKU of `emailProtection` and never `clientAuth` (the enrollment identity only signs and decrypts CMS; a certificate with **no** EKU would pass Go's `clientAuth` check, `crypto/x509/verify.go:1011`), 7 days. `SCEPCHALLENGE`, `AUTHORIZING` and `NOTIFYING` webhooks.
- **Every issuance asks the API first** (`AUTHORIZING` on both), and the API says yes only to an open **certificate permit** (below).
- **The webhooks.** Four, each with its own `id` (`X-Smallstep-Webhook-ID`). ⚠ **No secret is ever in step-ca's config.** step-ca serves its provisioners, webhook URLs included, to anyone at `GET /provisioners` (`api/api.go:401`; `Webhook.URL` is plain JSON), and writes the full URL into its logs on any transport error (`*url.Error` wrapped into the access log's `error` field, `api/log/log.go:63`, and `webhook.go`'s close-body `log.Printf`). So each webhook URL is `https://127.0.0.1:9443/<kind>` on a **relay sidecar** in the step-ca pod (`cmd/cahookrelay`, a few dozen lines of Go in the authd module, the same image): it serves TLS on loopback with a `localhost` certificate from a namespace-local cert-manager CA used for nothing else, which step-ca trusts through `SSL_CERT_FILE` (read once at start); it forwards only the four known paths, adds `Authorization: Bearer <token>` from its own Secret (`prod_device_ca_hooks` in Doppler, mounted only into the relay container), and calls the API's hooks listener. The API holds SHA-256 of the token (`CA_HOOK_TOKEN_HASH` in `prod_api`) and compares in constant time; a missing or wrong token, a wrong id for the path, or a body `timestamp` more than 60 seconds off is a 404. The API serves the hooks on a second `Bun.serve` listener, `:3443`, with its **own `fetch` handler** (never `app.fetch`, so no main route is reachable there and the main request logger never sees it), logging only the hook kind and never a header; server-authenticated TLS for `i10-api-ca-hooks.i10-prod.svc` from the same namespace CA (10-year leaf, because `Bun.serve` cannot reload `tls`). Each handler bounds itself to 5 seconds (`SCEPCHALLENGE` has no timeout on step-ca's side). NetworkPolicies narrow callers to step-ca but are only additive (`i10-prod` already lets Traefik and CNPG reach every pod), so they never decide. Traefik never routes `/provisioners`.
- **Public surface: `ca.i10.tech`**, DNS-only (no Cloudflare proxy, so bot rules never meet Apple's clients), through Traefik with the existing wildcard certificate, path-scoped to `PathPrefix(/acme/apple/)` and `Path(/scep/apple-scep) || PathPrefix(/scep/apple-scep/)` (never `/roots`, `/provisioners`, `/1.0/*`, `/renew`, `/rekey`, `/revoke`, `/health`), with `RateLimit` and `InFlightReq` middlewares so an outsider cannot fill the badger volume. Traefik keeps `Host: ca.i10.tech` (step-ca checks JWS URLs against it) and reaches step-ca over HTTPS, verifying its certificate against the device root for its service name. `ca.json` `dnsNames` holds only that service name. NetworkPolicies: only Traefik reaches step-ca; step-ca's egress is the API's `:3443` and DNS only. A disk-usage alert on the volume.
- **The device CA is a trust anchor only in the front and Traefik.** No profile installs it as trusted, and no device needs it to. The intermediate is name-constrained to step-ca's service name.

**Lifetimes and renewal (section 8's open question).**

| Certificate                | Lifetime | Notes                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root                       | 20 years | Signs the intermediate once; **its key is then destroyed** (below)                                                                                                                                                                                                                             |
| Intermediate               | 10 years | step-ca's signing key. At year 7 a new root and intermediate are made, the front and Traefik trust both, step-ca cuts over, the old root leaves at year 10. The webhook refuses a leaf whose `notAfter` passes the intermediate's                                                              |
| SCEP decrypter (RSA 3072)  | 10 years | No SANs, `keyEncipherment`; rotated with the intermediate                                                                                                                                                                                                                                      |
| Mac Secure Enclave (ACME)  | 3 years  | Nothing renews it. Renewal is re-enrollment, which mints a **new device row** with its own code and key, so the old row keeps working until the person has picked the new certificate in Mail; the old row is then revoked (PR 4, PR 5). Revocation is the row, so a long life weakens nothing |
| Enrollment identity (SCEP) | 7 days   | Used only inside one enrollment, to encrypt the final profile (PR 4)                                                                                                                                                                                                                           |

**Where the keys live, and who can read them**, said before any is created:

- **Root key:** made on the operator's machine in a throwaway directory, used once to sign the intermediate (and the decrypter), then destroyed. No device trusts the root, so a new CA is just a new pair that the front's bundle trusts beside the old one. Nothing in the cluster or Doppler ever holds it.
- **Intermediate key (ECDSA P-256) and the SCEP decrypter key:** a Doppler config of their own, `prod_device_ca`, synced to one Secret, `i10-device-ca`, mounted only into step-ca. Readable by the owner's Doppler login, the config's read-only service token (`doppler-token-i10-device-ca`), and anyone who can read Secrets in `i10-prod`. Not the API, authd, the front or Stalwart.
- **What a stolen intermediate key buys alone:** certificates nobody honours. It cannot call the hooks (the bearer token lives only in the relay's Secret), so it cannot bind a key. ⚠ It could mint a server certificate for the relay's `localhost` name, but only the relay's namespace CA, not the device root, vouches for that name to step-ca; and the device intermediate is name-constrained to step-ca's own service name, which is also what stops it minting one for `i10-api-ca-hooks.i10-prod.svc` (step-ca's webhook client trusts its own roots and intermediates too, `ca/ca.go:660`). The year-7 intermediate keeps the constraint.
- ⚠ **What step-ca is trusted with, and who else can bind a key.** The API cannot check Apple's attestation itself: `AUTHORIZING` carries only the attested serial and the key. So these can bind a key of their choosing to a Mac **that is enrolling at that moment** and, with the intermediate key, sign in as it: step-ca's process; anyone who can read Secrets in `i10-prod` (every key, token and the API's database password are there together, so the separate Doppler configs only contain a leaked Doppler token), **which includes Traefik**: the Traefik chart's cluster-wide RBAC lets it read and cache every Secret, and it terminates TLS for `ca.i10.tech`, so it also sees the nonce below (found in the #537 review; narrowing Traefik's RBAC is a psl-repo follow-up); anyone with DML on `authd.mail_devices` (the API's role), who can write `cert_key_sha256` directly. **Shrunk by a per-permit nonce:** PR 4 puts 16 random bytes, base64url, as an `OU` in the ACME payload's `Subject`, delivered only inside the profile encrypted to the device; the permit stores its SHA-256; the `apple` template copies the CSR's `OU` into the certificate, and `AUTHORIZING` requires it to match the permit. A forged hook body now needs a secret only the device, step-ca's process, the API and the TLS terminator in front of step-ca (Traefik; Cloudflare too while the record is proxied) see, and a late ACME order from one of a Mac's mailboxes can never bind to another mailbox's open permit for the same serial. **And detected:** `AUTHORIZING` for an `authorized` permit with a different key clears the bound key, deletes its liveness rows and logs at ERROR, so a real Mac arriving second undoes an attacker who arrived first. AWS KMS for the intermediate was considered and not chosen: it would not close this (step-ca's process still signs), it adds an AWS dependency and in-cluster credentials, and KMS cannot do SCEP's PKCS#1 v1.5 decryption.

### Certificate permits

`authd.mail_device_cert_permits`, PR 4's handle on the CA, written by the API (PR 4's enrollment; the operator script until then), read only by the webhook handlers:

| Column                                   | Notes                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` uuid                                | `uuidv7()`                                                                                                                                                                                   |
| `clerk_user_id` text not null            | FK to `authd.accounts` ON DELETE CASCADE: the lock order's first row, and the cascade on account end                                                                                         |
| `device_id` uuid                         | FK to `authd.mail_devices(id)` ON DELETE CASCADE. Required for `acme`, null for `scep` (CHECK): PR 4's SCEP step runs before the device row and its code exist, and the code is never stored |
| `kind` text                              | CHECK in (`acme`, `scep`)                                                                                                                                                                    |
| `status` text                            | `open` → (`scep`: `challenged` →) `authorized` → (`scep`: `notified`), or `expired`; CHECK                                                                                                   |
| `serial` text not null                   | the serial Apple signed in phase 2 (PR 4); ACME permits also hold `nonce_sha256`, the hash of the `OU` nonce (above)                                                                         |
| `challenge_hash` bytea                   | SCEP only: SHA-256 of a 32-byte random challenge; never the challenge                                                                                                                        |
| `key_sha256` bytea                       | the CSR's key: set at `SCEPCHALLENGE` (SCEP) or `AUTHORIZING` (ACME); what a retry is recognised by                                                                                          |
| `transaction_id` text                    | SCEP, from `SCEPCHALLENGE`                                                                                                                                                                   |
| `issued_cert_sha256` bytea               | SCEP, from `NOTIFYING`, best effort (step-ca ignores its failure); PR 4 matches phase 4 by key instead                                                                                       |
| `expires_at`, `created_at`, `updated_at` | expires 10 minutes after creation                                                                                                                                                            |

Partial unique indexes: one **open** ACME permit per serial (so the webhook knows which row a Mac's key belongs to; creating one first marks any expired open permit for that serial `expired`, in the same transaction), `transaction_id` and `key_sha256` where set. An index on `expires_at` for the retention job, which deletes permits a day past expiry. `authd` and `mailfront` get no access (an explicit REVOKE, since `authd`'s schema defaults would grant SELECT); grant tests assert it.

**The handlers (API, `:3443`).** Lock order is PR 2's: read the permit unlocked, then lock `authd.accounts` (`FOR NO KEY UPDATE`), then `authd.mail_devices`, then the permit, and re-check it. No network call while a lock is held.

- **ACME `AUTHORIZING`:** the open ACME permit for the attested serial, unexpired; refuse unless the template's CN equals it, its `OU` hashes to the permit's `nonce_sha256`, there is no DNS, IP, email or URI SAN, the EKU is `clientAuth` only, `notBefore` is within 5 minutes of now and `notAfter` at most 3 years (plus 5 minutes) ahead and inside the intermediate's; the row must be `macos`, have no key yet, and pass the mint-time gate. Then set `cert_key_sha256`, claim the first use (`first_used_at` and `last_used_at` both `coalesce(…, now())`, as the CHECK requires), mark the permit `authorized` with the key, answer `allow: true`. **Idempotent:** a retry (step-ca retries once) finds the `authorized` permit by serial and key within its life, re-runs the gate, and allows only if the row's key is still that key. Binding the key is the Mac's first use, so the code's ten-minute death does not depend on how long the two clicks take.
- **SCEP `SCEPCHALLENGE`:** `open` permit by `sha256(challenge)`, unexpired, CSR CN equal to its serial, the account passing the gate; set `challenged` with the transaction id and the CSR key's hash. Idempotent: a `challenged` permit with the same transaction id, key and serial allows again.
- **SCEP `AUTHORIZING`:** by key (no transaction id in the body): a `challenged`, unexpired permit with this key, the gate, template checks as above with 7 days and no `clientAuth`; set `authorized`. Idempotent like ACME.
- **SCEP `NOTIFYING`:** `authorized` permit with this transaction id and key; store the certificate's hash. A single indexed UPDATE. A `NotifyFailure` body (no certificate, `scep/api/api.go:413`) is logged and changes nothing.
- **Anything else:** `allow: false`. Our faults answer 5xx (step-ca then refuses the device; it never issues on an error).

### The front reads client certificates (993 only)

- **Two TLS configs.** 993 gets `tls.RequestClientCert` with `ClientCAs` naming the device CA, so a client with no matching identity sends nothing; 465 never asks. The trust pool is an `atomic.Pointer` read through `GetConfigForClient`, reloaded from a mounted ConfigMap like the certificate files (marked optional, and absent on the internal StatefulSet). With no bundle, 993 asks for nothing and `EXTERNAL` is never offered: the code ships inert.
- **Verified after the handshake:** chain to the bundle (`x509.Verify`, `clientAuth`, now), and the leaf must itself list `clientAuth` in its EKU and carry no DNS or IP name (so neither a no-EKU certificate nor step-ca's own TLS certificate gets past here; the binding would refuse them anyway), then `sha256(SPKI)`. A failure is logged and treated as no certificate. The handshake limit allows for `accountsd`'s keychain prompt (section 3).
- **`AUTH=EXTERNAL` is added to the greeting and `CAPABILITY` only for a connection whose certificate verified** (Apple prefers it whenever offered, probed).
- **`AUTHENTICATE EXTERNAL`**, with or without an initial response (`+` then one line; `*` cancels): the authorization identity must be empty or the account's own address. The front reads the device by key (`projection.DeviceByCertKey`, indexed; the role gains SELECT on `cert_key_sha256`) and its account as for a login; the row must be `macos`. It then forwards an `AUTHENTICATE PLAIN` of its own for that address with a bind token in `external` mode. No row, an unbound key or another platform: `NO [AUTHENTICATIONFAILED]`. A database error: `NO [UNAVAILABLE]`.
- **Only device sessions carry a certificate.** A certificate-verified IMAP session in `external` or `device_code` mode records the key on its `Grant` and ends at `cert_session_max_age`, 60 minutes plus up to 5 of jitter. A `password`-mode sign-in ignores any certificate the connection presented: no key in the token, the Clerk or pass-through rules for its life (`PassthroughMaxAge` stays 15 minutes).
- **The front answers SMTP AUTH's prompts itself, and forwards once.** Until now the front forwarded `AUTH LOGIN` (and `AUTH PLAIN` without an initial response) to Stalwart and relayed its `334` prompts, so by the time the password arrived, Stalwart was mid-exchange and the only way out was `*`, which Stalwart answers with a permanent `501 5.7.0 Authentication cancelled.` (`crates/smtp/src/inbound/auth.rs`), relayed to the client before the front could stop it. That already breaks PR 2's "temporarily unavailable" for a lookup failure at `AUTH LOGIN`. So the front answers every `334` itself (`AUTH LOGIN`'s two prompts; `AUTH PLAIN`'s empty one), holds the credentials, runs every pre-check (the login lookup, a `macos` code's device row and the Mac SMTP liveness row, below), and only then forwards **one** `AUTH PLAIN <initial response>` of its own, LOGIN rewritten as PLAIN. Any of our faults, or a missing liveness row, is answered `454 4.7.0` by the front and nothing reaches Stalwart. Tests cover LOGIN, PLAIN with and without an initial response, a cancel, and a lookup failure. The liveness read is SELECT on `authd.mail_device_cert_binds` (no secrets in it); authd still decides: a send the front lets through is checked again at the bind.

### Bind token v3: the front attests, authd decides

`i10mf3.` with its own MAC label (`i10-mailfront-bind-token/v3\x00`), one fixed-length binary payload with no optional encodings: key id, expiry, nonce, then under the MAC a **mode** byte, the **protocol** (IMAP or SMTP; any other value refused), the **client address** (4 bytes for IPv4, 16 for IPv6, with a family byte; an IPv4-mapped IPv6 address refused), a **certificate key** (presence byte and 32 bytes, zeroes when absent), and the **device** (presence byte and 16 bytes), plus the user id as before. Reserved bytes must be zero. `Unwrap` enforces a strict partition:

| Mode          | Real password                                     | Device                                                                                                               | Certificate key   | Protocol |
| ------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| `password`    | non-empty, not starting `i10dc`                   | absent                                                                                                               | absent            | any      |
| `device_code` | starts `i10dc`; if it parses (`devicecode.Of`)... | ...present and equal to the code's id; if not, absent (authd refuses it `device_code_malformed`, under the throttle) | present or absent | any      |
| `external`    | exactly empty                                     | present (the row the front found)                                                                                    | present           | IMAP     |

So a token for one mode never opens behind another's password, PR 2's "the device is read from the password on both sides" still holds for codes, and `handleBind` routes `external` to the device lane **after** the account row, `gate.RowRefusal` and `gate.Refusal` (exactly where codes enter today, `ldapsrv/bind.go`), and before any verifier, cache, flight or failure budget. v2 is refused; front and authd switch together.

⚠ **`EXTERNAL` moves part of the authentication into the front.** A code or password is checked by authd. A Mac's certificate is proved by the TLS handshake, which only the front sees, so for `external` authd trusts the front's MAC that the key was proved. PR 1's "a key leak alone signs nobody in" no longer holds for Macs: the bind-token key plus a connection to Stalwart's loopback listeners signs in any bound Mac, without waiting for it to connect. Those listeners are reachable only inside the pod, where the key already is, so the attacker this adds is one who runs code in the pod (who already sees every password in transit). The README's bind-token section must say so.

### authd's rules for a `macos` device

`gate.DeviceRefusal` refuses a `macos` row with no key (`device_cert_missing`), so a cleared key ends every session of that device, SMTP included. The device lane then adds:

| Bind                | Rule                                                                                                                                                                               | Refusal                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| IMAP, `external`    | the row is `macos` and the token's key equals the row's (constant time); no code parsing, no key ring                                                                              | `device_cert_mismatch` (invalid credentials)    |
| IMAP, `device_code` | the code matches and the token carries a key equal to the row's; a code alone is refused                                                                                           | `device_cert_required` (invalid credentials)    |
| SMTP, `device_code` | the code matches and a certificate-verified IMAP bind of this device **under its current key** succeeded from the same address (IPv4 exactly, IPv6 the same /64) within 75 minutes | `device_cert_session_missing` (**unavailable**) |
| iPhone and iPad     | unchanged; a `macos`-only rule never applies; protocol and address are logged                                                                                                      |                                                 |

Every successful `macos` bind (either protocol) claims the first use if still unclaimed and touches `last_used_at` daily, so an active Mac is never pruned.

The SMTP rule must look temporary to Mail, so that it keeps the message in its Outbox and retries until IMAP connects. Stalwart would turn authd's `unavailable` into `535` (above), so **the front answers `454 4.7.0` itself** when the liveness row is missing (above); authd's refusal is the backstop, for the race where the row lapses between the two reads. Whether Mail then waits quietly or shows an alert on `454` is for the real-device probe.

**Same address, on a dual-stack host.** `mail.i10.tech` has A and AAAA records, and IMAP and SMTP each pick their family. macOS prefers IPv6 when it works, so both usually agree, but a network with broken IPv6 can split them. The rule stays strict (without it a code dug out of Keychain sends from anywhere while the Mac is online), and authd logs the refusal with both families seen, so the PR 6 probe on a real dual-stack network can measure it. `AUTHD_MAC_SMTP_SAME_ADDRESS` (default `true`) turns the address part off if real devices show it fails.

**How every pod knows "the Mac is online".** A successful `macos` IMAP bind with a key upserts `authd.mail_device_cert_binds` (`device_id` FK cascade, `addr` the /32 or /64, `key_sha256`, `bound_at`; primary key `(device_id, addr)`; at most one write per row every 5 minutes, an index on `bound_at` for the prune, fillfactor 80, and at most 8 address rows per device, the oldest replaced). ⚠ **Lock order:** authd writes it only in single autocommit statements, never in a transaction that also touches `authd.mail_devices` (the ACME handler and the operator script lock the device row, then delete these rows; the reverse order would deadlock); the cap is one statement too, and the PR carries db-guard's concurrency evidence. The SMTP rule is one primary-key read that also requires `key_sha256` to equal the row's key. Every Stalwart pod's authd shares it through Postgres. Changing or clearing a device's key deletes its rows in the same transaction (the ACME handler and the operator script). authd may SELECT, INSERT, UPDATE and DELETE it (the per-device cap); the front may SELECT it (the `454` above); the API prunes rows older than a day. The front's 60-minute cap (plus jitter, plus the 5-minute write throttle) keeps every open certificate session inside the 75-minute window, and the front stays read-only. A `macos` SMTP session gets the same 60-minute cap rather than relying on Stalwart's `maxDuration`.

### The store and the access-change log

- `cert_key_sha256` is **un-ignored** by the four triggers: binding, changing or clearing a key logs the person. The re-check closes a certificate session whose key is no longer the row's, and every session of a `macos` row with no key (`DeviceRefusal`, above). Each `macos` SMTP session records the row's key at admission (the front reads it with the device at sign-in), so a key change closes those too (`device_key_changed`).
- A deleted device takes its key, permits and liveness rows by cascade. Every PR 2 delete path is unchanged.
- The two new tables are on the CI non-RLS allowlist with their reasons, and have no access-change triggers: neither gates an open session by itself (the key on the device row does).
- The operator script gains `bind-key <device> <certificate.pem>` and `unbind-key <device>`, which set or clear the key, claim the first use, and delete liveness rows, all in one transaction with PR 2's lock order.

### What ships in PR 3, and how it rolls out

Four steps, in order. The database goes first because the Stalwart and workloads Argo apps sync separately, and new authd code reading `cert_key_sha256` must never meet a database without it (old code reads no such column, so the rename alone is safe).

1. **Migrations PR:** the rename, the two tables, grants and REVOKEs, the triggers, indexes, with `schema.ts` and the RLS allowlist, so CI's generate and allowlist checks pass alone. Merged, applied and checked in prod before step 2.
2. **Code PR:** token v3, the front's certificate reading and `EXTERNAL`, authd's rules, the webhook handlers and their listener (off until its certificate is mounted), `cmd/cahookrelay`, the front's own SMTP AUTH exchange, retention, the operator script. With no trust bundle and no CA, nothing changes for anyone: Macs stay refused (no key is ever bound).
3. **Secrets, by hand:** the CA made on the operator machine (root key destroyed), `prod_device_ca` and `prod_device_ca_hooks` (the relay's bearer token; its hash goes to `prod_api`), their service token Secrets.
4. **Deploy PR:** step-ca with the relay sidecar, its volume, ConfigMap, Secrets, NetworkPolicies, the Traefik route and middlewares, the `ca.i10.tech` DNS record, the hooks listener's issuer and certificate, the front's trust bundle.

### What PR 3 proves alone, and what waits for a real Mac

- **On prod, with a throwaway account:** a throwaway `macos` device row; a P-384 key and certificate for it **issued by the real intermediate** inside the step-ca pod, bound with the operator script; IMAP `AUTHENTICATE EXTERNAL` (with and without an initial response) through the front signs in (authd logs `source: cert`); the code over IMAP `LOGIN` is refused; SMTP with the code is accepted from the same address and answered `unavailable` from another address, after the window and after `unbind-key`; `unbind-key` closes the open IMAP and SMTP sessions within about a second; a certificate from another CA is never offered `EXTERNAL`; `ca.i10.tech` answers only the two prefixes; a hook URL with a wrong token is a 404; a webhook with no permit answers `allow: false`. The probe certificate has no provisioner extension (step-ca's `noop` would renew it in-cluster), so its key is destroyed after the probe and the row deleted.
- **PR 4 and PR 6, on a real Mac (Apple silicon):** the ACME payload passes `device-attest-01` against `ca.i10.tech` and `AUTHORIZING` binds the Secure Enclave key; Mail with the two clicks signs in with `EXTERNAL`; Mail sends with the code while online and the send waits quietly in the Outbox when IMAP is off; the dual-stack split is measured; `accountsd`, iPhone Mail, Outlook and Thunderbird handle 993's certificate request without a prompt. PR 4 must not put an ACME payload in iPhone or iPad profiles (the handler refuses non-`macos` rows) and must refuse Intel Macs up front.

### Revision 5 rules

From the fourth review; each overrides the text above where they differ.

- **The certificate's serial is checked too, not only its key.** The front puts the leaf's subject CN (bounded to 64 bytes) in bind token v3 under the MAC beside the key. authd requires it to equal `authd.mail_devices.serial` whenever the row has a serial (PR 4 sets it from Apple's signature). So someone who can write a key into a row (the API's database role) still cannot sign in with a genuine certificate from their own Mac, whose CN is their serial.
- **Only a `macos` row ever carries a certificate key.** The front attaches the key to a token, and to a session's `Grant` with the 60-minute cap, only in `external` mode or for a `device_code` whose row is `macos`. `bindtoken.Unwrap` refuses a key on an SMTP token, and authd refuses a key on a non-`macos` row. An iPhone code sent on a connection that happens to present a Mac certificate behaves exactly as without it.
- **The front's `454` never says more than authd would.** The front answers the Mac SMTP rule's `454` only when the account row, `gate.Refusal`, the device row, `gate.DeviceRefusal` (person, address, workspace, a non-null key) all pass and only the liveness row is missing; anything else is forwarded, so authd's throttle and refusal decide, and an unknown device id looks like any wrong password. At most 3 such `454`s per connection, then the front closes it.
- **The same-address switch lives in both processes.** `AUTHD_MAC_SMTP_SAME_ADDRESS` and `MAILFRONT_MAC_SMTP_SAME_ADDRESS` default `true` and are set together in the StatefulSet; the front's liveness read and authd's switch in lockstep between `(device, addr, key)` and `(device, key)`.
- **Permit handlers.** Every retry branch re-runs every check the first call ran: the template checks, `expires_at > now()`, the challenge hash (SCEP), and the account and device gate (person, address, workspace, serial, the first-use window). Creating an ACME permit locks `authd.accounts`, then the device row, and only then marks earlier open permits for that serial `expired` (and supersedes the same person's own open permit, so a retried enrollment is not blocked for ten minutes). The "different key on an authorized permit" detection finds the permit by its nonce (`nonce_sha256` has its own unique index) and acts only when the nonce matches, so it cannot be used to wipe a key. `transaction_id` is unique only among `challenged` and `authorized` SCEP permits, and a unique violation is `allow: false`, never a 500.
- **The relay and the hooks listener.** The relay's certificate carries `IP:127.0.0.1` as well as `DNS:localhost` (step-ca dials the IP). The API accepts a comma-separated `CA_HOOK_TOKEN_HASHES`, so the relay's token rotates without an outage, as the bind-token keys do. The `:3443` listener caps bodies at 64 KiB before parsing, is stopped with the main server on `SIGTERM` before the database pool closes, and its environment is mirrored in `check-env.yaml`. A NetworkPolicy lets the step-ca pod reach `i10-api` on 3443 (the existing internal policy allows only 3001).
- **Small ones.** The liveness cap of 8 rows per device is a separate autocommit `DELETE` after the upsert (one statement's CTEs share a snapshot and cannot see each other's rows). `AUTHENTICATE EXTERNAL` accepts RFC 4959's `=` (an empty initial response) and an empty continuation line, and refuses a NUL in the authorization identity. On the prod probe, SMTP from another address or after the window is the front's `454`, and after `unbind-key` it is `535` (the device row has no key).

### Found in the step 2 code review (#535)

- **No TLS resumption on 993 while a certificate may be asked for.** Go puts a resumed session's client certificate back from the ticket with no new `CertificateVerify`, so a copied TLS session cache would sign a Mac in without its Secure Enclave key for as long as Go honours the ticket (7 days). The config that asks for a certificate sets `SessionTicketsDisabled`, and the front also treats a resumed session's certificate as no certificate. Every 993 handshake with a bundle loaded is a full one.
- **The Mac SMTP `454` comes before the code's secret is checked, and that is accepted.** The front holds no device-code keys (they are authd's, and the front parses untrusted bytes), so it cannot check a code's secret. A well-formed code with the right device id and a wrong secret therefore gets the front's `454` while the Mac is offline, where authd would refuse it. That tells the sender the device exists, is a Mac on this account with a key bound, and is offline from this address. It needs the device id, a UUIDv7 that cannot be scanned for (it is the first half of a code), it gives nothing toward the secret, and it is capped at 3 per connection. Reordering authd would change nothing a client sees, since Stalwart flattens every failed bind into `535`.
- **No client address, no Mac SMTP sign-in.** A zero prefix is the liveness read's "any address", so when the same-address rule is on and the front has no client address, it answers `454` before reading liveness.
- **#536: the "different key on an authorized permit" branch acts only while the permit lives.** Past `expires_at`, an authorized permit asked for another key is `no_permit`: it clears no key and leaves the permit as it is. Inside its ten minutes nothing changes: it clears only the key this permit bound, expires the permit, and logs at `ERROR`.

### Settled after review

- **The front does not check step-ca's provisioner extension.** The binding is the authority; a stolen intermediate could forge the extension anyway, and the check would refuse the probe certificate and, later, Thunderbird.
- **The address rule stays**, with the switch above, until real devices say otherwise.
- **step-ca's `device-attest-01` skips its nonce check when Apple's attestation lacks the nonce extension** (`acme/challenge.go:864`). Apple's always carries it, and the chain, serial and key are still verified; noted for upstream.

## 12. PR 4: the enrollment service (design, 2026-11-26)

PR 4 runs section 4's over-the-air flow for real: a person starts it on dash.i10.tech, their iPhone, iPad or Apple silicon Mac proves itself with Apple's signature, enrolls an identity through step-ca's SCEP provisioner, and receives a profile, encrypted to that identity, that holds the mail account with a sealed device code and, on a Mac, the ACME payload for its Secure Enclave key. It reuses PR 2's mint and PR 3's permits and handlers; it adds one table, one Go binary and four API routes.

This is revision 1, before its adversarial review.

### What was read, not assumed

- **Apple's device CA is SHA-1, RSA-1024, and expired in 2014.** The phase 2 signer is issued by `Apple iPhone Device CA` (Apple's OTA guide, read 2026-11-26), whose certificate is `sha1WithRSAEncryption` with a 1024-bit key, valid 2007-04-16 to 2014-04-16. Apple's guide says: "When device certificates signed 'Apple iPhone Device CA' are evaluated their validity dates should be ignored." Go's `x509.Verify` and `CheckSignatureFrom` refuse SHA-1 and an expired chain, so enrolld **pins that one certificate** (its DER, embedded) and checks the leaf's signature by hand with `Certificate.CheckSignature`, which still allows SHA-1 for a direct check. Validity dates are not checked for this chain only. The CMS signer-info signature (the device key over the attributes) is checked the same way. Which hash the device uses for each signature is for the real device to show (both SHA-1 and SHA-256 with RSA are accepted; nothing else).
- **Apple's phase 4 request echoes neither `CHALLENGE` nor `SERIAL`** (section 4), so it is resolved by the SCEP certificate's key, as PR 3's permits already allow (`key_sha256` has its own unique index).
- **The SCEP challenge hash is SHA-256 of the exact string sent** (PR 3's `challengeScep`), and ACME's `ClientIdentifier` and `CN` are the serial, never the UDID (section 4, PR 3's `authorizeAcme`).
- **The API already builds Apple mail payloads** (`apps/api/src/autoconfig/apple-profile.ts`, deterministic `PayloadIdentifier` and `PayloadUUID` per address, so a reinstall replaces). The sealed profile reuses that builder, so one function decides what an i10 mail account looks like.
- **Go has no CMS.** enrolld uses `github.com/smallstep/pkcs7` (the fork step-ca itself uses) for SignedData parsing and EnvelopedData with AES-256-CBC and RSA key transport. It parses untrusted bytes, so the body is capped before parsing, the parse runs under a recover, and the parse path is fuzzed.

### The shape

```
dash.i10.tech (console, PR 5)        API (:3001)                         enrolld (own Deployment)
  POST /console/mail-devices/enrollments  -> enrollment row, token
  shows QR / link https://ca.i10.tech/enroll/apple/<token>
device Safari GET  /enroll/apple/<token> ----------------------------> peek (API :3443) -> phase 1 profile
device POST /enroll/apple/profile (signed by Apple) -----------------> attest (API :3443) -> SCEP permit -> SCEP-only profile
device <-> step-ca SCEP (PR 3's three hooks gate it on that permit)
device POST /enroll/apple/profile (signed by the SCEP key) ----------> finish (API :3443) -> mint (+ ACME permit) -> sealed profile
```

**enrolld holds no database credentials and no device-code keys.** It verifies Apple's and step-ca's signatures, parses attributes, and encrypts. Every decision (who, which mailbox, platform rules, the gate, the epoch, minting) is the API's, through PR 2's and PR 3's store functions. Its only secret is a bearer token for the API's internal listener. A compromise of enrolld buys what any device on the internet has (the three internal calls), plus the sealed payloads passing through it during an enrollment; it cannot mint for a person who did not start an enrollment.

### The enrollment row, `authd.mail_device_enrollments`

| Column                                                      | Notes                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id` uuid                                                   | `uuidv7()`                                                                                                            |
| `clerk_user_id` text not null                               | FK `authd.accounts` ON DELETE CASCADE                                                                                 |
| `email` text not null, `tenant_id` uuid                     | the account's at creation; every later step requires the account to still match (null-safe), as the device lane does  |
| `expected_epoch` bigint not null                            | the account's `credential_epoch` read with the dash session; attest, the SCEP hooks and the mint refuse when it moved |
| `token_sha256` bytea not null unique                        | SHA-256 of the 32-byte base64url token in the link; the token is never stored                                         |
| `status` text                                               | `open` → `attested` → `sealed`, or `refused`, `expired`, `cancelled`; CHECK                                           |
| `refusal` text                                              | a fixed word for the console (`mac_not_apple_silicon`, `macos_too_old`, `unsupported_product`, a gate code)           |
| `serial`, `product`, `os_version`, `device_name` text       | from Apple's signed attributes at attest, bounded; the first attest binds the serial                                  |
| `udid_sha256`, `apple_signer_sha256` bytea                  | bound at attest; a retried attest must match both, a phase 4 that echoes a UDID must match                            |
| `platform` text                                             | `ios`, `ipados`, `macos`, decided at attest from `product`                                                            |
| `device_id` uuid                                            | FK `authd.mail_devices` ON DELETE SET NULL, set at seal                                                               |
| `created_by` text, `created_at`, `expires_at`, `updated_at` | `expires_at` = creation + 10 minutes; an attest moves it to attest + 10 minutes, the SCEP permit's own life           |

Indexes: unique `token_sha256`; `clerk_user_id` where `status in ('open','attested')`; `expires_at` for retention (deleted a day past expiry, like permits). `authd.mail_device_cert_permits` gains `enrollment_id` (FK ON DELETE CASCADE, CHECK: not null exactly for `scep`, indexed). Grants: the API's role only; an explicit REVOKE from `authd` and `mailfront`, grant tests assert it. On the CI non-RLS allowlist with its reason. No access-change triggers: an enrollment opens no session.

**PR 3's SCEP hooks gate on the enrollment.** `lockScepPermit` compared the account with itself ("a no-op until PR 4 stores one"). It now locks the account, then the permit, then the permit's enrollment, and refuses unless the enrollment is `attested` and unexpired and `mintRefusal` passes against the enrollment's workspace and `expected_epoch`, on the first call and on every retry. So a revocation, hold or epoch raise between the console click and SCEP stops the enrollment at the CA, before a code exists.

**Lock order** is unchanged: account, then device, then permit, then the enrollment (it hangs off the account, like a permit). Every write that reads an enrollment first reads it unlocked to learn the account, locks the account, then locks the enrollment and re-checks it.

### The console's routes (the contract PR 5 calls)

All under the console's session, workspace-scoped, the signed-in person's **own** mailbox only (no admin enrolls a device into someone else's mailbox).

- **`POST /console/mail-devices/enrollments`**, behind `requireFreshAuth` (the step-up dialog, as API-key deletion). Body `{}`. Reads the person's `authd.accounts` row and its epoch, runs `mintRefusal`, cancels the person's other `open` or `attested` enrollments, inserts the row. **201** `{ "id", "url", "expiresAt" }`, `url` = `https://ca.i10.tech/enroll/apple/<token>`, shown once (QR code and an "open on this device" link). **409** `{ "error": { "code" } }` with `no_mailbox` or a `mintRefusal` code; **503** `keys_not_configured`.
- **`GET /console/mail-devices/enrollments/:id`**: the person's own enrollment. **200** `{ "id", "status", "expiresAt", "refusal", "platform", "model", "deviceName", "deviceId", "needsMailSetup" }`. `status` is `open`, `attested`, `sealed`, `refused`, `expired` (an `open`/`attested` row past `expires_at` reads `expired`) or `cancelled`. `needsMailSetup` is true for a sealed Mac (the two clicks of section 5). **404** otherwise. The console polls it every 2 seconds while open.
- **`DELETE /console/mail-devices/enrollments/:id`**: cancels an `open` or `attested` enrollment (and expires its SCEP permit). **204**; **404** when not the person's.

### The internal calls (enrolld to API)

On the `:3443` listener (PR 3), with its own fetch branch: paths `/enrolld/peek`, `/enrolld/attest`, `/enrolld/finish`, `POST`, JSON, `Authorization: Bearer` checked against `ENROLLD_TOKEN_HASHES` (SHA-256 hex, comma-separated for rotation, as `CA_HOOK_TOKEN_HASHES`). The CA hook token never opens these paths and this token never opens a hook. Every authentication failure is a bare 404; 64 KiB cap; one 4-second deadline inside Postgres per call (PR 3's `decide`). A refusal is a 200 with `outcome: "refused"`; only our faults are 5xx.

- **`peek`** `{ token }` → `{ live }`. Read-only.
- **`attest`** `{ token, udid, serial, product, version, deviceName?, model?, appleSignerSha256 }`. Finds the enrollment by the token's hash, locks the account, then the enrollment: `open` (or `attested` with the same serial, UDID and signer: a retry), unexpired, `mintRefusal` with `expected_epoch`, the account still the enrollment's person, address and workspace. Then the platform rules:
  - `iPhone*` → `ios`, `iPad*` → `ipados`; a Mac identifier → `macos` only when it is Apple silicon (`MacBookPro17,1`, `MacBookPro18,*`, `MacBookAir10,1`, `Macmini9,1`, `iMac21,*`, `Mac13,*` and above) and the build (`version`) is macOS 14 or later (build major 23 and above); anything else is refused with its word and the row turns `refused`.
  - Creates the SCEP permit: 32 random bytes as base64url, stored as SHA-256 of that exact string, `serial`, `enrollment_id`, 10 minutes. A retry expires the earlier open permit and makes a new one.
  - → `{ outcome: "scep", serial, challenge }`.
- **`finish`** `{ keySha256, certSha256, commonName, udid? }`, both hashes hex. Finds the SCEP permit by `key_sha256` (`authorized` or `notified`, unexpired, CN equal to its serial, `issued_cert_sha256` equal when NOTIFYING recorded one), its enrollment `attested` and unexpired, a UDID when echoed equal to the bound one. In **one transaction**, lock order kept: mint through PR 2's store (the same function `mint`, refactored to run inside a caller's transaction, `expectedEpoch` from the row, platform, `model` = product, `serial`, `deviceName`, `createdBy` = the enrollment's creator), for `macos` create the ACME permit the same way (PR 3's `createAcmePermit`, in that transaction), mark the SCEP permit `expired` and the enrollment `sealed` with the device id. Builds the inner payload list: the mail account from `apple-profile.ts` with the code as `IncomingPassword` and `OutgoingPassword`, and for `macos` the ACME payload (`DirectoryURL` `https://ca.i10.tech/acme/apple/directory`, `ClientIdentifier` and `CN` the serial, `OU` the permit's nonce, `ECSECPrimeRandom` 384, `HardwareBound`, `Attest`, EKU `clientAuth`). → `{ outcome: "sealed", inner, identifier, uuid, displayName, scope }`, `inner` being the plist the outer profile encrypts, `scope` `System` for iPhone and iPad, `User` for a Mac.
  - **Single use.** A second `finish` for a sealed enrollment is refused: the code is not stored, so it cannot be sent again. The device row it minted dies unused after ten minutes (PR 2's rule), and the person starts over.

### enrolld

- `cmd/enrolld` in the authd module, the same image, its own Deployment and ServiceAccount (no token mounted), non-root, read-only root, no capabilities. Plain HTTP on one port behind Traefik, which terminates TLS for `ca.i10.tech` and routes `PathPrefix(/enroll/apple/)` to it, with the existing rate-limit and in-flight middlewares. `ReadHeaderTimeout` 5 s, `ReadTimeout` 10 s, `WriteTimeout` 15 s, 64 KiB body cap, a bound on concurrent requests.
- **`GET /enroll/apple/<token>`**: the token must be exactly 43 base64url characters, else 404 without calling the API. `peek`; live → the phase 1 Profile Service profile (`URL` `https://ca.i10.tech/enroll/apple/profile`, `DeviceAttributes` UDID, VERSION, PRODUCT, SERIAL, DEVICE_NAME, MODEL, `Challenge` the token), `Content-Type: application/x-apple-aspen-config`; not live → 404. The token never reaches a log (a 4-byte hash prefix at most). Traefik's access log sees the path; the token is single-use, ten minutes and bound to the first serial.
- **`POST /enroll/apple/profile`**: the phase is decided by **who signed**, never by what the attributes say:
  - signer issued by the pinned Apple iPhone Device CA (issuer bytes equal and `CheckSignature` by its key) → phase 2. The attributes plist is parsed by a strict parser of its own (a flat `dict` of `key`/`string` pairs, nothing else, each value bounded), `CHALLENGE` required, then `attest`; `scep` → the SCEP-only profile (`URL` `https://ca.i10.tech/scep/apple-scep`, `Subject` CN the serial, `Challenge`, RSA 2048, `Key Usage` 5; nothing else in it, section 4).
  - signer chaining by `x509.Verify` to the device root through the intermediate (both from the front's public trust bundle), EKU `emailProtection`, no SANs → phase 4, `finish` with `sha256(SPKI)`, `sha256(DER)`, the CN and the UDID if echoed; `sealed` → encrypt `inner` to that certificate (AES-256-CBC, RSA PKCS#1 v1.5 key transport), wrap it as `EncryptedPayloadContent` in a `Configuration` profile with the identifier, UUID, name and scope from the API.
  - anything else, or a refusal: 400 with no body worth reading. The person sees why on the console.
- **Never** logs a token, a challenge, the inner plist or a code. It logs the phase, the outcome, the product and a hash prefix of the serial.
- The final profile is not signed: no key that Apple devices trust is available to it (the public wildcard key lives in Traefik). iOS shows it as not verified; signing it is a later step.

### What PR 4 proves alone, and what waits for a device

- **On prod, with a throwaway account:** an enrollment from the console route; phase 1 served; a synthetic phase 2 signed by a test key is refused (the pinned CA is real); `peek`, `attest` and `finish` refuse every wrong token, permit, key and state; the SCEP hooks refuse a challenge for another enrollment; retention removes expired rows.
- **Only a real device (PR 6, or the owner's iPhone and Mac earlier if a step stalls):** Apple's actual signature algorithms and attribute set in phase 2 and phase 4, SCEP through step-ca with the real challenge, the AES-256-CBC profile opening, the Mac's ACME `device-attest-01` binding through PR 3's hook, and Mail signing in with the sealed code.

### Review 1 rules

From the first independent review (2026-11-26: no CRITICAL, 3 HIGH, 7 MEDIUM). Each rule overrides the text above where they differ.

**A device probe gates the merge (H1, H3, L5).** Three facts above come from Apple's 2018 guide or are inferred, and only real bytes settle them:

- Phase 2's real chain and hashes. The probe's own verifier (`verify.go`, added after the device runs in #504) checks dates against Apple Root CA, which a chain that expired in 2014 would fail, and nobody reconciled the two.
- Whether Apple's SCEP client enrolls against `ca.i10.tech` with **no** i10 root trusted on the device, when step-ca signs the response with the ECDSA P-256 intermediate. Apple's guide says the device must trust the CA. The probe's devices trusted a test CA for its TLS, and it ran SCEP over plain HTTP.
- Whether Apple's ACME client puts the `OU` nonce in its CSR.

Before PR 4 merges, an iPhone and an Apple silicon Mac run the probe against **prod's** step-ca. It uses a SCEP permit made by the operator script, a responder with a publicly trusted certificate, and nothing i10 installed on the device. The raw phase 2 and phase 4 requests it saves become enrolld's golden tests, and the pin is taken from those bytes. If SCEP needs a trusted root, the flow is redesigned before merge. `CAFingerprint` is added only if the probe shows it helps.

**Phase 2 verification (H1).**

- There must be exactly one SignerInfo.
- The signer certificate is the one its `IssuerAndSerialNumber` names. That one object is used for the CA check, the hashes, the CN and the recipient.
- enrolld checks the signer info itself: the content-type attribute, the `messageDigest` attribute, the DER re-encoding of the signed attributes as a SET, and `Certificate.CheckSignature`.
- No library call that compares `signingTime` with the leaf's dates is used. Dates are ignored on the Apple path only.
- Phase 2 attributes are **claims made by whoever holds an Apple-activated key** (a jailbroken device can sign any serial). Only ACME's `device-attest-01` re-verifies a Mac's serial with Apple. Nothing below treats a phase 2 serial as proven.

**The link token (H2).**

- **It is not single-use until attest.** It is bound to the first attested serial, UDID and Apple signer, and the text above that says "single-use" means only that.
- **It is kept out of every log we control.** The Traefik router for `/enroll/apple/` turns off access logging (per-router `observability.accessLogs: false`). The build checks that the cluster's Traefik version supports it, or uses a separate entry point with no access log.
- **The person is told.** After a seal, the API sends the person an email with the attested model and the last 4 characters of the serial, and a link to the devices page. A device the person did not enroll is then one tap from revoked. That makes a stolen QR code something the person sees, not something silent.

**The API seals; enrolld never sees a code (M1).** `finish` takes the phase 4 signer certificate's DER instead of only its hashes. The API computes the hashes itself, checks the certificate as enrolld did (below), and builds the CMS EnvelopedData: AES-256-CBC, RSA PKCS#1 v1.5 key transport, DER written in the API and tested by `openssl cms -decrypt`. It returns the **complete** final profile. enrolld relays bytes it cannot read, and holds no pkcs7 encryption code.

**A lost response is retryable (M2).**

- `finish` matches the SCEP permit by **key only**, never by `issued_cert_sha256`. A lost CertRep makes step-ca sign a second certificate for the same key, and NOTIFYING keeps only the first.
- The sealed profile, encrypted to the device's key and so readable only by it, is stored on the enrollment (`sealed_profile` bytea) until `expires_at`.
- A repeat `finish` from the same key, for a `sealed` row within its life, returns the same bytes and mints nothing.
- Retention deletes the row, profile included.

**A profile builder of its own (M3).**

- `apple-profile.ts`'s passwordless builder stays as it is. A separate sealed builder writes the payload list, with identifiers derived from the **device row id** (`tech.i10.mail-device.<id>`).
- A re-enrollment therefore adds a profile beside the old one, which section 11's Mac renewal needs (the old row works until the person revokes it).
- Apple's key is `OutgoingPasswordSameAsIncomingPassword`. The existing builder's `OutgoingPasswordSameAsIncoming` is fixed in this PR.

**Windows (M4, L2).**

- **Attest window.** An enrollment can be attested up to 15 minutes after creation. Every attest retry expires the enrollment's live SCEP permits and makes one new one. Its life is capped at creation plus 30 minutes, whatever the retries.
- **Stolen Device Protection set to "Always"** (about an hour) does not fit. The console says so on a timeout.
- **The 10-minute unused-code rule is kept.** The final profile installs as the last step of the flow the person already approved, so Mail should connect within seconds. The probe measures the time from phase 4 to the first sign-in, and the rule changes only if that measurement says it must.

**Database (M5, M6).**

- **Enrollment indexes.** The `clerk_user_id` index is full (the account cascade uses it). `device_id` has its own index (ON DELETE SET NULL scans otherwise). No CHECK ties `device_id` to `status`.
- **One live enrollment per person.** This is a partial UNIQUE index on `clerk_user_id` where status is `open` or `attested`. The POST cancels the person's live one in the same transaction, before it inserts.
- **The permit column.** On the existing permits table, `enrollment_id`'s FK and CHECK are added `NOT VALID` and validated as db-guard says.
- **Hash lengths.** `octet_length` CHECKs on every hash column.
- **Per-person ACME permits (M6).** The one-open-ACME-permit-per-serial unique index becomes per `(serial, clerk_user_id)`. The ACME hook finds a permit by its nonce, so it never needed the serial alone to be unique. `createAcmePermit` no longer refuses another person's live permit for the same serial. Without that change, a forged phase 2 for a victim's serial would block their Mac indefinitely, and two people sharing a Mac would collide.

**Lock order everywhere (L3):** `authd.accounts`, then `mail_device_enrollments`, then `mail_devices`, then `mail_device_cert_permits`, then `mail_device_cert_binds`. An unlocked read only chooses what to lock.

- The SCEP hooks lock account, enrollment, permit.
- `finish` locks account, enrollment, device (insert), permits.
- The ACME hook is unchanged (account, device, permit).
- Retention's cascade takes enrollment before permit, which is the same direction.

**enrolld's network (M7).**

- An ingress rule for enrolld on the API's 3443 in `api-ca-hooks-clients`.
- An egress policy for enrolld: the API's 3443 and DNS only.
- Ingress from Traefik only.
- The namespace hooks CA is mounted into enrolld as the only root it trusts.

**Phase 4 signer (L1).** The certificate must meet all of these, or the request is refused:

- issued by the device **intermediate** (the decrypter certificate, issued straight from the root with no EKU, is refused);
- EKU explicitly includes `emailProtection`;
- **no SAN extension at all** (ACME certificates carry an otherName SAN Go does not parse);
- verified with `x509.Verify` against the device root.

**Smaller rules.**

- The SCEP payload sets `KeyIsExtractable` false.
- Phase 1 sends `Challenge` as a `<string>`. The attribute parser accepts `CHALLENGE` as `<string>` or `<data>`, and nothing else as `<data>`.
- **POST response.** `Cache-Control: no-store`.
- **Workspace.** The POST is workspace-optional and uses the account's own `tenant_id` (null for an i10.tech mailbox), whatever workspace the session has open: it is the person's own mailbox.
- **DELETE of a sealed enrollment** is `409 already_sealed`.
- **SCEP hook refusals are shown.** A refusal from the SCEP hooks marks the enrollment `refused` with its code, in the hook's transaction, so the console shows it rather than waiting for the expiry.
- **Logged serials** are a keyed hash (HMAC under a random per-process key), never a plain prefix.
- **Signed profiles** (L4: unsigned profiles teach people to install "Not Verified" ones) need a publicly trusted signing certificate. They are a follow-up issue.

### The device probe (2026-11-27), and what it changed

An iPhone (`iPhone17,2`, iOS 27.2) and an Apple silicon Mac (`MacBookPro18,3`, macOS 27.3) ran the whole flow against prod step-ca, through a probe server standing in for enrolld and the API, with a throwaway account (deleted afterwards). These rules override anything above that they contradict.

- **The iPhone works end to end.** Phase 2, SCEP, phase 4, then the sealed profile (AES-256-CBC, RSA PKCS#1 v1.5) installed. Mail signed in with the sealed code through the front (`source: device`) 7 s after the seal. enrolld's verifier accepts all five real phase 2 requests and the phase 4 request: the pinned Apple CA is right, and Apple's signed attributes come in DER order.
- **SCEP works with no i10 root on the device, but only with the decrypter alone.** iOS refuses a GetCACert answer in which it cannot pick a CA ("The Registration Authority's response is invalid"). It also checks the CertRep against the certificate marked `digitalSignature`, which is the intermediate, while step-ca 0.30.2 always signs the CertRep with the provisioner's decrypter key ("The SCEP server returned an invalid response"). Sending decrypter plus root, without the intermediate, is refused too, because no certificate is marked for signing. The one answer that works is the decrypter certificate alone, as `application/x-x509-ca-cert`. In step-ca that is `"excludeIntermediate": true` on `apple-scep`, with `includeRoot` left off. The deploy PR sets it.
- **A Mac signs both requests without signed attributes** (RFC 5652 5.4: the signature covers the content), with sha1WithRSA and a four-certificate Apple chain. Its attributes add `MODEL`, `MODELNUMBER`, `DEVICE_NAME`, `SOFTWARE_UPDATE_DEVICE_ID`, `UserID`, `UserShortName`, `UserLongName` and a boolean `NotOnConsole`. enrolld accepts both forms and the boolean. Every other rule stays.
- **The Mac's ACME certificate works.** step-ca issued the Secure Enclave certificate with CN = serial and OU = the permit's nonce (L5 settled).
- **macOS checks the mail account while it installs the profile**, over IMAP `LOGIN` with the code and over SMTP `AUTH`, with no certificate. PR 3 refuses both for a Mac (`device_cert_required`, and the front's `454`), so the whole install failed with "Unable to verify account name or password".

**The Mac install grace (owner's decision, 2026-11-27).** A new Mac's code works alone, on IMAP and SMTP, while the device is in grace:

- the row is `macos` and its ACME key is bound (`cert_key_sha256` set);
- the id's embedded time (`uuidv7()`) is between 10 minutes ago and 1 minute ahead, so the front needs no new column grant and a future-dated id cannot make the grace permanent;
- no certificate session was ever recorded for it (no `authd.mail_device_cert_binds` row).

A grace bind passes every other gate rule, never writes a liveness row, and logs `grace: true`. Every code-only session admitted under it ends when the grace does. After that, PR 3's rules apply unchanged: the code alone is refused until the two clicks in Mail. The cost: a code lifted from that Mac in its first 10 minutes signs in alone until the grace ends.

---

## Sources

- Apple, `apple/device-management`, branch `release`, read 2026-11-21: `mdm/profiles/com.apple.mail.managed.yaml`, `com.apple.security.acme.yaml`, `com.apple.security.identitypreference.yaml`, and the `mdm/profiles` listing.
- Stalwart docs, read 2026-11-21: telemetry webhooks (`auth.success`, `auth.failed` carry `remoteIp` and a session `spanId`), the event reference (`imap.id` exists), and the reverse proxy page (PROXY v2 with the SSL extension).
- `mail-one-password.md` and the #383 comments for the lanes in section 7.
- Stalwart docs, read 2026-11-21: the reverse proxy page (dedicated loopback listeners, `overrideProxyTrustedNetworks`, "Every connection from those networks must carry the header, or it is dropped", "Listener changes take effect after a restart").
