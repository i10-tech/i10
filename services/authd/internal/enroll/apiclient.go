package enroll

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	// maxAPIProfileRespBytes caps every /enrolld/{peek,attest,finish} JSON
	// response from enrollctl, each of which carries a base64-encoded CMS-signed
	// .mobileconfig (typically ~4 to 12 KiB).
	maxAPIProfileRespBytes = 256 << 10
)

// PeekResponse is the parsed /enrolld/peek 200 payload. When Live is true,
// ProfileBytes holds the decoded signed Phase 1 Profile Service .mobileconfig.
type PeekResponse struct {
	Live         bool   `json:"live"`
	Profile      string `json:"profile"`
	ProfileBytes []byte `json:"-"`
}

// AttestRequest matches the internal /enrolld/attest contract verbatim.
type AttestRequest struct {
	Token             string  `json:"token"`
	UDID              string  `json:"udid"`
	Serial            string  `json:"serial"`
	Product           string  `json:"product"`
	Version           string  `json:"version"`
	DeviceName        *string `json:"deviceName"`
	Model             *string `json:"model"`
	AppleSignerSHA256 string  `json:"appleSignerSha256"`
}

// AttestResponse is the parsed /enrolld/attest 200 payload. When Outcome is
// "scep", ProfileBytes holds the decoded signed SCEP-only .mobileconfig bytes
// ready to relay unchanged to the device.
type AttestResponse struct {
	Outcome      string `json:"outcome"`
	Profile      string `json:"profile"`
	Reason       string `json:"reason"`
	ProfileBytes []byte `json:"-"`
}

// FinishRequest matches the internal /enrolld/finish contract verbatim.
type FinishRequest struct {
	CertDER string  `json:"certDer"`
	UDID    *string `json:"udid"`
}

// FinishResponse is the parsed /enrolld/finish 200 payload. When Outcome is
// "sealed", ProfileBytes holds the decoded signed final .mobileconfig bytes
// ready to relay unchanged to the device.
type FinishResponse struct {
	Outcome      string `json:"outcome"`
	Profile      string `json:"profile"`
	Reason       string `json:"reason"`
	ProfileBytes []byte `json:"-"`
}

// APIClient calls enrollctl's internal :3443 /enrolld/{peek,attest,finish}
// routes over HTTPS, trusting ONLY the mounted hooks CA file (never the system
// trust store).
//
// NO REDIRECTS, NO ENVIRONMENT PROXY, NO SECRET LOGGING. Errors returned by
// APIClient never include the bearer token or request/response bodies.
type APIClient struct {
	baseURL string
	token   string
	client  *http.Client
}

// NewAPIClient constructs an APIClient pinned to caFile.
func NewAPIClient(baseURL, caFile, token string, timeout time.Duration) (*APIClient, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("enroll: API URL must be https without query or fragment, got %q", baseURL)
	}
	token = strings.TrimSpace(token)
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("enroll: API bearer token is empty or contains a line break")
	}
	if timeout < time.Second || timeout > 35*time.Second {
		return nil, fmt.Errorf("enroll: API timeout %s out of range (1s..35s)", timeout)
	}
	rawCA, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("enroll: read API CA file: %w", err)
	}
	certs, err := parseStrictPEMCerts(rawCA)
	if err != nil {
		return nil, fmt.Errorf("enroll: parse API CA file: %w", err)
	}
	pool := x509.NewCertPool()
	for _, c := range certs {
		pool.AddCert(c)
	}

	transport := &http.Transport{
		Proxy: nil, // Never follow environment proxies with the bearer token.
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			// Never follow redirects with the bearer token.
			return http.ErrUseLastResponse
		},
	}
	return &APIClient{
		baseURL: baseURL,
		token:   token,
		client:  client,
	}, nil
}

// Peek calls POST /enrolld/peek and returns whether the enrollment token is
// live along with the signed Phase 1 profile bytes.
func (c *APIClient) Peek(ctx context.Context, token string) (*PeekResponse, error) {
	body, err := c.postJSON(ctx, "/enrolld/peek", struct {
		Token string `json:"token"`
	}{Token: token}, maxAPIProfileRespBytes)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Live    *bool  `json:"live"`
		Profile string `json:"profile"`
	}
	if err := decodeSingleJSON(body, &raw); err != nil {
		return nil, fmt.Errorf("enroll: decode peek response: %w", err)
	}
	if raw.Live == nil {
		return nil, errors.New("enroll: peek response missing live field")
	}
	resp := &PeekResponse{Live: *raw.Live, Profile: raw.Profile}
	if resp.Live {
		if resp.Profile == "" {
			return nil, errors.New("enroll: peek live response missing profile")
		}
		decoded, err := base64.StdEncoding.DecodeString(resp.Profile)
		if err != nil || len(decoded) == 0 {
			return nil, errors.New("enroll: peek live response has invalid base64 profile")
		}
		resp.ProfileBytes = decoded
	}
	return resp, nil
}

// Attest calls POST /enrolld/attest and validates/decodes the signed SCEP profile.
func (c *APIClient) Attest(ctx context.Context, req AttestRequest) (*AttestResponse, error) {
	body, err := c.postJSON(ctx, "/enrolld/attest", req, maxAPIProfileRespBytes)
	if err != nil {
		return nil, err
	}
	var resp AttestResponse
	if err := decodeSingleJSON(body, &resp); err != nil {
		return nil, fmt.Errorf("enroll: decode attest response: %w", err)
	}
	switch resp.Outcome {
	case "scep":
		if resp.Profile == "" {
			return nil, errors.New("enroll: attest scep response missing profile")
		}
		decoded, err := base64.StdEncoding.DecodeString(resp.Profile)
		if err != nil || len(decoded) == 0 {
			return nil, errors.New("enroll: attest scep response has invalid base64 profile")
		}
		resp.ProfileBytes = decoded
		return &resp, nil
	case "refused":
		return &resp, nil
	default:
		return nil, fmt.Errorf("enroll: unexpected attest outcome %q", clampLog(resp.Outcome, 32))
	}
}

// Finish calls POST /enrolld/finish and validates/decodes the signed sealed profile.
func (c *APIClient) Finish(ctx context.Context, req FinishRequest) (*FinishResponse, error) {
	body, err := c.postJSON(ctx, "/enrolld/finish", req, maxAPIProfileRespBytes)
	if err != nil {
		return nil, err
	}
	var resp FinishResponse
	if err := decodeSingleJSON(body, &resp); err != nil {
		return nil, fmt.Errorf("enroll: decode finish response: %w", err)
	}
	switch resp.Outcome {
	case "sealed":
		if resp.Profile == "" {
			return nil, errors.New("enroll: finish sealed response missing profile")
		}
		decoded, err := base64.StdEncoding.DecodeString(resp.Profile)
		if err != nil || len(decoded) == 0 {
			return nil, errors.New("enroll: finish sealed response has invalid base64 profile")
		}
		resp.ProfileBytes = decoded
		return &resp, nil
	case "refused":
		return &resp, nil
	default:
		return nil, fmt.Errorf("enroll: unexpected finish outcome %q", clampLog(resp.Outcome, 32))
	}
}

func (c *APIClient) postJSON(ctx context.Context, path string, payload any, maxRespBytes int64) ([]byte, error) {
	reqBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("enroll: marshal %s request: %w", path, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(reqBytes))
	if err != nil {
		return nil, fmt.Errorf("enroll: build %s request: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("enroll: call %s: %w", path, err)
	}
	defer resp.Body.Close()

	// Drain up to maxRespBytes+1 so oversized responses fail closed instead of
	// being truncated, and keep connections reusable for normal responses.
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes+1))
	if err != nil {
		return nil, fmt.Errorf("enroll: read %s response: %w", path, err)
	}
	if int64(len(respBytes)) > maxRespBytes {
		return nil, fmt.Errorf("enroll: %s response exceeds %d bytes", path, maxRespBytes)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("enroll: %s returned status %d", path, resp.StatusCode)
	}
	return respBytes, nil
}

func decodeSingleJSON(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(dst); err != nil {
		return err
	}
	// Reject trailing garbage after the first JSON value.
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after JSON value")
	}
	return nil
}
