package appleattest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"testing"
	"time"
)

func makeTestAppleAttestPKI(t *testing.T) (*x509.CertPool, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	now := time.Now().UTC()
	rootKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rootTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Apple Enterprise Attestation Root CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}

	interKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	interTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "Test Apple Attestation Intermediate"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, rootCert, &interKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	interCert, err := x509.ParseCertificate(interDER)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(rootCert)
	return pool, interCert, interKey
}

func makeAttestLeaf(t *testing.T, inter *x509.Certificate, interKey *ecdsa.PrivateKey, exts []pkix.Extension) ([]byte, *ecdsa.PrivateKey) {
	t.Helper()
	now := time.Now().UTC()
	leafKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(100),
		Subject:               pkix.Name{CommonName: "Apple Attestation Leaf"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		ExtraExtensions:       exts,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, inter, &leafKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	return der, leafKey
}

func TestProductionRootLoads(t *testing.T) {
	v := NewProductionVerifier()
	if v == nil || v.roots == nil {
		t.Fatal("production verifier has nil root pool")
	}
}

func TestVerifyChallengeAndRefusals(t *testing.T) {
	pool, inter, interKey := makeTestAppleAttestPKI(t)
	v := NewVerifierForTest(pool)
	now := time.Now().UTC()
	token := "challenge-token-xyz"
	nonce := sha256.Sum256([]byte(token))

	validLeaf, _ := makeAttestLeaf(t, inter, interKey, []pkix.Extension{
		{Id: OIDAppleSerialNumber, Value: []byte("C02MAC12345")},
		{Id: OIDAppleUDID, Value: []byte("UDID-999")},
		{Id: OIDAppleSEPOSVersion, Value: []byte("24D70")},
		{Id: OIDAppleNonce, Value: nonce[:]},
	})
	data, err := v.VerifyChallenge([][]byte{validLeaf, inter.Raw}, "C02MAC12345", token, now)
	if err != nil {
		t.Fatalf("VerifyChallenge valid: %v", err)
	}
	if data.SerialNumber != "C02MAC12345" || data.UDID != "UDID-999" || data.SEPVersion != "24D70" {
		t.Fatalf("unexpected data: %+v", data)
	}

	// Fake root (production verifier must reject test chain).
	if _, err := NewProductionVerifier().VerifyChallenge([][]byte{validLeaf, inter.Raw}, "C02MAC12345", token, now); !errors.Is(err, ErrInvalidChain) {
		t.Fatalf("fake root got %v, want ErrInvalidChain", err)
	}
	// Serial mismatch.
	if _, err := v.VerifyChallenge([][]byte{validLeaf, inter.Raw}, "C02OTHER", token, now); !errors.Is(err, ErrSerialMismatch) {
		t.Fatalf("serial mismatch got %v, want ErrSerialMismatch", err)
	}
	// Nonce mismatch.
	if _, err := v.VerifyChallenge([][]byte{validLeaf, inter.Raw}, "C02MAC12345", "wrong-token", now); !errors.Is(err, ErrNonceMismatch) {
		t.Fatalf("nonce mismatch got %v, want ErrNonceMismatch", err)
	}
	// Missing nonce MUST be refused (unlike step-ca).
	noNonceLeaf, _ := makeAttestLeaf(t, inter, interKey, []pkix.Extension{
		{Id: OIDAppleSerialNumber, Value: []byte("C02MAC12345")},
	})
	if _, err := v.VerifyChallenge([][]byte{noNonceLeaf, inter.Raw}, "C02MAC12345", token, now); !errors.Is(err, ErrMissingNonce) {
		t.Fatalf("missing nonce got %v, want ErrMissingNonce", err)
	}
	// Missing serial MUST be refused.
	noSerialLeaf, _ := makeAttestLeaf(t, inter, interKey, []pkix.Extension{
		{Id: OIDAppleNonce, Value: nonce[:]},
	})
	if _, err := v.VerifyChallenge([][]byte{noSerialLeaf, inter.Raw}, "C02MAC12345", token, now); !errors.Is(err, ErrMissingSerial) {
		t.Fatalf("missing serial got %v, want ErrMissingSerial", err)
	}
}
