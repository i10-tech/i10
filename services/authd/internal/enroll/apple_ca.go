package enroll

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
)

// appleIPhoneDeviceCAPEM is the "Apple iPhone Device CA" certificate published
// in Apple's Over-the-Air Profile Delivery and Configuration guide
// (profile-service.html).
//
// Subject: C=US, O=Apple Inc., OU=Apple iPhone, CN=Apple iPhone Device CA
// Validity: 2007-04-16 to 2014-04-16 (RSA-1024, sha1WithRSAEncryption)
// SHA-256: 76f27d00e1333bc88de0e2916c38c9a7f2b75774c25a794c092a80e3c4c66cce
//
// ⚠ PINNED IN ONE PLACE AND HELD AS A SLICE. Real device probes may reveal a
// second Apple intermediate for newer hardware (Review 1 rules); adding a
// second PEM block here extends phase 2 trust without touching verification
// logic.
const appleIPhoneDeviceCAPEM = `-----BEGIN CERTIFICATE-----
MIIDaTCCAlGgAwIBAgIBATANBgkqhkiG9w0BAQUFADB5MQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxLTArBgNVBAMTJEFwcGxlIGlQaG9uZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTAeFw0wNzA0MTYyMjU0NDZaFw0xNDA0MTYyMjU0NDZaMFoxCzAJ
BgNVBAYTAlVTMRMwEQYDVQQKEwpBcHBsZSBJbmMuMRUwEwYDVQQLEwxBcHBsZSBp
UGhvbmUxHzAdBgNVBAMTFkFwcGxlIGlQaG9uZSBEZXZpY2UgQ0EwgZ8wDQYJKoZI
hvcNAQEBBQADgY0AMIGJAoGBAPGUSsnquloYYK3Lok1NTlQZaRdZB2bLl+hmmkdf
Rq5nerVKc1SxywT2vTa4DFU4ioSDMVJl+TPhl3ecK0wmsCU/6TKqewh0lOzBSzgd
Z04IUpRai1mjXNeT9KD+VYW7TEaXXm6yd0UvZ1y8Cxi/WblshvcqdXbSGXH0KWO5
JQuvAgMBAAGjgZ4wgZswDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8w
HQYDVR0OBBYEFLL+ISNEhpVqedWBJo5zENinTI50MB8GA1UdIwQYMBaAFOc0Ki4i
3jlga7SUzneDYS8xoHw1MDgGA1UdHwQxMC8wLaAroCmGJ2h0dHA6Ly93d3cuYXBw
bGUuY29tL2FwcGxlY2EvaXBob25lLmNybDANBgkqhkiG9w0BAQUFAAOCAQEAd13P
Z3pMViukVHe9WUg8Hum+0I/0kHKvjhwVd/IMwGlXyU7DhUYWdja2X/zqj7W24Aq5
7dEKm3fqqxK5XCFVGY5HI0cRsdENyTP7lxSiiTRYj2mlPedheCn+k6T5y0U4Xr40
FXwWb2nWqCF1AgIudhgvVbxlvqcxUm8Zz7yDeJ0JFovXQhyO5fLUHRLCQFssAbf8
B4i8rYYsBUhYTspVJcxVpIIltkYpdIRSIARA49HNvKK4hzjzMS/OhKQpVKw+OCEZ
xptCVeN2pjbdt9uzi175oVo/u6B2ArKAW17u6XEHIdDMOe7cb33peVI6TD15W4MI
pyQPbp8orlXe+tA8JA==
-----END CERTIFICATE-----
`

// pinnedAppleDeviceCAs is the immutable production set of pinned Apple device
// CA certificates, parsed once at package init.
var pinnedAppleDeviceCAs = mustParsePEMCerts([]byte(appleIPhoneDeviceCAPEM))

// appleDeviceCAs is the slice consulted for phase 2 verification.
//
// ⚠ OVERRIDDEN ONLY BY TESTS. Production never mutates this variable; unit
// tests verify that its default equals pinnedAppleDeviceCAs.
var appleDeviceCAs = pinnedAppleDeviceCAs

func mustParsePEMCerts(raw []byte) []*x509.Certificate {
	certs, err := parseStrictPEMCerts(raw)
	if err != nil {
		panic("enroll: embedded Apple device CA failed to parse: " + err.Error())
	}
	return certs
}

// parseStrictPEMCerts parses a PEM bundle containing one or more CERTIFICATE
// blocks and nothing else. Any non-certificate block, trailing non-whitespace
// bytes or empty bundle is an error.
func parseStrictPEMCerts(raw []byte) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	rest := raw
	for {
		rest = bytes.TrimSpace(rest)
		if len(rest) == 0 {
			break
		}
		block, next := pem.Decode(rest)
		if block == nil {
			return nil, errors.New("trailing non-PEM bytes in certificate bundle")
		}
		if block.Type != "CERTIFICATE" {
			return nil, fmt.Errorf("unexpected PEM block type %q", block.Type)
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse certificate: %w", err)
		}
		certs = append(certs, cert)
		rest = next
	}
	if len(certs) == 0 {
		return nil, errors.New("no certificates in bundle")
	}
	return certs, nil
}
