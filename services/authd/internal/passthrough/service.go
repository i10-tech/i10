package passthrough

import "context"

// Service is what the LDAP bind handler calls for a managed account.
type Service struct {
	src    Source
	binder *Binder
}

// NewService joins a settings source (normally a Cache over the API) to a binder.
func NewService(src Source, binder *Binder) *Service {
	return &Service{src: src, binder: binder}
}

// Bind answers one managed account's bind through its connection's directory.
//
// ⚠ NO FALLBACK ANYWHERE. A connection without pass-through is refused
// (IMAP is off for it); an API that cannot be reached is "unavailable". Neither
// ever becomes a question for Clerk.
func (s *Service) Bind(ctx context.Context, connectionID, email, password string) Result {
	settings, err := s.src.Fetch(ctx, connectionID)
	if err != nil {
		return Result{Unavailable, ReasonSettingsDown}
	}
	if settings == nil {
		return Result{Rejected, ReasonPassthroughOff}
	}
	return s.binder.Bind(ctx, *settings, email, password)
}
