package projection

import (
	"bytes"
	"context"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// gateLogs is how each table the gate reads must be logged: the kind and the
// column holding the key (`authd.log_access_change`'s first two arguments). The
// mail front maps each kind to its connections (mailfront Sweeper.Poll), so a
// table logged under the wrong key would re-check the wrong people.
//
// ⚠ A TABLE ADDED TO THE GATE FAILS TestEveryTableTheGateReadsLogsItsChanges
// UNTIL IT IS HERE AND HAS ITS TRIGGERS, and its paths belong in gatePaths
// (internal/mailfront paths_db_test.go).
var gateLogs = map[string][2]string{
	"authd.accounts":         {string(ChangeAccount), "clerk_user_id"},
	"authd.managed_accounts": {string(ChangeAccount), "clerk_user_id"},
	"authd.required_exempt":  {string(ChangeAccount), "clerk_user_id"},
	// The device rows of open device sessions (SweepQuery), by person.
	"authd.mail_devices":         {string(ChangeAccount), "clerk_user_id"},
	"authd.passthrough_versions": {string(ChangeConnection), "connection_id"},
	"authd.required_domains":     {string(ChangeDomain), "domain"},
	"core.domains":               {string(ChangeDomain), "name"},
	"core.join_domains":          {string(ChangeDomain), "name"},
}

// gateSQL is every statement the gate's decision is made from: the front's and
// the bind's own SQL, and the body of every function they reach, followed
// through the catalog. It returns the text and the tables named in it.
func gateSQL(t *testing.T, ctx context.Context, db *pgxpool.Pool) (text string, tables []string) {
	t.Helper()
	return walkSQL(t, ctx, db, accountColumns+"\n"+accountFrom+"\n"+SweepQuery, rootSearchPath)
}

// rootSearchPath is where an unqualified name in authd's own SQL would resolve:
// `"$user", public` for the two roles that run it, authd and mailfront.
var rootSearchPath = []string{"authd", "mailfront", "public"}

// systemSchemas hold no table a trigger can be put on and no function this repo
// wrote, so names in them are not followed.
var systemSchemas = map[string]bool{"pg_catalog": true, "information_schema": true, "pg_toast": true, "pg_temp": true}

var (
	sqlComment = regexp.MustCompile(`(?s)--[^\n]*|/\*.*?\*/`)
	// sqlName is an identifier with up to two dotted parts after it: a bare name,
	// `schema.name` or `alias.column`, or `schema.table.column`.
	sqlName = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*){0,2}`)
)

// walkSQL returns src, and the text of every function it reaches, and the
// tables named in any of it.
//
// ⚠ EVERY NAME, IN ANY SCHEMA, QUALIFIED OR NOT. A dotted name is resolved in
// the catalog whatever its first part says, so a table in a schema the gate has
// not read before (identity, say) is found; an alias such as `a.email` resolves
// to nothing and is skipped. A bare name is resolved the way Postgres would
// resolve it in that text: against the search path the function pins
// (`proconfig`), or its caller's when it pins none. Every bare word is tried,
// not only the ones after FROM or JOIN, so a comma join, a subquery or an
// UPDATE target is found without parsing SQL; a word that only happens to share
// a table's name over-reports, which fails loudly rather than missing an input.
func walkSQL(t *testing.T, ctx context.Context, db *pgxpool.Pool, src string, searchPath []string) (text string, tables []string) {
	t.Helper()
	seenTable, seenFunc := map[string]bool{}, map[uint32]bool{}
	var texts []string

	var walk func(src string, path []string)
	// followRel resolves schema.name to a relation and records tables.
	followRel := func(schema, name string) bool {
		if systemSchemas[schema] {
			return false
		}
		var relkind string
		err := db.QueryRow(ctx, `SELECT c.relkind::text FROM pg_class c
			WHERE c.oid = to_regclass(quote_ident($1) || '.' || quote_ident($2))`, schema, name).Scan(&relkind)
		switch {
		case err == nil && (relkind == "r" || relkind == "p"):
			if q := schema + "." + name; !seenTable[q] {
				seenTable[q] = true
				tables = append(tables, q)
			}
			return true
		case err == nil && relkind != "S" && relkind != "i" && relkind != "I":
			t.Fatalf("the gate's SQL reads %s.%s, a relation of kind %q this walk does not follow: teach it", schema, name, relkind)
		case err != nil && err != pgx.ErrNoRows:
			t.Fatal(err)
		}
		return false
	}
	// followFunc resolves schema.name to SQL/PLpgSQL functions and walks their
	// full definitions (pg_get_functiondef covers BEGIN ATOMIC bodies too).
	followFunc := func(schema, name string, path []string) bool {
		if systemSchemas[schema] {
			return false
		}
		rows, err := db.Query(ctx, `SELECT p.oid::int8, pg_get_functiondef(p.oid), coalesce(p.proconfig, '{}')
			FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			JOIN pg_language l ON l.oid = p.prolang
			WHERE n.nspname = $1 AND p.proname = $2 AND l.lanname IN ('sql', 'plpgsql') AND p.prokind IN ('f', 'p')`, schema, name)
		if err != nil {
			t.Fatal(err)
		}
		type fn struct {
			oid    uint32
			body   string
			config []string
		}
		var fns []fn
		for rows.Next() {
			var f fn
			var oid int64
			if err := rows.Scan(&oid, &f.body, &f.config); err != nil {
				t.Fatal(err)
			}
			f.oid = uint32(oid)
			fns = append(fns, f)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		for _, f := range fns {
			if seenFunc[f.oid] {
				continue
			}
			seenFunc[f.oid] = true
			walk(f.body, pinnedPath(f.config, path))
		}
		return len(fns) > 0
	}
	walk = func(src string, path []string) {
		src = sqlComment.ReplaceAllString(src, " ")
		texts = append(texts, src)
		for _, m := range sqlName.FindAllString(src, -1) {
			parts := strings.Split(strings.ToLower(m), ".")
			if len(parts) == 1 {
				// Relations and functions have separate namespaces in Postgres,
				// so resolve each independently across the search path.
				for _, schema := range path {
					if followRel(schema, parts[0]) {
						break
					}
				}
				for _, schema := range path {
					if followFunc(schema, parts[0], path) {
						break
					}
				}
				continue
			}
			var isSchema bool
			if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, parts[0]).Scan(&isSchema); err != nil {
				t.Fatal(err)
			}
			if !isSchema {
				continue // alias.column
			}
			foundRel := followRel(parts[0], parts[1])
			foundFunc := followFunc(parts[0], parts[1], path)
			if !foundRel && !foundFunc && !systemSchemas[parts[0]] && !isType(t, ctx, db, parts[0], parts[1]) {
				t.Fatalf("the gate's SQL names %s.%s, which is neither a table, a function nor a type", parts[0], parts[1])
			}
		}
	}
	walk(src, searchPath)
	sort.Strings(tables)
	return strings.Join(texts, "\n"), tables
}

// pinnedPath is the search path a function runs with: its own `SET
// search_path`, or its caller's.
func pinnedPath(config, caller []string) []string {
	for _, c := range config {
		v, ok := strings.CutPrefix(c, "search_path=")
		if !ok {
			continue
		}
		var path []string
		for _, s := range strings.Split(v, ",") {
			if s = strings.Trim(strings.TrimSpace(s), `"`); s != "" && s != "$user" && !systemSchemas[s] {
				path = append(path, s)
			}
		}
		return path
	}
	return caller
}

func isType(t *testing.T, ctx context.Context, db *pgxpool.Pool, schema, name string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(ctx, `SELECT to_regtype(quote_ident($1) || '.' || quote_ident($2)) IS NOT NULL`, schema, name).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// ⚠ THE WALK FINDS A TABLE HOWEVER IT IS NAMED. Without this, a gate input in a
// schema the walk did not know, or named bare inside a function that pins its
// search path, would get no trigger and every test would stay green. A scratch
// schema holds a function with both, and an alias that must not be taken for a
// table.
func TestTheGateWalkFindsTablesInAnySchemaAndUnqualified(t *testing.T) {
	admin := os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if admin == "" {
		t.Skip("AUTHD_TEST_ADMIN_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	drop := func() {
		_, _ = db.Exec(ctx, `DROP SCHEMA IF EXISTS gate_walk_test, gate_walk_test_2 CASCADE`)
	}
	drop()
	t.Cleanup(drop)
	for _, q := range []string{
		`CREATE SCHEMA gate_walk_test`,
		`CREATE SCHEMA gate_walk_test_2`,
		// Same name as a table and a function in one schema (qualified lookup).
		`CREATE TABLE gate_walk_test.dual (id int)`,
		`CREATE TABLE gate_walk_test.hidden_by_dual (id int)`,
		`CREATE FUNCTION gate_walk_test.dual() RETURNS boolean LANGUAGE sql STABLE
		 AS $$ SELECT EXISTS (SELECT 1 FROM gate_walk_test.hidden_by_dual) $$`,
		// Unqualified name where schema 1 has a table and schema 2 has a function.
		`CREATE TABLE gate_walk_test.split_name (id int)`,
		`CREATE TABLE gate_walk_test_2.hidden_by_split (id int)`,
		`CREATE FUNCTION gate_walk_test_2.split_name() RETURNS boolean LANGUAGE sql STABLE
		 AS $$ SELECT EXISTS (SELECT 1 FROM gate_walk_test_2.hidden_by_split) $$`,
		// Standard SQL BEGIN ATOMIC function (prosrc is empty; body lives in prosqlbody).
		`CREATE TABLE gate_walk_test.atomic_target (id int)`,
		`CREATE FUNCTION gate_walk_test.atomic_fn() RETURNS boolean LANGUAGE sql STABLE
		 BEGIN ATOMIC
		   SELECT EXISTS (SELECT 1 FROM gate_walk_test.atomic_target);
		 END`,
		`CREATE FUNCTION gate_walk_test.bare() RETURNS boolean LANGUAGE sql STABLE
		 SET search_path = gate_walk_test, gate_walk_test_2, core, pg_temp
		 AS $$ SELECT split_name() AND gate_walk_test.dual() AND gate_walk_test.atomic_fn()
		       AND EXISTS (SELECT 1 FROM plans p, tenants t WHERE p.id IS NULL) $$`,
	} {
		if _, err := db.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	_, tables := walkSQL(t, ctx, db, `SELECT a.email, gate_walk_test.bare()
		FROM authd.accounts a JOIN identity.connections c ON c.id IS NULL`, rootSearchPath)
	want := []string{
		"authd.accounts",
		"core.plans",
		"core.tenants",
		"gate_walk_test.atomic_target",
		"gate_walk_test.dual",
		"gate_walk_test.hidden_by_dual",
		"gate_walk_test.split_name",
		"gate_walk_test_2.hidden_by_split",
		"identity.connections",
	}
	if !slices.Equal(tables, want) {
		t.Fatalf("the walk found %v, want %v", tables, want)
	}
}

// ⚠ EVERY TABLE THE GATE READS LOGS ITS CHANGES. The tables come from the gate's
// own SQL, not from a list, so a table the gate starts reading (directly or
// inside a core function) fails here until it has all four triggers. And no
// column the gate's SQL names may be in a trigger's ignore list: an update of
// it would not be logged, and its revocation would wait for the backstop.
func TestEveryTableTheGateReadsLogsItsChanges(t *testing.T) {
	admin := os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if admin == "" {
		t.Skip("AUTHD_TEST_ADMIN_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	text, tables := gateSQL(t, ctx, db)
	// The walk has to find the tables behind core.mailbox_domain_refused too, or
	// it proves nothing about them.
	for _, want := range []string{"core.domains", "core.join_domains", "authd.accounts"} {
		if !slices.Contains(tables, want) {
			t.Fatalf("the gate's SQL was read as naming %v, missing %s", tables, want)
		}
	}
	word := func(col string) bool {
		return regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(col) + `\b`).MatchString(text)
	}

	for _, table := range tables {
		want, ok := gateLogs[table]
		if !ok {
			t.Errorf("the gate reads %s, which gateLogs does not list: give it the access-change triggers and a kind", table)
			continue
		}
		schema, name, _ := strings.Cut(table, ".")
		rows, err := db.Query(ctx, `
			SELECT t.tgtype::int, t.tgargs, coalesce(t.tgoldtable::text, ''), coalesce(t.tgnewtable::text, '')
			FROM pg_trigger t
			JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
			  AND t.tgfoid = 'authd.log_access_change()'::regprocedure
			  AND t.tgqual IS NULL AND cardinality(t.tgattr) = 0`, schema, name)
		if err != nil {
			t.Fatal(err)
		}
		events := map[string]bool{}
		var columns []string
		if err := db.QueryRow(ctx, `SELECT array_agg(column_name::text) FROM information_schema.columns
			WHERE table_schema = $1 AND table_name = $2`, schema, name).Scan(&columns); err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var tgtype int
			var raw []byte
			var oldTable, newTable string
			if err := rows.Scan(&tgtype, &raw, &oldTable, &newTable); err != nil {
				t.Fatal(err)
			}
			// pg_trigger.tgtype: 1 row, 2 before, 4 insert, 8 delete, 16 update,
			// 32 truncate, 64 instead.
			if tgtype&(1|2|64) != 0 {
				t.Errorf("%s: an access-change trigger that is not AFTER ... FOR EACH STATEMENT (tgtype %d)", table, tgtype)
			}
			args := strings.Split(string(bytes.TrimSuffix(raw, []byte{0})), "\x00")
			if len(args) < 2 || args[0] != want[0] || args[1] != want[1] {
				t.Errorf("%s: logged as %v, want kind %q keyed on %q", table, args, want[0], want[1])
				continue
			}
			for ev, bit := range map[string]int{"INSERT": 4, "DELETE": 8, "UPDATE": 16, "TRUNCATE": 32} {
				if tgtype&bit == 0 {
					continue
				}
				events[ev] = true
				needOld, needNew := ev == "DELETE" || ev == "UPDATE", ev == "INSERT" || ev == "UPDATE"
				if needOld != (oldTable == "old_rows") || needNew != (newTable == "new_rows") {
					t.Errorf("%s %s: transition tables %q/%q, want the names the function reads", table, ev, oldTable, newTable)
				}
			}
			for _, ignored := range args[2:] {
				if !slices.Contains(columns, ignored) {
					t.Errorf("%s: ignores %q, which is not one of its columns", table, ignored)
				}
				if word(ignored) {
					t.Errorf("%s: ignores %q, which the gate's SQL names: its changes would not be logged", table, ignored)
				}
			}
		}
		rows.Close()
		for _, ev := range []string{"INSERT", "UPDATE", "DELETE", "TRUNCATE"} {
			if !events[ev] {
				t.Errorf("%s has no access-change trigger for %s", table, ev)
			}
		}
	}
	for table := range gateLogs {
		if !slices.Contains(tables, table) {
			t.Errorf("gateLogs lists %s, which the gate no longer reads", table)
		}
	}
}

// ⚠ THE LOST-ENTRY TRAP. A transaction that started writing first and commits
// last has the lower txid and id. A reader that remembered "the highest id I
// read" would skip it for good; reading by snapshot returns it once it commits,
// and returns nothing twice.
func TestAccessChangesReturnsALateCommitOnceItCommits(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_MAILFRONT_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_MAILFRONT_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	const early, late = "user_changes_early", "user_changes_late"
	purge := func() {
		_, _ = w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id IN ($1, $2)`, early, late)
	}
	purge()
	t.Cleanup(purge)
	if _, err := w.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES
		($1, 'changes-early@changes.example', true), ($2, 'changes-late@changes.example', true)`, early, late); err != nil {
		t.Fatal(err)
	}
	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	mine := func(b ChangeBatch) []string {
		var out []string
		for _, c := range b.Changes {
			if c.Kind == ChangeAccount && (c.Key == early || c.Key == late) {
				out = append(out, c.Key)
			}
		}
		return out
	}
	start, err := store.AccessChanges(ctx, "", 1000)
	if err != nil || len(start.Changes) != 0 || start.Snapshot == "" {
		t.Fatalf("a read with no position = (%+v, %v), want only a snapshot", start, err)
	}

	slow, err := w.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = slow.Rollback(ctx) }()
	if _, err := slow.Exec(ctx, `UPDATE authd.accounts SET suspended_at = now() WHERE clerk_user_id = $1`, early); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Exec(ctx, `UPDATE authd.accounts SET banned = true WHERE clerk_user_id = $1`, late); err != nil {
		t.Fatal(err)
	}

	first, err := store.AccessChanges(ctx, start.Snapshot, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := mine(first); !slices.Equal(got, []string{late}) {
		t.Fatalf("with the early writer still open, read %v, want only %s", got, late)
	}
	if err := slow.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := store.AccessChanges(ctx, first.Snapshot, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := mine(second); !slices.Equal(got, []string{early}) {
		t.Fatalf("after the early writer committed, read %v, want only %s (once, and not %s again)", got, early, late)
	}
	third, err := store.AccessChanges(ctx, second.Snapshot, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := mine(third); len(got) != 0 {
		t.Fatalf("a read with nothing new returned %v again", got)
	}

	// A rolled-back change is never returned.
	tx, err := w.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE authd.accounts SET locked = true WHERE clerk_user_id = $1`, early); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	fourth, err := store.AccessChanges(ctx, third.Snapshot, 1000)
	if err != nil || len(mine(fourth)) != 0 {
		t.Fatalf("a rolled-back change was read: %v (%v)", mine(fourth), err)
	}

	// The limit: two changes, a limit of one, then a limit of exactly two. (Each
	// row must really change: a row the update leaves as it was logs nothing.)
	if _, err := w.Exec(ctx, `UPDATE authd.accounts SET banned = NOT banned WHERE clerk_user_id IN ($1, $2)`, early, late); err != nil {
		t.Fatal(err)
	}
	if b, err := store.AccessChanges(ctx, fourth.Snapshot, 1); err != nil || !b.Truncated || len(b.Changes) != 1 {
		t.Fatalf("a read past its limit = (%+v, %v), want one change and Truncated", b, err)
	}
	if b, err := store.AccessChanges(ctx, fourth.Snapshot, 2); err != nil || b.Truncated || len(mine(b)) != 2 {
		t.Fatalf("a read of exactly its limit = (%+v, %v), want both changes and not Truncated", b, err)
	}
}

// ⚠ TRANSACTION IDS THAT WENT BACK. After a restore or a failover to a lagging
// replica, ids below the old position are handed out again and a snapshot test
// calls them already seen ('150' is visible in '100:200:'). A position from
// above the server's current xmax must come back Rewound, with a fresh position
// that is not.
func TestAccessChangesReportsTransactionIDsThatWentBack(t *testing.T) {
	dsn := os.Getenv("AUTHD_TEST_MAILFRONT_DATABASE_URL")
	if dsn == "" {
		t.Skip("AUTHD_TEST_MAILFRONT_DATABASE_URL is not set")
	}
	ctx := context.Background()
	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now, err := store.AccessChanges(ctx, "", 10)
	if err != nil || now.Rewound || now.ServerStart.IsZero() {
		t.Fatalf("a read with no position = (%+v, %v), want it not rewound with a server start time", now, err)
	}
	if b, err := store.AccessChanges(ctx, now.Snapshot, 10); err != nil || b.Rewound || !b.ServerStart.Equal(now.ServerStart) {
		t.Fatalf("a read from the current position = (%+v, %v), want it not rewound with the same server start time", b, err)
	}
	ahead := "9000000000000:9000000000000:"
	b, err := store.AccessChanges(ctx, ahead, 10)
	if err != nil || !b.Rewound || b.Snapshot == "" || !b.ServerStart.Equal(now.ServerStart) {
		t.Fatalf("a read from a position ahead of the server = (%+v, %v), want Rewound and a fresh position", b, err)
	}
	if again, err := store.AccessChanges(ctx, b.Snapshot, 10); err != nil || again.Rewound || !again.ServerStart.Equal(now.ServerStart) {
		t.Fatalf("a read from the fresh position = (%+v, %v), want it not rewound", again, err)
	}
}

// ⚠ THE MAIL DOMAIN IS THE SERVER'S lower(), NOT GO'S. It is the key a connection
// is filed under for `domain` changes, and the gate compares with Postgres's
// lower(); under a C ctype that lowercases only ASCII, which strings.ToLower
// would not match. So the column is read, never derived.
func TestTheMailDomainIsTheGatesOwn(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	const id = "user_mail_domain"
	purge := func() { _, _ = w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id) }
	purge()
	t.Cleanup(purge)
	// Stored as the server's own lower() makes it, which is what
	// accounts_email_lowercase accepts. Under a C ctype that keeps the É, which
	// strings.ToLower would not, so the test still tells the two apart.
	const email = "Someone@Sub.ÉXAMPLE.Test@extra"
	if _, err := w.Exec(ctx, `INSERT INTO authd.accounts (clerk_user_id, email, active) VALUES ($1, lower($2), true)`, id, email); err != nil {
		t.Fatal(err)
	}
	var want string
	if err := w.QueryRow(ctx, `SELECT lower(split_part(email, '@', 2)) FROM authd.accounts WHERE clerk_user_id = $1`, id).Scan(&want); err != nil {
		t.Fatal(err)
	}
	store, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	bound, err := store.AccountByUID(ctx, id)
	if err != nil || bound == nil {
		t.Fatalf("AccountByUID = (%v, %v)", bound, err)
	}
	swept, _, err := store.AccountsByUIDs(ctx, []string{id}, nil)
	if err != nil || len(swept) != 1 {
		t.Fatalf("AccountsByUIDs = (%v, %v)", swept, err)
	}
	if bound.MailDomain != want || swept[0].MailDomain != want {
		t.Fatalf("MailDomain: bind %q, sweep %q, want the server's %q", bound.MailDomain, swept[0].MailDomain, want)
	}
}

// The prune deletes only rows older than its fixed hour, in bounded 10,000-id
// windows. Who may run it is TestTheMailFrontRoleReadsTheGateAndWritesNothing's.
func TestThePruneKeepsTheLastHour(t *testing.T) {
	admin := os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if admin == "" {
		t.Skip("AUTHD_TEST_ADMIN_DATABASE_URL is not set")
	}
	ctx := context.Background()
	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	// Rows written by hand, as the superuser, with negative ids below every real
	// sequence id (>= 1), so a recent negative id always bounds the prune before
	// it reaches whatever positive rows the shared database holds.
	purge := func() {
		_, _ = w.Exec(ctx, `DELETE FROM authd.access_changes WHERE id < 0`)
	}
	purge()
	t.Cleanup(purge)

	pruneOnce := func(t *testing.T) int {
		t.Helper()
		var n int
		if err := w.QueryRow(ctx, `SELECT authd.prune_access_changes()`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	t.Run("keeps rows inside the last hour", func(t *testing.T) {
		purge()
		if _, err := w.Exec(ctx, `INSERT INTO authd.access_changes (id, kind, key, at) OVERRIDING SYSTEM VALUE VALUES
			(-2, 'account', 'prune-test-old', now() - interval '61 minutes'),
			(-1, 'account', 'prune-test-new', now() - interval '59 minutes')`); err != nil {
			t.Fatal(err)
		}
		if n := pruneOnce(t); n != 1 {
			t.Fatalf("first prune deleted %d, want 1", n)
		}
		if n := pruneOnce(t); n != 0 {
			t.Fatalf("second prune deleted %d, want 0", n)
		}
		var keys []string
		if err := w.QueryRow(ctx, `SELECT coalesce(array_agg(key ORDER BY key), '{}') FROM authd.access_changes WHERE id < 0`).Scan(&keys); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(keys, []string{"prune-test-new"}) {
			t.Fatalf("after the prune the test rows are %v, want only the one inside the hour", keys)
		}
	})

	t.Run("drains a backlog larger than one 10000-id batch", func(t *testing.T) {
		purge()
		// 12,000 expired rows at ids -20000..-8001, plus 5 recent rows at -8000..-7996.
		if _, err := w.Exec(ctx, `
			INSERT INTO authd.access_changes (id, kind, key, at) OVERRIDING SYSTEM VALUE
			SELECT -20001 + g, 'account', 'prune-backlog-old-' || g, now() - interval '2 hours'
			  FROM generate_series(1, 12000) g
			UNION ALL
			SELECT -8001 + g, 'account', 'prune-backlog-new-' || g, now() - interval '10 minutes'
			  FROM generate_series(1, 5) g`); err != nil {
			t.Fatal(err)
		}
		if n := pruneOnce(t); n != 10000 {
			t.Fatalf("first batch deleted %d, want 10000", n)
		}
		if n := pruneOnce(t); n != 2000 {
			t.Fatalf("second batch deleted %d, want 2000", n)
		}
		if n := pruneOnce(t); n != 0 {
			t.Fatalf("third batch deleted %d, want 0", n)
		}
		var remaining int
		if err := w.QueryRow(ctx, `SELECT count(*) FROM authd.access_changes WHERE id < 0`).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		if remaining != 5 {
			t.Fatalf("remaining test rows = %d, want 5 recent rows", remaining)
		}
	})

	t.Run("handles id gaps wider than a batch", func(t *testing.T) {
		purge()
		// Two expired rows in [-50000, -40000), a >10,000 gap, one expired row at
		// -20000, another gap, and a recent row at -1000.
		if _, err := w.Exec(ctx, `INSERT INTO authd.access_changes (id, kind, key, at) OVERRIDING SYSTEM VALUE VALUES
			(-50000, 'account', 'prune-gap-1', now() - interval '2 hours'),
			(-45000, 'account', 'prune-gap-2', now() - interval '2 hours'),
			(-20000, 'account', 'prune-gap-3', now() - interval '2 hours'),
			(-1000,  'account', 'prune-gap-new', now() - interval '15 minutes')`); err != nil {
			t.Fatal(err)
		}
		if n := pruneOnce(t); n != 2 {
			t.Fatalf("first gap batch deleted %d, want 2", n)
		}
		if n := pruneOnce(t); n != 1 {
			t.Fatalf("second gap batch deleted %d, want 1", n)
		}
		if n := pruneOnce(t); n != 0 {
			t.Fatalf("third gap batch deleted %d, want 0", n)
		}
		var keys []string
		if err := w.QueryRow(ctx, `SELECT coalesce(array_agg(key ORDER BY id), '{}') FROM authd.access_changes WHERE id < 0`).Scan(&keys); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(keys, []string{"prune-gap-new"}) {
			t.Fatalf("remaining rows = %v, want [prune-gap-new]", keys)
		}
	})

	t.Run("stops on an all-recent window", func(t *testing.T) {
		purge()
		if _, err := w.Exec(ctx, `INSERT INTO authd.access_changes (id, kind, key, at) OVERRIDING SYSTEM VALUE VALUES
			(-500, 'account', 'prune-recent-1', now() - interval '50 minutes'),
			(-400, 'account', 'prune-recent-2', now() - interval '20 minutes'),
			(-1,   'account', 'prune-recent-3', now() - interval '1 minute')`); err != nil {
			t.Fatal(err)
		}
		if n := pruneOnce(t); n != 0 {
			t.Fatalf("prune on an all-recent window deleted %d, want 0", n)
		}
		var remaining int
		if err := w.QueryRow(ctx, `SELECT count(*) FROM authd.access_changes WHERE id < 0`).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		if remaining != 3 {
			t.Fatalf("remaining rows = %d, want 3", remaining)
		}
	})
}
