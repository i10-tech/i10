package directory

import "strings"

// EqualDN reports whether two DNs name the same entry.
//
// This is a deliberately narrow comparison: case-insensitive, whitespace
// trimmed around commas, and nothing else. A full RFC 4514 normalisation would
// have to handle escaping, hex-encoded values, and per-attribute matching
// rules — and every DN authd compares is one it built itself, so the extra
// surface would be all risk and no benefit.
func EqualDN(a, b string) bool {
	return strings.EqualFold(canonDN(a), canonDN(b))
}

// UnderDN reports whether dn is at or beneath base. An empty base matches
// everything, which is what a root-DSE-style search expects.
func UnderDN(dn, base string) bool {
	if strings.TrimSpace(base) == "" {
		return true
	}
	c, b := canonDN(dn), canonDN(base)
	return strings.EqualFold(c, b) ||
		strings.HasSuffix(strings.ToLower(c), ","+strings.ToLower(b))
}

// IsChildOfDN reports whether dn is exactly one level below base, which is what
// the singleLevel search scope means.
func IsChildOfDN(dn, base string) bool {
	if !UnderDN(dn, base) || EqualDN(dn, base) {
		return false
	}
	rest := canonDN(dn)[:len(canonDN(dn))-len(canonDN(base))-1]
	return !strings.Contains(rest, ",")
}

// UIDFromDN pulls the uid value out of a DN of the form
// "uid=<value>,ou=people,<base>", returning "" if the DN is not that shape.
func UIDFromDN(dn, baseDN string) string {
	if !UnderDN(dn, "ou=people,"+baseDN) {
		return ""
	}
	first, _, found := strings.Cut(canonDN(dn), ",")
	if !found {
		return ""
	}
	attr, value, ok := strings.Cut(first, "=")
	if !ok || !strings.EqualFold(strings.TrimSpace(attr), "uid") {
		return ""
	}
	return unescapeRDNValue(strings.TrimSpace(value))
}

// canonDN trims whitespace around each RDN separator so that
// "uid=a, ou=people, dc=i10" and "uid=a,ou=people,dc=i10" compare equal.
func canonDN(dn string) string {
	parts := splitRDNs(dn)
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return strings.Join(parts, ",")
}

// splitRDNs splits on commas that are not escaped.
func splitRDNs(dn string) []string {
	var parts []string
	var cur strings.Builder
	escaped := false
	for _, r := range dn {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\':
			cur.WriteRune(r)
			escaped = true
		case r == ',':
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	parts = append(parts, cur.String())
	return parts
}

func unescapeRDNValue(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] == '\\' && i+1 < len(v) {
			i++
			b.WriteByte(v[i])
			continue
		}
		b.WriteByte(v[i])
	}
	return b.String()
}
