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
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/smallstep/pkcs7"
)

func TestClassifySigner(t *testing.T) {
	pki := newTestPKI(t)
	withFakeAppleCAs(t, pki.appleCA1.cert, pki.appleCA2.cert)

	// Valid phase 2 leaves (expired dates ignored; both SHA1WithRSA and
	// SHA256WithRSA allowed; second pinned intermediate also works).
	appleLeafSHA1 := pki.issueAppleLeaf(t, pki.appleCA1, "dev-sha1", x509.SHA1WithRSA, 1024, nil)
	appleLeafSHA256 := pki.issueAppleLeaf(t, pki.appleCA1, "dev-sha256", x509.SHA256WithRSA, 2048, nil)
	appleLeafCA2 := pki.issueAppleLeaf(t, pki.appleCA2, "dev-ca2", x509.SHA256WithRSA, 2048, nil)

	// Invalid phase 2 leaves.
	appleLeafSHA384 := pki.issueAppleLeaf(t, pki.appleCA1, "dev-sha384", x509.SHA384WithRSA, 2048, nil)
	appleLeafIsCA := pki.issueAppleLeaf(t, pki.appleCA1, "dev-ca", x509.SHA256WithRSA, 2048, func(c *x509.Certificate) {
		c.IsCA = true
		c.BasicConstraintsValid = true
	})
	appleLeafRogue := pki.issueAppleLeaf(t, pki.rogueCA, "dev-rogue", x509.ECDSAWithSHA256, 2048, nil)

	// Valid phase 4 SCEP leaf: issued by intermediate, EKU emailProtection, no SANs.
	scepValid := pki.issueSCEPLeaf(t, pki.deviceInter, "C02VALID1234", nil)

	// Invalid phase 4 leaves (Review 1 rule L1).
	// 1. SCEP decrypter cert: issued directly by root (no EKU).
	decrypterNoEKU := pki.issueSCEPLeaf(t, pki.deviceRoot, "i10 Device SCEP Decrypter 2026", func(c *x509.Certificate) {
		c.ExtKeyUsage = nil
		c.KeyUsage = x509.KeyUsageKeyEncipherment
	})
	// 2. Cert issued directly by root EVEN WITH emailProtection EKU (must still be refused!).
	directRootWithEKU := pki.issueSCEPLeaf(t, pki.deviceRoot, "direct-root", nil)
	// 3. Issued by intermediate, no EKU at all.
	scepNoEKU := pki.issueSCEPLeaf(t, pki.deviceInter, "C02NOEKU", func(c *x509.Certificate) {
		c.ExtKeyUsage = nil
	})
	// 4. Issued by intermediate, only clientAuth EKU.
	scepClientAuthOnly := pki.issueSCEPLeaf(t, pki.deviceInter, "C02CLIENTAUTH", func(c *x509.Certificate) {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	})
	// 4b. emailProtection plus a second EKU, and plus one Go cannot name: the
	// edge requires exactly [emailProtection], as enrollctl does.
	scepTwoEKUs := pki.issueSCEPLeaf(t, pki.deviceInter, "C02TWOEKU", func(c *x509.Certificate) {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection, x509.ExtKeyUsageClientAuth}
	})
	scepUnknownEKU := pki.issueSCEPLeaf(t, pki.deviceInter, "C02UNKEKU", func(c *x509.Certificate) {
		c.UnknownExtKeyUsage = []asn1.ObjectIdentifier{{1, 3, 6, 1, 4, 1, 99999, 1}}
	})
	// 5. Issued by intermediate, carries unparsed otherName SAN (permanentIdentifier, like ACME).
	scepOtherNameSAN := pki.issueSCEPLeaf(t, pki.deviceInter, "C02OTHERNAME", func(c *x509.Certificate) {
		c.ExtraExtensions = []pkix.Extension{permanentIdentifierSANExt(t, "C02OTHERNAME")}
	})
	// 6. Issued by intermediate, carries DNS SAN (permitted by intermediate's name constraint).
	scepDNSSAN := pki.issueSCEPLeaf(t, pki.deviceInter, "C02DNSSAN", func(c *x509.Certificate) {
		c.DNSNames = []string{"i10-device-ca.i10-prod.svc"}
	})
	// 7. Issued by intermediate, carries Email SAN.
	scepEmailSAN := pki.issueSCEPLeaf(t, pki.deviceInter, "C02EMAILSAN", func(c *x509.Certificate) {
		c.EmailAddresses = []string{"alice@i10.tech"}
	})
	// 8. Issued by intermediate, carries URI SAN.
	scepURISAN := pki.issueSCEPLeaf(t, pki.deviceInter, "C02URISAN", func(c *x509.Certificate) {
		c.URIs = append(c.URIs, mustParseURL(t, "https://i10.tech/device"))
	})
	// 9. Issued by intermediate, carries IP SAN.
	scepIPSAN := pki.issueSCEPLeaf(t, pki.deviceInter, "C02IPSAN", func(c *x509.Certificate) {
		c.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	})
	// 10. Expired SCEP leaf.
	scepExpired := pki.issueSCEPLeaf(t, pki.deviceInter, "C02EXPIRED", func(c *x509.Certificate) {
		c.NotBefore = pki.now.Add(-48 * time.Hour)
		c.NotAfter = pki.now.Add(-time.Hour)
	})
	// 11. Not-yet-valid SCEP leaf.
	scepFuture := pki.issueSCEPLeaf(t, pki.deviceInter, "C02FUTURE", func(c *x509.Certificate) {
		c.NotBefore = pki.now.Add(time.Hour)
		c.NotAfter = pki.now.Add(48 * time.Hour)
	})
	// 12. SCEP leaf with IsCA=true.
	scepIsCA := pki.issueSCEPLeaf(t, pki.deviceInter, "C02ISCA", func(c *x509.Certificate) {
		c.IsCA = true
	})
	// 13. Issued by rogue CA.
	scepRogue := pki.issueSCEPLeaf(t, pki.rogueCA, "C02ROGUE", nil)

	// 14. Sub-intermediate issued by a root-with-pathlen-1 (never mounted as a trusted intermediate).
	subKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	subTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(55),
		Subject:               pkix.Name{CommonName: "Rogue Sub-CA"},
		NotBefore:             pki.now.Add(-time.Hour),
		NotAfter:              pki.now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	subDER, _ := x509.CreateCertificate(rand.Reader, subTpl, pki.deviceRoot.cert, &subKey.PublicKey, pki.deviceRoot.key)
	subCert, _ := x509.ParseCertificate(subDER)
	scepFromUnmountedInter := pki.issueSCEPLeaf(t, testIdentity{cert: subCert, key: subKey}, "C02SUB", nil)

	cases := []struct {
		name      string
		cms       *VerifiedCMS
		wantPhase Phase
		wantErr   bool
	}{
		{
			name:      "phase 2 valid SHA1 leaf + SHA1 CMS (expired ignored)",
			cms:       mustVerifyCMS(t, signWithPKCS7(t, appleLeafSHA1, pkcs7.OIDDigestAlgorithmSHA1, []byte(samplePlist))),
			wantPhase: Phase2Apple,
		},
		{
			name:      "phase 2 valid SHA256 leaf + SHA256 CMS (expired ignored)",
			cms:       mustVerifyCMS(t, signWithPKCS7(t, appleLeafSHA256, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantPhase: Phase2Apple,
		},
		{
			name:      "phase 2 valid via second pinned Apple CA",
			cms:       mustVerifyCMS(t, signWithPKCS7(t, appleLeafCA2, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantPhase: Phase2Apple,
		},
		{
			name:      "phase 2 valid Mac no signedAttrs SHA1",
			cms:       mustVerifyCMS(t, signWithoutSignedAttrs(t, appleLeafSHA1, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, []byte(samplePlist))),
			wantPhase: Phase2Apple,
		},
		{
			name:      "phase 2 valid Mac no signedAttrs SHA256",
			cms:       mustVerifyCMS(t, signWithoutSignedAttrs(t, appleLeafSHA256, oidDigestSHA256, oidSigRSASHA256, crypto.SHA256, []byte(samplePlist))),
			wantPhase: Phase2Apple,
		},
		{
			name:    "phase 2 refuses Mac no signedAttrs SHA384WithRSA",
			cms:     mustVerifyCMS(t, signWithoutSignedAttrs(t, appleLeafSHA256, oidDigestSHA384, oidSigRSASHA384, crypto.SHA384, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 2 refuses SHA384WithRSA CMS signature",
			cms:     mustVerifyCMS(t, buildCustomCMS(t, appleLeafSHA256, customCMSOpts{content: []byte(samplePlist), digestOID: oidDigestSHA384, sigOID: oidSigRSA, hashAlg: crypto.SHA384})),
			wantErr: true,
		},
		{
			name:    "phase 2 refuses SHA384WithRSA leaf signature",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, appleLeafSHA384, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 2 refuses IsCA leaf",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, appleLeafIsCA, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 2 refuses untrusted CA",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, appleLeafRogue, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:      "phase 4 valid SCEP leaf SHA256",
			cms:       mustVerifyCMS(t, signWithPKCS7(t, scepValid, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantPhase: Phase4DeviceCA,
		},
		{
			name:      "phase 4 valid SCEP leaf SHA1",
			cms:       mustVerifyCMS(t, signWithPKCS7(t, scepValid, pkcs7.OIDDigestAlgorithmSHA1, []byte(samplePlist))),
			wantPhase: Phase4DeviceCA,
		},
		{
			name:      "phase 4 valid Mac SCEP leaf no signedAttrs SHA1",
			cms:       mustVerifyCMS(t, signWithoutSignedAttrs(t, scepValid, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, []byte(samplePlist))),
			wantPhase: Phase4DeviceCA,
		},
		{
			name:      "phase 4 valid Mac SCEP leaf no signedAttrs SHA256",
			cms:       mustVerifyCMS(t, signWithoutSignedAttrs(t, scepValid, oidDigestSHA256, oidSigRSASHA256, crypto.SHA256, []byte(samplePlist))),
			wantPhase: Phase4DeviceCA,
		},
		{
			name:    "phase 4 refuses SCEP decrypter cert issued by root",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, decrypterNoEKU, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses root-issued cert even with emailProtection EKU",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, directRootWithEKU, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with empty EKU",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepNoEKU, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with only clientAuth EKU",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepClientAuthOnly, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses emailProtection plus clientAuth",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepTwoEKUs, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses emailProtection plus an unknown EKU",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepUnknownEKU, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with unparsed otherName SAN (ACME permanentIdentifier)",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepOtherNameSAN, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with DNS SAN",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepDNSSAN, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with Email SAN",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepEmailSAN, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with URI SAN",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepURISAN, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf with IP SAN",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepIPSAN, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses expired leaf",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepExpired, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses not-yet-valid leaf",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepFuture, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses IsCA leaf",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepIsCA, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses rogue CA",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepRogue, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist))),
			wantErr: true,
		},
		{
			name:    "phase 4 refuses leaf from unmounted intermediate",
			cms:     mustVerifyCMS(t, signWithPKCS7(t, scepFromUnmountedInter, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist), subCert)),
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			phase, err := ClassifySigner(tc.cms, pki.trust, pki.now)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got phase=%v", phase)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if phase != tc.wantPhase {
				t.Fatalf("phase = %v, want %v", phase, tc.wantPhase)
			}
		})
	}
}

func mustVerifyCMS(t *testing.T, der []byte) *VerifiedCMS {
	t.Helper()
	v, err := ParseAndVerifyCMS(der)
	if err != nil {
		t.Fatalf("ParseAndVerifyCMS: %v", err)
	}
	return v
}

// ⚠ THE APPLE PATH IS DECIDED BY THE PINNED CA'S SIGNATURE, NOT ITS NAME. An
// impostor CA with byte-identical subject bytes but its own key issues a leaf
// whose RawIssuer equals the pin's RawSubject. Without the CheckSignature
// below the name match, anyone could forge phase 2 claims (any serial, any
// product) without an Apple device.
func TestClassifySignerRefusesImpostorWithPinnedIssuerName(t *testing.T) {
	pki := newTestPKI(t)
	withFakeAppleCAs(t, pki.appleCA1.cert)

	impostor := makeRSA1024ExpiredCA(t, "Fake Apple iPhone Device CA 1", 10)
	if !bytes.Equal(impostor.cert.RawSubject, pki.appleCA1.cert.RawSubject) {
		t.Fatal("test setup: impostor subject must equal the pinned CA's")
	}
	forged := pki.issueAppleLeaf(t, impostor, "forged-device", x509.SHA256WithRSA, 2048, nil)
	cms := mustVerifyCMS(t, signWithPKCS7(t, forged, pkcs7.OIDDigestAlgorithmSHA256, []byte(samplePlist)))

	phase, err := ClassifySigner(cms, pki.trust, pki.now)
	if err == nil || phase != PhaseUnknown {
		t.Fatalf("ClassifySigner(impostor leaf) = %v, %v; want PhaseUnknown and an error", phase, err)
	}
}
