// Package clerkauth delegates password verification to Clerk.
//
// Clerk is the source of truth for i10 users. authd holds no password material
// of any kind — not a hash, not a verifier. Every bind becomes one call to
// Clerk's Backend API and the answer is passed straight through to Stalwart.
package clerkauth

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
	"time"
)

// Outcome is the tri-state answer a bind needs. The third state is the one that
// matters: "we could not find out" is not the same as "wrong password", and
// collapsing them is the most damaging bug this package could ship.
type Outcome int

const (
	// Rejected means Clerk answered, and the answer was no.
	Rejected Outcome = iota
	// Verified means Clerk answered yes.
	Verified
	// Unavailable means Clerk did not answer. The caller must NOT report this
	// to the client as invalid credentials.
	Unavailable
)

func (o Outcome) String() string {
	switch o {
	case Verified:
		return "verified"
	case Rejected:
		return "rejected"
	default:
		return "unavailable"
	}
}

type Client struct {
	http    *http.Client
	baseURL string
	secret  string
}

func New(baseURL, secretKey string, timeout time.Duration) *Client {
	return &Client{
		http:    &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secretKey,
	}
}

// Verify checks a password for one Clerk user.
//
// The status mapping below was established by probing a live Clerk instance,
// because none of it is documented:
//
//	200                     → Verified
//	422                     → Rejected  (wrong password)
//	400 "no_password_set"   → Rejected  (OAuth-only user who has not set one)
//	429, 5xx, transport err → Unavailable
//
// Also measured, and load-bearing for the whole design: this endpoint does NOT
// feed Clerk's account-lockout counter. Fifteen consecutive failures left
// verification_attempts_remaining at 10 and the account unlocked. A mail client
// retrying a stale saved password therefore cannot lock a user out of their
// dashboard. Re-confirm against the production instance before launch.
//
// The password is never logged, never wrapped into an error, and never
// returned. Errors from this function are safe to log verbatim.
func (c *Client) Verify(ctx context.Context, userID, password string) (Outcome, error) {
	if userID == "" {
		return Rejected, errors.New("clerkauth: empty user id")
	}

	body, err := json.Marshal(struct {
		Password string `json:"password"`
	}{password})
	if err != nil {
		return Unavailable, fmt.Errorf("clerkauth: encode request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/users/%s/verify_password", c.baseURL, url.PathEscape(userID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Unavailable, fmt.Errorf("clerkauth: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.secret)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// Transport failure, DNS, TLS, or the client timeout firing. Never a
		// statement about the password.
		return Unavailable, fmt.Errorf("clerkauth: request failed: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		_ = resp.Body.Close()
	}()

	switch {
	case resp.StatusCode == http.StatusOK:
		return Verified, nil

	case resp.StatusCode == http.StatusUnprocessableEntity:
		return Rejected, nil

	case resp.StatusCode == http.StatusBadRequest:
		// 400 is only a rejection when Clerk names the reason. An unrecognised
		// 400 is our bug or a contract change, and guessing "wrong password"
		// would hide it — so it degrades to Unavailable and gets logged.
		if code := firstErrorCode(resp.Body); code == "no_password_set" {
			return Rejected, nil
		} else if code != "" {
			return Unavailable, fmt.Errorf("clerkauth: unexpected 400 (%s)", code)
		}
		return Unavailable, errors.New("clerkauth: unexpected 400")

	case resp.StatusCode == http.StatusTooManyRequests:
		return Unavailable, fmt.Errorf("clerkauth: rate limited (retry-after %q)",
			resp.Header.Get("Retry-After"))

	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// Our own credential is bad, or the user is locked. Either way this is
		// not evidence about the password the client supplied.
		return Unavailable, fmt.Errorf("clerkauth: not authorised (%d)", resp.StatusCode)

	case resp.StatusCode == http.StatusNotFound:
		// The projection knows a user Clerk does not. Stale projection, not a
		// password answer — surface it so the drift gets noticed.
		return Unavailable, errors.New("clerkauth: user not found in Clerk")

	default:
		return Unavailable, fmt.Errorf("clerkauth: unexpected status %d", resp.StatusCode)
	}
}

// firstErrorCode pulls errors[0].code out of a Clerk error envelope, returning
// "" when the body is not shaped as expected.
func firstErrorCode(r io.Reader) string {
	var payload struct {
		Errors []struct {
			Code string `json:"code"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&payload); err != nil {
		return ""
	}
	if len(payload.Errors) == 0 {
		return ""
	}
	return payload.Errors[0].Code
}
