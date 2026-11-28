package acmed

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// Stateless ACME accounts.
//
// ⚠ AN ACCOUNT IS ITS KEY, AND newAccount WRITES NOTHING. Anyone can generate
// a key, so a stored account would let an unauthenticated flood fill the 128 MB
// noeviction i10-enroll-redis that every iPhone enrollment needs. The account
// URL (the JWS `kid`) instead names the key under a MAC:
//
//	<base>/acct/<base64url(canonical JWK)>.<base64url(kid(1) || HMAC-SHA256(K[kid], label || kid || canonical JWK)[:16])>
//
// keyed by the ACMED_NONCE_KEYS ring under its own label. <base> is the
// request's path token base (<prefix>/d/<token>), so an account URL is valid
// only under the token it was issued under, and nothing reaches the account
// code without a verified path token. A `kid` request is verified with the key
// its URL names, once the MAC checks. Since an account is stored nowhere, the
// only ACME state in Redis is what a verified path token's state changes
// write: at most (devices sealed in the last 10 minutes) x MaxOrdersPerDevice
// orders plus their spent nonces (handler.go). Everywhere else
// (who owns an order, an authorization, a certificate) the account is the
// key's RFC 7638 thumbprint. Its object is always status valid, an empty
// contact and the `orders` URL <account URL>/orders, which RFC 8555 section
// 7.1.2 makes required and the macOS client refuses an account without. The
// list it answers is always empty: nothing indexes orders by account.
const (
	accountLabel        = "i10/acme-account/v1\x00"
	accountMACLen       = 16
	accountPath         = "/acct/"
	accountOrdersSuffix = "/orders"
	maxAccountURLLen    = 640
)

// account is a verified account URL: the key it names and that key's
// thumbprint.
type account struct {
	URL        string
	Thumbprint string
	Pub        *ecdsa.PublicKey
}

func accountMAC(secret []byte, kid byte, canonicalJWK []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(accountLabel))
	m.Write([]byte{kid})
	m.Write(canonicalJWK)
	return m.Sum(nil)[:accountMACLen]
}

// accountURL is the account URL for a canonical JWK (ParsePublicECJWK's),
// under the request's path token.
func (h *Handler) accountURL(rt route, canonicalJWK []byte) (string, error) {
	kid, secret, err := h.deps.NonceKeys.SigningKey()
	if err != nil {
		return "", err
	}
	tag := append([]byte{kid}, accountMAC(secret, kid, canonicalJWK)...)
	return rt.url(accountPath + base64.RawURLEncoding.EncodeToString(canonicalJWK) +
		"." + base64.RawURLEncoding.EncodeToString(tag)), nil
}

// parseAccountURL verifies an account URL and returns the key it names, or nil
// when the URL is not one acmed issued: another prefix, malformed or
// non-canonical base64url, an unknown key id, a MAC that does not verify, or a
// JWK that is not exactly the canonical form of a valid key, or a URL under
// another path token.
func (h *Handler) parseAccountURL(rt route, u string) *account {
	if len(u) > maxAccountURLLen {
		return nil
	}
	rest, ok := strings.CutPrefix(u, rt.url(accountPath))
	if !ok {
		return nil
	}
	jwkPart, tagPart, ok := strings.Cut(rest, ".")
	if !ok {
		return nil
	}
	jwk, ok := decodeCanonicalB64(jwkPart)
	if !ok {
		return nil
	}
	tag, ok := decodeCanonicalB64(tagPart)
	if !ok || len(tag) != 1+accountMACLen {
		return nil
	}
	secret, ok := h.deps.NonceKeys.Secret(tag[0])
	if !ok || !hmac.Equal(tag[1:], accountMAC(secret, tag[0], jwk)) {
		return nil
	}
	pub, thumb, canon, err := ParsePublicECJWK(jwk, "")
	if err != nil || !bytes.Equal(canon, jwk) {
		return nil
	}
	return &account{URL: u, Thumbprint: thumb, Pub: pub}
}

func decodeCanonicalB64(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) == 0 || base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, false
	}
	return b, true
}
