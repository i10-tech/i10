package passthrough

import (
	"context"

	"github.com/i10-tech/i10/services/authd/internal/okta"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// Service is what the bind handler calls for a managed account.
type Service struct {
	src    Source
	binder *Binder
	okta   *okta.Client
}

// NewService joins a settings source (normally a Cache over the API) to the two
// lanes' clients. A nil oktaClient is the production one.
func NewService(src Source, binder *Binder, oktaClient *okta.Client) *Service {
	if oktaClient == nil {
		oktaClient = &okta.Client{}
	}
	return &Service{src: src, binder: binder, okta: oktaClient}
}

// Bind answers one managed account's bind through its connection's lane.
//
// ⚠ NO FALLBACK ANYWHERE. A connection without pass-through is refused
// (IMAP is off for it); an API that cannot be reached is "unavailable". Neither
// ever becomes a question for Clerk, and neither lane ever becomes the other.
func (s *Service) Bind(ctx context.Context, connectionID, email, password string) Result {
	answer, err := s.src.Fetch(ctx, connectionID)
	if err != nil {
		return Result{Outcome: Unavailable, Reason: ReasonSettingsDown}
	}
	switch {
	case answer == nil:
		return Result{Outcome: Rejected, Reason: ReasonPassthroughOff}
	case answer.Lane == LaneLDAP && answer.LDAP != nil:
		res := s.binder.Bind(ctx, *answer.LDAP, email, password)
		res.Lane = LaneLDAP
		return res
	case answer.Lane == LaneOkta && answer.Okta != nil:
		res := s.okta.Verify(ctx, *answer.Okta, email, password)
		return Result{Outcome: outcomeOf(res.Outcome), Reason: res.Reason, Lane: LaneOkta}
	}
	return Result{Outcome: Unavailable, Reason: ReasonBadSettings}
}

// outcomeOf is the Okta client's answer in this package's own tri-state.
func outcomeOf(o verify.Outcome) Outcome {
	switch o {
	case verify.Verified:
		return Verified
	case verify.Rejected:
		return Rejected
	}
	return Unavailable
}
