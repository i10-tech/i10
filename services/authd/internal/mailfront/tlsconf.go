package mailfront

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync/atomic"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
)

// CertFiles serves the certificate in two files and picks up a new one when
// they change.
//
// ⚠ THE FILES ARE A MOUNTED Secret, WHICH THE KUBELET REWRITES WHEN
// cert-manager RENEWS IT. Stalwart reads its certificate once at boot from an
// environment variable, so a renewal needed a pod restart (cert-reload.yaml).
// For 993 and 465 that is over: the front re-reads the files and the next
// handshake gets the new certificate. Port 25 is still Stalwart's and still
// needs the restart.
type CertFiles struct {
	CertFile, KeyFile string
	Log               *slog.Logger

	cur     atomic.Pointer[tls.Certificate]
	certPEM []byte
	keyPEM  []byte
}

// Load reads the pair, failing if it does not parse.
func (c *CertFiles) Load() error {
	certPEM, err := os.ReadFile(c.CertFile)
	if err != nil {
		return fmt.Errorf("mailfront: read certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(c.KeyFile)
	if err != nil {
		return fmt.Errorf("mailfront: read key: %w", err)
	}
	if bytes.Equal(certPEM, c.certPEM) && bytes.Equal(keyPEM, c.keyPEM) {
		return nil
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("mailfront: parse certificate: %w", err)
	}
	c.cur.Store(&pair)
	c.certPEM, c.keyPEM = certPEM, keyPEM
	if c.Log != nil && pair.Leaf != nil {
		c.Log.Info("certificate loaded", "subject", pair.Leaf.Subject.String(),
			"notAfter", pair.Leaf.NotAfter.UTC().Format(time.RFC3339))
	}
	return nil
}

// Watch re-reads the files every interval until ctx ends. A pair that does not
// parse (the kubelet swaps the files one symlink at a time) keeps the current
// certificate and is tried again next time.
func (c *CertFiles) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.Load(); err != nil && c.Log != nil {
				c.Log.Warn("certificate reload failed, keeping the current one", slog.Any("err", err))
			}
		}
	}
}

func (c *CertFiles) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return c.cur.Load(), nil
}

// ClientCAs holds the device CA trust bundle read from a mounted PEM file and
// reloaded periodically. When the file is absent or empty (the ConfigMap is
// optional), Pool returns nil so 993 asks for no certificate and never offers
// AUTH=EXTERNAL.
type ClientCAs struct {
	File string
	Log  *slog.Logger

	cur atomic.Pointer[x509.CertPool]
	pem []byte
}

// Pool returns the current trust pool, or nil when none is loaded.
func (c *ClientCAs) Pool() *x509.CertPool {
	if c == nil {
		return nil
	}
	return c.cur.Load()
}

// Load reads File and updates the pool. An absent or blank file clears the pool
// and returns nil (the bundle is optional). A malformed file returns an error
// and keeps the previous pool.
func (c *ClientCAs) Load() error {
	if c.File == "" {
		c.cur.Store(nil)
		c.pem = nil
		return nil
	}
	raw, err := os.ReadFile(c.File)
	if errors.Is(err, os.ErrNotExist) {
		if c.cur.Swap(nil) != nil && c.Log != nil {
			c.Log.Info("device CA bundle removed: client certificates disabled")
		}
		c.pem = nil
		return nil
	}
	if err != nil {
		return fmt.Errorf("mailfront: read device CA bundle: %w", err)
	}
	if bytes.Equal(raw, c.pem) {
		return nil
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		c.cur.Store(nil)
		c.pem = raw
		return nil
	}
	pool, count, err := ParseCertPool(raw)
	if err != nil {
		return fmt.Errorf("mailfront: parse device CA bundle: %w", err)
	}
	c.cur.Store(pool)
	c.pem = raw
	if c.Log != nil {
		c.Log.Info("device CA bundle loaded", "certs", count)
	}
	return nil
}

// Watch re-reads the trust bundle every interval until ctx ends. A broken file
// keeps the previous pool and is retried on the next tick.
func (c *ClientCAs) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.Load(); err != nil && c.Log != nil {
				c.Log.Warn("device CA bundle reload failed, keeping the current one", slog.Any("err", err))
			}
		}
	}
}

// ParseCertPool reads a PEM bundle of CERTIFICATE blocks and nothing else:
// another block type, trailing bytes or no certificate at all is an error, so a
// truncated or mixed-up mount is refused rather than half-trusted.
func ParseCertPool(raw []byte) (*x509.CertPool, int, error) {
	pool := x509.NewCertPool()
	rest := raw
	count := 0
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			if len(bytes.TrimSpace(rest)) > 0 {
				return nil, 0, errors.New("trailing non-PEM bytes")
			}
			break
		}
		if blk.Type != "CERTIFICATE" {
			return nil, 0, fmt.Errorf("unexpected PEM block %q", blk.Type)
		}
		cert, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, 0, err
		}
		pool.AddCert(cert)
		count++
	}
	if count == 0 {
		return nil, 0, errors.New("no certificates in bundle")
	}
	return pool, count, nil
}

// TLSConfig is what the front serves: what Stalwart served on 993 and 465.
// Never requests a client certificate (used directly for 465).
//
// Stalwart v1.1.0 is rustls with its default suites (measured against it,
// mail-device-binding.md 6): TLS 1.2 and 1.3, and for 1.2 only ECDHE with an
// AEAD cipher. Go's TLS 1.3 suites are the same three; the 1.2 list here is
// rustls's. Go's default would add CBC suites Stalwart never offered.
func TLSConfig(certs *CertFiles) *tls.Config {
	return &tls.Config{
		GetCertificate: certs.get,
		MinVersion:     tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
	}
}

// IMAPTLSConfig is the TLS config for 993: when clientCAs holds a trust pool,
// GetConfigForClient asks for a client certificate (tls.RequestClientCert) with
// that pool as ClientCAs, so clients with no matching identity send nothing.
// When clientCAs is nil or holds no pool, no certificate is requested.
func IMAPTLSConfig(certs *CertFiles, clientCAs *ClientCAs) *tls.Config {
	base := TLSConfig(certs)
	if clientCAs == nil {
		return base
	}
	base.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
		pool := clientCAs.Pool()
		if pool == nil {
			return nil, nil
		}
		cfg := base.Clone()
		cfg.GetConfigForClient = nil
		cfg.ClientAuth = tls.RequestClientCert
		cfg.ClientCAs = pool
		return cfg, nil
	}
	return base
}

// verifiedCert is a client certificate the front verified after the 993 TLS
// handshake: SHA-256 of its SubjectPublicKeyInfo DER and its subject CN.
type verifiedCert struct {
	key []byte
	cn  string
}

// verifyClientCert checks the client certificate presented during the 993 TLS
// handshake against roots. It returns (nil, nil) when no certificate was
// presented or roots is nil, and (nil, err) when a certificate was presented
// but failed any rule (the caller logs and treats it as no certificate).
//
// ⚠ STRICT LEAF CHECKS (section 11 + revision 5):
//   - chain verifies to roots for ExtKeyUsageClientAuth at now;
//   - leaf explicitly lists ExtKeyUsageClientAuth in its own ExtKeyUsage
//     (Go's x509.Verify allows an empty EKU);
//   - leaf carries no DNS or IP SAN (excludes server certs such as step-ca's);
//   - leaf Subject.CommonName fits in bindtoken.MaxCNLen (never truncated).
func verifyClientCert(state tls.ConnectionState, roots *x509.CertPool, now time.Time) (*verifiedCert, error) {
	if roots == nil || len(state.PeerCertificates) == 0 {
		return nil, nil
	}
	leaf := state.PeerCertificates[0]
	var intermediates *x509.CertPool
	if len(state.PeerCertificates) > 1 {
		intermediates = x509.NewCertPool()
		for _, ic := range state.PeerCertificates[1:] {
			intermediates.AddCert(ic)
		}
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		return nil, fmt.Errorf("chain verification failed: %w", err)
	}
	if !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		return nil, errors.New("leaf certificate lacks explicit clientAuth EKU")
	}
	if len(leaf.DNSNames) > 0 || len(leaf.IPAddresses) > 0 {
		return nil, errors.New("leaf certificate carries DNS or IP SAN")
	}
	cn := leaf.Subject.CommonName
	if len(cn) > bindtoken.MaxCNLen {
		return nil, fmt.Errorf("leaf certificate CN is %d bytes (max %d)", len(cn), bindtoken.MaxCNLen)
	}
	if len(leaf.RawSubjectPublicKeyInfo) == 0 {
		return nil, errors.New("leaf certificate has empty SPKI")
	}
	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return &verifiedCert{key: sum[:], cn: cn}, nil
}
