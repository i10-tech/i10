package projection

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("projection: parse dsn: %w", err)
	}
	// authd sits behind PgBouncer in transaction pooling mode, where server-side
	// prepared statements do not survive between transactions.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	cfg.MaxConnLifetime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("projection: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("projection: ping: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

// Ping is used by the readiness probe. authd with an unreachable projection can
// answer nothing, and should not be routed to.
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

const accountColumns = `a.clerk_user_id, a.email, coalesce(a.display_name, ''),
	coalesce(a.description, ''), a.active, a.password_updated_at`

func (p *Postgres) AccountsByAddress(ctx context.Context, addresses []string) ([]Account, error) {
	norm := normalise(addresses)
	if len(norm) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT `+accountColumns+`
		FROM authd.accounts a
		WHERE a.active
		  AND (a.email = ANY($1)
		       OR EXISTS (SELECT 1 FROM authd.aliases al
		                  WHERE al.clerk_user_id = a.clerk_user_id
		                    AND al.address = ANY($1)))`, norm)
	if err != nil {
		return nil, fmt.Errorf("projection: accounts by address: %w", err)
	}
	accounts, err := scanAccounts(rows)
	if err != nil {
		return nil, err
	}
	return accounts, p.hydrate(ctx, accounts)
}

func (p *Postgres) AccountByUID(ctx context.Context, clerkUserID string) (*Account, error) {
	if clerkUserID == "" {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT `+accountColumns+`
		FROM authd.accounts a
		WHERE a.active AND a.clerk_user_id = $1`, clerkUserID)
	if err != nil {
		return nil, fmt.Errorf("projection: account by uid: %w", err)
	}
	accounts, err := scanAccounts(rows)
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return nil, nil
	}
	if err := p.hydrate(ctx, accounts); err != nil {
		return nil, err
	}
	return &accounts[0], nil
}

func (p *Postgres) GroupsByAddress(ctx context.Context, addresses []string) ([]Group, error) {
	norm := normalise(addresses)
	if len(norm) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT g.name, coalesce(g.email, ''), coalesce(g.description, '')
		FROM authd.groups g
		WHERE lower(g.email) = ANY($1)`, norm)
	if err != nil {
		return nil, fmt.Errorf("projection: groups by address: %w", err)
	}
	return p.scanAndFillGroups(ctx, rows)
}

func (p *Postgres) GroupsForMember(ctx context.Context, clerkUserID string) ([]Group, error) {
	if clerkUserID == "" {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT g.name, coalesce(g.email, ''), coalesce(g.description, '')
		FROM authd.groups g
		JOIN authd.group_members m ON m.group_name = g.name
		WHERE m.clerk_user_id = $1`, clerkUserID)
	if err != nil {
		return nil, fmt.Errorf("projection: groups for member: %w", err)
	}
	return p.scanAndFillGroups(ctx, rows)
}

func scanAccounts(rows pgx.Rows) ([]Account, error) {
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.ClerkUserID, &a.Email, &a.DisplayName,
			&a.Description, &a.Active, &a.PasswordUpdatedAt); err != nil {
			return nil, fmt.Errorf("projection: scan account: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// hydrate fills aliases and group membership for a batch of accounts in two
// queries rather than two per account.
func (p *Postgres) hydrate(ctx context.Context, accounts []Account) error {
	if len(accounts) == 0 {
		return nil
	}
	ids := make([]string, len(accounts))
	idx := make(map[string]int, len(accounts))
	for i, a := range accounts {
		ids[i] = a.ClerkUserID
		idx[a.ClerkUserID] = i
	}

	aliasRows, err := p.pool.Query(ctx,
		`SELECT clerk_user_id, address FROM authd.aliases WHERE clerk_user_id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("projection: aliases: %w", err)
	}
	if err := eachPair(aliasRows, func(id, value string) {
		if i, ok := idx[id]; ok {
			accounts[i].Aliases = append(accounts[i].Aliases, value)
		}
	}); err != nil {
		return err
	}

	groupRows, err := p.pool.Query(ctx,
		`SELECT clerk_user_id, group_name FROM authd.group_members WHERE clerk_user_id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("projection: memberships: %w", err)
	}
	return eachPair(groupRows, func(id, value string) {
		if i, ok := idx[id]; ok {
			accounts[i].MemberOf = append(accounts[i].MemberOf, value)
		}
	})
}

func eachPair(rows pgx.Rows, fn func(key, value string)) error {
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return fmt.Errorf("projection: scan pair: %w", err)
		}
		fn(key, value)
	}
	return rows.Err()
}

func (p *Postgres) scanAndFillGroups(ctx context.Context, rows pgx.Rows) ([]Group, error) {
	var groups []Group
	func() {
		defer rows.Close()
		for rows.Next() {
			var g Group
			if err := rows.Scan(&g.Name, &g.Email, &g.Description); err != nil {
				groups = nil
				return
			}
			groups = append(groups, g)
		}
	}()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("projection: scan groups: %w", err)
	}
	if len(groups) == 0 {
		return nil, nil
	}

	names := make([]string, len(groups))
	idx := make(map[string]int, len(groups))
	for i, g := range groups {
		names[i] = g.Name
		idx[g.Name] = i
	}
	// Only active members are listed. A suspended account must not keep
	// receiving group mail.
	memberRows, err := p.pool.Query(ctx, `
		SELECT m.group_name, m.clerk_user_id
		FROM authd.group_members m
		JOIN authd.accounts a ON a.clerk_user_id = m.clerk_user_id AND a.active
		WHERE m.group_name = ANY($1)`, names)
	if err != nil {
		return nil, fmt.Errorf("projection: group members: %w", err)
	}
	if err := eachPair(memberRows, func(group, member string) {
		if i, ok := idx[group]; ok {
			groups[i].Members = append(groups[i].Members, member)
		}
	}); err != nil {
		return nil, err
	}
	return groups, nil
}

// normalise lowercases and de-duplicates addresses, dropping empties.
func normalise(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

var _ Store = (*Postgres)(nil)
