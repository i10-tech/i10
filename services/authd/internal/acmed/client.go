package acmed

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// FinalizeRequest is sent by acmed to enrollctl POST /acme/finalize.
type FinalizeRequest struct {
	Serial         string   `json:"serial"`
	OU             string   `json:"ou"`
	CSRDer         string   `json:"csrDer"`
	AttestationX5C []string `json:"attestationX5c"`
}

// FinalizeResponse is returned by enrollctl POST /acme/finalize.
type FinalizeResponse struct {
	Outcome string `json:"outcome"` // "issued" | "refused"
	Reason  string `json:"reason,omitempty"`
	CertPEM string `json:"certPem,omitempty"`
}

// Finalizer abstracts the enrollctl /acme/finalize RPC.
type Finalizer interface {
	Finalize(ctx context.Context, req FinalizeRequest) (FinalizeResponse, error)
}

// ErrUpstreamUnavailable indicates a transport error, timeout, or 5xx from enrollctl.
var ErrUpstreamUnavailable = errors.New("acmed: enrollctl unavailable")

// EnrollctlClient calls enrollctl POST /acme/finalize over pinned internal HTTPS
// (never system roots, no redirects, no environment proxy).
type EnrollctlClient struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewEnrollctlClient constructs an EnrollctlClient pinned to caPEM.
func NewEnrollctlClient(baseURL, token string, caPEM []byte, timeout time.Duration) (*EnrollctlClient, error) {
	if !strings.HasPrefix(baseURL, "https://") {
		return nil, errors.New("acmed: enrollctl URL must be https://")
	}
	if len(token) < 16 {
		return nil, errors.New("acmed: enrollctl bearer token too short")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("acmed: failed to parse enrollctl CA PEM")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    pool,
		},
		Proxy:               nil,
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     60 * time.Second,
	}
	return &EnrollctlClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Transport: tr,
			Timeout:   timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// NewEnrollctlClientFromCAFile reads caFile and returns an EnrollctlClient.
func NewEnrollctlClientFromCAFile(baseURL, token, caFile string, timeout time.Duration) (*EnrollctlClient, error) {
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("acmed: read enrollctl CA file: %w", err)
	}
	return NewEnrollctlClient(baseURL, token, caPEM, timeout)
}

// Finalize posts req to enrollctl /acme/finalize.
func (c *EnrollctlClient) Finalize(ctx context.Context, req FinalizeRequest) (FinalizeResponse, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return FinalizeResponse{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/acme/finalize", bytes.NewReader(raw))
	if err != nil {
		return FinalizeResponse{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return FinalizeResponse{}, fmt.Errorf("%w: %v", ErrUpstreamUnavailable, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 128*1024+1))
	if err != nil {
		return FinalizeResponse{}, fmt.Errorf("%w: read body: %v", ErrUpstreamUnavailable, err)
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return FinalizeResponse{}, fmt.Errorf("%w: status %d", ErrUpstreamUnavailable, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return FinalizeResponse{Outcome: "refused", Reason: "upstream_rejected"}, nil
	}
	var out FinalizeResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return FinalizeResponse{}, fmt.Errorf("%w: decode response", ErrUpstreamUnavailable)
	}
	return out, nil
}
