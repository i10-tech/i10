package passthrough

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPSourceRefusesWhatItCannotTrust(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"unauthorised": {http.StatusUnauthorized, `{"name":"invalid_access"}`},
		"unavailable":  {http.StatusServiceUnavailable, `{"enabled":false}`},
		"server error": {http.StatusInternalServerError, ``},
		"not found":    {http.StatusNotFound, `{"enabled":false}`},
		"unreadable":   {http.StatusOK, `not json`},
		"empty":        {http.StatusOK, ``},
		"redirect":     {http.StatusTemporaryRedirect, ``},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.status == http.StatusTemporaryRedirect {
					w.Header().Set("Location", "http://127.0.0.1:1/elsewhere")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			src, err := NewHTTPSource(srv.URL, strings.Repeat("s", 32), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			// ⚠ An error, and never "off": an outage must not read as a
			// connection with no IMAP.
			s, err := src.Fetch(context.Background(), "conn-1")
			if err == nil || s != nil {
				t.Fatalf("Fetch = %v, %v; want an error", s, err)
			}
			if strings.Contains(err.Error(), strings.Repeat("s", 32)) {
				t.Errorf("the error carries the secret: %v", err)
			}
		})
	}
}

func TestHTTPSourceIsRefusedWhenTheAPIIsDown(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	src, _ := NewHTTPSource(url, strings.Repeat("s", 32), 200*time.Millisecond)
	if s, err := src.Fetch(context.Background(), "conn-1"); err == nil || s != nil {
		t.Fatalf("Fetch = %v, %v; want an error", s, err)
	}
}

func TestHTTPSourceSendsTheSecretAndReadsTheAnswer(t *testing.T) {
	secret := strings.Repeat("k", 32)
	var gotAuth, gotBody, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		b := make([]byte, 512)
		n, _ := r.Body.Read(b)
		gotBody = string(b[:n])
		_, _ = w.Write([]byte(`{"enabled":true,"host":"ldap.acme.test","port":636,"tlsMode":"ldaps","caPem":"",
			"searchBase":"dc=acme","userFilter":"(mail={email})","bindDn":"cn=svc","bindSecret":"s"}`))
	}))
	defer srv.Close()
	src, _ := NewHTTPSource(srv.URL+"/", secret, time.Second)
	s, err := src.Fetch(context.Background(), "conn-1")
	if err != nil || s == nil {
		t.Fatalf("Fetch = %v, %v", s, err)
	}
	if gotAuth != "Bearer "+secret || gotPath != "/internal/authd/passthrough" || gotBody != `{"connectionId":"conn-1"}` {
		t.Errorf("request = %q %q %q", gotAuth, gotPath, gotBody)
	}
	if s.Host != "ldap.acme.test" || s.Port != 636 || s.BindSecret != "s" {
		t.Errorf("settings = %+v", s)
	}
}

func TestHTTPSourceAnswersOffAsNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"enabled":false}`))
	}))
	defer srv.Close()
	src, _ := NewHTTPSource(srv.URL, strings.Repeat("k", 32), time.Second)
	if s, err := src.Fetch(context.Background(), "c"); s != nil || err != nil {
		t.Fatalf("Fetch = %v, %v; want nil, nil", s, err)
	}
}

func TestNewHTTPSourceValidates(t *testing.T) {
	for _, u := range []string{"", "i10-api:3001", "file:///x", "ftp://x", "https://"} {
		if _, err := NewHTTPSource(u, strings.Repeat("k", 32), time.Second); err == nil {
			t.Errorf("%q accepted", u)
		}
	}
	if _, err := NewHTTPSource("https://api.i10.tech", "", time.Second); err == nil {
		t.Error("an empty secret was accepted")
	}
}

type countingSource struct {
	calls atomic.Int32
	s     *Settings
	err   error
}

func (c *countingSource) Fetch(context.Context, string) (*Settings, error) {
	c.calls.Add(1)
	return c.s, c.err
}

func TestCacheKeepsAnAnswerForAtMostAMinute(t *testing.T) {
	src := &countingSource{s: &Settings{Host: "h"}}
	// Asked for an hour; capped.
	c := NewCache(src, time.Hour)
	if c.ttl != MaxCacheTTL {
		t.Fatalf("ttl = %s, want %s", c.ttl, MaxCacheTTL)
	}
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		_, _ = c.Fetch(ctx, "a")
	}
	if got := src.calls.Load(); got != 1 {
		t.Fatalf("source called %d times inside the window, want 1", got)
	}
	now = now.Add(MaxCacheTTL - time.Second)
	_, _ = c.Fetch(ctx, "a")
	if got := src.calls.Load(); got != 1 {
		t.Fatalf("source called %d times at 59s, want 1", got)
	}
	now = now.Add(time.Second)
	_, _ = c.Fetch(ctx, "a")
	if got := src.calls.Load(); got != 2 {
		t.Fatalf("source called %d times at 60s, want 2 (the answer expired)", got)
	}
	// One entry per connection.
	_, _ = c.Fetch(ctx, "b")
	if got := src.calls.Load(); got != 3 {
		t.Fatalf("source called %d times, want 3", got)
	}
}

func TestCacheNeverRemembersAFailure(t *testing.T) {
	src := &countingSource{err: errors.New("api down")}
	c := NewCache(src, time.Minute)
	for i := 0; i < 3; i++ {
		if s, err := c.Fetch(context.Background(), "a"); err == nil || s != nil {
			t.Fatalf("Fetch = %v, %v; want the error", s, err)
		}
	}
	if got := src.calls.Load(); got != 3 {
		t.Fatalf("source called %d times, want 3: a failure was cached", got)
	}
}

func TestCacheRemembersOffForTheSameMinute(t *testing.T) {
	src := &countingSource{}
	c := NewCache(src, time.Minute)
	for i := 0; i < 3; i++ {
		if s, err := c.Fetch(context.Background(), "a"); s != nil || err != nil {
			t.Fatalf("Fetch = %v, %v", s, err)
		}
	}
	if got := src.calls.Load(); got != 1 {
		t.Fatalf("source called %d times, want 1", got)
	}
}

func TestCacheCanBeSwitchedOff(t *testing.T) {
	src := &countingSource{s: &Settings{}}
	c := NewCache(src, 0)
	_, _ = c.Fetch(context.Background(), "a")
	_, _ = c.Fetch(context.Background(), "a")
	if got := src.calls.Load(); got != 2 {
		t.Fatalf("source called %d times, want 2", got)
	}
}
