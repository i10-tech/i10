package projection

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
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
		&d.CodeHash, &d.CodeKID, &d.Used, &d.Idle, &d.TouchDue)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("projection: device by id: %w", err)
	}
	return &d, nil
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
