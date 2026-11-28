// Package appleattest verifies Apple Enterprise Attestation certificate chains
// used by com.apple.security.acme device-attest-01 challenges.
//
// Shared by acmed (on challenge validation) and enrollctl (independent
// re-verification on /acme/finalize so a compromised acmed cannot obtain a
// certificate for any key Apple did not attest for that serial).
package appleattest

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"time"
)

// appleEnterpriseAttestationRootCAPEM is the Apple Enterprise Attestation Root CA.
// Source: Apple Private Certificate Authority
// (https://www.apple.com/certificateauthority/private/), copied from
// step-ca 0.30.2 (acme/challenge.go:1269-1282, Apache-2.0).
const appleEnterpriseAttestationRootCAPEM = `-----BEGIN CERTIFICATE-----
MIICJDCCAamgAwIBAgIUQsDCuyxyfFxeq/bxpm8frF15hzcwCgYIKoZIzj0EAwMw
UTEtMCsGA1UEAwwkQXBwbGUgRW50ZXJwcmlzZSBBdHRlc3RhdGlvbiBSb290IENB
MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzAeFw0yMjAyMTYxOTAx
MjRaFw00NzAyMjAwMDAwMDBaMFExLTArBgNVBAMMJEFwcGxlIEVudGVycHJpc2Ug
QXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UE
BhMCVVMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT6Jigq+Ps9Q4CoT8t8q+UnOe2p
oT9nRaUfGhBTbgvqSGXPjVkbYlIWYO+1zPk2Sz9hQ5ozzmLrPmTBgEWRcHjA2/y7
7GEicps9wn2tj+G89l3INNDKETdxSPPIZpPj8VmjQjBAMA8GA1UdEwEB/wQFMAMB
Af8wHQYDVR0OBBYEFPNqTQGd8muBpV5du+UIbVbi+d66MA4GA1UdDwEB/wQEAwIB
BjAKBggqhkjOPQQDAwNpADBmAjEA1xpWmTLSpr1VH4f8Ypk8f3jMUKYz4QPG8mL5
8m9sX/b2+eXpTv2pH4RZgJjucnbcAjEA4ZSB6S45FlPuS/u4pTnzoz632rA+xW/T
ZwFEh9bhKjJ+5VQ9/Do1os0u3LEkgN/r
-----END CERTIFICATE-----`

var (
	// OIDAppleSerialNumber is Apple's attestation extension carrying the device serial.
	OIDAppleSerialNumber = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 9, 1}
	// OIDAppleUDID is Apple's attestation extension carrying the device UDID.
	OIDAppleUDID = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 9, 2}
	// OIDAppleSEPOSVersion is Apple's attestation extension carrying the SEP OS version.
	OIDAppleSEPOSVersion = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 10, 2}
	// OIDAppleNonce is Apple's attestation extension carrying SHA-256(challenge.token).
	OIDAppleNonce = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 11, 1}
)

var (
	// ErrInvalidChain indicates x5c is malformed or does not verify to the pinned root.
	ErrInvalidChain = errors.New("appleattest: invalid attestation certificate chain")
	// ErrMissingNonce indicates the leaf lacks the required Apple nonce extension.
	ErrMissingNonce = errors.New("appleattest: attestation leaf missing nonce extension")
	// ErrNonceMismatch indicates the leaf nonce does not equal SHA-256(challenge token).
	ErrNonceMismatch = errors.New("appleattest: attestation nonce mismatch")
	// ErrMissingSerial indicates the leaf lacks the required Apple serial extension.
	ErrMissingSerial = errors.New("appleattest: attestation leaf missing serial extension")
	// ErrSerialMismatch indicates the leaf serial does not equal the expected serial.
	ErrSerialMismatch = errors.New("appleattest: attestation serial mismatch")
)

const maxX5CCerts = 8

var pinnedRootPool = mustBuildPinnedRootPool()

func mustBuildPinnedRootPool() *x509.CertPool {
	blk, rest := pem.Decode([]byte(appleEnterpriseAttestationRootCAPEM))
	if blk == nil || blk.Type != "CERTIFICATE" || len(rest) != 0 {
		panic("appleattest: failed to decode pinned Apple Enterprise Attestation Root CA PEM")
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		panic("appleattest: failed to parse pinned Apple Enterprise Attestation Root CA: " + err.Error())
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return pool
}

// Data holds the verified fields extracted from an Apple Enterprise Attestation
// certificate chain.
type Data struct {
	Leaf            *x509.Certificate
	SerialNumber    string
	UDID            string
	SEPVersion      string
	Nonce           []byte
	PublicKeySPKI   []byte
	PublicKeySha256 [32]byte
	PublicKeyHex    string
}

// Verifier verifies Apple Enterprise Attestation x5c chains. Production code
// always uses NewProductionVerifier(), which pins the embedded Apple root.
// Test code may inject a synthetic root through NewVerifierForTest (never an
// environment variable).
type Verifier struct {
	roots *x509.CertPool
}

// NewProductionVerifier returns a Verifier pinned to the embedded Apple
// Enterprise Attestation Root CA.
func NewProductionVerifier() *Verifier {
	return &Verifier{roots: pinnedRootPool}
}

// NewVerifierForTest constructs a Verifier trusting a custom test root pool.
// Production binaries must never wire this from configuration or env vars.
func NewVerifierForTest(roots *x509.CertPool) *Verifier {
	return &Verifier{roots: roots}
}

// VerifyChain parses x5c (leaf first, followed by intermediates), verifies the
// chain to the pinned root at now, and extracts the Apple attestation extensions
// and leaf public key SPKI SHA-256.
func (v *Verifier) VerifyChain(x5c [][]byte, now time.Time) (*Data, error) {
	if v == nil || v.roots == nil {
		return nil, ErrInvalidChain
	}
	if len(x5c) == 0 || len(x5c) > maxX5CCerts {
		return nil, fmt.Errorf("%w: unexpected x5c length %d", ErrInvalidChain, len(x5c))
	}
	leaf, err := x509.ParseCertificate(x5c[0])
	if err != nil {
		return nil, fmt.Errorf("%w: parse leaf: %v", ErrInvalidChain, err)
	}
	if leaf.IsCA {
		return nil, fmt.Errorf("%w: attestation leaf must not be a CA", ErrInvalidChain)
	}
	intermediates := x509.NewCertPool()
	for i, raw := range x5c[1:] {
		ic, err := x509.ParseCertificate(raw)
		if err != nil {
			return nil, fmt.Errorf("%w: parse intermediate %d: %v", ErrInvalidChain, i, err)
		}
		intermediates.AddCert(ic)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         v.roots,
		Intermediates: intermediates,
		CurrentTime:   now.UTC().Truncate(time.Second),
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidChain, err)
	}
	if len(leaf.RawSubjectPublicKeyInfo) == 0 {
		return nil, fmt.Errorf("%w: leaf missing SPKI", ErrInvalidChain)
	}

	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	data := &Data{
		Leaf:            leaf,
		PublicKeySPKI:   leaf.RawSubjectPublicKeyInfo,
		PublicKeySha256: sum,
		PublicKeyHex:    hex.EncodeToString(sum[:]),
	}
	for _, ext := range leaf.Extensions {
		switch {
		case ext.Id.Equal(OIDAppleSerialNumber):
			data.SerialNumber = decodeAppleExtString(ext.Value)
		case ext.Id.Equal(OIDAppleUDID):
			data.UDID = decodeAppleExtString(ext.Value)
		case ext.Id.Equal(OIDAppleSEPOSVersion):
			data.SEPVersion = decodeAppleExtString(ext.Value)
		case ext.Id.Equal(OIDAppleNonce):
			data.Nonce = decodeAppleExtBytes(ext.Value)
		}
	}
	if data.SerialNumber == "" {
		return nil, ErrMissingSerial
	}
	return data, nil
}

// VerifyChallenge verifies x5c, requires the Apple serial extension to match
// expectedSerial, and requires the Apple nonce extension to be PRESENT and
// equal to SHA-256(challengeToken).
func (v *Verifier) VerifyChallenge(x5c [][]byte, expectedSerial, challengeToken string, now time.Time) (*Data, error) {
	data, err := v.VerifyChain(x5c, now)
	if err != nil {
		return nil, err
	}
	if data.SerialNumber != expectedSerial {
		return nil, ErrSerialMismatch
	}
	if len(data.Nonce) == 0 {
		return nil, ErrMissingNonce
	}
	wantNonce := sha256.Sum256([]byte(challengeToken))
	if subtle.ConstantTimeCompare(data.Nonce, wantNonce[:]) != 1 {
		return nil, ErrNonceMismatch
	}
	return data, nil
}

// decodeAppleExtString handles Apple's attestation extension values, which
// macOS encodes as raw bytes inside the X.509 extension OCTET STRING (as
// verified against step-ca 0.30.2 in the live macOS 27.3 probe).
func decodeAppleExtString(raw []byte) string {
	return string(raw)
}

func decodeAppleExtBytes(raw []byte) []byte {
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}
