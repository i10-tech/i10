// Package okta checks a managed account's password against its company's Okta
// org, with Okta's own password grant (#383, B9).
//
// ⚠ NOTHING SECRET IS HELD FOR THIS. The org's authorization server URL and a
// PUBLIC client id (an Okta native app with `token_endpoint_auth_method: none`)
// are all a bind needs, and neither is a credential. The person's password goes
// to Okta in one request and is kept nowhere: not here, not in an error, not in
// a log. i10 stores no mail password, hash, app password or per-device secret.
//
// The answers below were probed against a real org (issue #383, "Okta password
// lane probed"), because none of them is documented as a contract:
//
//	200 with an access_token                          -> Verified
//	400 invalid_grant, "credentials ... invalid"      -> Rejected
//	400 invalid_grant, "denied by sign on policy"     -> Rejected, okta_mfa_required
//	invalid_client, unauthorized_client, any other 4xx -> Unavailable (our customer's setup)
//	429, 5xx, a redirect, a timeout, DNS or TLS        -> Unavailable
//
// ⚠ A LOCKED OKTA ACCOUNT ANSWERS EXACTLY LIKE A WRONG PASSWORD. Ten wrong
// passwords lock the REAL account (the default policy), and Okta then says "the
// credentials provided were invalid" for the right one too. This package cannot
// tell the two apart, and does not try: the failure budget in the bind path
// (3 per 15 minutes, internal/budgetstore) is what keeps i10 from being the
// thing that spends a person's ten.
//
// ⚠ AN UNRECOGNISED INVALID_GRANT IS STILL REJECTED, not Unavailable. invalid_grant
// is a statement about the person's credentials by definition (RFC 6749 5.2),
// and a rejection keeps its budget slot while an unavailable answer gives it
// back. Guessing "unavailable" for a refusal Okta really counted would let a
// mail client retry it without limit against the real account.
package okta

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
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

// UserAgent is what Okta's system log shows for an attempt made on a person's
// behalf by a mail client.
const UserAgent = "i10-authd"

// Settings are one connection's Okta settings, as the API answers them.
type Settings struct {
	// Issuer is the authorization server: https://<org host>/oauth2/default, or
	// /oauth2/<server id>. The token endpoint is Issuer + "/v1/token".
	Issuer string `json:"issuer"`
	// ClientID is a public client (no secret) with the password grant allowed.
	ClientID string `json:"clientId"`
}

var (
	hostPattern     = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	serverPattern   = regexp.MustCompile(`^/oauth2/[0-9A-Za-z]{1,64}$`)
	clientIDPattern = regexp.MustCompile(`^0oa[0-9A-Za-z]{17}$`)
)

// Validate re-checks what the API already validated (apps/api/src/identity/
// okta-mail.ts must agree). Cheap, and the thing that turns a corrupt or
// hostile answer into a refusal rather than a request.
//
// ⚠ THE STRING CHECK IS NOT THE EGRESS GUARD. It refuses what is obviously
// wrong; the guard (internal/egress) resolves the name and vets every address
// at every connection.
func (s Settings) Validate() error {
	u, err := url.Parse(s.Issuer)
	switch {
	case err != nil || u.Scheme != "https" || u.Opaque != "":
		return errors.New("issuer is not an https url")
	case u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "":
		return errors.New("issuer has more than a host and a path")
	case u.Port() != "" || strings.Contains(u.Host, ":"):
		// Okta is on 443. A port, or an IPv6 literal, is not a thing to connect to.
		return errors.New("issuer has a port")
	case !hostPattern.MatchString(u.Host) || isAddress(u.Host) || numericTLD(u.Host):
		return errors.New("issuer host is not a DNS name")
	case !serverPattern.MatchString(u.Path):
		return errors.New("issuer path is not /oauth2/default or /oauth2/<server id>")
	case !clientIDPattern.MatchString(s.ClientID):
		return errors.New("client id is not an Okta client id")
	}
	return nil
}

func isAddress(host string) bool {
	_, err := netip.ParseAddr(host)
	return err == nil
}

// numericTLD catches 127.1.2.3-shaped names the pattern lets through.
func numericTLD(host string) bool {
	label := host[strings.LastIndex(host, ".")+1:]
	return strings.Trim(label, "0123456789") == ""
}

// Reason codes. These are what is logged, never a password, a token or text
// Okta sent: an answer is reduced to one of these before it leaves this package.
const (
	ReasonVerified           = "verified"
	ReasonEmptyPassword      = "empty_password"
	ReasonBadSettings        = "bad_settings"
	ReasonInvalidCredentials = "okta_invalid_credentials"
	// ReasonMFARequired is Okta's "denied by sign on policy": the right password,
	// refused because the app's sign-in policy still wants a second factor. It is
	// a Rejected answer with its own code so the console can later tell the admin
	// to add the password-only policy (issue #383, B9 step 2b).
	ReasonMFARequired = "okta_mfa_required"
	ReasonRateLimited = "okta_rate_limited"
	ReasonServerError = "okta_server_error"
	ReasonRedirected  = "okta_redirected"
	ReasonBadResponse = "okta_bad_response"
	// ReasonConfigPrefix starts the codes for a 4xx that is about our customer's
	// setup (okta_config_invalid_client, okta_config_unauthorized_client, ...).
	ReasonConfigPrefix = "okta_config_"
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

func (f failure) Error() string { return "okta: " + f.reason }

// Client asks an Okta org about one password. The zero value is the production
// client: the system resolver, a plain dialer and the system roots.
type Client struct {
	// Resolver is DNS for the host check; net.DefaultResolver when nil.
	Resolver egress.Resolver
	// Dial opens the connection to the VETTED address. Production dials TCP; tests
	// point it at their server.
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
	// RootCAs verifies the org's certificate; the system roots when nil. Tests
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

// Verify checks email's password against the org described by s.
//
// ⚠ THE ORDER IS THE SECURITY PROPERTY: the settings are validated, then the
// host is vetted and the connection made to the VETTED address (dialTLS), TLS
// is verified against the issuer's name, and only then does the password leave.
// Redirects are never followed: a 3xx would carry the password to a place nobody
// configured.
//
// ⚠ THE PASSWORD IS NEVER LOGGED, WRAPPED INTO AN ERROR OR KEPT, and neither is
// the token Okta answers with. It is read only to see that one is there.
func (c *Client) Verify(ctx context.Context, s Settings, email, password string) Result {
	// An empty password would only ever be a rejection, so it is not sent.
	if password == "" {
		return Result{verify.Rejected, ReasonEmptyPassword}
	}
	if err := s.Validate(); err != nil {
		return Result{verify.Unavailable, ReasonBadSettings}
	}

	form := url.Values{
		"grant_type": {"password"},
		"username":   {email},
		"password":   {password},
		"scope":      {"openid"},
		"client_id":  {s.ClientID},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Issuer+"/v1/token", strings.NewReader(form.Encode()))
	if err != nil {
		return Result{verify.Unavailable, ReasonBadSettings}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// So the customer's admin can tell us in their Okta system log.
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
	return classify(resp.StatusCode, body)
}

// answer is the part of Okta's reply that is read. access_token is read only to
// see that it is there.
type answer struct {
	AccessToken string `json:"access_token"`
	Error       string `json:"error"`
	Description string `json:"error_description"`
}

func classify(status int, body []byte) Result {
	var a answer
	parsed := json.Unmarshal(body, &a) == nil

	switch {
	case status == http.StatusOK:
		if parsed && a.AccessToken != "" {
			return Result{verify.Verified, ReasonVerified}
		}
		// A 200 that is not a token is not a yes.
		return Result{verify.Unavailable, ReasonBadResponse}

	case status == http.StatusBadRequest && parsed && a.Error == "invalid_grant":
		if strings.Contains(strings.ToLower(a.Description), "sign on policy") {
			return Result{verify.Rejected, ReasonMFARequired}
		}
		return Result{verify.Rejected, ReasonInvalidCredentials}

	case status == http.StatusTooManyRequests:
		return Result{verify.Unavailable, ReasonRateLimited}

	case status >= 500:
		return Result{verify.Unavailable, ReasonServerError}

	case status >= 300 && status < 400:
		return Result{verify.Unavailable, ReasonRedirected}

	case status >= 400 && status < 500:
		// invalid_client, unauthorized_client, unsupported_grant_type, a 401 or
		// 403: the org's setup is wrong. It says nothing about the password, so it
		// is unavailable and gives its budget slot back.
		return Result{verify.Unavailable, configReason(a.Error, parsed)}
	}
	return Result{verify.Unavailable, ReasonBadResponse}
}

var errorCode = regexp.MustCompile(`^[a-z_]{1,40}$`)

// configReason is okta_config_<error code>. Okta's error codes are lower-case
// words; anything else is dropped rather than logged, so a hostile org cannot
// put text of its choosing in our logs.
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
