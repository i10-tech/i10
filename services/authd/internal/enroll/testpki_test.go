package enroll

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"math/big"
	"net"
	"net/url"
	"testing"
	"time"

	"github.com/smallstep/pkcs7"
)

type testIdentity struct {
	cert *x509.Certificate
	key  crypto.Signer
}

type testPKI struct {
	// Fake Apple device CAs (RSA-1024, expired 2007-2014, SHA1WithRSA, matching
	// the real pinned Apple iPhone Device CA).
	appleCA1 testIdentity
	appleCA2 testIdentity

	// Fake i10 device CA (ECDSA P-256 root -> name-constrained ECDSA P-256
	// intermediate, mirroring infra/k8s/i10/device-ca/trust.yaml).
	deviceRoot  testIdentity
	deviceInter testIdentity
	bundlePEM   []byte
	trust       *DeviceTrust

	// Rogue unrelated CA.
	rogueCA testIdentity

	now time.Time
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)

	appleCA1 := makeRSA1024ExpiredCA(t, "Fake Apple iPhone Device CA 1", 10)
	appleCA2 := makeRSA1024ExpiredCA(t, "Fake Apple iPhone Device CA 2", 20)

	deviceRoot := makeECDSARootCA(t, "Test i10 Device Root CA", now)
	deviceInter := makeECDSAIntermediateCA(t, "Test i10 Device Intermediate CA", deviceRoot, now)
	bundlePEM := append(pemCert(deviceRoot.cert.Raw), pemCert(deviceInter.cert.Raw)...)
	trust, err := ParseDeviceTrustBundle(bundlePEM)
	if err != nil {
		t.Fatalf("ParseDeviceTrustBundle: %v", err)
	}

	rogueCA := makeECDSARootCA(t, "Rogue CA", now)

	return &testPKI{
		appleCA1:    appleCA1,
		appleCA2:    appleCA2,
		deviceRoot:  deviceRoot,
		deviceInter: deviceInter,
		bundlePEM:   bundlePEM,
		trust:       trust,
		rogueCA:     rogueCA,
		now:         now,
	}
}

// withFakeAppleCAs temporarily overrides the package-level appleDeviceCAs pin
// for routing tests and restores it on test cleanup.
func withFakeAppleCAs(t *testing.T, cas ...*x509.Certificate) {
	t.Helper()
	orig := appleDeviceCAs
	appleDeviceCAs = cas
	t.Cleanup(func() {
		appleDeviceCAs = orig
	})
}

func pemCert(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func makeRSA1024ExpiredCA(t *testing.T, cn string, serial int64) testIdentity {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(serial),
		Subject:               pkix.Name{Country: []string{"US"}, Organization: []string{"Apple Inc."}, CommonName: cn},
		NotBefore:             time.Date(2007, 4, 16, 0, 0, 0, 0, time.UTC),
		NotAfter:              time.Date(2014, 4, 16, 0, 0, 0, 0, time.UTC),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		SignatureAlgorithm:    x509.SHA1WithRSA,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{cert: cert, key: key}
}

func makeECDSARootCA(t *testing.T, cn string, now time.Time) testIdentity {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"i10"}, CommonName: cn},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{cert: cert, key: key}
}

func makeECDSAIntermediateCA(t *testing.T, cn string, root testIdentity, now time.Time) testIdentity {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, ipv4All, _ := net.ParseCIDR("0.0.0.0/0")
	_, ipv6All, _ := net.ParseCIDR("::/0")
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{Organization: []string{"i10"}, CommonName: cn},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(5 * 365 * 24 * time.Hour),
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		// Mirror the real i10 Device Intermediate CA's critical name constraints.
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{"i10-device-ca.i10-prod.svc", "i10-device-ca.i10-prod.svc.cluster.local"},
		ExcludedIPRanges:            []*net.IPNet{ipv4All, ipv6All},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, root.cert, &key.PublicKey, root.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{cert: cert, key: key}
}

func (p *testPKI) issueAppleLeaf(t *testing.T, ca testIdentity, cn string, sigAlg x509.SignatureAlgorithm, bits int, mutate func(*x509.Certificate)) testIdentity {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:       big.NewInt(time.Now().UnixNano()),
		Subject:            pkix.Name{CommonName: cn},
		NotBefore:          time.Date(2009, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:           time.Date(2014, 1, 1, 0, 0, 0, 0, time.UTC), // expired!
		KeyUsage:           x509.KeyUsageDigitalSignature,
		SignatureAlgorithm: sigAlg,
	}
	if mutate != nil {
		mutate(tpl)
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{cert: cert, key: key}
}

func (p *testPKI) issueSCEPLeaf(t *testing.T, issuer testIdentity, cn string, mutate func(*x509.Certificate)) testIdentity {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             p.now.Add(-time.Hour),
		NotAfter:              p.now.Add(7 * 24 * time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
	}
	if mutate != nil {
		mutate(tpl)
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, issuer.cert, &key.PublicKey, issuer.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{cert: cert, key: key}
}

// permanentIdentifierSANExt builds an X.509 SAN extension (OID 2.5.29.17)
// containing only an otherName permanentIdentifier (OID 1.3.6.1.5.5.7.8.3),
// matching what step-ca's ACME apple.tpl emits and Go's x509 does not parse
// into DNSNames/IPAddresses/EmailAddresses/URIs.
func permanentIdentifierSANExt(t *testing.T, serial string) pkix.Extension {
	t.Helper()
	type permanentIdentifier struct {
		IdentifierValue string `asn1:"utf8"`
	}
	type otherName struct {
		TypeID asn1.ObjectIdentifier
		Value  permanentIdentifier `asn1:"explicit,tag:0"`
	}
	val, err := asn1.Marshal(otherName{
		TypeID: asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 8, 3},
		Value:  permanentIdentifier{IdentifierValue: serial},
	})
	if err != nil {
		t.Fatal(err)
	}
	// GeneralNames ::= SEQUENCE OF GeneralName; otherName is [0] IMPLICIT.
	var seq asn1.RawValue
	if _, err := asn1.Unmarshal(val, &seq); err != nil {
		t.Fatal(err)
	}
	gn := asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: seq.Bytes}
	sanBytes, err := asn1.Marshal([]asn1.RawValue{gn})
	if err != nil {
		t.Fatal(err)
	}
	return pkix.Extension{Id: oidExtensionSubjectAltName, Value: sanBytes}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// signWithPKCS7 creates a genuine CMS SignedData using github.com/smallstep/pkcs7
// (including signingTime = time.Now(), proving our parser handles real pkcs7
// output even when signingTime falls years after an expired Apple leaf's dates).
func signWithPKCS7(t *testing.T, id testIdentity, digestOID asn1.ObjectIdentifier, content []byte, extraCerts ...*x509.Certificate) []byte {
	t.Helper()
	sd, err := pkcs7.NewSignedData(content)
	if err != nil {
		t.Fatalf("pkcs7.NewSignedData: %v", err)
	}
	sd.SetDigestAlgorithm(digestOID)
	if len(extraCerts) > 0 {
		if err := sd.AddSignerChain(id.cert, id.key, extraCerts, pkcs7.SignerInfoConfig{}); err != nil {
			t.Fatalf("pkcs7.AddSignerChain: %v", err)
		}
	} else {
		if err := sd.AddSigner(id.cert, id.key, pkcs7.SignerInfoConfig{}); err != nil {
			t.Fatalf("pkcs7.AddSigner: %v", err)
		}
	}
	der, err := sd.Finish()
	if err != nil {
		t.Fatalf("pkcs7.Finish: %v", err)
	}
	return der
}

// customCMSOpts lets tests craft exact valid or intentionally broken CMS
// SignedData DER/BER structures to exercise every H1 refusal path.
type customCMSOpts struct {
	contentType        asn1.ObjectIdentifier
	encapContentType   asn1.ObjectIdentifier
	content            []byte
	detached           bool
	certs              []*x509.Certificate
	signerVersion      int
	overrideSID        *cmsIssuerAndSerial
	digestOID          asn1.ObjectIdentifier
	sigOID             asn1.ObjectIdentifier
	hashAlg            crypto.Hash
	omitContentType    bool
	wrongContentType   asn1.ObjectIdentifier
	dupContentType     bool
	omitMessageDigest  bool
	wrongMessageDigest []byte
	dupMessageDigest   bool
	omitSignedAttrs    bool
	tamperSignature    bool
	duplicateSigner    bool
	zeroSigners        bool
	extraAttr          *cmsAttribute
}

func buildCustomCMS(t *testing.T, id testIdentity, opts customCMSOpts) []byte {
	t.Helper()
	if len(opts.contentType) == 0 {
		opts.contentType = oidSignedData
	}
	if len(opts.encapContentType) == 0 {
		opts.encapContentType = oidData
	}
	if len(opts.digestOID) == 0 {
		opts.digestOID = oidDigestSHA256
	}
	if len(opts.sigOID) == 0 {
		opts.sigOID = oidSigRSA
	}
	if opts.hashAlg == 0 {
		opts.hashAlg = crypto.SHA256
	}
	if opts.signerVersion == 0 {
		opts.signerVersion = 1
	}
	certs := opts.certs
	if certs == nil {
		certs = []*x509.Certificate{id.cert}
	}

	var encapContent asn1.RawValue
	if !opts.detached {
		oct, err := asn1.Marshal(opts.content)
		if err != nil {
			t.Fatal(err)
		}
		encapContent = asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: oct}
	}

	var signerInfos []cmsSignerInfo
	if !opts.zeroSigners {
		sid := cmsIssuerAndSerial{
			Issuer:       asn1.RawValue{FullBytes: id.cert.RawIssuer},
			SerialNumber: id.cert.SerialNumber,
		}
		if opts.overrideSID != nil {
			sid = *opts.overrideSID
		}

		var attrs []cmsAttribute
		if !opts.omitSignedAttrs {
			if !opts.omitContentType {
				ct := opts.encapContentType
				if len(opts.wrongContentType) > 0 {
					ct = opts.wrongContentType
				}
				attrs = append(attrs, mustMakeAttr(t, oidAttrContentType, ct))
				if opts.dupContentType {
					attrs = append(attrs, mustMakeAttr(t, oidAttrContentType, ct))
				}
			}
			if !opts.omitMessageDigest {
				h := opts.hashAlg.New()
				_, _ = h.Write(opts.content)
				md := h.Sum(nil)
				if opts.wrongMessageDigest != nil {
					md = opts.wrongMessageDigest
				}
				attrs = append(attrs, mustMakeAttr(t, oidAttrMsgDigest, md))
				if opts.dupMessageDigest {
					attrs = append(attrs, mustMakeAttr(t, oidAttrMsgDigest, md))
				}
			}
			if opts.extraAttr != nil {
				attrs = append(attrs, *opts.extraAttr)
			}
		}

		var toSign []byte
		if len(attrs) > 0 {
			var err error
			toSign, err = encodeSignedAttrsDERSet(attrs)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			toSign = opts.content
		}
		h := opts.hashAlg.New()
		_, _ = h.Write(toSign)
		sig, err := id.key.Sign(rand.Reader, h.Sum(nil), opts.hashAlg)
		if err != nil {
			t.Fatal(err)
		}
		if opts.tamperSignature {
			sig[len(sig)-1] ^= 0xFF
		}

		si := cmsSignerInfo{
			Version:            opts.signerVersion,
			SID:                sid,
			DigestAlgorithm:    pkix.AlgorithmIdentifier{Algorithm: opts.digestOID},
			SignedAttrs:        attrs,
			SignatureAlgorithm: pkix.AlgorithmIdentifier{Algorithm: opts.sigOID},
			Signature:          sig,
		}
		signerInfos = append(signerInfos, si)
		if opts.duplicateSigner {
			signerInfos = append(signerInfos, si)
		}
	}

	var rawCertBytes []byte
	for _, c := range certs {
		rawCertBytes = append(rawCertBytes, c.Raw...)
	}
	var certsField asn1.RawValue
	if len(rawCertBytes) > 0 {
		certsField = asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: rawCertBytes}
	}

	sd := cmsSignedData{
		Version:          1,
		DigestAlgorithms: []pkix.AlgorithmIdentifier{{Algorithm: opts.digestOID}},
		EncapContentInfo: cmsContentInfo{
			ContentType: opts.encapContentType,
			Content:     encapContent,
		},
		Certificates: certsField,
		SignerInfos:  signerInfos,
	}
	sdDER, err := asn1.Marshal(sd)
	if err != nil {
		t.Fatal(err)
	}
	outer := cmsContentInfo{
		ContentType: opts.contentType,
		Content:     asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: sdDER},
	}
	der, err := asn1.Marshal(outer)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func mustMakeAttr(t *testing.T, oid asn1.ObjectIdentifier, val any) cmsAttribute {
	t.Helper()
	valDER, err := asn1.Marshal(val)
	if err != nil {
		t.Fatal(err)
	}
	a := cmsAttribute{
		Type:  oid,
		Value: asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true, Bytes: valDER},
	}
	raw, err := asn1.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	a.Raw = raw
	return a
}
