# @i10/api

## Mail device enrollment (I10-62)

The API no longer answers the device CA. step-ca's SCEP hooks are decided by
its `cahookrelay` sidecar against `i10-enroll-redis`, Phase 2 and Phase 4 by
`enrollctl`, and Macs get their certificate from `acmed`
(`services/authd/README.md`; design in `docs/research/enrollment-at-scale.md`).
The API's part is the console: `src/routes/console/mail-device-enrollments.ts`
starts, shows and cancels an enrollment session in `i10-enroll-redis`
(`src/mail-devices/enroll-redis.ts`, using the same Lua files Go embeds from
`services/authd/internal/enrollredis/lua/`), signs the enrollment link, and
consumes the `enroll:notice` stream to send the "device added" email. It holds
no device-code, permit or CA key.

### Operator commands

`scripts/mail-device.ts` is for throwaway-account probes. Only `mint` needs
`MAIL_DEVICE_CODE_KEYS`; every command needs `DATABASE_URL`. `mint` writes only
the device code to stdout.

```sh
bun scripts/mail-device.ts mint --email <addr> --platform <ios|ipados|macos> --name <n> [--model <m>] [--serial <s>]
bun scripts/mail-device.ts list --email <addr>
bun scripts/mail-device.ts revoke --id <uuid>
bun scripts/mail-device.ts bind-key <device id> <certificate.pem> [--replace]
bun scripts/mail-device.ts unbind-key <device id>
```

- `bind-key` hashes the first certificate in the file (the leaf's
  SubjectPublicKeyInfo). It sets the key, claims the first use and deletes the
  device's liveness rows, in one transaction, accounts first. It refuses a row
  that already has a key unless `--replace` is given, and a key another device
  holds.
- `unbind-key` clears the key and deletes the liveness rows. The mail front
  then closes the Mac's sessions at its next poll.

### Retention

The hourly retention job (`src/retention.ts`, `src/mail-devices/prune.ts`)
deletes device codes never used within 10 minutes of creation, used codes idle
for 90 days, and Mac liveness rows (`authd.mail_device_cert_binds`) older than a
day, 1,000 rows per transaction through each table's own index. Enrollment
sessions, SCEP and ACME state live in `i10-enroll-redis` with bounded TTLs.
