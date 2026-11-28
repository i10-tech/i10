package enrollctl

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"testing"
	"time"
)

// signingChain is a leaf and its intermediate with chosen validity, the leaf
// optionally a CA.
func signingChain(t *testing.T, now time.Time, interNotAfter, leafNotAfter time.Time, leafIsCA bool) ([]*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	interKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	interTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "Test Inter"},
		NotBefore: now.Add(-time.Hour), NotAfter: interNotAfter,
		KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true,
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, interTmpl, &interKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	inter, _ := x509.ParseCertificate(interDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "profiles.i10.tech"},
		NotBefore: now.Add(-time.Hour), NotAfter: leafNotAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, BasicConstraintsValid: true, IsCA: leafIsCA,
	}, inter, &leafKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(leafDER)
	return []*x509.Certificate{leaf, inter}, leafKey
}

func TestProfileSignerChecksEveryCertificateOfTheChain(t *testing.T) {
	now := time.Now().UTC()

	chain, key := signingChain(t, now, now.Add(-time.Minute), now.Add(30*24*time.Hour), false)
	if _, err := validateProfileSigner(chain, key, now); err == nil {
		t.Fatal("a chain with an expired intermediate was loaded")
	}

	chain, key = signingChain(t, now, now.Add(60*24*time.Hour), now.Add(30*24*time.Hour), true)
	if _, err := validateProfileSigner(chain, key, now); err == nil {
		t.Fatal("a CA leaf was loaded")
	}

	// Loaded while valid; the intermediate then expires before the leaf.
	chain, key = signingChain(t, now, now.Add(2*time.Hour), now.Add(30*24*time.Hour), false)
	ps, err := validateProfileSigner(chain, key, now)
	if err != nil {
		t.Fatal(err)
	}
	later := now.Add(3 * time.Hour)
	l := &ProfileSignerLoader{Now: func() time.Time { return later }}
	l.cur.Store(ps)
	if err := l.CheckAvailable(); !errors.Is(err, ErrSignerExpired) {
		t.Fatalf("CheckAvailable with an expired intermediate = %v, want ErrSignerExpired", err)
	}
	if _, err := l.Sign([]byte("plist")); !errors.Is(err, ErrSignerExpired) {
		t.Fatalf("Sign with an expired intermediate = %v, want ErrSignerExpired", err)
	}
}
