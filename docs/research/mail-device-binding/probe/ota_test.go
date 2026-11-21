package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestRepliesArePlists(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(dir+"/enroll.plist", []byte(enrollReply("SERIAL123", "chal")), 0o600)
	if out, err := exec.Command("plutil", "-lint", dir+"/enroll.plist").CombinedOutput(); err != nil {
		t.Fatalf("enroll: %s", out)
	}
	src, _ := os.ReadFile("ota.go")
	if strings.Count(string(src), "com.apple.security.acme") != 1 || strings.Count(string(src), "com.apple.security.scep") != 1 {
		t.Fatal("expected one acme (sealed) and one scep (enroll) payload")
	}
}

// ---- throwaway PKI for the handler tests ----

type testCA struct {
	cert *x509.Certificate
	key  *rsa.PrivateKey
}

func pemCert(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func newCA(t *testing.T, cn string) *testCA {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &testCA{c, key}
}

// leaf is a signing identity: certificate and key as PEM.
type leaf struct{ certPEM, keyPEM []byte }

func (ca *testCA) issue(t *testing.T, cn string) leaf {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return leaf{pemCert(der), pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})}
}

type fixture struct {
	srv         *otaServer
	apple, step *testCA
	dir         string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(dir+"/pki", 0o700); err != nil {
		t.Fatal(err)
	}
	f := &fixture{dir: dir, apple: newCA(t, "Test Apple Root"), step: newCA(t, "i10 probe step CA")}
	s := newOTAServer(dir)
	s.appleRoot, s.stepRoot, s.stepInter = dir+"/apple.pem", dir+"/step.pem", ""
	os.WriteFile(s.appleRoot, pemCert(f.apple.cert.Raw), 0o600)
	os.WriteFile(s.stepRoot, pemCert(f.step.cert.Raw), 0o600)
	os.WriteFile(dir+"/scep-challenge.txt", []byte("scep-secret\n"), 0o600)
	f.srv = s
	return f
}

// sign builds the CMS SignedData a device would POST for the given attributes.
func sign(t *testing.T, id leaf, chal, serial string) []byte {
	t.Helper()
	d := t.TempDir()
	os.WriteFile(d+"/c.pem", id.certPEM, 0o600)
	os.WriteFile(d+"/k.pem", id.keyPEM, 0o600)
	attrs := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CHALLENGE</key><string>%s</string><key>SERIAL</key><string>%s</string>
<key>UDID</key><string>U</string><key>PRODUCT</key><string>iPhone15,2</string><key>VERSION</key><string>1</string>
</dict></plist>`, chal, serial)
	os.WriteFile(d+"/a.plist", []byte(attrs), 0o600)
	out, err := exec.Command("openssl", "cms", "-sign", "-nodetach", "-binary", "-outform", "DER",
		"-signer", d+"/c.pem", "-inkey", d+"/k.pem", "-in", d+"/a.plist", "-out", d+"/o.der").CombinedOutput()
	if err != nil {
		t.Fatalf("sign: %s", out)
	}
	b, _ := os.ReadFile(d + "/o.der")
	return b
}

func post(s *otaServer, body []byte) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ota/profile", bytes.NewReader(body))
	req.Header.Set("User-Agent", "Profile/1.0")
	s.phase2(rec, req)
	return rec
}

func assertRejected(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400; body: %.200s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "EncryptedPayloadContent") || strings.Contains(rec.Body.String(), "PayloadContent") {
		t.Fatal("a rejected request still got a profile")
	}
}

func issued(t *testing.T, f *fixture) string {
	t.Helper()
	id, err := f.srv.chals.issue()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

const serial = "F2LXYZ123"

// A full, honest run: Apple-signed phase 2, then phase 3 signed by the cert
// step-ca would issue (CN = serial) gets a sealed profile.
func TestHonestFlowGetsSealedProfile(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	p2 := post(f.srv, sign(t, f.apple.issue(t, "device"), chal, serial))
	if p2.Code != 200 || !strings.Contains(p2.Body.String(), "com.apple.security.scep") {
		t.Fatalf("phase 2: %d %.200s", p2.Code, p2.Body.String())
	}
	p3 := post(f.srv, sign(t, f.step.issue(t, serial), chal, serial))
	if p3.Code != 200 || !strings.Contains(p3.Body.String(), "EncryptedPayloadContent") {
		t.Fatalf("phase 3: %d %.200s", p3.Code, p3.Body.String())
	}
}

// (a) Issuer name alone proves nothing: a cert whose issuer CN is "i10 probe
// step CA" but which does not chain to the real step root gets nothing, for
// phase 3 and as a phase 2 stand-in alike.
func TestForgedStepIssuerRejected(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	post(f.srv, sign(t, f.apple.issue(t, "device"), chal, serial)) // challenge now bound

	fakeStep := newCA(t, "i10 probe step CA") // same name, different key
	forged := fakeStep.issue(t, serial)
	assertRejected(t, post(f.srv, sign(t, forged, chal, serial)))

	// The challenge was not consumed by the forgery, so the real one still works.
	if rec := post(f.srv, sign(t, f.step.issue(t, serial), chal, serial)); rec.Code != 200 {
		t.Fatalf("honest phase 3 after forgery: %d", rec.Code)
	}

	// Self-signed with that issuer name, no challenge history at all.
	assertRejected(t, post(f.srv, sign(t, fakeStep.issue(t, "x"), issued(t, f), "x")))
}

// (b) Unknown and expired challenges are refused in both phases.
func TestUnknownOrExpiredChallengeRejected(t *testing.T) {
	f := newFixture(t)
	dev := f.apple.issue(t, "device")

	assertRejected(t, post(f.srv, sign(t, dev, "never-issued", serial)))

	chal := issued(t, f)
	f.srv.chals.now = func() time.Time { return time.Now().Add(challengeTTL + time.Minute) }
	assertRejected(t, post(f.srv, sign(t, dev, chal, serial)))

	// Bound in time, then expired before phase 3.
	f.srv.chals.now = time.Now
	chal = issued(t, f)
	if rec := post(f.srv, sign(t, dev, chal, serial)); rec.Code != 200 {
		t.Fatalf("phase 2: %d", rec.Code)
	}
	f.srv.chals.now = func() time.Time { return time.Now().Add(challengeTTL + time.Minute) }
	assertRejected(t, post(f.srv, sign(t, f.step.issue(t, serial), chal, serial)))
}

// (c) A challenge works once.
func TestChallengeCannotBeReused(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	post(f.srv, sign(t, f.apple.issue(t, "device"), chal, serial))
	id := f.step.issue(t, serial)
	if rec := post(f.srv, sign(t, id, chal, serial)); rec.Code != 200 {
		t.Fatalf("first use: %d", rec.Code)
	}
	assertRejected(t, post(f.srv, sign(t, id, chal, serial)))
	// And it cannot be restarted from phase 2 either.
	assertRejected(t, post(f.srv, sign(t, f.apple.issue(t, "device"), chal, serial)))
}

// (d) The phase 3 certificate must belong to the serial that passed phase 2.
func TestPhase3CNMustMatchSerial(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	post(f.srv, sign(t, f.apple.issue(t, "device"), chal, serial))
	other := f.step.issue(t, "SOMEONEELSE")
	assertRejected(t, post(f.srv, sign(t, other, chal, serial)))
	// A different serial in the attributes cannot borrow the bound challenge.
	assertRejected(t, post(f.srv, sign(t, f.step.issue(t, "SOMEONEELSE"), chal, "SOMEONEELSE")))
}

// A challenge never bound by an Apple-verified phase 2 cannot go straight to phase 3.
func TestPhase3WithoutPhase2Rejected(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	assertRejected(t, post(f.srv, sign(t, f.step.issue(t, serial), chal, serial)))
}

// An Apple-signed phase 2 cannot rebind a challenge to a different serial.
func TestPhase2CannotRebindSerial(t *testing.T) {
	f := newFixture(t)
	chal := issued(t, f)
	dev := f.apple.issue(t, "device")
	post(f.srv, sign(t, dev, chal, serial))
	assertRejected(t, post(f.srv, sign(t, dev, chal, "OTHERSERIAL")))
}
