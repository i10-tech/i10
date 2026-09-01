package ldapsrv

import (
	"context"

	"github.com/vjeantet/goldap/message"
	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/directory"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// handleSearch answers the three lookups Stalwart performs.
//
//	filterLogin     "(&(objectClass=inetOrgPerson)(mail=?))"     — resolve a login to a DN
//	filterMailbox   "(|(&(objectClass=inetOrgPerson)(|(mail=?)(mailAlias=?)))…)" — is this a local recipient?
//	filterMemberOf  "(&(objectClass=groupOfNames)(member=?))"    — group membership
//
// None of them touch Clerk. They are answered entirely from the projection,
// which is what keeps delivery off the Clerk request budget — and what lets an
// account that has never signed in still receive mail, the limitation that
// ruled the OIDC directory out.
//
// Rather than pattern-match those three filters, authd extracts the values
// being searched for, fetches a candidate superset from Postgres, and then
// evaluates the real filter against each candidate. The filters are
// configurable on Stalwart's side, so matching on their exact shape would
// break the first time someone edited one.
func (s *Server) handleSearch(w ldap.ResponseWriter, m *ldap.Message) {
	r := m.GetSearchRequest()
	filter := r.Filter()

	select {
	case <-m.Done:
		w.Write(ldap.NewSearchResultDoneResponse(ldap.LDAPResultCanceled))
		return
	default:
	}

	ctx, cancel := s.opContext()
	defer cancel()

	entries, err := s.candidates(ctx, filter)
	if err != nil {
		s.log.Error("search: projection lookup failed", "filter", r.FilterString(), "err", err)
		res := ldap.NewSearchResultDoneResponse(ldap.LDAPResultUnavailable)
		res.SetDiagnosticMessage("directory temporarily unavailable")
		w.Write(res)
		return
	}

	base := string(r.BaseObject())
	requested := attributeNames(r.Attributes())
	limit := int(r.SizeLimit())

	sent := 0
	for _, e := range entries {
		if !inScope(e.DN, base, r.Scope()) {
			continue
		}
		if !directory.Match(filter, e) {
			continue
		}
		if limit > 0 && sent >= limit {
			w.Write(ldap.NewSearchResultDoneResponse(ldap.LDAPResultSizeLimitExceeded))
			return
		}
		w.Write(buildResultEntry(e, requested))
		sent++
	}

	s.log.Debug("search", "filter", r.FilterString(), "base", base,
		"candidates", len(entries), "returned", sent)
	w.Write(ldap.NewSearchResultDoneResponse(ldap.LDAPResultSuccess))
}

// candidates fetches the rows any entry matching this filter could come from.
//
// The set only has to be a superset — Match does the authoritative filtering
// afterwards — so it errs towards fetching too much rather than too little.
func (s *Server) candidates(ctx context.Context, filter message.Filter) ([]*directory.Entry, error) {
	var entries []*directory.Entry
	seen := map[string]bool{}
	add := func(e *directory.Entry) {
		if !seen[e.DN] {
			seen[e.DN] = true
			entries = append(entries, e)
		}
	}

	// filterLogin and filterMailbox both search by address.
	if addrs := directory.EqualityValues(filter,
		directory.AttrMail, directory.AttrMailAlias); len(addrs) > 0 {
		accounts, err := s.store.AccountsByAddress(ctx, addrs)
		if err != nil {
			return nil, err
		}
		for _, a := range accounts {
			add(s.accountEntry(a))
		}
		groups, err := s.store.GroupsByAddress(ctx, addrs)
		if err != nil {
			return nil, err
		}
		for _, g := range groups {
			add(s.groupEntry(g))
		}
	}

	// A direct lookup by account id.
	for _, uid := range directory.EqualityValues(filter, directory.AttrUID) {
		account, err := s.store.AccountByUID(ctx, uid)
		if err != nil {
			return nil, err
		}
		if account != nil {
			add(s.accountEntry(*account))
		}
	}

	// filterMemberOf substitutes the account's DN into (member=?).
	for _, dn := range directory.EqualityValues(filter, directory.AttrMember) {
		uid := directory.UIDFromDN(dn, s.baseDN)
		if uid == "" {
			continue
		}
		groups, err := s.store.GroupsForMember(ctx, uid)
		if err != nil {
			return nil, err
		}
		for _, g := range groups {
			add(s.groupEntry(g))
		}
	}

	return entries, nil
}

func (s *Server) accountEntry(a projection.Account) *directory.Entry {
	e := directory.NewEntry(directory.UserDN(a.ClerkUserID, s.baseDN))
	e.Set(directory.AttrObjectClass, directory.ClassTop, directory.ClassInetOrgPerson)
	e.Set(directory.AttrUID, a.ClerkUserID)
	e.Set(directory.AttrMail, a.Email)
	e.Set(directory.AttrMailAlias, a.Aliases...)
	e.Set(directory.AttrCN, a.DisplayName)
	e.Set(directory.AttrDescription, a.Description)

	groups := make([]string, 0, len(a.MemberOf))
	for _, name := range a.MemberOf {
		groups = append(groups, directory.GroupDN(name, s.baseDN))
	}
	e.Set(directory.AttrMemberOf, groups...)

	// Stalwart reads this as attrSecretChanged to expire cached OAuth tokens.
	// Absent when Clerk has never recorded a password change, which is correct:
	// no value means nothing to compare against, not "changed at the epoch".
	if a.ClerkUpdatedAt != nil {
		e.Set(directory.AttrPwdChangeTime, directory.GeneralizedTime(*a.ClerkUpdatedAt))
	}
	return e
}

func (s *Server) groupEntry(g projection.Group) *directory.Entry {
	e := directory.NewEntry(directory.GroupDN(g.Name, s.baseDN))
	e.Set(directory.AttrObjectClass, directory.ClassTop, directory.ClassGroupOfNames)
	e.Set(directory.AttrCN, g.Name)
	e.Set(directory.AttrMail, g.Email)
	e.Set(directory.AttrDescription, g.Description)

	members := make([]string, 0, len(g.Members))
	for _, uid := range g.Members {
		members = append(members, directory.UserDN(uid, s.baseDN))
	}
	e.Set(directory.AttrMember, members...)
	return e
}

func inScope(dn, base string, scope message.ENUMERATED) bool {
	switch int(scope) {
	case ldap.SearchRequestScopeBaseObject:
		return directory.EqualDN(dn, base)
	case ldap.SearchRequestSingleLevel:
		return directory.IsChildOfDN(dn, base)
	default: // wholeSubtree
		return directory.UnderDN(dn, base)
	}
}

func attributeNames(sel message.AttributeSelection) []string {
	out := make([]string, 0, len(sel))
	for _, a := range sel {
		out = append(out, string(a))
	}
	return out
}

func buildResultEntry(e *directory.Entry, requested []string) message.SearchResultEntry {
	entry := ldap.NewSearchResultEntry(e.DN)
	for _, name := range e.Select(requested) {
		values := e.Get(name)
		attrValues := make([]message.AttributeValue, 0, len(values))
		for _, v := range values {
			attrValues = append(attrValues, message.AttributeValue(v))
		}
		entry.AddAttribute(message.AttributeDescription(name), attrValues...)
	}
	return entry
}
