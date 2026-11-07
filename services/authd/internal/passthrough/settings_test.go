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
	a, err := src.Fetch(context.Background(), "conn-1")
	if err != nil || a == nil {
		t.Fatalf("Fetch = %v, %v", a, err)
	}
	if gotAuth != "Bearer "+secret || gotPath != "/internal/authd/passthrough" || gotBody != `{"connectionId":"conn-1"}` {
		t.Errorf("request = %q %q %q", gotAuth, gotPath, gotBody)
	}
	// No `lane` is the shape the API had before the OIDC lanes: LDAP.
	if a.Lane != LaneLDAP || a.OIDC != nil || a.LDAP == nil ||
		a.LDAP.Host != "ldap.acme.test" || a.LDAP.Port != 636 || a.LDAP.BindSecret != "s" {
		t.Errorf("answer = %+v", a)
	}
}

func fetchFrom(t *testing.T, body string) (*Answer, error) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	src, _ := NewHTTPSource(srv.URL, strings.Repeat("k", 32), time.Second)
	return src.Fetch(context.Background(), "c")
}

func TestHTTPSourceReadsTheLaneTheAPINames(t *testing.T) {
	a, err := fetchFrom(t, `{"enabled":true,"lane":"ldap","host":"ldap.acme.test","port":636,"tlsMode":"ldaps",
		"searchBase":"dc=acme","userFilter":"(mail={email})","bindDn":"cn=svc","bindSecret":"s"}`)
	if err != nil || a == nil || a.Lane != LaneLDAP || a.LDAP == nil || a.LDAP.Host != "ldap.acme.test" || a.OIDC != nil {
		t.Fatalf("ldap lane: %+v, %v", a, err)
	}

	a, err = fetchFrom(t, `{"enabled":true,"lane":"oidc","preset":"auth0","issuer":"https://acme.auth0.com","tokenEndpoint":"https://acme.auth0.com/oauth/token",
		"clientId":"Zk3q9XvYw0aB5cD7","extra":{"realm":"Employees","audience":"https://mail"}}`)
	if err != nil || a == nil || a.Lane != LaneOIDC || a.LDAP != nil || a.OIDC == nil ||
		a.OIDC.Preset != "auth0" || a.OIDC.Issuer != "https://acme.auth0.com" || a.OIDC.TokenEndpoint != "https://acme.auth0.com/oauth/token" ||
		a.OIDC.ClientID != "Zk3q9XvYw0aB5cD7" || a.OIDC.Extra["realm"] != "Employees" || a.OIDC.Extra["audience"] != "https://mail" {
		t.Fatalf("oidc lane: %+v, %v", a, err)
	}
}

// ⚠ AN API FROM BEFORE THE GENERIC LANE answers an Okta connection with just an
// issuer and a client id. It is the okta preset, and its token endpoint was always
// the issuer's /v1/token.
func TestHTTPSourceStillReadsTheOldOktaLane(t *testing.T) {
	a, err := fetchFrom(t, `{"enabled":true,"lane":"okta","issuer":"https://acme.okta.com/oauth2/default","clientId":"0oa1b2c3d4e5f6g7h8i9"}`)
	if err != nil || a == nil || a.Lane != LaneOIDC || a.LDAP != nil || a.OIDC == nil ||
		a.OIDC.Preset != "okta" || a.OIDC.Issuer != "https://acme.okta.com/oauth2/default" ||
		a.OIDC.TokenEndpoint != "https://acme.okta.com/oauth2/default/v1/token" || a.OIDC.ClientID != "0oa1b2c3d4e5f6g7h8i9" {
		t.Fatalf("old okta lane: %+v, %v", a, err)
	}
	if err := a.OIDC.Validate(); err != nil {
		t.Errorf("what it reads is not valid settings: %v", err)
	}
}

// ⚠ AN API NEWER THAN THIS AUTHD IS AN OUTAGE, not "off": off is a refusal, and
// would be cached for a minute as "this connection has no IMAP".
func TestHTTPSourceDoesNotReadALaneItDoesNotKnowAsOff(t *testing.T) {
	if a, err := fetchFrom(t, `{"enabled":true,"lane":"entra"}`); err == nil || a != nil {
		t.Fatalf("Fetch = %v, %v; want an error", a, err)
	}
}

func TestHTTPSourceAnswersAnOffConnectionOfAnyLaneAsNil(t *testing.T) {
	for _, body := range []string{`{"enabled":false}`, `{"enabled":false,"lane":"oidc"}`} {
		if a, err := fetchFrom(t, body); a != nil || err != nil {
			t.Fatalf("%s: Fetch = %v, %v; want nil, nil", body, a, err)
		}
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
	a     *Answer
	err   error
}

func (c *countingSource) Fetch(context.Context, string) (*Answer, error) {
	c.calls.Add(1)
	return c.a, c.err
}

func TestCacheKeepsAnAnswerForAtMostAMinute(t *testing.T) {
	src := &countingSource{a: &Answer{Lane: LaneLDAP, LDAP: &Settings{Host: "h"}}}
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
	src := &countingSource{a: &Answer{Lane: LaneLDAP, LDAP: &Settings{}}}
	c := NewCache(src, 0)
	_, _ = c.Fetch(context.Background(), "a")
	_, _ = c.Fetch(context.Background(), "a")
	if got := src.calls.Load(); got != 2 {
		t.Fatalf("source called %d times, want 2", got)
	}
}
