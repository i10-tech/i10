package projection

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// dialPolicy bounds how long authd waits for the projection at startup.
//
// ⚠ A NEW POD'S FIRST CONNECTION TO A ClusterIP IS REFUSED while kube-proxy and
// the CNI finish programming rules for it. pgxpool dials lazily, so the first
// Ping is that first connection, and authd used to exit on it. The database
// was healthy; the packet never arrived.
//
// ⚠ IT FAILED A DEPLOY (Build run 36369175248, 2026-09-28). authd is a sidecar
// in i10-stalwart-0, so its exit restarted the pod's Stalwart with it, and the
// second start landed after "Verify the rollout" had already given up. The
// cluster was fine a minute later; the release was marked failed.
//
// ⚠ A RESTART BY KUBERNETES IS NOT THE RETRY. It costs the whole pod and a
// CrashLoopBackOff delay that grows, which is exactly what the verify window
// cannot absorb. The wait has to be inside the process, as it is in
// apps/api/src/db/client.ts for the bun services.
type dialPolicy struct {
	budget  time.Duration // total time before giving up and exiting
	attempt time.Duration // cap on a single Ping, so a black-holed SYN cannot eat the budget
	base    time.Duration // first backoff; doubles per attempt
	max     time.Duration // backoff ceiling
}

var startupDial = dialPolicy{
	budget:  30 * time.Second,
	attempt: 5 * time.Second,
	base:    250 * time.Millisecond,
	max:     3 * time.Second,
}

// pingUntilReachable calls ping until it succeeds, the budget runs out, or ctx
// is cancelled, and returns the last error it saw.
//
// ⚠ ONLY TRANSPORT FAILURES ARE RETRIED. A *pgconn.PgError means Postgres (or
// PgBouncer) answered - wrong password, missing database, no such role - and
// that is a configuration. Thirty seconds of retrying it would only delay the
// error that says so.
func pingUntilReachable(ctx context.Context, ping func(context.Context) error, p dialPolicy, log *slog.Logger) error {
	deadline := time.Now().Add(p.budget)
	backoff := p.base
	for n := 1; ; n++ {
		attemptCtx, cancel := context.WithTimeout(ctx, p.attempt)
		err := ping(attemptCtx)
		cancel()
		if err == nil {
			if n > 1 {
				log.Info("projection reachable", "attempts", n)
			}
			return nil
		}
		if ctx.Err() != nil {
			return err
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return err
		}

		// Jitter in [backoff/2, backoff]: every authd in a fresh rollout starts
		// at the same instant and should not hit the pooler in lockstep.
		delay := backoff/2 + rand.N(backoff/2+1)
		if time.Now().Add(delay).After(deadline) {
			return err
		}
		log.Warn("projection unreachable, retrying", "attempt", n, "in", delay, slog.Any("err", err))

		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return err
		case <-t.C:
		}
		backoff = min(backoff*2, p.max)
	}
}
