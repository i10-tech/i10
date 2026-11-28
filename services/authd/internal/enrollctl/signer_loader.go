package enrollctl

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"
)

const (
	// ProfileSignerWarnWindow logs WARN when the active profile-signing leaf has
	// fewer than 14 days remaining before NotAfter (design section 3.3).
	ProfileSignerWarnWindow = 14 * 24 * time.Hour
	// ProfileSignerReloadRetryDelay waits briefly once on reload error in case
	// kubelet swapped tls.crt and tls.key across reads.
	ProfileSignerReloadRetryDelay = 100 * time.Millisecond
)

var (
	// ErrSignerNotLoaded indicates no valid profile signer is loaded.
	ErrSignerNotLoaded = errors.New("enrollctl: profile signer not loaded")
	// ErrSignerExpired indicates the active profile signing certificate is past NotAfter.
	ErrSignerExpired = errors.New("enrollctl: profile signing certificate expired")
)

// ProfileSigner holds an immutable validated signing key and full chain.
type ProfileSigner struct {
	Chain  []*x509.Certificate // Chain[0] is leaf; Chain[1..] are intermediates
	Signer crypto.Signer
}

// Sign signs content as DER CMS SignedData, refusing once any certificate of
// the chain is outside its validity (never falling back to unsigned profiles).
func (ps *ProfileSigner) Sign(content []byte, now time.Time) ([]byte, error) {
	if ps == nil || len(ps.Chain) < 2 || ps.Signer == nil {
		return nil, ErrSignerNotLoaded
	}
	if err := chainValidAt(ps.Chain, now); err != nil {
		return nil, err
	}
	return SignCMSSignedData(content, ps.Chain, ps.Signer, now)
}

// chainValidAt is ErrSignerExpired unless EVERY certificate of the chain is
// valid at now: an expired intermediate makes the signature as useless to a
// device as an expired leaf.
func chainValidAt(chain []*x509.Certificate, now time.Time) error {
	for _, c := range chain {
		if now.Before(c.NotBefore) || !now.Before(c.NotAfter) {
			return ErrSignerExpired
		}
	}
	return nil
}

// ProfileSignerLoader loads and hot-reloads the mounted `i10-profile-signing-tls`
// Secret into an atomic.Pointer (docs/research/enrollment-at-scale.md section 3.3).
type ProfileSignerLoader struct {
	CertFile string
	KeyFile  string
	Log      *slog.Logger
	Now      func() time.Time

	cur     atomic.Pointer[ProfileSigner]
	certPEM []byte
	keyPEM  []byte
}

// NewStaticProfileSigner wraps an already-validated chain and signer (used in tests
// and enrollload without disk polling).
func NewStaticProfileSigner(chain []*x509.Certificate, signer crypto.Signer) (*ProfileSignerLoader, error) {
	ps, err := validateProfileSigner(chain, signer, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	l := &ProfileSignerLoader{Now: time.Now}
	l.cur.Store(ps)
	return l, nil
}

func (l *ProfileSignerLoader) now() time.Time {
	if l.Now != nil {
		return l.Now().UTC()
	}
	return time.Now().UTC()
}

// Active returns the currently active ProfileSigner, or nil.
func (l *ProfileSignerLoader) Active() *ProfileSigner {
	if l == nil {
		return nil
	}
	return l.cur.Load()
}

// Sign signs content with the currently active signer. Refuses (503) if none
// is loaded or if the active leaf is expired.
func (l *ProfileSignerLoader) Sign(content []byte) ([]byte, error) {
	ps := l.Active()
	if ps == nil {
		return nil, ErrSignerNotLoaded
	}
	return ps.Sign(content, l.now())
}

// CheckAvailable verifies a non-expired signer is loaded (checked BEFORE
// minting a device in Postgres so an expired cert never mints an unsignable row).
func (l *ProfileSignerLoader) CheckAvailable() error {
	ps := l.Active()
	if ps == nil {
		return ErrSignerNotLoaded
	}
	return chainValidAt(ps.Chain, l.now())
}

// Load reads CertFile and KeyFile, retrying once after 100ms on failure (in
// case kubelet is mid-rotation), and swaps the atomic.Pointer only when every
// validation check passes. On failure, the previous signer stays active.
func (l *ProfileSignerLoader) Load() error {
	err := l.loadOnce()
	if err == nil {
		return nil
	}
	time.Sleep(ProfileSignerReloadRetryDelay)
	if err2 := l.loadOnce(); err2 == nil {
		return nil
	} else {
		return err2
	}
}

func (l *ProfileSignerLoader) loadOnce() error {
	certPEM, err := os.ReadFile(l.CertFile)
	if err != nil {
		return fmt.Errorf("enrollctl: read profile signing cert: %w", err)
	}
	keyPEM, err := os.ReadFile(l.KeyFile)
	if err != nil {
		return fmt.Errorf("enrollctl: read profile signing key: %w", err)
	}
	if bytes.Equal(certPEM, l.certPEM) && bytes.Equal(keyPEM, l.keyPEM) && l.cur.Load() != nil {
		l.warnIfExpiring(l.cur.Load())
		return nil
	}
	ps, err := ParseProfileSignerPEM(certPEM, keyPEM, l.now())
	if err != nil {
		return err
	}
	l.cur.Store(ps)
	l.certPEM = certPEM
	l.keyPEM = keyPEM
	if l.Log != nil {
		l.Log.Info("profile signing certificate loaded",
			"subject", ps.Chain[0].Subject.String(),
			"certs", len(ps.Chain),
			"notAfter", ps.Chain[0].NotAfter.UTC().Format(time.RFC3339))
	}
	l.warnIfExpiring(ps)
	return nil
}

func (l *ProfileSignerLoader) warnIfExpiring(ps *ProfileSigner) {
	if l.Log == nil || ps == nil || len(ps.Chain) == 0 {
		return
	}
	rem := ps.Chain[0].NotAfter.Sub(l.now())
	if rem < ProfileSignerWarnWindow {
		l.Log.Warn("profile signing certificate expiring soon",
			"remaining", rem.Round(time.Minute).String(),
			"notAfter", ps.Chain[0].NotAfter.UTC().Format(time.RFC3339))
	}
}

// Watch reloads the mounted certificate files every interval until ctx ends.
func (l *ProfileSignerLoader) Watch(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := l.Load(); err != nil && l.Log != nil {
				l.Log.Warn("profile signing certificate reload failed, keeping previous", slog.Any("err", err))
			}
		}
	}
}

// ParseProfileSignerPEM parses and strictly validates a profile-signing cert
// chain and key PEM pair per design section 3.3:
//   - at least 2 PEM CERTIFICATE blocks (leaf + >=1 intermediate)
//   - tls.X509KeyPair succeeds (private key matches leaf public key)
//   - ECDSA P-256 leaf key, not a CA
//   - every certificate valid at now (notBefore <= now < notAfter)
//   - leaf chains to the included intermediate(s)
func ParseProfileSignerPEM(certPEM, keyPEM []byte, now time.Time) (*ProfileSigner, error) {
	chain, err := parseCertChainStrict(certPEM)
	if err != nil {
		return nil, err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: profile signing keypair mismatch: %w", err)
	}
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("enrollctl: profile signing private key does not implement crypto.Signer")
	}
	return validateProfileSigner(chain, signer, now)
}

func validateProfileSigner(chain []*x509.Certificate, signer crypto.Signer, now time.Time) (*ProfileSigner, error) {
	if len(chain) < 2 {
		return nil, fmt.Errorf("enrollctl: profile signing bundle has %d cert(s), need >= 2 (leaf + intermediate)", len(chain))
	}
	leaf := chain[0]
	if leaf.IsCA {
		return nil, errors.New("enrollctl: profile signing leaf must not be a CA")
	}
	ecPub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || ecPub.Curve != elliptic.P256() {
		return nil, errors.New("enrollctl: profile signing leaf must be ECDSA P-256")
	}
	signerPub, ok := signer.Public().(*ecdsa.PublicKey)
	if !ok || !ecPub.Equal(signerPub) {
		return nil, errors.New("enrollctl: profile signing private key does not match leaf")
	}
	for i, c := range chain {
		if now.Before(c.NotBefore) || !now.Before(c.NotAfter) {
			return nil, fmt.Errorf("enrollctl: profile signing cert %d not valid at %s (valid %s..%s)", i,
				now.UTC().Format(time.RFC3339),
				c.NotBefore.UTC().Format(time.RFC3339),
				c.NotAfter.UTC().Format(time.RFC3339))
		}
	}
	// Verify every certificate in the bundle chains cleanly to the next one
	// (leaf -> intermediate[0] -> ...).
	for i := 0; i < len(chain)-1; i++ {
		if err := chain[i].CheckSignatureFrom(chain[i+1]); err != nil {
			return nil, fmt.Errorf("enrollctl: cert %d does not chain to cert %d: %w", i, i+1, err)
		}
		if !chain[i+1].IsCA {
			return nil, fmt.Errorf("enrollctl: bundled issuer cert %d is not a CA", i+1)
		}
	}
	return &ProfileSigner{Chain: chain, Signer: signer}, nil
}

func parseCertChainStrict(raw []byte) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	rest := raw
	for {
		rest = bytes.TrimSpace(rest)
		if len(rest) == 0 {
			break
		}
		block, next := pem.Decode(rest)
		if block == nil {
			return nil, errors.New("enrollctl: trailing non-PEM bytes in certificate bundle")
		}
		if block.Type != "CERTIFICATE" {
			return nil, fmt.Errorf("enrollctl: unexpected PEM block %q", block.Type)
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("enrollctl: parse certificate: %w", err)
		}
		certs = append(certs, cert)
		rest = next
	}
	if len(certs) == 0 {
		return nil, errors.New("enrollctl: empty certificate bundle")
	}
	return certs, nil
}
