package mailfront

import (
	"bytes"
	"encoding/base64"
	"strings"
)

// The SASL mechanisms the front can attribute to an account. Every other one is
// refused before it reaches Stalwart and is taken out of what Stalwart
// advertises (see filterMechanisms).
//
// ⚠ OAUTHBEARER AND XOAUTH2 ARE REFUSED, NOT ATTRIBUTED. Their `user=` / `a=` field
// is the client's claim, and the token is what Stalwart checks: trusting the
// claim would attribute a session to whoever the client names. No i10 mail
// client uses them (Stalwart's OAuth endpoints are not published, and the OAuth
// lane is not being built), so refusing them breaks nothing that works today.
const (
	mechPlain    = "PLAIN"
	mechLogin    = "LOGIN"
	mechExternal = "EXTERNAL"
)

// saslResult is what a client's SASL response said about who is signing in.
type saslResult struct {
	// authcid is the identity whose password is checked, as typed.
	authcid string
	// ok is false when the response could not be read.
	ok bool
	// foreignAuthzid is true when the client asked to act as someone other than
	// the identity it authenticates as (PLAIN's authzid). The front cancels that
	// exchange: an i10 mail client never sends it, and a session whose account
	// is not the one whose password was checked cannot be attributed.
	foreignAuthzid bool
}

// decodeSASL decodes one base64 client response. "=" is the empty response
// (RFC 4954, RFC 4959). Rejects embedded CR and LF, which Go's base64 decoder
// would silently skip.
func decodeSASL(s string) ([]byte, bool) {
	if strings.ContainsAny(s, "\r\n") {
		return nil, false
	}
	s = strings.TrimSpace(s)
	if s == "=" {
		return nil, true
	}
	b, err := base64.StdEncoding.DecodeString(s)
	return b, err == nil
}

// parsePlain reads a PLAIN response: authzid NUL authcid NUL password.
func parsePlain(b64 string) saslResult {
	raw, ok := decodeSASL(b64)
	if !ok {
		return saslResult{}
	}
	defer clear(raw)
	parts := bytes.SplitN(raw, []byte{0}, 3)
	if len(parts) != 3 || len(parts[1]) == 0 {
		return saslResult{}
	}
	authzid, authcid := string(parts[0]), string(parts[1])
	return saslResult{
		authcid:        authcid,
		ok:             true,
		foreignAuthzid: authzid != "" && !strings.EqualFold(normaliseLogin(authzid), normaliseLogin(authcid)),
	}
}

// decodePlain decodes a PLAIN response into its three parts for the front-owned
// SMTP AUTH exchange, clearing the temporary buffer.
func decodePlain(b64 string) (authzid, authcid, password string, ok, foreign bool) {
	raw, decOK := decodeSASL(b64)
	if !decOK {
		return "", "", "", false, false
	}
	defer clear(raw)
	parts := bytes.SplitN(raw, []byte{0}, 3)
	if len(parts) != 3 || len(parts[1]) == 0 {
		return "", "", "", false, false
	}
	authzid, authcid, password = string(parts[0]), string(parts[1]), string(parts[2])
	foreign = authzid != "" && !strings.EqualFold(normaliseLogin(authzid), normaliseLogin(authcid))
	return authzid, authcid, password, true, foreign
}

// encodePlain builds a freshly base64-encoded PLAIN response, clearing its
// working buffer.
func encodePlain(authzid, authcid, password string) string {
	out := make([]byte, 0, len(authzid)+len(authcid)+len(password)+2)
	out = append(append(append(append(out, authzid...), 0), authcid...), 0)
	out = append(out, password...)
	defer clear(out)
	return base64.StdEncoding.EncodeToString(out)
}

// parseExternal decodes an AUTHENTICATE EXTERNAL response (RFC 4422 appendix A,
// RFC 4959). As an initial response, "=" is the empty authorization identity;
// as a continuation line, an empty line is the empty authorization identity.
// A NUL byte in the authorization identity is refused (revision 5).
func parseExternal(resp string, isInitial bool) (authzid string, ok bool) {
	if strings.ContainsAny(resp, "\r\n") {
		return "", false
	}
	if isInitial {
		if resp == "=" {
			return "", true
		}
		if resp == "" {
			return "", false
		}
	} else if resp == "" {
		return "", true
	}
	raw, err := base64.StdEncoding.DecodeString(resp)
	if err != nil {
		return "", false
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return "", false
	}
	return string(raw), true
}

// parseLoginUser reads the LOGIN mechanism's first response, the user name.
func parseLoginUser(b64 string) saslResult {
	raw, ok := decodeSASL(b64)
	if !ok || len(raw) == 0 || bytes.IndexByte(raw, 0) >= 0 {
		return saslResult{}
	}
	return saslResult{authcid: string(raw), ok: true}
}

// normaliseLogin is how a login is compared: trimmed and lower-cased, as the
// projection normalises every address it looks up.
func normaliseLogin(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// supportedMech reports whether the front can attribute this mechanism.
func supportedMech(m string, allowLogin bool) bool {
	switch strings.ToUpper(m) {
	case mechPlain:
		return true
	case mechLogin:
		return allowLogin
	}
	return false
}

// filterMechanisms keeps only the mechanisms the front can attribute, in order.
func filterMechanisms(mechs []string, allowLogin bool) []string {
	out := mechs[:0:0]
	for _, m := range mechs {
		if supportedMech(m, allowLogin) {
			out = append(out, m)
		}
	}
	return out
}

// plainWithToken re-encodes a PLAIN response with its password passed through
// token. The authzid and authcid go back as they came. The password is never
// returned or logged; the decoded bytes are cleared.
func plainWithToken(b64 string, token func(string) (string, error)) (string, error) {
	raw, ok := decodeSASL(b64)
	if !ok {
		return "", errAmbiguous
	}
	defer clear(raw)
	parts := bytes.SplitN(raw, []byte{0}, 3)
	if len(parts) != 3 {
		return "", errAmbiguous
	}
	pw, err := token(string(parts[2]))
	if err != nil {
		return "", err
	}
	return encodePlain(string(parts[0]), string(parts[1]), pw), nil
}
