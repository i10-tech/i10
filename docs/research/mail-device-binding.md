# Locking a mail sign-in to one device

**Status:** research, probed on real devices on 2026-11-21. No product code changed. The design in section 6 is a proposal for #383 (I10-62), not a decision.

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
4. **The device POSTs again, signed with its new SCEP key.**
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

---

## Sources

- Apple, `apple/device-management`, branch `release`, read 2026-11-21: `mdm/profiles/com.apple.mail.managed.yaml`, `com.apple.security.acme.yaml`, `com.apple.security.identitypreference.yaml`, and the `mdm/profiles` listing.
- Stalwart docs, read 2026-11-21: telemetry webhooks (`auth.success`, `auth.failed` carry `remoteIp` and a session `spanId`), the event reference (`imap.id` exists), and the reverse proxy page (PROXY v2 with the SSL extension).
- `mail-one-password.md` and the #383 comments for the lanes in section 7.
