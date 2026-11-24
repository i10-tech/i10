package projection

import (
	"context"
	"fmt"
	"log/slog"
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
	if err := pingUntilReachable(ctx, pool.Ping, startupDial, slog.Default()); err != nil {
		pool.Close()
		return nil, fmt.Errorf("projection: ping: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

// Pool is the connection pool, for the one other thing authd writes: the shared
// failure budget (internal/budgetstore). It is shared rather than duplicated so
// that the PgBouncer settings above apply to it too.
func (p *Postgres) Pool() *pgxpool.Pool { return p.pool }

// Ping is used by the readiness probe. authd with an unreachable projection can
// answer nothing, and should not be routed to.
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

// accountColumns reads managed status in the same query as the account, so the
// answer the bind acts on cannot be older than the account it belongs to.
// ⚠ A LEFT JOIN, NOT A COLUMN ON authd.accounts: a managed account is managed
// before it has a mailbox row, and a missing row must read as "managed" only
// when authd.managed_accounts says so.
//
// ⚠ EVERY REASON A BIND IS REFUSED BEFORE THE CREDENTIAL CACHE IS READ FROM THIS
// ONE ROW: suspension, a payment hold, a Clerk ban or lock, and whether SSO is
// required for the address. They share the query so none can be older than the
// account they belong to, and so a new one cannot be added to the search path
// and forgotten on the bind path.
//
// ⚠ AND EVERY TABLE THIS READS HAS AN ACCESS-CHANGE TRIGGER. The mail front
// re-checks an open connection when `authd.access_changes` names it (see
// AccessChanges), so a table or column added here, or to a `core` function it
// calls, must be logged too, or a revocation through it closes open sessions
// only at the once-a-minute backstop. TestEveryTableTheGateReadsLogsItsChanges
// reads the tables from this text and the functions it reaches, and fails until
// each has its triggers and no column read here is in a trigger's ignore list;
// the new path belongs in gatePaths (internal/mailfront paths_db_test.go).
// `locked_until > now()` is the one clock read: it only ever lifts a lock, so it
// needs no trigger.
//
// ⚠ AND SO IS WHETHER THE ACCOUNT'S DOMAIN STILL HOSTS MAIL (#406):
// `core.mailbox_domain_refused` is a SECURITY DEFINER function the `authd` role may
// execute and nothing else in `core`. It is true only for a name that has a
// `core.domains` row and is not in `core.mailbox_domains()` for this account's
// workspace, so i10's own domains (no row) and unattributed accounts on them are
// never refused by it.
//
// ⚠ A REQUIRED DOMAIN BINDS ONLY ITS OWN WORKSPACE'S ACCOUNTS (`tenant_id`). The
// mirror is recomputed on the changes that move it, but a row left behind for a
// name that has since changed hands must not lock out the new owner's people.
//
// ⚠ WHO IS EXEMPT FROM IT IS READ FROM THE SAME ROW OF THE SAME QUERY, THROUGH THE
// CONNECTION THAT REQUIRES THE DOMAIN. `authd.required_exempt` has a row for a
// person exactly while they are an owner or admin of the workspace with its owner
// exemption on, or on that connection's bypass list; the API recomputes it in the
// transaction of every change to any of those, so adding or removing somebody
// shows at the next bind on both pods. It is joined on the domain's own connection
// and tenant, so a pass for one connection says nothing about another's. Nothing in
// it expires by itself (see `authd.required_exempt` in apps/api/src/db/schema.ts),
// which is why no clock is read here.
//
// ⚠ THE MAIL DOMAIN IS RETURNED AS THE GATE ITSELF DERIVES IT (accountDomain), so
// the key the mail front files a connection under (`domain` changes in
// `authd.access_changes`) is the text these comparisons used, in the server's
// own lower(), and never a client-side copy that could lowercase differently.
const accountColumns = `a.clerk_user_id, a.email, ` + accountDomain + `, coalesce(a.display_name, ''),
	coalesce(a.description, ''), a.active, a.clerk_updated_at, a.credential_epoch,
	(m.clerk_user_id IS NOT NULL), coalesce(m.connection_id::text, ''),
	coalesce((SELECT pv.version FROM authd.passthrough_versions pv
	          WHERE pv.connection_id = m.connection_id), 0),
	(a.suspended_at IS NOT NULL), (a.payment_hold_at IS NOT NULL), a.banned,
	(a.locked AND (a.locked_until IS NULL OR a.locked_until > now())),
	EXISTS (SELECT 1 FROM authd.required_domains rd
	        WHERE rd.domain = ` + accountDomain + `
	          AND rd.tenant_id = a.tenant_id),
	EXISTS (SELECT 1 FROM authd.required_domains rd
	        JOIN authd.required_exempt ex
	          ON ex.connection_id = rd.connection_id AND ex.tenant_id = rd.tenant_id
	        WHERE rd.domain = ` + accountDomain + `
	          AND rd.tenant_id = a.tenant_id
	          AND ex.clerk_user_id = a.clerk_user_id),
	` + domainRefused + `,
	(a.deleting_at IS NOT NULL)`

// domainRefused is the account's domain gate (#406), the one column of
// accountColumns that is not a read of a row: a call per account. The sweep
// replaces it with the same call made once per domain (SweepQuery).
const domainRefused = `core.mailbox_domain_refused(a.tenant_id, ` + accountDomain + `)`

// accountDomain is an account's mail domain as every gate query compares it.
const accountDomain = `lower(split_part(a.email, '@', 2))`

const accountFrom = `FROM authd.accounts a
		LEFT JOIN authd.managed_accounts m ON m.clerk_user_id = a.clerk_user_id`

// AccountsByAddress resolves the active accounts whose primary address or any
// alias is in addresses, once each, with their aliases and groups.
//
// ⚠ THE ADDRESSES ARE TURNED INTO ACCOUNT IDS FIRST, ONE INDEX LOOKUP PER BRANCH,
// AND ONLY THEN ARE THE ACCOUNTS READ, BY PRIMARY KEY. It runs on every IMAP and
// SMTP sign-in and every LDAP search Stalwart makes for a recipient. Written as
// one `a.email = ANY($1) OR EXISTS (alias ...)`, the OR with a correlated
// subquery kept `accounts_email_unique` from being used: the planner filtered
// every active account and hashed all of `authd.managed_accounts` for the join,
// 262 ms for one address and 823 ms for 50 at 300,000 mailboxes, and the same
// full scan for an address that does not exist (finding 1 of
// docs/research/db-scale/README.md, report-2026-11-22.md). Here the email
// branch uses `accounts_email_unique`, the alias branch the `authd.aliases`
// primary key, UNION removes an account both branches find, and the managed
// join is a primary-key probe per account found.
func (p *Postgres) AccountsByAddress(ctx context.Context, addresses []string) ([]Account, error) {
	norm := normalise(addresses)
	if len(norm) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT `+accountColumns+`
		`+accountFrom+`
		WHERE a.active
		  AND a.clerk_user_id IN (
		        SELECT e.clerk_user_id FROM authd.accounts e WHERE e.email = ANY($1::text[])
		        UNION
		        SELECT al.clerk_user_id FROM authd.aliases al WHERE al.address = ANY($1::text[]))`, norm)
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
		`+accountFrom+`
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

// AccountsByUIDs reads the gate's row for many accounts at once, for the mail
// front's revocation sweep. Missing and inactive ids are simply absent. The
// duration is the query's own, without the wait for a pooled connection
// (queryTimed).
//
// ⚠ THE SAME COLUMNS AS A BIND, SO THE SAME GATE. The front decides with
// internal/gate on exactly what a bind would read. It is one primary-key lookup
// per id (`= ANY($1)` on accounts_pkey), with no aliases or group membership,
// which the gate does not need.
func (p *Postgres) AccountsByUIDs(ctx context.Context, clerkUserIDs []string) ([]Account, time.Duration, error) {
	if len(clerkUserIDs) == 0 {
		return nil, 0, nil
	}
	var accounts []Account
	took, err := p.queryTimed(ctx, func(conn *pgxpool.Conn) error {
		rows, err := conn.Query(ctx, SweepQuery, clerkUserIDs)
		if err != nil {
			return err
		}
		accounts, err = scanAccounts(rows)
		return err
	})
	if err != nil {
		return nil, took, fmt.Errorf("projection: accounts by uids: %w", err)
	}
	return accounts, took, nil
}

// queryTimed runs fn on one pooled connection and returns how long fn took,
// leaving out the wait to acquire the connection.
//
// ⚠ THE MAIL FRONT PACES ITSELF ON THIS NUMBER (mailfront nextWait), SO IT IS
// THE DATABASE'S TIME, NOT THE POOL'S. A reconnect storm that holds every
// connection of the pool (`pool_max_conns`) makes the acquire wait while the
// database is idle; counted in, it would stretch the revocation window for no
// load at all.
func (p *Postgres) queryTimed(ctx context.Context, fn func(*pgxpool.Conn) error) (time.Duration, error) {
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()
	start := time.Now()
	err = fn(conn)
	return time.Since(start), err
}

// SweepQuery is AccountsByUIDs' statement, exported so its cost can be measured
// with EXPLAIN on the statement that actually runs.
//
// ⚠ THE SAME COLUMNS AS A BIND, WITH THE DOMAIN GATE CALLED ONCE PER DOMAIN, NOT
// ONCE PER ACCOUNT. `core.mailbox_domain_refused` is SECURITY DEFINER, so it is
// never inlined: each call is its own plan. Indexed on `lower(name)` (the
// 20261121202659 and 20261121202814 migrations) a call costs about 0.3 ms; before
// them it scanned `core.domains`, about 14 ms a call at 20,000 domains (measured
// 2026-11-21, docs/research/mail-device-binding.md). A bind pays one call. A
// sweep paying one per account would still spend 0.3 s a second at 1,000 live
// accounts. So the accounts come first, the distinct (tenant, domain) pairs are
// judged once each in a MATERIALIZED step, and every other column is
// accountColumns' own text, so a gate added there reaches the sweep without a
// second edit. The account's domain, which accountColumns derives three times,
// is read from `live`, which derived it once with the same text (accountDomain).
// The mail front runs it for every live account once a minute
// (the backstop) and, each second, for the accounts the access-change log names
// (AccessChanges).
//
// ⚠ AN INNER JOIN ON THE VERDICT. An account whose pair found no verdict is
// dropped, which the front reads as "account gone" and closes: never as hosted.
var SweepQuery = `
	WITH live AS (
		SELECT a.*, ` + accountDomain + ` AS domain
		FROM authd.accounts a
		WHERE a.active AND a.clerk_user_id = ANY($1)
	), verdicts AS MATERIALIZED (
		SELECT p.tenant_id, p.domain,
		       core.mailbox_domain_refused(p.tenant_id, p.domain) AS refused
		FROM (SELECT DISTINCT tenant_id, domain FROM live) p
	)
	SELECT ` + strings.ReplaceAll(strings.Replace(accountColumns, domainRefused, `v.refused`, 1), accountDomain, `a.domain`) + `
	FROM live a
	JOIN verdicts v ON v.tenant_id IS NOT DISTINCT FROM a.tenant_id AND v.domain = a.domain
	LEFT JOIN authd.managed_accounts m ON m.clerk_user_id = a.clerk_user_id`

// AccessChanges reads the access-change log (`authd.access_changes`, written by
// a trigger on every table the gate reads) for the mail front: every change
// whose transaction was not yet visible in the snapshot `since`, and the
// current snapshot to pass as `since` next time. An empty `since` returns no
// changes, only the snapshot. At most `limit` changes come back; Truncated says
// there were more. QueryTime is the statement's own time (queryTimed).
//
// ⚠ BY SNAPSHOT, NOT BY ID OR txid. Both are assigned before commit, so a
// transaction that commits after a later one has rows below what a reader has
// already passed, and "id > last" loses them. A change is returned by the first
// read whose snapshot sees its transaction: it was not visible in that read's
// `since` (the previous read's snapshot), and it is visible now. Visibility only
// grows from one snapshot to the next, so each committed change is returned
// exactly once, however late it commits.
//
// ⚠ "NOT VISIBLE IN since" IS "AT OR ABOVE ITS xmax, OR IN ITS IN-PROGRESS LIST",
// exactly (pg_visible_in_snapshot: below xmin is visible, at or above xmax is
// not, and between them only the listed transactions are not). Written that way
// the read is one index range from xmax plus a point lookup per transaction that
// was in progress, so a long writing transaction elsewhere, which holds xmin
// back, costs one more lookup and not a re-read of everything committed since it
// began. ⚠ AS A UNION ALL, NOT AN OR: the OR form was planned as a sequential
// scan of the whole log (docs/research/mail-device-binding/
// change-driven-plans-2026-11-24.txt).
//
// ⚠ ONE STATEMENT, SO ONE SNAPSHOT. The rows and the snapshot handed back are
// the same snapshot (pg_current_snapshot() is the statement's), which is what
// makes the next read start exactly where this one stopped. No session state:
// it runs as one autocommit statement through PgBouncer in transaction mode.
//
// ⚠ TRANSACTION IDS THAT WENT BACK ARE REPORTED, NOT READ PAST (Rewound). After a
// point-in-time restore, or a failover to a replica that had not replayed
// everything, the server hands out ids below `since`'s xmax again, and a
// snapshot test calls each of them already seen. The same statement compares the
// current xmax with `since`'s and also returns `pg_postmaster_start_time()`
// (ServerStart), which catches a promoted lagging replica even after new commits
// push its xmax back past `since`'s. When either trips, the caller must re-check
// everything and start again from the snapshot and start time returned.
func (p *Postgres) AccessChanges(ctx context.Context, since string, limit int) (ChangeBatch, error) {
	var b ChangeBatch
	var kinds, keys []string
	var n int
	took, err := p.queryTimed(ctx, func(conn *pgxpool.Conn) error {
		return conn.QueryRow(ctx, AccessChangesQuery, nullIfEmpty(since), limit+1).Scan(&b.Snapshot, &b.ServerStart, &b.Rewound, &n, &kinds, &keys)
	})
	b.QueryTime = took
	if err != nil {
		return ChangeBatch{QueryTime: took}, fmt.Errorf("projection: access changes: %w", err)
	}
	b.Truncated = n > limit
	b.Changes = make([]Change, min(len(kinds), limit))
	for i := range b.Changes {
		b.Changes[i] = Change{Kind: ChangeKind(kinds[i]), Key: keys[i]}
	}
	return b, nil
}

// AccessChangesQuery is AccessChanges' statement, exported so its cost can be
// measured with EXPLAIN on the statement that actually runs. $2 is one more
// than the most changes the caller takes, so a full read is told from a read of
// exactly that many. The changes are limited before they are aggregated, so a
// burst costs at most $2 rows. A NULL $1 matches no row (every comparison with
// it is NULL) and is never rewound.
const AccessChangesQuery = `
	SELECT pg_current_snapshot()::text,
	       pg_postmaster_start_time(),
	       coalesce(pg_snapshot_xmax(pg_current_snapshot()) < pg_snapshot_xmax($1::pg_snapshot), false),
	       count(*)::int, coalesce(array_agg(c.kind), '{}'), coalesce(array_agg(c.key), '{}')
	FROM (
		(SELECT l.kind, l.key FROM authd.access_changes l
		  WHERE l.txid >= pg_snapshot_xmax($1::pg_snapshot))
		UNION ALL
		(SELECT l.kind, l.key FROM authd.access_changes l
		  WHERE l.txid = ANY (ARRAY(SELECT pg_snapshot_xip($1::pg_snapshot))))
		LIMIT $2
	) c`

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// AccountByLogin resolves the account a mail login names, the way Stalwart's
// `filterLogin` (`(&(objectClass=inetOrgPerson)(mail=?))`) does through authd's
// search: the address is normalised as every lookup here normalises it, and
// only the PRIMARY address matches, because `mail` is the primary address
// (aliases are `mailAlias`, which the login filter does not read). Email is
// unique, so this is one row or none. Aliases and groups are not loaded.
func (p *Postgres) AccountByLogin(ctx context.Context, login string) (*Account, error) {
	norm := normalise([]string{login})
	if len(norm) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT `+accountColumns+`
		`+accountFrom+`
		WHERE a.active AND a.email = $1`, norm[0])
	if err != nil {
		return nil, fmt.Errorf("projection: account by login: %w", err)
	}
	accounts, err := scanAccounts(rows)
	if err != nil || len(accounts) == 0 {
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

func (p *Postgres) GroupsByName(ctx context.Context, names []string) ([]Group, error) {
	if len(names) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT g.name, coalesce(g.email, ''), coalesce(g.description, '')
		FROM authd.groups g
		WHERE g.name = ANY($1)`, names)
	if err != nil {
		return nil, fmt.Errorf("projection: groups by name: %w", err)
	}
	return p.scanAndFillGroups(ctx, rows)
}

func scanAccounts(rows pgx.Rows) ([]Account, error) {
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.ClerkUserID, &a.Email, &a.MailDomain, &a.DisplayName,
			&a.Description, &a.Active, &a.ClerkUpdatedAt, &a.CredentialEpoch,
			&a.Managed, &a.ManagedConnection, &a.PassthroughVersion, &a.Suspended, &a.PaymentHold,
			&a.Banned, &a.Locked, &a.SSORequired, &a.SSOExempt, &a.DomainNotHosted, &a.Deleting); err != nil {
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
