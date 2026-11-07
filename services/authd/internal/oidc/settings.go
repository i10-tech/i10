package oidc

import (
	"errors"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
)

// Settings are one connection's OIDC password-lane settings, as the API answers
// them.
type Settings struct {
	// Preset is one of the Preset* names.
	Preset string `json:"preset"`
	// Issuer is the provider's issuer URL, https and on the DNS name the owner gave.
	Issuer string `json:"issuer"`
	// TokenEndpoint is where the password goes. The API read it from the issuer's
	// discovery document when an owner saved the connection (apps/api/src/identity/
	// oidc-mail.ts); it is NOT discovered again here.
	TokenEndpoint string `json:"tokenEndpoint"`
	// ClientID is a public client (no secret) with the password grant allowed.
	ClientID string `json:"clientId"`
	// Extra are the preset's optional, non-secret form fields (presets.go).
	Extra map[string]string `json:"extra,omitempty"`
}

var (
	hostPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	// pathPattern is zero to eight plain segments of up to 64 characters (RE2 caps
	// a nested repeat at 1000). No empty segment, so no trailing slash and no `//`;
	// no `%`, so nothing is decoded differently by two readers.
	pathPattern = regexp.MustCompile(`^(?:/[A-Za-z0-9._~-]{1,64}){0,8}$`)
	// extraValue is a bounded printable string. A space is allowed inside it (a
	// scope is "openid email"), never at either end, and no control character is.
	extraValue = regexp.MustCompile(`^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$`)
)

// Validate re-checks what the API already validated (apps/api/src/identity/
// oidc-mail.ts must agree). Cheap, and the thing that turns a corrupt or hostile
// answer into a refusal rather than a request.
//
// ⚠ THE STRING CHECK IS NOT THE EGRESS GUARD. It refuses what is obviously
// wrong; the guard (internal/egress) resolves the name and vets every address at
// every connection.
//
// ⚠ THE TOKEN ENDPOINT MUST BE ON THE ISSUER'S OWN HOST, exactly: same name, and
// both on 443. It is where every managed member's mail password is POSTed, and a
// discovery document is the provider's own word, so one that names another host
// is a provider (or an attacker who controls its document) choosing where the
// owner's approved issuer sends passwords. Exact host rather than "the same
// registrable domain": acme.okta.com and evil.okta.com share okta.com, and no
// provider in presets.go splits its issuer and token endpoint across hosts.
func (s Settings) Validate() error {
	p, ok := presets[s.Preset]
	if !ok {
		return errors.New("preset is not one this build knows")
	}
	issuer, err := parseHTTPS(s.Issuer, "issuer")
	if err != nil {
		return err
	}
	if p.issuerPath != nil && !p.issuerPath.MatchString(issuer.Path) {
		return errors.New("issuer path is not one this preset uses")
	}
	token, err := parseHTTPS(s.TokenEndpoint, "token endpoint")
	if err != nil {
		return err
	}
	switch {
	case token.Path == "":
		return errors.New("token endpoint has no path")
	case token.Host != issuer.Host:
		return errors.New("token endpoint is not on the issuer's host")
	case !p.clientID.MatchString(s.ClientID):
		return errors.New("client id is not one this preset uses")
	}
	if len(s.Extra) > len(p.extras) {
		return errors.New("more extra fields than the preset takes")
	}
	for k, v := range s.Extra {
		if !contains(p.extras, k) || !extraValue.MatchString(v) {
			return errors.New("extra field is not one this preset takes")
		}
	}
	return nil
}

// parseHTTPS reads a URL that must be a host and a plain path on 443.
func parseHTTPS(raw, what string) (*url.URL, error) {
	u, err := url.Parse(raw)
	switch {
	case err != nil || u.Scheme != "https" || u.Opaque != "":
		return nil, errors.New(what + " is not an https url")
	case u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "":
		return nil, errors.New(what + " has more than a host and a path")
	case u.Port() != "" || strings.Contains(u.Host, ":"):
		// 443 only. A port, or an IPv6 literal, is not a thing to connect to.
		return nil, errors.New(what + " has a port")
	case !hostPattern.MatchString(u.Host) || isAddress(u.Host) || numericTLD(u.Host):
		return nil, errors.New(what + " host is not a DNS name")
	case !pathPattern.MatchString(u.Path) || hasDotSegment(u.Path):
		return nil, errors.New(what + " path is not plain segments")
	}
	return u, nil
}

func hasDotSegment(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if seg != "" && strings.Trim(seg, ".") == "" {
			return true
		}
	}
	return false
}

func isAddress(host string) bool {
	_, err := netip.ParseAddr(host)
	return err == nil
}

// numericTLD catches 127.1.2.3-shaped names the pattern lets through.
func numericTLD(host string) bool {
	label := host[strings.LastIndex(host, ".")+1:]
	return strings.Trim(label, "0123456789") == ""
}
