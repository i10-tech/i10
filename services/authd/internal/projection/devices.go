package projection

import (
	"context"
	"errors"
	"fmt"
	"net/netip"

	"github.com/jackc/pgx/v5"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
)

// The device code clock rules (#383), judged by the database's clock in the
// statements below, never by authd's: the first-use claim, the idle limit and
// the daily touch all compare with the same now(). Top-level constants, so the
// scale harness (apps/api/scripts/scale/go-sql.ts) can read the statements.

// DeviceFirstUseWindow is how long a minted code may wait for its first
// sign-in. Past it, an unused code is dead (and the prune deletes it).
const DeviceFirstUseWindow = `interval '10 minutes'`

// DeviceIdleLimit is how long a used code may go without a sign-in.
const DeviceIdleLimit = `interval '90 days'`

// deviceTouchEvery bounds the `last_used_at` writes to one a day per device.
const deviceTouchEvery = `interval '1 day'`

// DeviceByIDQuery is DeviceByID's statement, exported so its cost can be
// measured with EXPLAIN on the statement that actually runs. One primary-key
// lookup.
const DeviceByIDQuery = `
	SELECT d.id::text, d.clerk_user_id, d.email, coalesce(d.tenant_id::text, ''), d.platform,
	       d.cert_key_sha256, coalesce(d.serial, ''),
	       d.code_hash, d.code_kid,
	       d.first_used_at IS NOT NULL,
	       coalesce(d.last_used_at < now() - ` + DeviceIdleLimit + `, false),
	       coalesce(d.last_used_at < now() - ` + deviceTouchEvery + `, false)
	FROM authd.mail_devices d
	WHERE d.id = $1::uuid`

// DeviceByID reads one mail device for authd's bind, or (nil, nil) when there
// is no such row. Not cached: a revoke is a DELETE, and the next bind must see
// it.
func (p *Postgres) DeviceByID(ctx context.Context, id string) (*DeviceCredential, error) {
	var d DeviceCredential
	err := p.pool.QueryRow(ctx, DeviceByIDQuery, id).Scan(&d.ID, &d.ClerkUserID, &d.Email, &d.TenantID, &d.Platform,
		&d.CertKey, &d.Serial, &d.CodeHash, &d.CodeKID, &d.Used, &d.Idle, &d.TouchDue)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("projection: device by id: %w", err)
	}
	return &d, nil
}

// frontDeviceColumns are the `authd.mail_devices` columns the mail front's role
// may read (a column grant: never the code's hash, the serial or the name), in
// Device's order.
const frontDeviceColumns = `d.id::text, d.clerk_user_id, d.email, coalesce(d.tenant_id::text, ''), d.platform, d.cert_key_sha256`

// DeviceGateQuery is DeviceGate's statement: one primary-key lookup.
const DeviceGateQuery = `SELECT ` + frontDeviceColumns + ` FROM authd.mail_devices d WHERE d.id = $1::uuid`

// DeviceByCertKeyQuery is DeviceByCertKey's statement: one probe of the
// partial unique index on `cert_key_sha256` (`= $1::bytea` is strict, so the
// planner knows it implies the index's `IS NOT NULL`).
const DeviceByCertKeyQuery = `SELECT ` + frontDeviceColumns + ` FROM authd.mail_devices d WHERE d.cert_key_sha256 = $1::bytea`

// DeviceGate reads a device row as the gate matches it, for the mail front:
// whether a code's row is a Mac before a sign-in is forwarded. (nil, nil) when
// there is no such row. An id that is not a UUID is no row.
func (p *Postgres) DeviceGate(ctx context.Context, id string) (*Device, error) {
	if _, ok := devicecode.ParseIDText(id); !ok {
		return nil, nil
	}
	return p.frontDevice(ctx, "device gate", DeviceGateQuery, id)
}

// DeviceByCertKey reads the device a certificate key is bound to, for the mail
// front's AUTHENTICATE EXTERNAL: (nil, nil) when the key is bound to none.
func (p *Postgres) DeviceByCertKey(ctx context.Context, key []byte) (*Device, error) {
	if len(key) != 32 {
		return nil, nil
	}
	return p.frontDevice(ctx, "device by certificate key", DeviceByCertKeyQuery, key)
}

func (p *Postgres) frontDevice(ctx context.Context, what, query string, arg any) (*Device, error) {
	var d Device
	err := p.pool.QueryRow(ctx, query, arg).Scan(&d.ID, &d.ClerkUserID, &d.Email, &d.TenantID, &d.Platform, &d.CertKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("projection: %s: %w", what, err)
	}
	return &d, nil
}

// ── the Mac liveness rows (`authd.mail_device_cert_binds`, #383 PR 3) ───────
//
// A Mac sends with its code only while a certificate-verified IMAP session of
// it lives: every successful Mac IMAP bind with a key records (device, the
// client's /32 or /64, the key), and an SMTP bind of that Mac needs a row for
// its current key, recent enough, from the same address. Every Stalwart pod's
// authd shares them through Postgres, and the front reads them to answer the
// missing row as temporary itself (Stalwart would turn authd's `unavailable`
// into a permanent 535).

// MacLiveWindow is how recent a liveness row must be for a Mac's SMTP bind.
// The front ends a certificate session after at most 65 minutes, and authd
// refreshes the row at most once every macLiveRefresh, so a session still open
// always has a row inside the window.
const MacLiveWindow = `interval '75 minutes'`

// macLiveRefresh bounds the writes: one per (device, address) every five
// minutes, however many connections Mail opens.
const macLiveRefresh = `interval '5 minutes'`

// MacLiveRowsPerDevice caps a device's liveness rows: a Mac that roams keeps
// its most recent addresses, the oldest is replaced. macLiveRowsSQL is the same
// number as the statement spells it (a test keeps the two equal).
const MacLiveRowsPerDevice = 8

const macLiveRowsSQL = `8`

// RecordMacLiveQuery is RecordMacLive's statement.
//
// ⚠ NO WRITE, AND NO ROW LOCK, WHEN THE ROW IS FRESH. The SELECT yields nothing
// while a row for this device, address and key is younger than macLiveRefresh,
// so the INSERT is never attempted; ON CONFLICT DO UPDATE would lock the
// conflicting row even when its WHERE skips the update. Otherwise it inserts,
// or moves the row to this key and now. `inserted` (xmax = 0) says whether a
// new row was added, which is when the cap runs.
const RecordMacLiveQuery = `
	INSERT INTO authd.mail_device_cert_binds AS b (device_id, addr, key_sha256, bound_at)
	SELECT $1::uuid, $2::cidr, $3::bytea, now()
	 WHERE NOT EXISTS (
	       SELECT 1 FROM authd.mail_device_cert_binds f
	        WHERE f.device_id = $1::uuid AND f.addr = $2::cidr AND f.key_sha256 = $3::bytea
	          AND f.bound_at > now() - ` + macLiveRefresh + `)
	ON CONFLICT (device_id, addr) DO UPDATE
	   SET key_sha256 = EXCLUDED.key_sha256, bound_at = EXCLUDED.bound_at
	RETURNING (b.xmax = 0)`

// CapMacLiveQuery is the per-device cap: every row of the device but its
// MacLiveRowsPerDevice most recent. ⚠ A STATEMENT OF ITS OWN, after the upsert:
// one statement's CTEs share a snapshot and could not see the row just added.
const CapMacLiveQuery = `
	DELETE FROM authd.mail_device_cert_binds b
	 WHERE b.device_id = $1::uuid
	   AND b.addr NOT IN (
	       SELECT k.addr FROM authd.mail_device_cert_binds k
	        WHERE k.device_id = $1::uuid
	        ORDER BY k.bound_at DESC, k.addr
	        LIMIT ` + macLiveRowsSQL + `)`

// MacLiveAtQuery is the SMTP rule with the address: one primary-key probe that
// also requires the row's key to be the device's current key.
const MacLiveAtQuery = `
	SELECT EXISTS (
	       SELECT 1 FROM authd.mail_device_cert_binds b
	        WHERE b.device_id = $1::uuid AND b.addr = $2::cidr AND b.key_sha256 = $3::bytea
	          AND b.bound_at > now() - ` + MacLiveWindow + `)`

// MacLiveFamiliesQuery is the SMTP rule without the address
// (AUTHD_MAC_SMTP_SAME_ADDRESS=false), and what authd logs beside a refusal:
// the address families (4, 6) of the device's live rows under its current key.
// A range of the primary key on `device_id`, at most MacLiveRowsPerDevice rows.
const MacLiveFamiliesQuery = `
	SELECT coalesce(array_agg(DISTINCT family(b.addr)), '{}')::int[]
	  FROM authd.mail_device_cert_binds b
	 WHERE b.device_id = $1::uuid AND b.key_sha256 = $2::bytea
	   AND b.bound_at > now() - ` + MacLiveWindow

// MacLivePrefix is the liveness row's address for a client: its /32, or its
// IPv6 /64 (what one subscriber is usually given, and what survives privacy
// addresses).
func MacLivePrefix(a netip.Addr) netip.Prefix {
	a = a.Unmap().WithZone("")
	bits := 64
	if a.Is4() {
		bits = 32
	}
	p, _ := a.Prefix(bits)
	return p
}

// RecordMacLive records that a Mac's certificate-verified IMAP bind succeeded
// from at under key, then caps the device's rows when one was added.
//
// ⚠ TWO AUTOCOMMIT STATEMENTS, NEVER A TRANSACTION, AND NEITHER TOUCHES
// `authd.mail_devices`. The API's ACME handler and the operator script lock the
// device row and then delete these rows; a transaction here that held a
// liveness row while it waited on the device row would deadlock with them. The
// upsert's foreign-key check reads the device row with KEY SHARE, which their
// FOR NO KEY UPDATE does not block, and a new row is invisible to their DELETE.
func (p *Postgres) RecordMacLive(ctx context.Context, deviceID string, at netip.Prefix, key []byte) error {
	var inserted bool
	err := p.pool.QueryRow(ctx, RecordMacLiveQuery, deviceID, at.String(), key).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // fresh: nothing written
	}
	if err != nil {
		return fmt.Errorf("projection: record mac liveness: %w", err)
	}
	if !inserted {
		return nil
	}
	if _, err := p.pool.Exec(ctx, CapMacLiveQuery, deviceID); err != nil {
		return fmt.Errorf("projection: cap mac liveness rows: %w", err)
	}
	return nil
}

// MacLive reports whether the device has a live row for key: from at when at is
// valid, from any address when it is the zero Prefix.
func (p *Postgres) MacLive(ctx context.Context, deviceID string, at netip.Prefix, key []byte) (bool, error) {
	if len(key) == 0 {
		return false, nil
	}
	if !at.IsValid() {
		fams, err := p.MacLiveFamilies(ctx, deviceID, key)
		return len(fams) > 0, err
	}
	var live bool
	if err := p.pool.QueryRow(ctx, MacLiveAtQuery, deviceID, at.String(), key).Scan(&live); err != nil {
		return false, fmt.Errorf("projection: mac liveness: %w", err)
	}
	return live, nil
}

// MacLiveFamilies is the address families of the device's live rows for key.
func (p *Postgres) MacLiveFamilies(ctx context.Context, deviceID string, key []byte) ([]int32, error) {
	var fams []int32
	if err := p.pool.QueryRow(ctx, MacLiveFamiliesQuery, deviceID, key).Scan(&fams); err != nil {
		return nil, fmt.Errorf("projection: mac liveness families: %w", err)
	}
	return fams, nil
}

// ClaimDeviceFirstUseQuery is ClaimDeviceFirstUse's statement.
//
// ⚠ COALESCE, SO EVERY FIRST CONNECTION PASSES. Apple Mail opens several
// connections at once with a new account. Each bind's UPDATE waits for the one
// before it on the row lock, then re-reads the row: `first_used_at` is set by
// then, so the WHERE still holds and the coalesce keeps the first values. Only a
// code never used and older than the window matches no row.
const ClaimDeviceFirstUseQuery = `
	UPDATE authd.mail_devices
	   SET first_used_at = coalesce(first_used_at, now()),
	       last_used_at = coalesce(last_used_at, now())
	 WHERE id = $1::uuid
	   AND (first_used_at IS NOT NULL OR created_at > now() - ` + DeviceFirstUseWindow + `)
	RETURNING id`

// ClaimDeviceFirstUse records a code's first sign-in. It reports false when the
// code expired unused (or the row is gone), which is a refusal.
func (p *Postgres) ClaimDeviceFirstUse(ctx context.Context, id string) (bool, error) {
	tag, err := p.pool.Exec(ctx, ClaimDeviceFirstUseQuery, id)
	if err != nil {
		return false, fmt.Errorf("projection: claim device first use: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// TouchDeviceQuery is TouchDevice's statement. A row it does not match is a
// touch another bind made today, never a refusal.
const TouchDeviceQuery = `
	UPDATE authd.mail_devices
	   SET last_used_at = now()
	 WHERE id = $1::uuid
	   AND last_used_at < now() - ` + deviceTouchEvery

// TouchDevice moves a used code's `last_used_at` to now, at most once a day, so
// a device in use is never idle past DeviceIdleLimit.
func (p *Postgres) TouchDevice(ctx context.Context, id string) error {
	if _, err := p.pool.Exec(ctx, TouchDeviceQuery, id); err != nil {
		return fmt.Errorf("projection: touch device: %w", err)
	}
	return nil
}
