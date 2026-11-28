package acmed

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"testing"

	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
)

func FuzzParseFlattenedJWS(f *testing.F) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	validNewAcct, _ := SignFlattenedJWS(key, ProtectedHeader{
		Nonce: "nonce123",
		URL:   "https://ca.i10.tech/acme/apple/new-account",
		JWK:   jwk,
	}, []byte(`{"termsOfServiceAgreed":true}`))
	validKID, _ := SignFlattenedJWS(key, ProtectedHeader{
		Nonce: "nonce456",
		URL:   "https://ca.i10.tech/acme/apple/new-order",
		KID:   "https://ca.i10.tech/acme/apple/account/acct12345",
	}, []byte(`{}`))

	for _, s := range [][]byte{
		{},
		[]byte(`{}`),
		validNewAcct,
		validKID,
		[]byte(`{"protected":"e30","payload":"","signature":"AA"}`),
	} {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxBodyBytes+1024 {
			data = data[:MaxBodyBytes+1024]
		}
		if p, err := ParseFlattenedJWS(data, "https://ca.i10.tech/acme/apple/new-account", true); err == nil && p.PubKey != nil {
			_ = p.VerifySignature(p.PubKey)
		}
		if p, err := ParseFlattenedJWS(data, "https://ca.i10.tech/acme/apple/new-order", false); err == nil {
			_ = p.VerifySignature(&key.PublicKey)
		}
	})
}

func FuzzParseAppleAttestationCBOR(f *testing.F) {
	valid := EncodeAppleAttestationCBOR([][]byte{[]byte("leaf-der"), []byte("inter-der")})
	for _, s := range [][]byte{
		{},
		valid,
		{0xa0},
		{0xbf, 0xff}, // indefinite map
		{0x9f, 0xff}, // indefinite array
		{0x5f, 0xff}, // indefinite bstr
		{0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81}, // nesting bomb
	} {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxBodyBytes {
			data = data[:MaxBodyBytes]
		}
		_, _ = ParseAppleAttestationCBOR(data)
	})
}

func FuzzFinalizeCSRPath(f *testing.F) {
	key, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	validCSR, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FUZZ", OrganizationalUnit: []string{"OU1"}},
	}, key)
	f.Add(validCSR)
	f.Add([]byte{})
	f.Add([]byte{0x30, 0x80, 0x00, 0x00})

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxBodyBytes {
			data = data[:MaxBodyBytes]
		}
		csr, err := x509.ParseCertificateRequest(data)
		if err != nil {
			return
		}
		_ = csr.CheckSignature()
		_ = enrollctl.ValidateMacACMECSRSubject(csr, "C02FUZZ", "")
	})
}
