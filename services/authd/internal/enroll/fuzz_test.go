package enroll

import (
	"crypto"
	"crypto/x509"
	"encoding/asn1"
	"testing"

	"github.com/smallstep/pkcs7"
)

// FuzzParseEnrollmentRequest fuzzes the entire untrusted request-parsing path
// (BER-to-DER normalization, CMS SignedData parsing and SignerInfo H1 checks,
// phase classification, and strict XML attributes-plist parsing). It must
// never panic or blow up memory on arbitrary attacker-controlled bytes.
func FuzzParseEnrollmentRequest(f *testing.F) {
	pki := newTestPKI(&testing.T{})
	appleLeaf := pki.issueAppleLeaf(&testing.T{}, pki.appleCA1, "fuzz-apple", x509.SHA1WithRSA, 1024, nil)
	scepLeaf := pki.issueSCEPLeaf(&testing.T{}, pki.deviceInter, "FUZZSERIAL", nil)

	validPlist := makePhase2Plist("string", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"UDID-1", "FUZZSERIAL", "iPhone17,2", "22A3354", "Fuzz iPhone", "iPhone")
	dataPlist := makePhase2Plist("data", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"UDID-1", "FUZZSERIAL", "iPhone17,2", "22A3354", "", "")
	phase4Plist := []byte(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>UDID</key><string>UDID-1</string></dict></plist>`)
	macPlist := makeMacAttributesPlist("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"11111111-2222-3333-4444-555555555555", "FUZZMAC", "Mac15,6", "26C5047e", "Fuzz Mac", "MacBook Pro", false)

	p2DER := signWithPKCS7(&testing.T{}, appleLeaf, pkcs7.OIDDigestAlgorithmSHA1, validPlist)
	p4DER := signWithPKCS7(&testing.T{}, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256, phase4Plist)
	macP2DER := signWithoutSignedAttrs(&testing.T{}, appleLeaf, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, macPlist)
	macP4DER := signWithoutSignedAttrs(&testing.T{}, scepLeaf, oidDigestSHA1, oidSigRSASHA1, crypto.SHA1, macPlist)

	// Indefinite-length BER outer ContentInfo seed.
	var outer asn1.RawValue
	_, _ = asn1.Unmarshal(p4DER, &outer)
	indefBER := append([]byte{0x30, 0x80}, outer.Bytes...)
	indefBER = append(indefBER, 0x00, 0x00)

	// Deep BER nesting bomb seed.
	deepBER := make([]byte, 0, 160)
	for i := 0; i < 40; i++ {
		deepBER = append(deepBER, 0x30, 0x80)
	}
	for i := 0; i < 40; i++ {
		deepBER = append(deepBER, 0x00, 0x00)
	}

	seeds := [][]byte{
		{},
		{0x30, 0x00},
		{0x30, 0x80, 0x00, 0x00},
		deepBER,
		p2DER,
		p4DER,
		macP2DER,
		macP4DER,
		indefBER,
		validPlist,
		dataPlist,
		phase4Plist,
		macPlist,
		[]byte(`<!DOCTYPE plist [<!ENTITY a "x">]><plist version="1.0"><dict><key>A</key><string>&a;</string></dict></plist>`),
		[]byte(`<plist version="1.0"><dict><key>A</key><string><![CDATA[x]]></string></dict></plist>`),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	trust := pki.trust
	now := pki.now

	f.Fuzz(func(t *testing.T, data []byte) {
		// Cap to realistic input sizes above MaxBodyBytes so oversized refusal is
		// exercised without wasting time allocating multi-megabyte fuzz inputs.
		if len(data) > MaxBodyBytes+1024 {
			data = data[:MaxBodyBytes+1024]
		}
		if cms, err := ParseAndVerifyCMS(data); err == nil {
			_, _ = ClassifySigner(cms, trust, now)
			_, _ = ParseAttributesPlist(cms.Content)
		}
		// Also fuzz the strict XML attributes-plist parser directly so it gets
		// full coverage even on inputs that are not valid CMS SignedData.
		_, _ = ParseAttributesPlist(data)
	})
}

// FuzzParseAttributesPlist focuses fuzzing strictly on the XML attributes-plist
// parser (including Mac boolean elements, CHALLENGE <data>, and hostile XML).
func FuzzParseAttributesPlist(f *testing.F) {
	validPlist := makePhase2Plist("string", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"UDID-1", "FUZZSERIAL", "iPhone17,2", "22A3354", "Fuzz iPhone", "iPhone")
	dataPlist := makePhase2Plist("data", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"UDID-1", "FUZZSERIAL", "iPhone17,2", "22A3354", "", "")
	macPlist := makeMacAttributesPlist("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
		"11111111-2222-3333-4444-555555555555", "FUZZMAC", "Mac15,6", "26C5047e", "Fuzz Mac", "MacBook Pro", false)
	macTruePlist := makeMacAttributesPlist("",
		"11111111-2222-3333-4444-555555555555", "FUZZMAC", "Mac15,6", "26C5047e", "Fuzz Mac", "MacBook Pro", true)

	for _, s := range [][]byte{
		{},
		validPlist,
		dataPlist,
		macPlist,
		macTruePlist,
		[]byte(`<plist version="1.0"><dict><key>NotOnConsole</key><true></true><key>B</key><false/></dict></plist>`),
		[]byte(`<!DOCTYPE plist [<!ENTITY a "x">]><plist version="1.0"><dict><key>A</key><string>&a;</string></dict></plist>`),
		[]byte(`<plist version="1.0"><dict><key>A</key><string><![CDATA[x]]></string></dict></plist>`),
		[]byte(`<plist version="1.0"><dict><key>NotOnConsole</key><true>bad</true></dict></plist>`),
	} {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > maxPlistBytes+1024 {
			data = data[:maxPlistBytes+1024]
		}
		_, _ = ParseAttributesPlist(data)
	})
}
