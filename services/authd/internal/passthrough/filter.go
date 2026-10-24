package passthrough

import (
	"strings"

	ldap "github.com/go-ldap/ldap/v3"
)

// FilterPlaceholder is where the user's address goes in the filter template.
const FilterPlaceholder = "{email}"

// RenderFilter substitutes the address, RFC 4515 escaped.
//
// ⚠ EVERY ADDRESS THAT REACHES A FILTER GOES THROUGH ldap.EscapeFilter. An
// address is not trusted text: `*` makes a wildcard and `)` ends the term and
// starts one of the attacker's. strings.ReplaceAll, not a regexp or a
// template, so nothing in the address is read as a pattern.
func RenderFilter(template, address string) string {
	return strings.ReplaceAll(template, FilterPlaceholder, ldap.EscapeFilter(address))
}
