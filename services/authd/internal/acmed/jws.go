// Package acmed implements i10's stateless Mac device-attest-01 ACME server
// (RFC 8555 subset for com.apple.security.acme).
//
// Security boundary:
//   - acmed is internet-facing (behind Traefik on /acme/apple/*) and holds NO
//     CA key, NO profile-signing key and NO permit key. Its two key rings are
//     ACMED_NONCE_KEYS, which MACs its own Replay-Nonces and account URLs, and
//     ENROLL_ACME_PATH_KEYS, with which it only verifies the per-Mac path
//     tokens enrollctl signs. Neither mints anything.
//   - acmed holds only i10-enroll-redis credentials scoped to `enroll:acme:*`
//     and a bearer token for enrollctl `/acme/finalize`.
//   - enrollctl independently re-verifies the Apple Enterprise Attestation x5c
//     chain, CSR signature + key match, CN/OU subject, and the self-certifying
//     OU permit MAC before binding any key or signing any certificate.
//   - Therefore, a compromised acmed cannot obtain a certificate for any key
//     Apple did not attest for that serial, and cannot bind anything without a
//     live permit that only the Mac received inside its encrypted profile.
package acmed

import (
	"bytes"
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
)

// ACME RFC 8555 problem error types.
const (
	ProblemAccountDoesNotExist     = "urn:ietf:params:acme:error:accountDoesNotExist"
	ProblemBadAttestationStatement = "urn:ietf:params:acme:error:badAttestationStatement"
	ProblemBadCSR                  = "urn:ietf:params:acme:error:badCSR"
	ProblemBadNonce                = "urn:ietf:params:acme:error:badNonce"
	ProblemBadPublicKey            = "urn:ietf:params:acme:error:badPublicKey"
	ProblemBadSignatureAlgorithm   = "urn:ietf:params:acme:error:badSignatureAlgorithm"
	ProblemMalformed               = "urn:ietf:params:acme:error:malformed"
	ProblemOrderNotReady           = "urn:ietf:params:acme:error:orderNotReady"
	ProblemRateLimited             = "urn:ietf:params:acme:error:rateLimited"
	ProblemRejectedIdentifier      = "urn:ietf:params:acme:error:rejectedIdentifier"
	ProblemServerInternal          = "urn:ietf:params:acme:error:serverInternal"
	ProblemUnauthorized            = "urn:ietf:params:acme:error:unauthorized"
	ProblemUnsupportedIdentifier   = "urn:ietf:params:acme:error:unsupportedIdentifier"
)

// Problem is an RFC 7807 / RFC 8555 ACME problem document.
type Problem struct {
	Status int    `json:"status"`
	Type   string `json:"type"`
	Detail string `json:"detail"`
}

func (p *Problem) Error() string { return p.Type + ": " + p.Detail }

func newProblem(status int, typ, detail string) *Problem {
	return &Problem{Status: status, Type: typ, Detail: detail}
}

// FlattenedJWS is the RFC 7515 flattened JSON serialization required by RFC 8555 section 6.2.
type FlattenedJWS struct {
	Protected string `json:"protected"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// ProtectedHeader is the parsed ACME JWS protected header.
type ProtectedHeader struct {
	Alg   string          `json:"alg"`
	Nonce string          `json:"nonce"`
	URL   string          `json:"url"`
	JWK   json.RawMessage `json:"jwk,omitempty"`
	KID   string          `json:"kid,omitempty"`
	Crit  json.RawMessage `json:"crit,omitempty"`
	B64   *bool           `json:"b64,omitempty"`
}

// ECJWK is a public EC JWK (ES256 / ES384), decoded strictly.
//
// ⚠ ONLY THESE MEMBERS ARE ACCEPTED. kty, crv, x and y are the key. kid, use,
// key_ops and alg are general JWK members (RFC 7517 section 4) that change
// nothing about an ACME account key, so they are accepted and ignored. Every
// other member is refused, including the private `d` and any certificate
// member (x5c, x5u, x5t, x5t#S256).
type ECJWK struct {
	Kty    string          `json:"kty"`
	Crv    string          `json:"crv"`
	X      string          `json:"x"`
	Y      string          `json:"y"`
	Kid    json.RawMessage `json:"kid,omitempty"`
	Use    json.RawMessage `json:"use,omitempty"`
	KeyOps json.RawMessage `json:"key_ops,omitempty"`
	Alg    json.RawMessage `json:"alg,omitempty"`
}

// decodeStrict decodes exactly one JSON object into v, refusing unknown
// fields and ANYTHING after it but whitespace (another value, `[1]`, `"x"`,
// garbage): only io.EOF may follow.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("acmed: trailing data after JSON object")
	}
	return nil
}

// ParsedJWS is the structurally validated JWS before cryptographic signature
// verification against an account public key.
type ParsedJWS struct {
	Raw        FlattenedJWS
	Header     ProtectedHeader
	Payload    []byte // decoded raw bytes (empty for POST-as-GET)
	PubKey     *ecdsa.PublicKey
	Thumbprint string // RFC 7638 JWK thumbprint (populated when JWK is present)
	RawJWK     json.RawMessage
}

// ParseFlattenedJWS strictly parses and validates a flattened JWS envelope
// per RFC 7515 and RFC 8555 section 6.2:
//   - flattened JSON only (no extra top-level fields, no general "signatures")
//   - protected header must carry alg, nonce, url
//   - alg allowlist: ES256, ES384 only (rejects none, HS*, RS*, etc.)
//   - rejects crit and any b64 != true
//   - exactly one of jwk (only when allowJWK is true) or kid (when !allowJWK)
//   - url must equal expectedURL (computed from configured base URL, never Host)
func ParseFlattenedJWS(body []byte, expectedURL string, allowJWK bool) (*ParsedJWS, error) {
	var env FlattenedJWS
	if err := decodeStrict(body, &env); err != nil {
		return nil, newProblem(400, ProblemMalformed, "malformed JWS envelope")
	}
	if env.Protected == "" || env.Signature == "" {
		return nil, newProblem(400, ProblemMalformed, "missing protected header or signature")
	}

	protBytes, err := base64.RawURLEncoding.DecodeString(env.Protected)
	if err != nil || len(protBytes) == 0 {
		return nil, newProblem(400, ProblemMalformed, "invalid base64url protected header")
	}
	if base64.RawURLEncoding.EncodeToString(protBytes) != env.Protected {
		return nil, newProblem(400, ProblemMalformed, "non-canonical protected header encoding")
	}

	var hdr ProtectedHeader
	if err := decodeStrict(protBytes, &hdr); err != nil {
		return nil, newProblem(400, ProblemMalformed, "malformed JWS protected header")
	}

	if len(hdr.Crit) > 0 && string(bytes.TrimSpace(hdr.Crit)) != "null" {
		return nil, newProblem(400, ProblemMalformed, "crit header is not supported")
	}
	if hdr.B64 != nil && !*hdr.B64 {
		return nil, newProblem(400, ProblemMalformed, "b64=false is not supported")
	}

	switch hdr.Alg {
	case "ES256", "ES384":
	default:
		return nil, newProblem(400, ProblemBadSignatureAlgorithm, "unsupported signature algorithm")
	}

	if hdr.Nonce == "" {
		return nil, newProblem(400, ProblemBadNonce, "missing Replay-Nonce in protected header")
	}
	if hdr.URL != expectedURL {
		return nil, newProblem(400, ProblemUnauthorized, "JWS url header does not match request URL")
	}

	hasJWK := len(bytes.TrimSpace(hdr.JWK)) > 0 && string(bytes.TrimSpace(hdr.JWK)) != "null"
	hasKID := hdr.KID != ""
	if hasJWK == hasKID {
		return nil, newProblem(400, ProblemMalformed, "protected header must carry exactly one of jwk or kid")
	}
	if allowJWK && !hasJWK {
		return nil, newProblem(400, ProblemMalformed, "newAccount requires jwk in protected header")
	}
	if !allowJWK && hasJWK {
		return nil, newProblem(400, ProblemMalformed, "endpoint requires kid in protected header")
	}

	var payload []byte
	if env.Payload != "" {
		payload, err = base64.RawURLEncoding.DecodeString(env.Payload)
		if err != nil {
			return nil, newProblem(400, ProblemMalformed, "invalid base64url payload")
		}
		if base64.RawURLEncoding.EncodeToString(payload) != env.Payload {
			return nil, newProblem(400, ProblemMalformed, "non-canonical payload encoding")
		}
	}

	out := &ParsedJWS{
		Raw:     env,
		Header:  hdr,
		Payload: payload,
	}
	if hasJWK {
		pub, thumb, canonicalJWK, err := ParsePublicECJWK(hdr.JWK, hdr.Alg)
		if err != nil {
			return nil, err
		}
		out.PubKey = pub
		out.Thumbprint = thumb
		out.RawJWK = canonicalJWK
	}
	return out, nil
}

// ParsePublicECJWK parses an EC JWK strictly (see ECJWK), validates curve
// consistency with alg (when alg != ""), ensures the point lies on the curve,
// and computes the RFC 7638 SHA-256 thumbprint.
func ParsePublicECJWK(raw json.RawMessage, alg string) (*ecdsa.PublicKey, string, json.RawMessage, error) {
	var k ECJWK
	if err := decodeStrict(raw, &k); err != nil {
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "malformed JWK or a member that is not allowed")
	}
	if k.Kty != "EC" {
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "only EC account keys are supported")
	}
	var (
		curve    elliptic.Curve
		ecdhCrv  ecdh.Curve
		coordLen int
	)
	switch k.Crv {
	case "P-256":
		if alg != "" && alg != "ES256" {
			return nil, "", nil, newProblem(400, ProblemBadSignatureAlgorithm, "alg does not match P-256 JWK")
		}
		curve = elliptic.P256()
		ecdhCrv = ecdh.P256()
		coordLen = 32
	case "P-384":
		if alg != "" && alg != "ES384" {
			return nil, "", nil, newProblem(400, ProblemBadSignatureAlgorithm, "alg does not match P-384 JWK")
		}
		curve = elliptic.P384()
		ecdhCrv = ecdh.P384()
		coordLen = 48
	default:
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "unsupported EC curve")
	}
	xb, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil || len(xb) != coordLen {
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "invalid EC JWK x coordinate")
	}
	yb, err := base64.RawURLEncoding.DecodeString(k.Y)
	if err != nil || len(yb) != coordLen {
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "invalid EC JWK y coordinate")
	}
	// Validate the uncompressed point lies on the curve via crypto/ecdh.
	uncompressed := make([]byte, 1+2*coordLen)
	uncompressed[0] = 0x04
	copy(uncompressed[1:1+coordLen], xb)
	copy(uncompressed[1+coordLen:], yb)
	if _, err := ecdhCrv.NewPublicKey(uncompressed); err != nil {
		return nil, "", nil, newProblem(400, ProblemBadPublicKey, "EC JWK point is not on curve")
	}

	pub := &ecdsa.PublicKey{
		Curve: curve,
		X:     new(big.Int).SetBytes(xb),
		Y:     new(big.Int).SetBytes(yb),
	}

	// RFC 7638 section 3.2: canonical lexicographical JSON with crv, kty, x, y.
	canonX := base64.RawURLEncoding.EncodeToString(xb)
	canonY := base64.RawURLEncoding.EncodeToString(yb)
	canon := fmt.Sprintf(`{"crv":%q,"kty":"EC","x":%q,"y":%q}`, k.Crv, canonX, canonY)
	sum := sha256.Sum256([]byte(canon))
	thumb := base64.RawURLEncoding.EncodeToString(sum[:])
	return pub, thumb, json.RawMessage(canon), nil
}

// VerifySignature verifies the ECDSA signature over `protected.payload` using
// pub, including step-ca's macOS ACME client leading-zero ECDSA signature
// patch (where macOS omits 1 or 2 leading 0x00 bytes from R and/or S).
func (p *ParsedJWS) VerifySignature(pub *ecdsa.PublicKey) error {
	if pub == nil {
		return newProblem(400, ProblemMalformed, "missing account public key")
	}
	var (
		hashAlg  crypto.Hash
		coordLen int
	)
	switch p.Header.Alg {
	case "ES256":
		if pub.Curve != elliptic.P256() {
			return newProblem(400, ProblemBadSignatureAlgorithm, "account key curve does not match ES256")
		}
		hashAlg = crypto.SHA256
		coordLen = 32
	case "ES384":
		if pub.Curve != elliptic.P384() {
			return newProblem(400, ProblemBadSignatureAlgorithm, "account key curve does not match ES384")
		}
		hashAlg = crypto.SHA384
		coordLen = 48
	default:
		return newProblem(400, ProblemBadSignatureAlgorithm, "unsupported signature algorithm")
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(p.Raw.Signature)
	if err != nil {
		return newProblem(400, ProblemMalformed, "invalid base64url signature")
	}

	signingInput := p.Raw.Protected + "." + p.Raw.Payload
	h := hashAlg.New()
	h.Write([]byte(signingInput))
	digest := h.Sum(nil)

	fullLen := 2 * coordLen
	if len(sigBytes) == fullLen {
		if verifyRawECDSA(pub, digest, sigBytes, coordLen) {
			return nil
		}
		return newProblem(400, ProblemMalformed, "invalid JWS signature")
	}

	// macOS com.apple.security.acme quirk (see step-ca acme/api/middleware.go):
	// occasionally strips leading zero byte(s) from R and/or S in raw ECDSA JWS
	// signatures, yielding fullLen-1 or fullLen-2 bytes. Try exact leading-zero
	// restorations only for those lengths.
	if len(sigBytes) == fullLen-1 {
		// Case 1: R is missing 1 leading zero byte (len(R)=coordLen-1, len(S)=coordLen).
		cand1 := make([]byte, fullLen)
		copy(cand1[1:coordLen], sigBytes[:coordLen-1])
		copy(cand1[coordLen:], sigBytes[coordLen-1:])
		if verifyRawECDSA(pub, digest, cand1, coordLen) {
			return nil
		}
		// Case 2: S is missing 1 leading zero byte (len(R)=coordLen, len(S)=coordLen-1).
		cand2 := make([]byte, fullLen)
		copy(cand2[:coordLen], sigBytes[:coordLen])
		copy(cand2[coordLen+1:], sigBytes[coordLen:])
		if verifyRawECDSA(pub, digest, cand2, coordLen) {
			return nil
		}
	} else if len(sigBytes) == fullLen-2 {
		// Case 1: both R and S missing 1 leading zero byte.
		cand1 := make([]byte, fullLen)
		copy(cand1[1:coordLen], sigBytes[:coordLen-1])
		copy(cand1[coordLen+1:], sigBytes[coordLen-1:])
		if verifyRawECDSA(pub, digest, cand1, coordLen) {
			return nil
		}
		// Case 2: R missing 2 leading zero bytes.
		cand2 := make([]byte, fullLen)
		copy(cand2[2:coordLen], sigBytes[:coordLen-2])
		copy(cand2[coordLen:], sigBytes[coordLen-2:])
		if verifyRawECDSA(pub, digest, cand2, coordLen) {
			return nil
		}
		// Case 3: S missing 2 leading zero bytes.
		cand3 := make([]byte, fullLen)
		copy(cand3[:coordLen], sigBytes[:coordLen])
		copy(cand3[coordLen+2:], sigBytes[coordLen:])
		if verifyRawECDSA(pub, digest, cand3, coordLen) {
			return nil
		}
	}

	return newProblem(400, ProblemMalformed, "invalid JWS signature")
}

func verifyRawECDSA(pub *ecdsa.PublicKey, digest, raw []byte, coordLen int) bool {
	if len(raw) != 2*coordLen {
		return false
	}
	r := new(big.Int).SetBytes(raw[:coordLen])
	s := new(big.Int).SetBytes(raw[coordLen:])
	if r.Sign() <= 0 || s.Sign() <= 0 {
		return false
	}
	return ecdsa.Verify(pub, digest, r, s)
}

// SignFlattenedJWS creates a flattened ECDSA JWS (used by tests and enrollload).
func SignFlattenedJWS(key *ecdsa.PrivateKey, hdr ProtectedHeader, payload []byte) ([]byte, error) {
	var (
		hashAlg  crypto.Hash
		coordLen int
	)
	switch key.Curve {
	case elliptic.P256():
		hdr.Alg = "ES256"
		hashAlg = crypto.SHA256
		coordLen = 32
	case elliptic.P384():
		hdr.Alg = "ES384"
		hashAlg = crypto.SHA384
		coordLen = 48
	default:
		return nil, errors.New("acmed: unsupported EC key curve")
	}
	protJSON, err := json.Marshal(hdr)
	if err != nil {
		return nil, err
	}
	protB64 := base64.RawURLEncoding.EncodeToString(protJSON)
	payB64 := ""
	if len(payload) > 0 {
		payB64 = base64.RawURLEncoding.EncodeToString(payload)
	}
	h := hashAlg.New()
	h.Write([]byte(protB64 + "." + payB64))
	r, s, err := ecdsa.Sign(cryptoRandReader(), key, h.Sum(nil))
	if err != nil {
		return nil, err
	}
	sig := make([]byte, 2*coordLen)
	r.FillBytes(sig[:coordLen])
	s.FillBytes(sig[coordLen:])
	return json.Marshal(FlattenedJWS{
		Protected: protB64,
		Payload:   payB64,
		Signature: base64.RawURLEncoding.EncodeToString(sig),
	})
}

// EncodePublicECJWK serializes an ECDSA public key as a canonical EC JWK.
func EncodePublicECJWK(pub *ecdsa.PublicKey) (json.RawMessage, error) {
	var (
		crv      string
		coordLen int
	)
	switch pub.Curve {
	case elliptic.P256():
		crv = "P-256"
		coordLen = 32
	case elliptic.P384():
		crv = "P-384"
		coordLen = 48
	default:
		return nil, errors.New("acmed: unsupported EC curve")
	}
	xb := make([]byte, coordLen)
	yb := make([]byte, coordLen)
	pub.X.FillBytes(xb)
	pub.Y.FillBytes(yb)
	return json.RawMessage(fmt.Sprintf(`{"crv":%q,"kty":"EC","x":%q,"y":%q}`,
		crv,
		base64.RawURLEncoding.EncodeToString(xb),
		base64.RawURLEncoding.EncodeToString(yb),
	)), nil
}
