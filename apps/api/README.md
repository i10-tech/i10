# @i10/api

## Device CA webhooks (#383 PR 3)

The device certificate authority (step-ca) asks the API before every issuance.
The API says yes only to an open **certificate permit**
(`authd.mail_device_cert_permits`), and binds a Mac's key to its device row in
the same transaction. The design is `docs/research/mail-device-binding.md`
section 11. step-ca's relay sidecar is `services/authd/cmd/cahookrelay`
(`services/authd/README.md`, "CA webhook relay").

### The hooks listener

A second `Bun.serve` in the API process (`src/ca-hooks/listener.ts`), on its own
port and with its own `fetch`. No main route is reachable on it, and the main
request logger never sees a hook.

- **Paths:** `POST` to `/acme-authorize`, `/scep-challenge`, `/scep-authorize`
  and `/scep-notify`, with no query string. Each is one step-ca webhook.
- **Authentication:** `Authorization: Bearer <token>` (the relay adds it),
  compared in constant time against every hash in `CA_HOOK_TOKEN_HASHES`; the
  `X-Smallstep-Webhook-ID` configured for that path; and a body `timestamp`
  within 60 seconds of now. The headers are checked before any of the body is
  read. Any failure, a wrong path or method, or a body over 64 KiB is a bare
  `404`.
- **Answers:** `{"allow": true}` or `{"allow": false}`, the shape of step-ca's
  `webhook.ResponseBody`, never with an `error` a device could read. A fault of
  ours is a `500`, and a handler past 5 seconds a `503`. step-ca retries once on
  a 5xx and then refuses; it never issues on one. Each handler transaction also
  sets `lock_timeout` 2 s and `statement_timeout` 4 s, so it cannot commit after
  the listener has answered.
- **Logs:** the hook kind and the outcome only, never a header, the body or the
  token. A second key for an authorized ACME permit is logged at `ERROR` with
  the permit's id.
- **Off by default.** It starts only when all three hook settings are set and
  both TLS files exist. Otherwise it logs once why it is off
  (`not_configured` or `no_certificate`) and nothing listens.
- **Shutdown:** `SIGTERM` stops it with the main listener, before the
  database pool closes.
- **TLS:** server-authenticated, from the namespace CA, for
  `i10-api-ca-hooks.i10-prod.svc`. The files are read once at start (`Bun.serve`
  cannot reload `tls`), so a new certificate needs a restart.

### Variables

| Variable                    | Default                     | Notes                                                                                                           |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CA_HOOKS_PORT`             | `3443`                      | Must differ from `PORT`.                                                                                        |
| `CA_HOOKS_TLS_CERT_FILE`    | `/etc/i10/ca-hooks/tls.crt` | Server certificate.                                                                                             |
| `CA_HOOKS_TLS_KEY_FILE`     | `/etc/i10/ca-hooks/tls.key` |                                                                                                                 |
| `CA_HOOK_TOKEN_HASHES`      | none                        | SHA-256 hex of the relay's bearer token, comma-separated, at most 4.                                            |
| `CA_HOOK_WEBHOOK_IDS`       | none                        | `acme-authorize=<id>,scep-challenge=<id>,scep-authorize=<id>,scep-notify=<id>`: each kind once, each id unique. |
| `CA_INTERMEDIATE_NOT_AFTER` | none                        | The device intermediate's `notAfter`, RFC 3339 with a zone. No leaf may outlive it.                             |

The last three are set together or not at all; the environment check refuses
any other combination. They live in `prod_api` (the `i10-api` Secret), which
the API Deployment and the PreSync environment check both read through
`envFrom`.

`CA_INTERMEDIATE_NOT_AFTER` is a config value because the API is never given
the device CA's files. Set it again with the year-7 rotation.

### Rotating the relay's token

The relay rereads its token file every 30 seconds, and the API accepts any
hash in the list, so the token rotates without an outage:

1. Make a new token (`TOKEN=$(openssl rand -hex 32)`). The listener accepts
   one word of 16 to 512 printable ASCII characters, with no spaces. Add its
   hash to `CA_HOOK_TOKEN_HASHES` beside the old one:
   `printf %s "$TOKEN" | shasum -a 256`. Restart the API pods (a Doppler
   change does not reach a running pod).
2. Put the new token in `prod_device_ca_hooks`, the relay's Secret. Within 30
   seconds of the Secret reaching the pod, the relay sends it.
3. Remove the old hash from `CA_HOOK_TOKEN_HASHES` and restart the API again.

### The handlers

`src/ca-hooks/handlers.ts` parses each body, and checks the template, before
any database work. Field names come from step-ca v0.30.2's source
(`src/ca-hooks/body.ts`). `src/mail-devices/permits.ts` holds the transactions.

| Hook             | Finds the permit by        | Refuses unless                                                                                                                                                                                                                                                                                                                                           | Then                                                                                                   |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `acme-authorize` | its `OU` nonce             | CN and attested serial are the permit's serial; one `OU`; no DNS, IP, email or URI name; only a permanent identifier SAN for the serial; no raw SAN, EKU or constraint extension; EKU `clientAuth` only; not a CA; `notBefore` within 5 minutes, `notAfter` at most 3 years and 5 minutes ahead and inside the intermediate; the account and device gate | binds the key, claims the device's first use, deletes its liveness rows, marks the permit `authorized` |
| `scep-challenge` | the challenge's SHA-256    | the CSR's CN is the serial; the account passes the gate                                                                                                                                                                                                                                                                                                  | `challenged`, with the transaction id and the CSR key                                                  |
| `scep-authorize` | the key                    | a `challenged` permit; the template as above but with no SANs, EKU `emailProtection` only, 7 days                                                                                                                                                                                                                                                        | `authorized`                                                                                           |
| `scep-notify`    | transaction id and the key | an `authorized` permit                                                                                                                                                                                                                                                                                                                                   | `notified`, with the certificate's hash. A failure notice (no certificate) changes nothing             |

Every retry from step-ca re-runs every check. A unique violation (a key or a
transaction id another permit holds) is `allow: false`, never a 5xx.

An ACME request with the right nonce but a different key from the one an
`authorized` permit bound clears that key from the device, deletes its
liveness rows and expires the permit. So a real Mac arriving second undoes
anyone who arrived first with its nonce. Without the nonce, no request can
reach this path.

**Lock order:** read the permit without a lock, then lock `authd.accounts`, then
`authd.mail_devices`, then the permit, and decide on the locked rows. It is the
order of PR 2's revocations, which reach permits by cascade. No handler calls
the network.

### Operator commands

`scripts/mail-device.ts` is **for throwaway-account probes only** until PR 4
and PR 5 ship enrollment and management. Only `mint` needs
`MAIL_DEVICE_CODE_KEYS`; every command needs `DATABASE_URL`.

```sh
bun scripts/mail-device.ts bind-key <device id> <certificate.pem>
bun scripts/mail-device.ts unbind-key <device id>
bun scripts/mail-device.ts acme-permit <device id>
```

- `bind-key` hashes the first certificate in the file (the leaf's
  SubjectPublicKeyInfo). It sets the key, claims the first use and deletes the
  device's liveness rows, in one transaction, accounts first. It refuses a
  missing row, a row that is not `macos`, and a code that has expired (so a
  bind can never revive one). It also refuses a key another device holds.
- `unbind-key` clears the key and deletes the liveness rows. The mail front
  then closes the Mac's sessions at its next poll.
- `acme-permit` opens a 10-minute ACME permit for a Mac that has a serial and
  no key. It prints the nonce, once, to stdout; the nonce goes in the
  certificate's `OU`. It replaces this person's own open permit for the serial,
  and any that have run out. It refuses another person's live one
  (`permit_conflict`).

### Retention

The hourly retention job (`src/retention.ts`) deletes permits a day past
`expires_at`, and liveness rows (`authd.mail_device_cert_binds`) older than a
day. It deletes 1,000 rows per transaction, through each table's own index.
