// Package oidc checks a managed account's password against its company's own
// OpenID Connect provider, with the provider's OAuth password grant (#383, B9).
// Okta, Keycloak, Auth0, PingFederate and FusionAuth are presets of one lane
// (presets.go); any other provider whose token endpoint takes a public client's
// password grant runs as "generic".
//
// ⚠ NOTHING SECRET IS HELD FOR THIS. The provider's token endpoint and a PUBLIC
// client id (no client secret, no basic auth) are all a bind needs, and neither
// is a credential. The person's password goes to the provider in one request and
// is kept nowhere: not here, not in an error, not in a log. i10 stores no mail
// password, hash, app password or per-device secret.
//
// The answers are mapped like this, for every preset; a preset adds the refusals
// it can tell apart (presets.go), each documented where it is listed:
//
//	200 with an access_token                          -> Verified
//	a preset signal (MFA, locked, disabled, ...)      -> Rejected, with its own reason
//	4xx invalid_grant                                 -> Rejected
//	429, 5xx, a redirect, a timeout, DNS or TLS       -> Unavailable
//	invalid_client, unauthorized_client, any other 4xx -> Unavailable (our customer's setup)
//
// ⚠ A LOCKED ACCOUNT USUALLY ANSWERS EXACTLY LIKE A WRONG PASSWORD. Okta, Keycloak
// and PingFederate all do (some on purpose), and a lock a mail client keeps
// retrying is a lock the customer's own policy extends. This package cannot tell
// the two apart where the provider does not, and does not try: the failure budget
// in the bind path (3 per 15 minutes, internal/budgetstore) is what keeps i10
// from being the thing that spends a person's attempts.
//
// ⚠ AN UNRECOGNISED INVALID_GRANT IS STILL REJECTED, not Unavailable. invalid_grant
// is a statement about the person's credentials by definition (RFC 6749 5.2),
// and a rejection keeps its budget slot while an unavailable answer gives it
// back. Guessing "unavailable" for a refusal the provider really counted would
// let a mail client retry it without limit against the real account. The status
// is not part of that rule: Keycloak says 401, Auth0 403, Okta 400.
package oidc

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/egress"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// RequestTimeout is the longest one token request may take. Okta's password grant
// measured one to seven seconds; ten is the pass-through's own ceiling
// (passthrough.VerifyTimeout), under verify.MaxTimeout.
const RequestTimeout = 10 * time.Second

// maxBody bounds what is read of an answer. A token response is well under 8 KiB.
const maxBody = 1 << 16

// UserAgent is what the provider's log shows for an attempt made on a person's
// behalf by a mail client.
const UserAgent = "i10-authd"

// Reason codes. These are what is logged, never a password, a token or text the
// provider sent: an answer is reduced to one of these before it leaves this
// package.
const (
	ReasonVerified           = "verified"
	ReasonEmptyPassword      = "empty_password"
	ReasonBadSettings        = "bad_settings"
	ReasonInvalidCredentials = "oidc_invalid_credentials"
	// ReasonMFARequired is the right password, refused because the provider still
	// wants a second factor. It is a Rejected answer with its own code so the
	// console can later tell the admin to allow a password-only sign-in for the
	// mail client (issue #383, B9 step 2b).
	ReasonMFARequired = "oidc_mfa_required"
	// ReasonActionRequired is a refusal until the person finishes something in the
	// provider's own pages: a pending required action, an expired password, an
	// unverified address.
	ReasonActionRequired  = "oidc_action_required"
	ReasonAccountLocked   = "oidc_account_locked"
	ReasonAccountDisabled = "oidc_account_disabled"
	ReasonRateLimited     = "oidc_rate_limited"
	ReasonServerError     = "oidc_server_error"
	ReasonRedirected      = "oidc_redirected"
	ReasonBadResponse     = "oidc_bad_response"
	// ReasonConfigPrefix starts the codes for a 4xx that is about our customer's
	// setup (oidc_config_invalid_client, oidc_config_unauthorized_client, ...).
	ReasonConfigPrefix = "oidc_config_"
	ReasonHostBlocked  = "host_blocked"
	ReasonDNSFailed    = "dns_failed"
	ReasonDialFailed   = "dial_failed"
	ReasonTLSFailed    = "tls_failed"
	ReasonTimeout      = "timeout"
	ReasonRequestError = "request_failed"
)

// Result is what a check learned, and why, in a word.
type Result struct {
	Outcome verify.Outcome
	Reason  string
}

// failure is a reason carried out of the dialer, through net/http's own error
// wrapping, to Verify.
type failure struct{ reason string }

func (f failure) Error() string { return "oidc: " + f.reason }

// Client asks a provider about one password. The zero value is the production
// client: the system resolver, a plain dialer and the system roots.
type Client struct {
	// Resolver is DNS for the host check; net.DefaultResolver when nil.
	Resolver egress.Resolver
	// Dial opens the connection to the VETTED address. Production dials TCP; tests
	// point it at their server.
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
	// RootCAs verifies the provider's certificate; the system roots when nil. Tests
	// pass their server's.
	RootCAs     *x509.CertPool
	DialTimeout time.Duration
}

func (c *Client) resolver() egress.Resolver {
	if c.Resolver != nil {
		return c.Resolver
	}
	return net.DefaultResolver
}

// Verify checks email's password against the provider described by s.
//
// ⚠ THE ORDER IS THE SECURITY PROPERTY: the settings are validated, then the
// host is vetted and the connection made to the VETTED address (dialTLS), TLS
// is verified against the token endpoint's name, and only then does the password
// leave. Redirects are never followed: a 3xx would carry the password to a place
// nobody configured.
//
// ⚠ THE PASSWORD IS NEVER LOGGED, WRAPPED INTO AN ERROR OR KEPT, and neither is
// the token the provider answers with. It is read only to see that one is there.
func (c *Client) Verify(ctx context.Context, s Settings, email, password string) Result {
	// An empty password would only ever be a rejection, so it is not sent.
	if password == "" {
		return Result{verify.Rejected, ReasonEmptyPassword}
	}
	if err := s.Validate(); err != nil {
		return Result{verify.Unavailable, ReasonBadSettings}
	}
	p := presets[s.Preset]

	form := url.Values{
		"grant_type": {"password"},
		"username":   {email},
		"password":   {password},
		"scope":      {"openid"},
		"client_id":  {s.ClientID},
	}
	// The extras cannot name a field above: presets.go lists only the optional ones.
	for k, v := range s.Extra {
		form.Set(k, v)
	}
	if p.form != nil {
		p.form(form, s.Extra)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Result{verify.Unavailable, ReasonBadSettings}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// So the customer's admin can tell us in their provider's log.
	req.Header.Set("User-Agent", UserAgent)

	resp, err := c.client().Do(req)
	if err != nil {
		return Result{verify.Unavailable, transportReason(err)}
	}
	// No keep-alive (see client), so there is no connection to hand back and no
	// reason to read what is past the bound.
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return Result{verify.Unavailable, ReasonBadResponse}
	}
	return classify(p, resp.StatusCode, body)
}

// answer is the part of the provider's reply that is read. access_token is read
// only to see that it is there.
type answer struct {
	AccessToken string `json:"access_token"`
	Error       string `json:"error"`
	Description string `json:"error_description"`
	// ErrorReason is FusionAuth's own, closed list of causes.
	ErrorReason string `json:"error_reason"`
}

func classify(p preset, status int, body []byte) Result {
	var a answer
	parsed := json.Unmarshal(body, &a) == nil

	switch {
	case status == http.StatusOK:
		if parsed && a.AccessToken != "" {
			return Result{verify.Verified, ReasonVerified}
		}
		// A 200 that is not a token is not a yes.
		return Result{verify.Unavailable, ReasonBadResponse}

	case status >= 500:
		return Result{verify.Unavailable, ReasonServerError}

	case status >= 300 && status < 400:
		return Result{verify.Unavailable, ReasonRedirected}

	case status >= 400 && status < 500:
		if parsed {
			// ⚠ SIGNALS BEFORE THE STATUS RULES: Auth0's lock is a 429.
			for _, sig := range p.signals {
				if sig.matches(status, a) {
					return Result{verify.Rejected, sig.reason}
				}
			}
			if a.Error == "invalid_grant" {
				return Result{verify.Rejected, ReasonInvalidCredentials}
			}
		}
		if status == http.StatusTooManyRequests {
			return Result{verify.Unavailable, ReasonRateLimited}
		}
		// invalid_client, unauthorized_client, unsupported_grant_type, a 401 or
		// 403: the provider's setup is wrong. It says nothing about the password,
		// so it is unavailable and gives its budget slot back.
		return Result{verify.Unavailable, configReason(a.Error, parsed)}
	}
	return Result{verify.Unavailable, ReasonBadResponse}
}

var errorCode = regexp.MustCompile(`^[a-z_]{1,40}$`)

// configReason is oidc_config_<error code>. OAuth error codes are lower-case
// words; anything else is dropped rather than logged, so a hostile provider
// cannot put text of its choosing in our logs.
func configReason(code string, parsed bool) string {
	if parsed && errorCode.MatchString(code) {
		return ReasonConfigPrefix + code
	}
	return ReasonConfigPrefix + "unknown"
}

// client is built per call. It holds nothing between binds: no keep-alive pool
// of tenant-chosen hosts, and a fresh vet for every connection.
func (c *Client) client() *http.Client {
	return &http.Client{
		Timeout: RequestTimeout,
		Transport: &http.Transport{
			// ⚠ NEVER A PROXY: one from the environment would carry the password
			// somewhere the egress guard cannot see.
			Proxy:             nil,
			DialTLSContext:    c.dialTLS,
			DisableKeepAlives: true,
			// HTTP/1.1 only; a non-nil empty map switches HTTP/2 off.
			TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
			MaxResponseHeaderBytes: maxBody,
		},
		// ⚠ NEVER FOLLOWED: a redirect would carry the password to a place nobody
		// configured. The 3xx itself is the answer.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// dialTLS vets host, connects to the vetted address and verifies TLS against the
// host's name. It is the egress guard for this package.
//
// ⚠ THE CONNECTION IS TO THE VETTED ADDRESS, never to the name again: a name
// that resolves somewhere else a moment later must not redirect it.
func (c *Client) dialTLS(ctx context.Context, _, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, failure{ReasonBadSettings}
	}
	addr, err := egress.Vet(ctx, c.resolver(), host)
	switch {
	case errors.Is(err, egress.ErrBlocked):
		return nil, failure{ReasonHostBlocked}
	case err != nil:
		return nil, failure{ReasonDNSFailed}
	}

	dial := c.Dial
	if dial == nil {
		d := &net.Dialer{Timeout: orDefault(c.DialTimeout, 5*time.Second)}
		dial = d.DialContext
	}
	dialCtx, cancel := context.WithTimeout(ctx, orDefault(c.DialTimeout, 5*time.Second))
	defer cancel()
	raw, err := dial(dialCtx, "tcp", net.JoinHostPort(addr.String(), port))
	if err != nil {
		return nil, failure{ReasonDialFailed}
	}

	conn := tls.Client(raw, &tls.Config{ServerName: host, RootCAs: c.RootCAs, MinVersion: tls.VersionTLS12})
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, failure{ReasonTLSFailed}
	}
	return conn, nil
}

func orDefault(d, fallback time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return fallback
}

// transportReason is why a request did not get an answer. Never the error's text:
// a transport error can carry the URL.
func transportReason(err error) string {
	var f failure
	if errors.As(err, &f) {
		return f.reason
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return ReasonTimeout
	}
	return ReasonRequestError
}
