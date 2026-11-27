package enroll

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestProductionAppleDeviceCAPin asserts that production starts with the exact
// Apple iPhone Device CA certificate fetched from Apple's OTA Profile Service
// guide, and that its SHA-256 fingerprint matches.
func TestProductionAppleDeviceCAPin(t *testing.T) {
	const wantSHA256 = "76f27d00e1333bc88de0e2916c38c9a7f2b75774c25a794c092a80e3c4c66cce"

	if len(appleDeviceCAs) != 1 {
		t.Fatalf("len(appleDeviceCAs) = %d, want 1", len(appleDeviceCAs))
	}
	if len(pinnedAppleDeviceCAs) != 1 || !bytes.Equal(appleDeviceCAs[0].Raw, pinnedAppleDeviceCAs[0].Raw) {
		t.Fatal("appleDeviceCAs does not match pinnedAppleDeviceCAs")
	}
	ca := appleDeviceCAs[0]
	sum := sha256.Sum256(ca.Raw)
	if got := hex.EncodeToString(sum[:]); got != wantSHA256 {
		t.Fatalf("Apple iPhone Device CA SHA-256 = %s, want %s", got, wantSHA256)
	}
	if ca.Subject.CommonName != "Apple iPhone Device CA" {
		t.Fatalf("CN = %q, want %q", ca.Subject.CommonName, "Apple iPhone Device CA")
	}
	pub, ok := ca.PublicKey.(*rsa.PublicKey)
	if !ok || pub.N.BitLen() != 1024 {
		t.Fatalf("public key = %T (%v), want 1024-bit RSA", ca.PublicKey, ca.PublicKeyAlgorithm)
	}
	wantNotAfter := time.Date(2014, 4, 16, 22, 54, 46, 0, time.UTC)
	if !ca.NotAfter.Equal(wantNotAfter) {
		t.Fatalf("NotAfter = %v, want %v", ca.NotAfter, wantNotAfter)
	}
}

func TestParseDeviceTrustBundle(t *testing.T) {
	pki := newTestPKI(t)

	if _, err := ParseDeviceTrustBundle(pki.bundlePEM); err != nil {
		t.Fatalf("valid bundle rejected: %v", err)
	}

	leaf := pki.issueSCEPLeaf(t, pki.deviceInter, "SERIAL1", nil)
	cases := []struct {
		name string
		raw  []byte
	}{
		{"empty", nil},
		{"root only", pemCert(pki.deviceRoot.cert.Raw)},
		{"intermediate only", pemCert(pki.deviceInter.cert.Raw)},
		{"contains leaf", append(append([]byte{}, pki.bundlePEM...), pemCert(leaf.cert.Raw)...)},
		{"trailing garbage", append(append([]byte{}, pki.bundlePEM...), []byte("\n# comment\n")...)},
		{"wrong block type", []byte("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseDeviceTrustBundle(tc.raw); err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
		})
	}
}

func TestDeviceCABundleLoadAndKeepPreviousOnBrokenReload(t *testing.T) {
	pki := newTestPKI(t)
	path := filepath.Join(t.TempDir(), "bundle.pem")
	if err := os.WriteFile(path, pki.bundlePEM, 0o600); err != nil {
		t.Fatal(err)
	}
	b := &DeviceCABundle{File: path}
	if err := b.Load(); err != nil {
		t.Fatalf("initial Load: %v", err)
	}
	first := b.Current()
	if first == nil {
		t.Fatal("Current() is nil after Load")
	}

	// Overwrite with malformed bytes: Load errors and keeps the previous trust.
	if err := os.WriteFile(path, []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := b.Load(); err == nil {
		t.Fatal("malformed reload succeeded")
	}
	if b.Current() != first {
		t.Fatal("previous bundle was not preserved after failed reload")
	}
}
