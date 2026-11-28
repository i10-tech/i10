package enrollctl

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enroll"
	"github.com/i10-tech/i10/services/authd/internal/mailfront"
)

type testProfilePKI struct {
	rootCert  *x509.Certificate
	rootPEM   []byte
	interCert *x509.Certificate
	interPEM  []byte
	leafCert  *x509.Certificate
	leafKey   *ecdsa.PrivateKey
	chainPEM  []byte
	keyPEM    []byte
}

func makeTestProfileSigningPKI(t *testing.T, notBefore, notAfter time.Time) testProfilePKI {
	t.Helper()
	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rootTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Profile Root CA"},
		NotBefore:             notBefore.Add(-time.Hour),
		NotAfter:              notAfter.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, _ := x509.ParseCertificate(rootDER)

	interKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	interTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "Test Profile Intermediate CA"},
		NotBefore:             notBefore.Add(-time.Hour),
		NotAfter:              notAfter.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, rootCert, &interKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	interCert, _ := x509.ParseCertificate(interDER)

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(3),
		Subject:               pkix.Name{CommonName: "profiles.i10.tech"},
		DNSNames:              []string{"profiles.i10.tech"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageEmailProtection},
		BasicConstraintsValid: true,
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, interCert, &leafKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	leafCert, _ := x509.ParseCertificate(leafDER)

	rootPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER})
	interPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: interDER})
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	return testProfilePKI{
		rootCert:  rootCert,
		rootPEM:   rootPEM,
		interCert: interCert,
		interPEM:  interPEM,
		leafCert:  leafCert,
		leafKey:   leafKey,
		chainPEM:  append(leafPEM, interPEM...),
		keyPEM:    keyPEM,
	}
}

func makeTestDeviceCAWithProdConstraints(t *testing.T) (rootCert *x509.Certificate, interCert *x509.Certificate, interKey *ecdsa.PrivateKey, bundlePEM []byte) {
	t.Helper()
	now := time.Now().UTC()
	rootKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rootTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(10),
		Subject:               pkix.Name{CommonName: "i10 Device Root CA Test"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, _ = x509.ParseCertificate(rootDER)

	interKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, ipv4All, _ := net.ParseCIDR("0.0.0.0/0")
	_, ipv6All, _ := net.ParseCIDR("::/0")
	// Exact production name constraints from infra/k8s/i10/device-ca/README.md:
	// permitted DNS i10-device-ca.i10-prod.svc and .cluster.local, all IPs excluded.
	interTmpl := &x509.Certificate{
		SerialNumber:                big.NewInt(11),
		Subject:                     pkix.Name{CommonName: "i10 Device Intermediate CA Test"},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(5 * 365 * 24 * time.Hour),
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid:       true,
		IsCA:                        true,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{"i10-device-ca.i10-prod.svc", ".cluster.local"},
		ExcludedIPRanges:            []*net.IPNet{ipv4All, ipv6All},
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, rootCert, &interKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	interCert, _ = x509.ParseCertificate(interDER)
	bundlePEM = append(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: interDER})...,
	)
	return rootCert, interCert, interKey, bundlePEM
}

func TestCMSSignAndVerifyWithOpenSSL(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pki := makeTestProfileSigningPKI(t, now.Add(-time.Hour), now.Add(90*24*time.Hour))

	payload, err := RenderPhase1Profile("https://ca.i10.tech/enroll/apple/profile", "v1.019abcde0123789a8bcdef0123456789.69288f10.AAAAAAAAAAAAAAAAAAAAAAA", "i10")
	if err != nil {
		t.Fatal(err)
	}
	signedDER, err := SignCMSSignedData(payload, []*x509.Certificate{pki.leafCert, pki.interCert}, pki.leafKey, now)
	if err != nil {
		t.Fatalf("SignCMSSignedData: %v", err)
	}

	opensslPath, err := exec.LookPath("openssl")
	if err != nil {
		t.Skip("openssl not on PATH; skipping openssl cms -verify interop check")
	}

	dir := t.TempDir()
	cmsFile := filepath.Join(dir, "signed.p7m")
	rootFile := filepath.Join(dir, "root.pem")
	outFile := filepath.Join(dir, "out.xml")
	if err := os.WriteFile(cmsFile, signedDER, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rootFile, pki.rootPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. Verify signature structure with -noverify.
	cmd1 := exec.Command(opensslPath, "cms", "-verify", "-inform", "DER", "-in", cmsFile, "-noverify", "-out", outFile)
	if out, err := cmd1.CombinedOutput(); err != nil {
		t.Fatalf("openssl cms -verify -noverify failed: %v\n%s", err, out)
	}
	gotPayload, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("verified payload differs from original")
	}

	// 2. Verify full chain against the test root CA (proves leaf + intermediate
	//    are both present in SignedData.certificates and chain cleanly).
	//    -purpose any because the leaf mirrors Let's Encrypt serverAuth EKU.
	cmd2 := exec.Command(opensslPath, "cms", "-verify", "-inform", "DER", "-in", cmsFile, "-CAfile", rootFile, "-purpose", "any", "-out", outFile)
	if out, err := cmd2.CombinedOutput(); err != nil {
		t.Fatalf("openssl cms -verify -CAfile failed: %v\n%s", err, out)
	}
}

func TestSealedProfileEncryptThenSignAndOpenSSLDecrypt(t *testing.T) {
	now := time.Now().UTC()
	_, inter, interKey, _ := makeTestDeviceCAWithProdConstraints(t)

	// Issue RSA-2048 SCEP recipient leaf cert.
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	scepTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(42),
		Subject:               pkix.Name{CommonName: "C02MACSEAL99"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
		BasicConstraintsValid: true,
	}
	scepDER, err := x509.CreateCertificate(rand.Reader, scepTmpl, inter, &rsaKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	scepLeaf, _ := x509.ParseCertificate(scepDER)

	code := "i10dc1." + strings.Repeat("0", 32) + "." + strings.Repeat("A", 43)
	permit := strings.Repeat("B", 50)

	// iOS profile: System scope, no ACME payload, no plaintext secret in outer XML.
	iosXML, err := BuildSealedMobileConfig(SealedProfileInput{
		DeviceID:     "019ab100-0000-7000-8000-000000000001",
		Email:        "ada@acme.com",
		Platform:     "ios",
		Serial:       "F2LIPHONE001",
		DeviceCode:   code,
		IMAPHost:     "mail.i10.tech",
		IMAPPort:     993,
		SMTPHost:     "mail.i10.tech",
		SMTPPort:     465,
		Organization: "i10",
	}, scepLeaf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(iosXML, []byte("<key>PayloadScope</key>\n\t<string>System</string>")) {
		t.Fatal("ios profile missing System scope")
	}
	if bytes.Contains(iosXML, []byte(code)) || bytes.Contains(iosXML, []byte("<key>PayloadContent</key>")) {
		t.Fatal("ios outer profile leaked secret or unencrypted PayloadContent")
	}

	// Mac profile: User scope, includes ACME payload with CN=serial & OU=permit.
	macIn := SealedProfileInput{
		DeviceID:     "019ab100-0000-7000-8000-000000000003",
		Email:        "ada@acme.com",
		Platform:     "macos",
		Serial:       "C02MACSEAL99",
		DeviceCode:   code,
		ACMEPermit:   permit,
		IMAPHost:     "mail.i10.tech",
		IMAPPort:     993,
		SMTPHost:     "mail.i10.tech",
		SMTPPort:     465,
		Organization: "i10",
	}
	if _, err := BuildSealedMobileConfig(macIn, scepLeaf); err == nil {
		t.Fatal("a Mac profile without its per-device directory URL was built")
	}
	macDir := ACMEDirectoryFor(DefaultACMEDirectoryURL, "PATHTOKEN")
	if macDir != "https://ca.i10.tech/acme/apple/d/PATHTOKEN/directory" {
		t.Fatalf("ACMEDirectoryFor = %q", macDir)
	}
	macIn.ACMEDirectoryURL = macDir
	macXML, err := BuildSealedMobileConfig(macIn, scepLeaf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(macXML, []byte("<key>PayloadScope</key>\n\t<string>User</string>")) {
		t.Fatal("mac profile missing User scope")
	}
	if bytes.Contains(macXML, []byte(code)) || bytes.Contains(macXML, []byte(permit)) {
		t.Fatal("mac outer profile leaked code or ACME permit")
	}

	re := regexp.MustCompile(`<key>EncryptedPayloadContent</key>\s*<data>([^<]+)</data>`)
	m := re.FindSubmatch(macXML)
	if len(m) != 2 {
		t.Fatal("missing EncryptedPayloadContent")
	}
	cmsDER, err := base64.StdEncoding.DecodeString(string(m[1]))
	if err != nil {
		t.Fatal(err)
	}
	plainGo, err := DecryptCMSEnvelopedData(cmsDER, rsaKey)
	if err != nil {
		t.Fatalf("DecryptCMSEnvelopedData: %v", err)
	}
	if !bytes.Contains(plainGo, []byte(code)) ||
		!bytes.Contains(plainGo, []byte("com.apple.security.acme")) ||
		!bytes.Contains(plainGo, []byte(permit)) ||
		!bytes.Contains(plainGo, []byte("<string>"+macDir+"</string>")) ||
		!bytes.Contains(plainGo, []byte("<key>OutgoingPasswordSameAsIncomingPassword</key>\n\t\t<true/>")) {
		t.Fatalf("decrypted inner plist missing expected fields:\n%s", plainGo)
	}

	// Verify OpenSSL decrypts the exact same CMS EnvelopedData identically.
	if opensslPath, err := exec.LookPath("openssl"); err == nil {
		dir := t.TempDir()
		envFile := filepath.Join(dir, "env.der")
		certFile := filepath.Join(dir, "leaf.pem")
		keyFile := filepath.Join(dir, "leaf.key")
		keyDER, _ := x509.MarshalPKCS8PrivateKey(rsaKey)
		_ = os.WriteFile(envFile, cmsDER, 0o600)
		_ = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: scepDER}), 0o600)
		_ = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600)

		cmd := exec.Command(opensslPath, "cms", "-decrypt", "-inform", "DER", "-in", envFile, "-recip", certFile, "-inkey", keyFile)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("openssl cms -decrypt failed: %v\n%s", err, out)
		}
		if !bytes.Equal(out, plainGo) {
			t.Fatalf("openssl decrypted bytes differ from Go decryption")
		}
	}
}

func TestProfileSignerLoaderReloadAndExpiry(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pki1 := makeTestProfileSigningPKI(t, now.Add(-time.Hour), now.Add(30*24*time.Hour))
	pki2 := makeTestProfileSigningPKI(t, now.Add(-time.Hour), now.Add(60*24*time.Hour))

	dir := t.TempDir()
	certPath := filepath.Join(dir, "tls.crt")
	keyPath := filepath.Join(dir, "tls.key")
	_ = os.WriteFile(certPath, pki1.chainPEM, 0o600)
	_ = os.WriteFile(keyPath, pki1.keyPEM, 0o600)

	curNow := now
	var logBuf bytes.Buffer
	loader := &ProfileSignerLoader{
		CertFile: certPath,
		KeyFile:  keyPath,
		Log:      slog.New(slog.NewJSONHandler(&logBuf, nil)),
		Now:      func() time.Time { return curNow },
	}
	if err := loader.Load(); err != nil {
		t.Fatalf("initial Load: %v", err)
	}
	firstSigner := loader.Active()
	if firstSigner == nil {
		t.Fatal("Active is nil after Load")
	}

	// Mismatched pair (new cert with old key) MUST fail and keep previous signer active.
	_ = os.WriteFile(certPath, pki2.chainPEM, 0o600)
	if err := loader.Load(); err == nil {
		t.Fatal("expected error for mismatched cert/key pair")
	}
	if loader.Active() != firstSigner {
		t.Fatal("previous signer was dropped on failed reload")
	}

	// Single-cert bundle (missing intermediate) MUST fail.
	leafOnly := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pki2.leafCert.Raw})
	_ = os.WriteFile(certPath, leafOnly, 0o600)
	_ = os.WriteFile(keyPath, pki2.keyPEM, 0o600)
	if err := loader.Load(); err == nil {
		t.Fatal("expected error for single-cert bundle without intermediate")
	}

	// Valid new pair swaps cleanly.
	_ = os.WriteFile(certPath, pki2.chainPEM, 0o600)
	if err := loader.Load(); err != nil {
		t.Fatalf("valid reload failed: %v", err)
	}
	if loader.Active() == firstSigner {
		t.Fatal("active signer did not update on valid reload")
	}

	// Advance clock to < 14 days left -> logs WARN, still signs.
	curNow = pki2.leafCert.NotAfter.Add(-5 * 24 * time.Hour)
	if err := loader.Load(); err != nil {
		t.Fatalf("Load within warn window: %v", err)
	}
	if !strings.Contains(logBuf.String(), "expiring soon") {
		t.Fatalf("expected WARN log when < 14 days left, got: %s", logBuf.String())
	}

	// Advance clock past NotAfter -> refuses to sign with ErrSignerExpired (never unsigned!).
	curNow = pki2.leafCert.NotAfter.Add(time.Second)
	if _, err := loader.Sign([]byte("plist")); !errors.Is(err, ErrSignerExpired) {
		t.Fatalf("Sign past NotAfter = %v, want ErrSignerExpired", err)
	}
}

func TestIssuedMacACMECertVerifiesUnderNameConstraintsAcceptedByMailfrontRefusedByL1(t *testing.T) {
	now := time.Now().UTC()
	rootCert, interCert, interKey, bundlePEM := makeTestDeviceCAWithProdConstraints(t)
	issuer, err := NewStaticDeviceCAIssuer(interCert, interKey)
	if err != nil {
		t.Fatal(err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const serial = "C02MACPROD01"
	ou := strings.Repeat("Z", 50)

	leafDER, chainPEM, err := issuer.IssueMacACMECert(&leafKey.PublicKey, serial, ou, now)
	if err != nil {
		t.Fatalf("IssueMacACMECert: %v", err)
	}
	leaf, err := x509.ParseCertificate(leafDER)
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Subject.CommonName != serial || len(leaf.Subject.OrganizationalUnit) != 1 || leaf.Subject.OrganizationalUnit[0] != ou {
		t.Fatalf("unexpected subject: %+v", leaf.Subject)
	}
	if leaf.SerialNumber.BitLen() < 128 {
		t.Fatalf("serial bit len = %d, want >= 128", leaf.SerialNumber.BitLen())
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("EKU = %v, want [clientAuth]", leaf.ExtKeyUsage)
	}
	if len(leaf.DNSNames) != 0 || len(leaf.IPAddresses) != 0 {
		t.Fatalf("unexpected DNS/IP SANs on Mac ACME cert")
	}

	// 1. Go x509.Verify against test root + intermediate WITH real name constraints passes.
	roots := x509.NewCertPool()
	roots.AddCert(rootCert)
	inters := x509.NewCertPool()
	inters.AddCert(interCert)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inters,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("x509.Verify under production name constraints failed: %v", err)
	}

	// 2. mailfront's exact client-cert check ACCEPTS it.
	keyHash, cn, err := mailfront.VerifyClientCert(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{leaf, interCert},
		DidResume:        false,
	}, roots, now)
	if err != nil {
		t.Fatalf("mailfront.VerifyClientCert refused issued Mac ACME cert: %v", err)
	}
	if cn != serial || len(keyHash) != 32 {
		t.Fatalf("mailfront.VerifyClientCert = (len=%d, cn=%q), want (32, %q)", len(keyHash), cn, serial)
	}

	// 3. Phase 4 L1 check REFUSES it (wrong EKU + has permanentIdentifier SAN + ECDSA not RSA).
	dt, err := enroll.ParseDeviceTrustBundle(bundlePEM)
	if err != nil {
		t.Fatal(err)
	}
	if err := dt.VerifyPhase4Leaf(leaf, now); err == nil {
		t.Fatal("Phase 4 L1 VerifyPhase4Leaf accepted a Mac ACME clientAuth cert (MUST refuse!)")
	}
	if _, _, reason := verifyPhase4SCEPLeaf(leafDER, enroll.NewStaticDeviceCABundle(dt), now); reason == "" {
		t.Fatal("verifyPhase4SCEPLeaf accepted a Mac ACME cert (MUST refuse!)")
	}

	// 4. Returned PEM chain has exactly leaf + intermediate.
	chain, err := parseCertChainStrict([]byte(chainPEM))
	if err != nil || len(chain) != 2 {
		t.Fatalf("chainPEM parse = (%d certs, %v), want 2", len(chain), err)
	}
}
