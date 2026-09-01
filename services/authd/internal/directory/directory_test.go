package directory

import (
	"testing"
	"time"
)

func TestUIDFromDN(t *testing.T) {
	const base = "dc=i10,dc=tech"
	tests := []struct {
		dn   string
		want string
	}{
		{"uid=user_abc,ou=people,dc=i10,dc=tech", "user_abc"},
		{"UID=user_abc,OU=People,DC=i10,DC=tech", "user_abc"},    // attribute names are case-insensitive
		{"uid=user_abc, ou=people, dc=i10, dc=tech", "user_abc"}, // whitespace after commas is legal
		{"cn=support,ou=groups,dc=i10,dc=tech", ""},              // a group, not a person
		{"uid=user_abc,ou=people,dc=evil,dc=example", ""},        // outside our base
		{"cn=stalwart,ou=services,dc=i10,dc=tech", ""},           // the service account
		{"", ""},
		{"uid=user_abc", ""}, // no base at all
	}
	for _, tc := range tests {
		if got := UIDFromDN(tc.dn, base); got != tc.want {
			t.Errorf("UIDFromDN(%q) = %q, want %q", tc.dn, got, tc.want)
		}
	}
}

// A DN built from a group name containing DN metacharacters must survive a
// round trip. DN construction that trusts its input is how injection gets in.
func TestGroupDNEscapesMetacharacters(t *testing.T) {
	dn := GroupDN("sales,ou=people", "dc=i10,dc=tech")
	if want := `cn=sales\,ou\=people,ou=groups,dc=i10,dc=tech`; dn != want {
		// The '=' inside a value needs no escape per RFC 4514, only ','.
		if dn != `cn=sales\,ou=people,ou=groups,dc=i10,dc=tech` {
			t.Errorf("GroupDN = %q", dn)
		}
	}
	// Whatever the escaping, the injected comma must not create a new RDN.
	if got := len(splitRDNs(dn)); got != 4 {
		t.Errorf("escaped DN split into %d RDNs, want 4: %q", got, dn)
	}
}

func TestUnderAndChildOfDN(t *testing.T) {
	const base = "dc=i10,dc=tech"
	if !UnderDN("uid=a,ou=people,dc=i10,dc=tech", base) {
		t.Error("subtree member not detected")
	}
	if !UnderDN(base, base) {
		t.Error("base is not under itself")
	}
	if UnderDN("uid=a,ou=people,dc=evil,dc=example", base) {
		t.Error("foreign DN reported as under base")
	}
	// A suffix match on the raw string would wrongly accept this.
	if UnderDN("dc=noti10,dc=tech", "dc=i10,dc=tech") {
		t.Error("suffix collision accepted")
	}
	if !IsChildOfDN("ou=people,dc=i10,dc=tech", base) {
		t.Error("direct child not detected")
	}
	if IsChildOfDN("uid=a,ou=people,dc=i10,dc=tech", base) {
		t.Error("grandchild reported as direct child")
	}
}

func TestEntrySetDropsEmptyValues(t *testing.T) {
	e := NewEntry("uid=a,dc=i10,dc=tech")
	e.Set(AttrDescription, "") // a NULL column in the projection
	if e.Has(AttrDescription) {
		t.Error("empty value produced a present attribute; a presence filter would now match")
	}
	e.Set(AttrMailAlias, "a@i10.tech", "", "b@i10.tech")
	if got := e.Get(AttrMailAlias); len(got) != 2 {
		t.Errorf("aliases = %v, want the two non-empty values", got)
	}
}

func TestEntryAttributeNamesAreCaseInsensitive(t *testing.T) {
	e := NewEntry("uid=a,dc=i10,dc=tech")
	e.Set(AttrObjectClass, ClassInetOrgPerson)
	// Stalwart's default filters say "objectClass"; plenty of tooling sends
	// "objectclass".
	if !e.Has("objectclass") || !e.Has("OBJECTCLASS") {
		t.Error("attribute lookup is case-sensitive")
	}
}

func TestEntrySelect(t *testing.T) {
	e := NewEntry("uid=a,dc=i10,dc=tech")
	e.Set(AttrMail, "a@i10.tech")
	e.Set(AttrCN, "A")

	if got := e.Select(nil); len(got) != 2 {
		t.Errorf("empty selection returned %v, want all", got)
	}
	if got := e.Select([]string{"*"}); len(got) != 2 {
		t.Errorf(`"*" returned %v, want all`, got)
	}
	if got := e.Select([]string{"MAIL"}); len(got) != 1 || got[0] != AttrMail {
		t.Errorf("case-insensitive selection returned %v", got)
	}
	// "1.1" means no attributes at all; returning everything would leak more
	// than the client asked for.
	if got := e.Select([]string{"1.1"}); len(got) != 0 {
		t.Errorf(`"1.1" returned %v, want none`, got)
	}
}

func TestGeneralizedTimeIsUTC(t *testing.T) {
	loc := time.FixedZone("UTC+2", 2*60*60)
	got := GeneralizedTime(time.Date(2026, 8, 30, 11, 0, 0, 0, loc))
	if want := "20260830090000Z"; got != want {
		t.Errorf("GeneralizedTime = %q, want %q", got, want)
	}
}
