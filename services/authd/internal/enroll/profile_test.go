package enroll

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func assertWellFormedXML(t *testing.T, raw []byte) {
	t.Helper()
	dec := xml.NewDecoder(bytes.NewReader(raw))
	dec.Strict = true
	for {
		_, err := dec.Token()
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatalf("rendered profile is not well-formed XML: %v\n%s", err, raw)
		}
	}
}

func TestRenderPhase1Profile(t *testing.T) {
	token := "abcDEF0123456789_-abcDEF0123456789_-abcDEF0"
	raw, err := RenderPhase1Profile("https://ca.i10.tech/enroll/apple/profile", token)
	if err != nil {
		t.Fatalf("RenderPhase1Profile: %v", err)
	}
	assertWellFormedXML(t, raw)

	s := string(raw)
	for _, want := range []string{
		"<key>PayloadType</key>\n  <string>Profile Service</string>",
		"<key>URL</key>\n    <string>https://ca.i10.tech/enroll/apple/profile</string>",
		"<key>Challenge</key>\n    <string>" + token + "</string>",
		"<string>UDID</string>",
		"<string>VERSION</string>",
		"<string>PRODUCT</string>",
		"<string>SERIAL</string>",
		"<string>DEVICE_NAME</string>",
		"<string>MODEL</string>",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("phase 1 profile missing %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "<data>") {
		t.Errorf("phase 1 Challenge must be <string>, not <data>:\n%s", s)
	}

	// XML escaping for special characters in URL and Challenge.
	tricky, err := RenderPhase1Profile("https://ca.i10.tech/a&b?x=<1>", `tok<&>"'`)
	if err != nil {
		t.Fatalf("RenderPhase1Profile tricky: %v", err)
	}
	assertWellFormedXML(t, tricky)
	if strings.Contains(string(tricky), `tok<&>"'`) {
		t.Fatalf("unescaped XML characters found in phase 1 profile:\n%s", tricky)
	}

	// Distinct UUIDs across calls.
	raw2, err := RenderPhase1Profile("https://ca.i10.tech/enroll/apple/profile", token)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(raw, raw2) {
		t.Fatal("two phase 1 profiles produced identical UUIDs")
	}

	if _, err := RenderPhase1Profile("", token); err == nil {
		t.Fatal("empty URL accepted")
	}
	if _, err := RenderPhase1Profile("https://ca.i10.tech/enroll/apple/profile", ""); err == nil {
		t.Fatal("empty token accepted")
	}
}

func TestRenderSCEPProfile(t *testing.T) {
	raw, err := RenderSCEPProfile("https://ca.i10.tech/scep/apple-scep", "C02SERIAL123", "scep-challenge-xyz")
	if err != nil {
		t.Fatalf("RenderSCEPProfile: %v", err)
	}
	assertWellFormedXML(t, raw)

	s := string(raw)
	for _, want := range []string{
		"<key>PayloadType</key>\n      <string>com.apple.security.scep</string>",
		"<key>URL</key>\n        <string>https://ca.i10.tech/scep/apple-scep</string>",
		"<string>CN</string>\n              <string>C02SERIAL123</string>",
		"<key>Challenge</key>\n        <string>scep-challenge-xyz</string>",
		"<key>Keysize</key>\n        <integer>2048</integer>",
		"<key>Key Type</key>\n        <string>RSA</string>",
		"<key>Key Usage</key>\n        <integer>5</integer>",
		"<key>KeyIsExtractable</key>\n        <false/>",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("SCEP profile missing %q:\n%s", want, s)
		}
	}
	// Must be SCEP-only: no ACME, no Mail, no CAFingerprint.
	for _, forbid := range []string{"com.apple.security.acme", "com.apple.mail.managed", "CAFingerprint"} {
		if strings.Contains(s, forbid) {
			t.Errorf("SCEP profile must not contain %q:\n%s", forbid, s)
		}
	}

	// XML escaping for hostile values in URL, serial, challenge.
	tricky, err := RenderSCEPProfile("https://ca.i10.tech/scep?a=1&b=2", `SER<>&"'`, `CHAL<>&"'`)
	if err != nil {
		t.Fatalf("RenderSCEPProfile tricky: %v", err)
	}
	assertWellFormedXML(t, tricky)
	if strings.Contains(string(tricky), `SER<>&"'`) || strings.Contains(string(tricky), `CHAL<>&"'`) {
		t.Fatalf("unescaped XML characters found in SCEP profile:\n%s", tricky)
	}

	if _, err := RenderSCEPProfile("", "S", "C"); err == nil {
		t.Fatal("empty URL accepted")
	}
	if _, err := RenderSCEPProfile("https://ca.i10.tech/scep/apple-scep", "", "C"); err == nil {
		t.Fatal("empty serial accepted")
	}
	if _, err := RenderSCEPProfile("https://ca.i10.tech/scep/apple-scep", "S", ""); err == nil {
		t.Fatal("empty challenge accepted")
	}
}
