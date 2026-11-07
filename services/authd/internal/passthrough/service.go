package passthrough

import (
	"context"

	"github.com/i10-tech/i10/services/authd/internal/oidc"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// Service is what the bind handler calls for a managed account.
type Service struct {
	src    Source
	binder *Binder
	oidc   *oidc.Client
}

// NewService joins a settings source (normally a Cache over the API) to the two
// lanes' clients. A nil oidcClient is the production one.
func NewService(src Source, binder *Binder, oidcClient *oidc.Client) *Service {
	if oidcClient == nil {
		oidcClient = &oidc.Client{}
	}
	return &Service{src: src, binder: binder, oidc: oidcClient}
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
	case answer.Lane == LaneOIDC && answer.OIDC != nil:
		res := s.oidc.Verify(ctx, *answer.OIDC, email, password)
		return Result{Outcome: outcomeOf(res.Outcome), Reason: res.Reason, Lane: LaneOIDC, Preset: answer.OIDC.Preset}
	}
	return Result{Outcome: Unavailable, Reason: ReasonBadSettings}
}

// outcomeOf is the OIDC client's answer in this package's own tri-state.
func outcomeOf(o verify.Outcome) Outcome {
	switch o {
	case verify.Verified:
		return Verified
	case verify.Rejected:
		return Rejected
	}
	return Unavailable
}
