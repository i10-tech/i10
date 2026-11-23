package mailfront

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"
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

// TLSConfig is what the front serves: what Stalwart served on 993 and 465.
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
