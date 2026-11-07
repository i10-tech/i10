// Package inflight collapses concurrent identical binds into one verification.
//
// Mail clients open several connections at once and every one of them binds with
// the same password. Without this each connection would make its own provider
// call, spend its own throttle token and, for a provider with a failure budget,
// its own slot - for an answer that cannot differ.
//
// It is not golang.org/x/sync/singleflight, on purpose. That runs the function
// on the first caller's goroutine under the first caller's context, so a leader
// that times out hands its cancellation to every follower. Here the work runs on
// its own goroutine under a context the work builds for itself, and each waiter
// stops waiting on its OWN context. A waiter that gives up changes nothing for
// the others.
package inflight

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"sync"
)

// ErrAbandoned is returned to a waiter whose work panicked. It carries no
// answer, so the caller must treat it like an unavailable backend.
var ErrAbandoned = errors.New("inflight: the shared work did not finish")

type call[T any] struct {
	done chan struct{}
	val  T
	err  error
}

type Group[T any] struct {
	mu    sync.Mutex
	calls map[string]*call[T]
	key   []byte
}

func New[T any]() *Group[T] {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic("inflight: no entropy for the hmac key: " + err.Error())
	}
	return &Group[T]{calls: make(map[string]*call[T]), key: key}
}

// Key derives the flight key for some identifying fields. It is an HMAC under a
// per-process key, so the raw password is never a map key and never sits in this
// package's memory longer than the call that produced the key. Each field is
// length-prefixed, so ("ab", "c") and ("a", "bc") are different keys.
func (g *Group[T]) Key(fields ...string) string {
	m := hmac.New(sha256.New, g.key)
	var n [8]byte
	for _, f := range fields {
		binary.BigEndian.PutUint64(n[:], uint64(len(f)))
		m.Write(n[:])
		m.Write([]byte(f))
	}
	return string(m.Sum(nil))
}

// Do runs fn once for every concurrent caller that passes the same key, and
// returns its result to each of them.
//
// fn receives no context: it must bound itself, because it outlives any one
// caller. A caller whose ctx ends first returns ctx.Err() and leaves fn running
// for the rest.
func (g *Group[T]) Do(ctx context.Context, key string, fn func() T) (T, error) {
	g.mu.Lock()
	c, running := g.calls[key]
	if !running {
		c = &call[T]{done: make(chan struct{})}
		g.calls[key] = c
		go g.run(key, c, fn)
	}
	g.mu.Unlock()

	select {
	case <-c.done:
		return c.val, c.err
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

func (g *Group[T]) run(key string, c *call[T], fn func() T) {
	// A panic in fn must not take authd down, and must not leave followers
	// waiting forever. Only a runtime error's message is kept, and otherwise just
	// the type: fn handles a password, and a panic value is arbitrary.
	c.err = ErrAbandoned
	defer func() {
		if r := recover(); r != nil {
			if re, ok := r.(runtime.Error); ok {
				c.err = fmt.Errorf("%w: %s", ErrAbandoned, re.Error())
			} else {
				c.err = fmt.Errorf("%w: panic of type %T", ErrAbandoned, r)
			}
		}
		g.mu.Lock()
		delete(g.calls, key)
		g.mu.Unlock()
		close(c.done)
	}()
	c.val = fn()
	c.err = nil
}
