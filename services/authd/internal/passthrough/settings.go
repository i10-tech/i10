// Package passthrough answers a managed account's bind from its company's own
// identity provider (#344, #383).
//
// ⚠ A MANAGED ACCOUNT'S PASSWORD BELONGS TO ITS COMPANY, so authd never asks
// Clerk about it. For each SSO connection the API says which lane, if any, the
// password is asked of, and this package fetches that (settings.go):
//
//   - LDAP: the company's own directory. The host is vetted (internal/egress)
//     and the bind walked (binder.go): bind as the service account, find the
//     one entry for the address, bind as that entry with the password given.
//     Success is that last bind and nothing else.
//   - OIDC: the provider's password grant (internal/oidc), for Okta, Keycloak,
//     Auth0, PingFederate, FusionAuth and any other provider that takes a public
//     client's. No service account and no secret at all, only the token endpoint
//     and a public client id.
//
// There is no mailbox password stored here and no fallback. A connection
// without pass-through has no IMAP, and an outage anywhere on this path is
// "unavailable" to the mail client - never "wrong password", and never a
// question for Clerk.
//
// The lane is a verify.Verifier (verifier.go), so everything the bind path does
// for a provider applies to it: the credential cache, the shared failure budget
// and the identical-retry memory. A success is remembered by internal/credcache
// under this verifier's name, which carries the connection id, and not by
// anything in this package; the settings Cache below holds the company's
// settings, never a password or a bind result.
package passthrough

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/oidc"
)

// Settings are one connection's pass-through settings, as the API answers them.
type Settings struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	TLSMode    string `json:"tlsMode"`
	CAPem      string `json:"caPem"`
	SearchBase string `json:"searchBase"`
	UserFilter string `json:"userFilter"`
	BindDN     string `json:"bindDn"`
	BindSecret string `json:"bindSecret"`
}

const (
	TLSModeLDAPS    = "ldaps"
	TLSModeStartTLS = "starttls"
)

// Validate re-checks what the API already validated. Cheap, and the thing that
// turns a corrupt or hostile answer into a refusal rather than a connection.
func (s *Settings) Validate() error {
	switch {
	case s.Host == "":
		return errors.New("no host")
	case s.Port != 389 && s.Port != 636:
		return errors.New("port is not 389 or 636")
	case s.TLSMode != TLSModeLDAPS && s.TLSMode != TLSModeStartTLS:
		// ⚠ PLAINTEXT IS NOT A MODE. An unknown value must not default to it.
		return errors.New("tls mode is not ldaps or starttls")
	case s.SearchBase == "":
		return errors.New("no search base")
	case !strings.Contains(s.UserFilter, FilterPlaceholder):
		return errors.New("filter has no address placeholder")
	case s.BindDN == "" || s.BindSecret == "":
		// ⚠ AN EMPTY SECRET WOULD MAKE THE SERVICE BIND AN UNAUTHENTICATED ONE.
		return errors.New("no service account")
	}
	return nil
}

// The two lanes a managed account's password can be asked of. A connection runs
// at most one (apps/api/src/identity/ldap.ts, passthroughFor, says which).
const (
	LaneLDAP = "ldap"
	LaneOIDC = "oidc"
)

// laneOktaWire is what an API from before the generic lane called an Okta
// connection. It is only ever READ, and becomes the okta preset of LaneOIDC.
const laneOktaWire = "okta"

// Answer is what the API says a connection does with a managed account's
// password: exactly one of LDAP and OIDC is set, the one Lane names.
type Answer struct {
	Lane string
	LDAP *Settings
	OIDC *oidc.Settings
}

// Source says how a connection answers a managed account's password. A nil
// *Answer with a nil error means the API answered that pass-through is off for it.
type Source interface {
	Fetch(ctx context.Context, connectionID string) (*Answer, error)
}

// HTTPSource asks the API, authenticated by the shared secret.
type HTTPSource struct {
	client *http.Client
	url    string
	secret string
}

// NewHTTPSource builds a source for the API at baseURL.
func NewHTTPSource(baseURL, secret string, timeout time.Duration) (*HTTPSource, error) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("passthrough: the API url must be http or https")
	}
	if secret == "" {
		return nil, errors.New("passthrough: no API secret")
	}
	return &HTTPSource{
		client: &http.Client{
			Timeout: timeout,
			// ⚠ NEVER FOLLOWED: a redirect would carry the bearer secret to a
			// place nobody configured.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		url:    strings.TrimRight(baseURL, "/") + "/internal/authd/passthrough",
		secret: secret,
	}, nil
}

// wire is the API's answer: both lanes' fields flattened beside `lane`, of which
// only the named lane's are meaningful. Their JSON names do not overlap.
//
// ⚠ `enabled` STAYS ON THE WIRE and still decides "off", and a missing `lane` is
// LDAP, so the API and authd can roll out in either order. An authd from before
// `lane` reads an OIDC answer as an LDAP one with no host (bad settings, so
// unavailable), not as "off" (a refusal that tells mail clients the password is
// wrong). An authd from before `oidc` reads it as an unknown lane, which is an
// error and so unavailable for the same reason.
//
// ⚠ `lane: "okta"` IS STILL READ, as the okta preset: an API from before the
// generic lane answers an Okta connection with just `issuer` and `clientId`, and
// its token endpoint was always the issuer's /v1/token.
type wire struct {
	Enabled       bool              `json:"enabled"`
	Lane          string            `json:"lane"`
	Issuer        string            `json:"issuer"`
	ClientID      string            `json:"clientId"`
	Preset        string            `json:"preset"`
	TokenEndpoint string            `json:"tokenEndpoint"`
	Extra         map[string]string `json:"extra"`
	Settings
}

// answer is the lane's settings, or an error for a lane this authd does not know.
func (w *wire) answer() (*Answer, error) {
	switch w.Lane {
	case "", LaneLDAP:
		s := w.Settings
		return &Answer{Lane: LaneLDAP, LDAP: &s}, nil
	case LaneOIDC:
		return &Answer{Lane: LaneOIDC, OIDC: &oidc.Settings{
			Preset: w.Preset, Issuer: w.Issuer, TokenEndpoint: w.TokenEndpoint,
			ClientID: w.ClientID, Extra: w.Extra,
		}}, nil
	case laneOktaWire:
		return &Answer{Lane: LaneOIDC, OIDC: &oidc.Settings{
			Preset: oidc.PresetOkta, Issuer: w.Issuer, TokenEndpoint: w.Issuer + "/v1/token", ClientID: w.ClientID,
		}}, nil
	}
	// An API newer than this authd. Not "off": that would read as a connection
	// with no IMAP, and be cached as such.
	return nil, errors.New("passthrough: unknown lane")
}

// Fetch implements Source. Every failure is an error, never "off": the caller
// answers "unavailable" for those, and an outage must not read as a connection
// with no IMAP.
func (h *HTTPSource) Fetch(ctx context.Context, connectionID string) (*Answer, error) {
	body, err := json.Marshal(struct {
		ConnectionID string `json:"connectionId"`
	}{connectionID})
	if err != nil {
		return nil, fmt.Errorf("passthrough: encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("passthrough: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+h.secret)
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		// Never the error's text: a transport error can carry the URL.
		return nil, fmt.Errorf("passthrough: request failed (%T)", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("passthrough: API answered %d", resp.StatusCode)
	}
	var w wire
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&w); err != nil {
		return nil, errors.New("passthrough: unreadable answer")
	}
	if !w.Enabled {
		return nil, nil
	}
	return w.answer()
}

// MaxCacheTTL is the longest an answer is kept, however it is configured.
//
// ⚠ SIXTY SECONDS IS HOW LONG A DISABLED PASS-THROUGH KEEPS ANSWERING, and
// how long a rotated service secret keeps being tried. It is a policy
// statement, not a tuning knob.
const MaxCacheTTL = 60 * time.Second

type cached struct {
	answer  *Answer
	expires time.Time
}

// Cache keeps the API's answers for a short while, in memory only.
//
// ⚠ IT HOLDS A COMPANY'S SERVICE SECRET IN THE CLEAR for up to MaxCacheTTL,
// in this process, never written anywhere. What it spares is the API round
// trip on every IMAP bind; what it does NOT hold is any user's password or any
// bind result.
//
// Only answers are cached, never failures: an outage is retried at the next
// bind rather than remembered. "Off" is cached like any other answer.
type Cache struct {
	src Source
	ttl time.Duration
	now func() time.Time

	mu      sync.Mutex
	entries map[string]cached
}

// NewCache wraps src. A ttl above MaxCacheTTL is cut to it; zero or less
// disables caching.
func NewCache(src Source, ttl time.Duration) *Cache {
	if ttl > MaxCacheTTL {
		ttl = MaxCacheTTL
	}
	return &Cache{src: src, ttl: ttl, now: time.Now, entries: make(map[string]cached)}
}

// Fetch implements Source.
func (c *Cache) Fetch(ctx context.Context, connectionID string) (*Answer, error) {
	if c.ttl > 0 {
		c.mu.Lock()
		e, ok := c.entries[connectionID]
		c.mu.Unlock()
		if ok && c.now().Before(e.expires) {
			return e.answer, nil
		}
	}
	a, err := c.src.Fetch(ctx, connectionID)
	if err != nil || c.ttl <= 0 {
		return a, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	// Connection ids come from our own database, so this stays small; the
	// sweep keeps a deleted connection's entry from outliving its minute.
	for id, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, id)
		}
	}
	c.entries[connectionID] = cached{answer: a, expires: now.Add(c.ttl)}
	return a, nil
}
