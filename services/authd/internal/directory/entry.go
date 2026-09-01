// Package directory models the LDAP view that Stalwart sees.
//
// authd stores nothing of its own: an Entry is a rendering of a row in the
// Clerk projection. Passwords never appear here. Stalwart is configured with
// bindAuthentication=true, which means it never reads a password attribute —
// it binds as the user and trusts the result — so there is deliberately no
// userPassword attribute anywhere in this package.
package directory

import (
	"fmt"
	"strings"
	"time"
)

// Attribute names authd understands. These match Stalwart's Directory object
// defaults so the deployed config stays close to the documented one.
const (
	AttrObjectClass   = "objectClass"
	AttrMail          = "mail"
	AttrMailAlias     = "mailAlias"
	AttrUID           = "uid"
	AttrCN            = "cn"
	AttrSN            = "sn"
	AttrDescription   = "description"
	AttrMemberOf      = "memberOf"
	AttrMember        = "member"
	AttrPwdChangeTime = "pwdChangeTime"
)

const (
	ClassTop           = "top"
	ClassInetOrgPerson = "inetOrgPerson"
	ClassGroupOfNames  = "groupOfNames"
)

// Entry is one LDAP entry: a DN plus multi-valued attributes.
//
// Attribute names are matched case-insensitively, because LDAP attribute
// descriptions are case-insensitive and clients are inconsistent about it —
// Stalwart's default filters say "objectClass" while plenty of tooling sends
// "objectclass".
type Entry struct {
	DN    string
	attrs map[string][]string // keyed by lowercased name
	order []string            // canonical names, insertion-ordered, for stable output
}

func NewEntry(dn string) *Entry {
	return &Entry{DN: dn, attrs: map[string][]string{}}
}

// Set replaces an attribute. Empty values are dropped, so a NULL column in the
// projection yields an absent attribute rather than an attribute with an empty
// string — those are different things to a presence filter.
func (e *Entry) Set(name string, values ...string) *Entry {
	kept := values[:0:0]
	for _, v := range values {
		if v != "" {
			kept = append(kept, v)
		}
	}
	key := strings.ToLower(name)
	if len(kept) == 0 {
		delete(e.attrs, key)
		return e
	}
	if _, seen := e.attrs[key]; !seen {
		e.order = append(e.order, name)
	}
	e.attrs[key] = kept
	return e
}

func (e *Entry) Get(name string) []string { return e.attrs[strings.ToLower(name)] }

func (e *Entry) Has(name string) bool { return len(e.Get(name)) > 0 }

// Names returns the canonical attribute names in insertion order.
func (e *Entry) Names() []string { return append([]string(nil), e.order...) }

// Select returns the attribute names to emit for a requested selection.
//
// An empty selection, or "*", means all user attributes. LDAP also defines
// "1.1" as "no attributes at all", which some clients use for existence checks;
// returning every attribute for that request leaks more than was asked for.
func (e *Entry) Select(requested []string) []string {
	if len(requested) == 0 {
		return e.Names()
	}
	var wantAll bool
	want := map[string]bool{}
	for _, r := range requested {
		switch r {
		case "*":
			wantAll = true
		case "1.1":
			return nil
		default:
			want[strings.ToLower(r)] = true
		}
	}
	if wantAll {
		return e.Names()
	}
	var out []string
	for _, n := range e.order {
		if want[strings.ToLower(n)] {
			out = append(out, n)
		}
	}
	return out
}

// UserDN builds the DN for a mailbox account.
func UserDN(clerkUserID, baseDN string) string {
	return fmt.Sprintf("uid=%s,ou=people,%s", escapeRDNValue(clerkUserID), baseDN)
}

// GroupDN builds the DN for a group.
func GroupDN(name, baseDN string) string {
	return fmt.Sprintf("cn=%s,ou=groups,%s", escapeRDNValue(name), baseDN)
}

// escapeRDNValue applies RFC 4514 §2.4 escaping.
//
// Clerk user ids are already restricted to a safe alphabet, but group names
// come from our own data and DN construction that trusts its input is how
// injection bugs get written.
func escapeRDNValue(v string) string {
	var b strings.Builder
	for i, r := range v {
		switch {
		case r == '"' || r == '+' || r == ',' || r == ';' || r == '<' || r == '>' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '#' && i == 0:
			b.WriteString(`\#`)
		case r == ' ' && (i == 0 || i == len(v)-1):
			b.WriteString(`\ `)
		case r == 0:
			b.WriteString(`\00`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// GeneralizedTime renders a timestamp in the form LDAP uses (RFC 4517 §3.3.13).
//
// This is what Stalwart reads as attrSecretChanged (default pwdChangeTime) to
// decide when to invalidate cached OAuth tokens. A Clerk password change moves
// this value, and Stalwart drops the tokens on its next comparison.
func GeneralizedTime(t time.Time) string {
	return t.UTC().Format("20060102150405Z")
}
