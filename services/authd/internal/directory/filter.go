package directory

import (
	"strings"

	"github.com/vjeantet/goldap/message"
)

// Match evaluates an LDAP filter against an entry.
//
// authd implements the subset RFC 4511 §4.5.1 defines that Stalwart's default
// filters actually use: and, or, not, equalityMatch, present, substrings.
// Anything else — approxMatch, greaterOrEqual, lessOrEqual, extensibleMatch —
// evaluates FALSE rather than erroring.
//
// False, not an error, is the deliberate choice. A search is a set membership
// question; an unsupported term simply matches nothing, and the surrounding
// and/or still resolves. Failing the whole search instead would turn a filter
// we merely don't understand into a delivery outage.
//
// All comparisons are case-insensitive. The attributes authd serves are
// caseIgnoreMatch (cn, description) or caseIgnoreIA5Match (mail, mailAlias),
// and no attribute here uses a case-sensitive matching rule.
func Match(f message.Filter, e *Entry) bool {
	switch v := f.(type) {
	case message.FilterAnd:
		// An empty AND is the LDAP "absolute true" filter.
		for _, sub := range v {
			if !Match(sub, e) {
				return false
			}
		}
		return true

	case message.FilterOr:
		// An empty OR is "absolute false".
		for _, sub := range v {
			if Match(sub, e) {
				return true
			}
		}
		return false

	case message.FilterNot:
		return !Match(v.Filter, e)

	case message.FilterPresent:
		return e.Has(string(v))

	case message.FilterEqualityMatch:
		want := string(v.AssertionValue())
		for _, got := range e.Get(string(v.AttributeDesc())) {
			if strings.EqualFold(got, want) {
				return true
			}
		}
		return false

	case message.FilterSubstrings:
		for _, got := range e.Get(string(v.Type_())) {
			if matchSubstrings(v.Substrings(), got) {
				return true
			}
		}
		return false

	default:
		return false
	}
}

// matchSubstrings implements initial/any/final matching against one value.
func matchSubstrings(parts []message.Substring, value string) bool {
	hay := strings.ToLower(value)
	for _, part := range parts {
		switch p := part.(type) {
		case message.SubstringInitial:
			needle := strings.ToLower(string(p))
			if !strings.HasPrefix(hay, needle) {
				return false
			}
			hay = hay[len(needle):]

		case message.SubstringAny:
			needle := strings.ToLower(string(p))
			idx := strings.Index(hay, needle)
			if idx < 0 {
				return false
			}
			// Consume through the match so successive `any` parts must appear
			// in order rather than all matching the same position.
			hay = hay[idx+len(needle):]

		case message.SubstringFinal:
			needle := strings.ToLower(string(p))
			if !strings.HasSuffix(hay, needle) {
				return false
			}
			hay = ""

		default:
			return false
		}
	}
	return true
}

// EqualityValues collects every value the filter tests for equality against any
// of the named attributes, anywhere in the tree.
//
// This is how a search becomes a bounded database query instead of a table
// scan. Stalwart's default filterMailbox is a nest of ORs across mail and
// mailAlias for the same address; pulling those values out lets us fetch the
// handful of candidate rows and then evaluate the real filter against them.
//
// It intentionally looks inside NOT as well. A value under a negation is still
// a value worth fetching — the candidate set only has to be a superset, since
// Match does the authoritative work afterwards.
func EqualityValues(f message.Filter, attrs ...string) []string {
	want := make(map[string]bool, len(attrs))
	for _, a := range attrs {
		want[strings.ToLower(a)] = true
	}
	seen := map[string]bool{}
	var out []string

	var walk func(message.Filter)
	walk = func(f message.Filter) {
		switch v := f.(type) {
		case message.FilterAnd:
			for _, sub := range v {
				walk(sub)
			}
		case message.FilterOr:
			for _, sub := range v {
				walk(sub)
			}
		case message.FilterNot:
			walk(v.Filter)
		case message.FilterEqualityMatch:
			if want[strings.ToLower(string(v.AttributeDesc()))] {
				val := string(v.AssertionValue())
				if key := strings.ToLower(val); val != "" && !seen[key] {
					seen[key] = true
					out = append(out, val)
				}
			}
		}
	}
	walk(f)
	return out
}
