package enroll

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/smallstep/pkcs7"
)

const samplePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>UDID</key><string>U1</string></dict></plist>`

func TestParseAndVerifyCMSWithSmallstepPKCS7(t *testing.T) {
	pki := newTestPKI(t)

	// Expired Apple leaf signed today (signingTime is years after NotAfter).
	// Prove both that our verifier succeeds AND that smallstep/pkcs7.Verify()
	// would reject this with SigningTimeNotValidError (Review 1 rule H1).
	appleLeaf := pki.issueAppleLeaf(t, pki.appleCA1, "apple-dev", x509.SHA1WithRSA, 1024, nil)
	for _, tc := range []struct {
		name      string
		digestOID asn1.ObjectIdentifier
		wantAlg   x509.SignatureAlgorithm
	}{
		{"SHA1WithRSA", pkcs7.OIDDigestAlgorithmSHA1, x509.SHA1WithRSA},
		{"SHA256WithRSA", pkcs7.OIDDigestAlgorithmSHA256, x509.SHA256WithRSA},
	} {
		t.Run(tc.name, func(t *testing.T) {
			der := signWithPKCS7(t, appleLeaf, tc.digestOID, []byte(samplePlist))

			// Confirm why pkcs7.Verify() is unusable here.
			p7, err := pkcs7.Parse(der)
			if err != nil {
				t.Fatalf("pkcs7.Parse: %v", err)
			}
			var stErr *pkcs7.SigningTimeNotValidError
			if err := p7.Verify(); !errors.As(err, &stErr) {
				t.Fatalf("expected pkcs7.Verify() to fail with SigningTimeNotValidError, got %v", err)
			}

			got, err := ParseAndVerifyCMS(der)
			if err != nil {
				t.Fatalf("ParseAndVerifyCMS: %v", err)
			}
			if !bytes.Equal(got.Signer.Raw, appleLeaf.cert.Raw) {
				t.Fatal("returned wrong signer certificate")
			}
			if string(got.Content) != samplePlist {
				t.Fatalf("content mismatch: got %q", got.Content)
			}
			if got.SigAlg != tc.wantAlg {
				t.Fatalf("SigAlg = %v, want %v", got.SigAlg, tc.wantAlg)
			}
		})
	}
}

func TestParseAndVerifyCMSBERIndefiniteLengthAndChunkedOctetString(t *testing.T) {
	pki := newTestPKI(t)
	leaf := pki.issueSCEPLeaf(t, pki.deviceInter, "SERIALBER", nil)
	der := signWithPKCS7(t, leaf, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))

	// Re-encode the outer ContentInfo with BER indefinite length (0x30 0x80 ... 0x00 0x00)
	// and verify our bounded BER-to-DER normalizer handles it identically.
	var outer asn1.RawValue
	if _, err := asn1.Unmarshal(der, &outer); err != nil {
		t.Fatal(err)
	}
	indef := make([]byte, 0, len(outer.Bytes)+4)
	indef = append(indef, 0x30, 0x80)
	indef = append(indef, outer.Bytes...)
	indef = append(indef, 0x00, 0x00)

	got, err := ParseAndVerifyCMS(indef)
	if err != nil {
		t.Fatalf("ParseAndVerifyCMS on indefinite BER: %v", err)
	}
	if string(got.Content) != samplePlist {
		t.Fatalf("content mismatch: got %q", got.Content)
	}

	// Test constructed OCTET STRING eContent (two primitive 0x04 chunks inside 0x24 0x80 ... 0x00 0x00).
	chunk1, _ := asn1.Marshal([]byte(samplePlist[:40]))
	chunk2, _ := asn1.Marshal([]byte(samplePlist[40:]))
	constructedOct := append([]byte{0x24, 0x80}, chunk1...)
	constructedOct = append(constructedOct, chunk2...)
	constructedOct = append(constructedOct, 0x00, 0x00)

	// Swap the DER OCTET STRING inside EncapContentInfo with the constructed BER OCTET STRING.
	plainOct, _ := asn1.Marshal([]byte(samplePlist))
	idx := bytes.Index(der, plainOct)
	if idx < 0 {
		t.Fatal("could not locate plain OCTET STRING in DER")
	}
	// Wrap the outer ContentInfo and SignedData with indefinite lengths via our helper?
	// Simpler: build SignedData with raw constructed OCTET STRING directly.
	var ci cmsContentInfo
	if _, err := asn1.Unmarshal(der, &ci); err != nil {
		t.Fatal(err)
	}
	var sd cmsSignedData
	if _, err := asn1.Unmarshal(ci.Content.Bytes, &sd); err != nil {
		t.Fatal(err)
	}
	// Convert the constructedOct to definite DER (0x24 <len> chunk1 chunk2) via berToDER,
	// or wrap directly into EncapContentInfo.Content.
	defConstructed, err := berToDER(constructedOct)
	if err != nil {
		t.Fatalf("berToDER constructed oct: %v", err)
	}
	sd.EncapContentInfo.Content = asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: defConstructed}
	sdBytes, err := asn1.Marshal(sd)
	if err != nil {
		t.Fatal(err)
	}
	ci.Content = asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: sdBytes}
	chunkedDER, err := asn1.Marshal(ci)
	if err != nil {
		t.Fatal(err)
	}
	got2, err := ParseAndVerifyCMS(chunkedDER)
	if err != nil {
		t.Fatalf("ParseAndVerifyCMS on constructed OCTET STRING: %v", err)
	}
	if string(got2.Content) != samplePlist {
		t.Fatalf("constructed content mismatch: got %q", got2.Content)
	}
}

func TestParseAndVerifyCMSWithoutSignedAttrs(t *testing.T) {
	pki := newTestPKI(t)
	appleLeaf := pki.issueAppleLeaf(t, pki.appleCA1, "mac-apple-dev", x509.SHA1WithRSA, 1024, nil)
	scepLeaf := pki.issueSCEPLeaf(t, pki.deviceInter, "C02MACSCEP", nil)

	macPlist := makeMacAttributesPlist(
		"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"11111111-2222-3333-4444-555555555555",
		"C02MACSCEP", "Mac15,6", "26C5047e", "Test MacBook Pro", "MacBook Pro", false,
	)

	cases := []struct {
		name      string
		id        testIdentity
		digestOID asn1.ObjectIdentifier
		sigOID    asn1.ObjectIdentifier
		hashAlg   crypto.Hash
		wantAlg   x509.SignatureAlgorithm
		extra     []*x509.Certificate
	}{
		{"phase 2 Apple SHA1WithRSA", appleLeaf, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, x509.SHA1WithRSA, []*x509.Certificate{pki.appleCA1.cert}},
		{"phase 2 Apple SHA256WithRSA", appleLeaf, oidDigestSHA256, oidSigRSASHA256, crypto.SHA256, x509.SHA256WithRSA, nil},
		{"phase 4 SCEP SHA1WithRSA", scepLeaf, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, x509.SHA1WithRSA, nil},
		{"phase 4 SCEP SHA256WithRSA", scepLeaf, oidDigestSHA256, oidSigRSA, crypto.SHA256, x509.SHA256WithRSA, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			der := signWithoutSignedAttrs(t, tc.id, tc.digestOID, tc.sigOID, tc.hashAlg, macPlist, tc.extra...)
			got, err := ParseAndVerifyCMS(der)
			if err != nil {
				t.Fatalf("ParseAndVerifyCMS: %v", err)
			}
			if !bytes.Equal(got.Signer.Raw, tc.id.cert.Raw) {
				t.Fatal("returned wrong signer certificate")
			}
			if !bytes.Equal(got.Content, macPlist) {
				t.Fatalf("content mismatch: got %q", got.Content)
			}
			if got.SigAlg != tc.wantAlg {
				t.Fatalf("SigAlg = %v, want %v", got.SigAlg, tc.wantAlg)
			}

			// Indefinite-length BER wrapper (as macOS sends) must verify identically.
			var outer asn1.RawValue
			if _, err := asn1.Unmarshal(der, &outer); err != nil {
				t.Fatal(err)
			}
			indef := append(append([]byte{0x30, 0x80}, outer.Bytes...), 0x00, 0x00)
			gotBER, err := ParseAndVerifyCMS(indef)
			if err != nil {
				t.Fatalf("ParseAndVerifyCMS on indefinite BER: %v", err)
			}
			if !bytes.Equal(gotBER.Content, macPlist) {
				t.Fatal("BER content mismatch")
			}
		})
	}
}

func TestParseAndVerifyCMSRefusals(t *testing.T) {
	pki := newTestPKI(t)
	leaf := pki.issueSCEPLeaf(t, pki.deviceInter, "SERIAL1", nil)
	other := pki.issueSCEPLeaf(t, pki.deviceInter, "SERIAL2", nil)

	// Build a conflicting cert with the exact same issuer & serial number as leaf
	// but a different key.
	conflict := pki.issueSCEPLeaf(t, pki.deviceInter, "CONFLICT", func(c *x509.Certificate) {
		c.SerialNumber = new(big.Int).Set(leaf.cert.SerialNumber)
	})

	// Build an ECDSA leaf to verify non-RSA CMS signatures are rejected.
	ecKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecTpl := &x509.Certificate{
		SerialNumber: big.NewInt(999),
		Subject:      pkix.Name{CommonName: "ECDSA"},
		NotBefore:    pki.now.Add(-time.Hour),
		NotAfter:     pki.now.Add(time.Hour),
	}
	ecDER, _ := x509.CreateCertificate(rand.Reader, ecTpl, pki.deviceInter.cert, &ecKey.PublicKey, pki.deviceInter.key)
	ecCert, _ := x509.ParseCertificate(ecDER)
	ecID := testIdentity{cert: ecCert, key: ecKey}

	// Build a deeply nested BER bomb (would OOM smallstep/pkcs7's ber2der).
	deepBER := make([]byte, 0, 200)
	for i := 0; i < 64; i++ {
		deepBER = append(deepBER, 0x30, 0x80)
	}
	for i := 0; i < 64; i++ {
		deepBER = append(deepBER, 0x00, 0x00)
	}

	validDER := buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist)})

	cases := []struct {
		name string
		raw  []byte
	}{
		{"empty", nil},
		{"oversized", make([]byte, MaxBodyBytes+1)},
		{"garbage", []byte("not asn1 at all")},
		{"deep BER nesting bomb", deepBER},
		{"trailing bytes after root", append(append([]byte{}, validDER...), 0x00)},
		{"wrong outer ContentType", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), contentType: oidData})},
		{"wrong encapContentType", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), encapContentType: oidSignedData})},
		{"detached content", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), detached: true})},
		{"empty content", buildCustomCMS(t, leaf, customCMSOpts{content: []byte{}})},
		{"zero signers", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), zeroSigners: true})},
		{"two signers", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), duplicateSigner: true})},
		{"SignerInfo version 3", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), signerVersion: 3})},
		{"no certificates", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), certs: []*x509.Certificate{}})},
		{"signer cert missing from set", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), certs: []*x509.Certificate{other.cert}})},
		{"conflicting cert same issuer and serial", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), certs: []*x509.Certificate{leaf.cert, conflict.cert}})},
		{"empty signedAttrs tag [0]", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), emptySignedAttrs: true})},
		{"no signedAttrs wrong encapContentType", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), omitSignedAttrs: true, encapContentType: oidSignedData})},
		{"no signedAttrs detached content", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), omitSignedAttrs: true, detached: true})},
		{"no signedAttrs empty content", buildCustomCMS(t, leaf, customCMSOpts{content: []byte{}, omitSignedAttrs: true})},
		{"no signedAttrs tampered signature", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), omitSignedAttrs: true, tamperSignature: true})},
		{"no signedAttrs SHA1 tampered signature", buildCustomCMS(t, leaf, customCMSOpts{
			content:         []byte(samplePlist),
			digestOID:       oidDigestSHA1,
			sigOID:          oidSigRSASHA1,
			hashAlg:         crypto.SHA1,
			omitSignedAttrs: true,
			tamperSignature: true,
		})},
		{"no signedAttrs mismatched digest/sig alg", buildCustomCMS(t, leaf, customCMSOpts{
			content:         []byte(samplePlist),
			digestOID:       oidDigestSHA1,
			sigOID:          oidSigRSASHA256,
			hashAlg:         crypto.SHA1,
			omitSignedAttrs: true,
		})},
		{"missing content-type attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), omitContentType: true})},
		{"wrong content-type attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), wrongContentType: oidSignedData})},
		{"duplicate content-type attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), dupContentType: true})},
		{"missing messageDigest attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), omitMessageDigest: true})},
		{"wrong messageDigest attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), wrongMessageDigest: bytes.Repeat([]byte{0xAA}, 32)})},
		{"duplicate messageDigest attr", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), dupMessageDigest: true})},
		{"tampered signature", buildCustomCMS(t, leaf, customCMSOpts{content: []byte(samplePlist), tamperSignature: true})},
		{"mismatched digest SHA1 and sig RSASHA256", buildCustomCMS(t, leaf, customCMSOpts{
			content:   []byte(samplePlist),
			digestOID: oidDigestSHA1,
			sigOID:    oidSigRSASHA256,
			hashAlg:   crypto.SHA1,
		})},
		{"unsupported ECDSA signature", buildCustomCMS(t, ecID, customCMSOpts{
			content:   []byte(samplePlist),
			digestOID: oidDigestSHA256,
			sigOID:    pkcs7.OIDDigestAlgorithmECDSASHA256,
			hashAlg:   crypto.SHA256,
		})},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseAndVerifyCMS(tc.raw); err == nil {
				t.Fatalf("ParseAndVerifyCMS accepted %s", tc.name)
			}
		})
	}
}
