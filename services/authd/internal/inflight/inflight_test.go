package inflight

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentCallersShareOneRun(t *testing.T) {
	g := New[int]()
	key := g.Key("user", "clerk", "pw")

	var runs atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once

	const n = 20
	results := make(chan int, n)
	for i := 0; i < n; i++ {
		go func() {
			v, err := g.Do(context.Background(), key, func() int {
				runs.Add(1)
				once.Do(func() { close(started) })
				<-release
				return 42
			})
			if err != nil {
				t.Errorf("Do: %v", err)
			}
			results <- v
		}()
	}

	<-started
	// Give the other callers time to join the flight that is already running.
	time.Sleep(50 * time.Millisecond)
	close(release)

	for i := 0; i < n; i++ {
		if v := <-results; v != 42 {
			t.Fatalf("a caller got %d, want the shared 42", v)
		}
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("fn ran %d times for %d concurrent callers, want 1", got, n)
	}
}

func TestSequentialCallersEachRun(t *testing.T) {
	g := New[int]()
	key := g.Key("user", "clerk", "pw")
	var runs atomic.Int32
	for i := 0; i < 3; i++ {
		if _, err := g.Do(context.Background(), key, func() int { return int(runs.Add(1)) }); err != nil {
			t.Fatal(err)
		}
	}
	if runs.Load() != 3 {
		t.Fatalf("a finished flight was reused: ran %d times, want 3", runs.Load())
	}
}

func TestDifferentKeysDoNotShare(t *testing.T) {
	g := New[string]()
	release := make(chan struct{})
	var wg sync.WaitGroup
	got := make([]string, 2)
	for i, pw := range []string{"a", "b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], _ = g.Do(context.Background(), g.Key("user", "clerk", pw), func() string {
				<-release
				return pw
			})
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if got[0] != "a" || got[1] != "b" {
		t.Fatalf("different passwords shared a flight: %v", got)
	}
}

// ⚠ THE REASON THIS IS NOT x/sync/singleflight. A caller whose own deadline
// passes must neither stop the work nor hand its cancellation to the others.
func TestAWaiterGivingUpDoesNotDisturbTheOthers(t *testing.T) {
	g := New[int]()
	key := g.Key("user", "clerk", "pw")
	release := make(chan struct{})
	started := make(chan struct{})

	var runs atomic.Int32
	fn := func() int {
		runs.Add(1)
		close(started)
		<-release
		return 7
	}

	// The first caller starts the work and then times out.
	short, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	leaderErr := make(chan error, 1)
	go func() {
		_, err := g.Do(short, key, fn)
		leaderErr <- err
	}()
	<-started

	// A second caller joins with a patient context.
	follower := make(chan int, 1)
	go func() {
		v, err := g.Do(context.Background(), key, func() int {
			t.Error("the follower started its own run")
			return -1
		})
		if err != nil {
			t.Errorf("follower: %v", err)
		}
		follower <- v
	}()

	if err := <-leaderErr; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the impatient caller got %v, want its own deadline", err)
	}

	close(release)
	select {
	case v := <-follower:
		if v != 7 {
			t.Fatalf("follower got %d, want the real answer 7", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("follower never got an answer")
	}
	if runs.Load() != 1 {
		t.Fatalf("fn ran %d times, want 1", runs.Load())
	}
}

func TestAPanicInTheWorkFailsEveryWaiterWithoutCrashing(t *testing.T) {
	g := New[int]()
	key := g.Key("user", "clerk", "pw")

	_, err := g.Do(context.Background(), key, func() int {
		var m map[string]int
		m["boom"] = 1 // nil map write
		return 1
	})
	if !errors.Is(err, ErrAbandoned) {
		t.Fatalf("err = %v, want ErrAbandoned", err)
	}

	// And the key is usable again.
	v, err := g.Do(context.Background(), key, func() int { return 5 })
	if err != nil || v != 5 {
		t.Fatalf("flight after a panic = (%d, %v)", v, err)
	}
}

func TestKeyDoesNotConflateFieldBoundaries(t *testing.T) {
	g := New[int]()
	if g.Key("ab", "c") == g.Key("a", "bc") {
		t.Fatal("field boundaries are ambiguous")
	}
}

func TestKeysAreNotSharedBetweenGroups(t *testing.T) {
	if New[int]().Key("u", "pw") == New[int]().Key("u", "pw") {
		t.Fatal("two groups derived the same key")
	}
}
