package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"time"
)

const (
	// templateSkew matches the 5-minute template clock skew the old API hook allowed.
	templateSkew = 5 * time.Minute

	// scepMaxLifetime is the SCEP enrollment identity ceiling: 7 days + 5m skew.
	scepMaxLifetime = 7*24*time.Hour + templateSkew
)

// timestampEnvelope extracts only the step-ca webhook timestamp for freshness check.
type timestampEnvelope struct {
	Timestamp string `json:"timestamp"`
}

// parseGoTime parses an RFC 3339 timestamp with explicit timezone (matching
// Go's time.Time JSON encoding).
func parseGoTime(raw string) (time.Time, bool) {
	if raw == "" || !strings.Contains(raw, "T") {
		return time.Time{}, false
	}
	// Require explicit zone (Z or +/-HH:MM).
	if !strings.HasSuffix(raw, "Z") {
		if len(raw) < 6 {
			return time.Time{}, false
		}
		tz := raw[len(raw)-6:]
		if (tz[0] != '+' && tz[0] != '-') || tz[3] != ':' {
			return time.Time{}, false
		}
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func parseBodyTimestamp(raw []byte) (time.Time, bool) {
	var env timestampEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return time.Time{}, false
	}
	return parseGoTime(env.Timestamp)
}

// decodeStrictStdBase64 enforces standard base64 without whitespace or padding ambiguity.
func decodeStrictStdBase64(s string) ([]byte, bool) {
	if s == "" || len(s)%4 != 0 {
		return nil, false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=' {
			continue
		}
		return nil, false
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

// spkiSHA256Hex validates that der is a valid SubjectPublicKeyInfo public key
// and returns the lowercase hex SHA-256 of the exact DER bytes.
func spkiSHA256Hex(der []byte) (string, bool) {
	if len(der) == 0 {
		return "", false
	}
	if _, err := x509.ParsePKIXPublicKey(der); err != nil {
		return "", false
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:]), true
}

// isValidSerial: 1..64 printable ASCII bytes.
func isValidSerial(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// ── /scep-challenge body ────────────────────────────────────────────────────

type scepChallengeReq struct {
	Timestamp              string `json:"timestamp"`
	SCEPChallenge          string `json:"scepChallenge"`
	SCEPTransactionID      string `json:"scepTransactionID"`
	X509CertificateRequest *struct {
		Subject *struct {
			CommonName string `json:"commonName"`
		} `json:"subject"`
		PublicKey string `json:"publicKey"`
	} `json:"x509CertificateRequest"`
}

type parsedSCEPChallenge struct {
	// Challenge is the plaintext step-ca received from the device. It goes into
	// the key binding so enrollctl can check it is the session's current one.
	Challenge       string
	ChallengeSHA256 string
	TransactionID   string
	CommonName      string
	KeySHA256       string
}

func parseSCEPChallengeBody(raw []byte) (parsedSCEPChallenge, string, string) {
	var req scepChallengeReq
	if err := json.Unmarshal(raw, &req); err != nil {
		return parsedSCEPChallenge{}, "", "bad_body"
	}
	if _, ok := parseGoTime(req.Timestamp); !ok {
		return parsedSCEPChallenge{}, "", "bad_body"
	}
	if len(req.SCEPChallenge) == 0 || len(req.SCEPChallenge) > 255 {
		return parsedSCEPChallenge{}, "", "bad_body"
	}
	chalSum := sha256.Sum256([]byte(req.SCEPChallenge))
	chalHex := hex.EncodeToString(chalSum[:])

	if len(req.SCEPTransactionID) == 0 || len(req.SCEPTransactionID) > 255 {
		return parsedSCEPChallenge{}, chalHex, "bad_body"
	}
	if req.X509CertificateRequest == nil {
		return parsedSCEPChallenge{}, chalHex, "bad_body"
	}
	pkDER, ok := decodeStrictStdBase64(req.X509CertificateRequest.PublicKey)
	if !ok {
		return parsedSCEPChallenge{}, chalHex, "bad_body"
	}
	keyHex, ok := spkiSHA256Hex(pkDER)
	if !ok {
		return parsedSCEPChallenge{}, chalHex, "bad_template"
	}
	if req.X509CertificateRequest.Subject == nil || req.X509CertificateRequest.Subject.CommonName == "" {
		return parsedSCEPChallenge{}, chalHex, "bad_template"
	}
	return parsedSCEPChallenge{
		Challenge:       req.SCEPChallenge,
		ChallengeSHA256: chalHex,
		TransactionID:   req.SCEPTransactionID,
		CommonName:      req.X509CertificateRequest.Subject.CommonName,
		KeySHA256:       keyHex,
	}, chalHex, ""
}

// ── /scep-authorize body (strict x509util.Certificate template validation) ──

// strictTemplateSubject is x509util.Subject. ⚠ A SCEP LEAF CARRIES A CN AND
// NOTHING ELSE: every other attribute is named here only so that a value in it
// is refused as bad_template (an unknown key is refused as bad_body).
type strictTemplateSubject struct {
	CommonName         string          `json:"commonName"`
	OrganizationalUnit json.RawMessage `json:"organizationalUnit"`
	Organization       json.RawMessage `json:"organization"`
	Country            json.RawMessage `json:"country"`
	Locality           json.RawMessage `json:"locality"`
	Province           json.RawMessage `json:"province"`
	StreetAddress      json.RawMessage `json:"streetAddress"`
	PostalCode         json.RawMessage `json:"postalCode"`
	SerialNumber       json.RawMessage `json:"serialNumber"`
	ExtraNames         json.RawMessage `json:"extraNames"`
}

// onlyCommonName reports whether every subject attribute but the CN is unset.
func (s *strictTemplateSubject) onlyCommonName() bool {
	for _, v := range []json.RawMessage{
		s.OrganizationalUnit, s.Organization, s.Country, s.Locality, s.Province,
		s.StreetAddress, s.PostalCode, s.SerialNumber, s.ExtraNames,
	} {
		if !isUnsetValue(v) {
			return false
		}
	}
	return true
}

type strictSAN struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type strictExtension struct {
	ID       string `json:"id"`
	Critical bool   `json:"critical"`
	Value    string `json:"value"`
}

type strictBasicConstraints struct {
	IsCA bool `json:"isCA"`
}

// strictCertificateTemplate mirrors x509util.Certificate + webhook.X509Certificate
// . Unmarshaled with DisallowUnknownFields so
// no unknown key that could alter the signed leaf can pass unread.
type strictCertificateTemplate struct {
	Version               *int                    `json:"version"`
	Subject               *strictTemplateSubject  `json:"subject"`
	RawSubject            *string                 `json:"rawSubject"`
	Issuer                json.RawMessage         `json:"issuer"`
	SerialNumber          json.RawMessage         `json:"serialNumber"`
	DNSNames              []string                `json:"dnsNames"`
	EmailAddresses        []string                `json:"emailAddresses"`
	IPAddresses           []string                `json:"ipAddresses"`
	URIs                  []string                `json:"uris"`
	SANs                  []strictSAN             `json:"sans"`
	Extensions            []strictExtension       `json:"extensions"`
	KeyUsage              []string                `json:"keyUsage"`
	ExtKeyUsage           []string                `json:"extKeyUsage"`
	UnknownExtKeyUsage    []string                `json:"unknownExtKeyUsage"`
	SubjectKeyID          json.RawMessage         `json:"subjectKeyId"`
	AuthorityKeyID        json.RawMessage         `json:"authorityKeyId"`
	OCSPServer            json.RawMessage         `json:"ocspServer"`
	IssuingCertificateURL json.RawMessage         `json:"issuingCertificateURL"`
	CRLDistributionPoints json.RawMessage         `json:"crlDistributionPoints"`
	PolicyIdentifiers     json.RawMessage         `json:"policyIdentifiers"`
	BasicConstraints      *strictBasicConstraints `json:"basicConstraints"`
	NameConstraints       json.RawMessage         `json:"nameConstraints"`
	SignatureAlgorithm    *string                 `json:"signatureAlgorithm"`
	PublicKey             *string                 `json:"publicKey"`
	PublicKeyAlgorithm    *string                 `json:"publicKeyAlgorithm"`
	NotBefore             *string                 `json:"notBefore"`
	NotAfter              *string                 `json:"notAfter"`
	Raw                   json.RawMessage         `json:"raw"`
}

// isUnsetValue matches body.ts `unset`: absent, null, empty string "", or empty array [].
func isUnsetValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte(`""`)) {
		return true
	}
	if len(trimmed) >= 2 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' {
		inner := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
		return len(inner) == 0
	}
	return false
}

func isNullOrAbsent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

func sameNames(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	a := slices.Clone(got)
	b := slices.Clone(want)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

type parsedSCEPAuthorize struct {
	CommonName string
	KeySHA256  string
}

func decodeStrictJSON(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}

// parseAndCheckSCEPAuthorize parses the step-ca AUTHORIZING webhook body and
// enforces every SCEP template rule (formerly in the API's CA hook).
// Returns (parsed, keyHexIfParsed, refusalOutcome).
func parseAndCheckSCEPAuthorize(raw []byte, now, intermediateNotAfter time.Time) (parsedSCEPAuthorize, string, string) {
	var envelope struct {
		Timestamp       string          `json:"timestamp"`
		X509Certificate json.RawMessage `json:"x509Certificate"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return parsedSCEPAuthorize{}, "", "bad_body"
	}
	if _, ok := parseGoTime(envelope.Timestamp); !ok || isNullOrAbsent(envelope.X509Certificate) {
		return parsedSCEPAuthorize{}, "", "bad_body"
	}

	// Best-effort extraction of publicKey hash before strict template checks so
	// a bad_template refusal can still mark the bound session refused.
	var keyHint struct {
		PublicKey string `json:"publicKey"`
	}
	keyHexHint := ""
	if err := json.Unmarshal(envelope.X509Certificate, &keyHint); err == nil {
		if der, ok := decodeStrictStdBase64(keyHint.PublicKey); ok {
			if h, ok := spkiSHA256Hex(der); ok {
				keyHexHint = h
			}
		}
	}

	var cert strictCertificateTemplate
	if err := decodeStrictJSON(envelope.X509Certificate, &cert); err != nil {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}

	// Validate unset fields, signatureAlgorithm, raw, publicKey, notBefore, notAfter.
	for _, field := range []json.RawMessage{
		cert.SerialNumber,
		cert.SubjectKeyID,
		cert.AuthorityKeyID,
		cert.OCSPServer,
		cert.IssuingCertificateURL,
		cert.CRLDistributionPoints,
		cert.PolicyIdentifiers,
	} {
		if !isUnsetValue(field) {
			return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
		}
	}
	if !isNullOrAbsent(cert.Raw) {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	if cert.SignatureAlgorithm != nil && *cert.SignatureAlgorithm != "" {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	if cert.PublicKey == nil || cert.NotBefore == nil || cert.NotAfter == nil {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	pkDER, ok := decodeStrictStdBase64(*cert.PublicKey)
	if !ok {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	notBefore, ok := parseGoTime(*cert.NotBefore)
	if !ok {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	notAfter, ok := parseGoTime(*cert.NotAfter)
	if !ok {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
	}
	for _, ext := range cert.Extensions {
		if _, ok := decodeStrictStdBase64(ext.Value); !ok {
			return parsedSCEPAuthorize{}, keyHexHint, "bad_body"
		}
	}

	keyHex, ok := spkiSHA256Hex(pkDER)
	if !ok {
		return parsedSCEPAuthorize{}, keyHexHint, "bad_template"
	}
	if cert.Subject == nil || cert.Subject.CommonName == "" {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	cn := cert.Subject.CommonName

	// Ported templateRefusal rules for SCEP (permanentIdentifierSan = false):
	if !isValidSerial(cn) || !cert.Subject.onlyCommonName() {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if cert.RawSubject != nil && *cert.RawSubject != "" {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if len(cert.DNSNames) > 0 || len(cert.EmailAddresses) > 0 || len(cert.IPAddresses) > 0 || len(cert.URIs) > 0 {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if len(cert.SANs) > 0 {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if len(cert.Extensions) > 0 {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if !sameNames(cert.KeyUsage, []string{"digitalSignature", "keyEncipherment"}) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	// AN EXPLICIT EKU WITHOUT clientAuth: a certificate with no EKU at all
	// would pass Go's clientAuth check (crypto/x509/verify.go).
	if !sameNames(cert.ExtKeyUsage, []string{"emailProtection"}) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if len(cert.UnknownExtKeyUsage) > 0 {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if (cert.BasicConstraints != nil && cert.BasicConstraints.IsCA) || !isNullOrAbsent(cert.NameConstraints) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}

	nowUTC := now.UTC()
	nbDelta := notBefore.Sub(nowUTC)
	if nbDelta < -templateSkew || nbDelta > templateSkew {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	floor := nowUTC
	if notBefore.After(floor) {
		floor = notBefore
	}
	if !notAfter.After(floor) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if notAfter.After(nowUTC.Add(scepMaxLifetime)) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}
	if notAfter.After(intermediateNotAfter.UTC()) {
		return parsedSCEPAuthorize{}, keyHex, "bad_template"
	}

	return parsedSCEPAuthorize{CommonName: cn, KeySHA256: keyHex}, keyHex, ""
}
