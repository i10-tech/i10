package oidc

import (
	"net/url"
	"regexp"
	"strings"
)

// The providers this lane knows by name. A preset shapes three things and
// nothing else: the client id a provider issues, the optional non-secret form
// fields its password grant takes, and the refusals that say more than a bare
// invalid_grant (the table below). Every preset runs the same request, the same
// egress guard and the same tri-state.
//
// ⚠ THIS TABLE MUST AGREE WITH apps/api/src/identity/oidc-mail.ts. The API
// validates what an owner saves; this file re-checks it at every bind.
//
// Left out on purpose: OneLogin, whose password grant is documented ONLY with
// `Authorization: Basic <client id>:<client secret>` (developers.onelogin.com/
// openid-connect/api/password-grant), and this lane holds no client secret. A
// public-client path may exist; nobody has shown it, so it is not offered.
const (
	PresetOkta       = "okta"
	PresetKeycloak   = "keycloak"
	PresetAuth0      = "auth0"
	PresetPing       = "ping"
	PresetFusionAuth = "fusionauth"
	PresetGeneric    = "generic"
)

// PresetNames is every preset, in the order the API lists them.
func PresetNames() []string {
	return []string{PresetOkta, PresetKeycloak, PresetAuth0, PresetPing, PresetFusionAuth, PresetGeneric}
}

// signal is one thing a provider's refusal can say beyond invalid_grant. Every
// signal here is a REJECTION: it is a statement about the person, and a
// rejection keeps its budget slot (see classify).
//
// A signal matches when every criterion it sets matches. At least one must be
// set (TestEverySignalSaysWhatItMatches).
type signal struct {
	reason string
	// status is the HTTP status, 0 for any.
	status int
	// errors are `error` values (lower-case), any one of which matches.
	errors []string
	// errorReasons are `error_reason` values, FusionAuth's own field.
	errorReasons []string
	// phrases are lower-case fragments of error_description, any one of which
	// matches. Descriptions are human text and change between releases, so a
	// phrase only ever REFINES a rejection into a more specific one: a provider
	// that rewords it is still a rejection, just a plainer one.
	phrases []string
}

func (s signal) matches(status int, a answer) bool {
	if s.status != 0 && s.status != status {
		return false
	}
	if len(s.errors) > 0 && !contains(s.errors, a.Error) {
		return false
	}
	if len(s.errorReasons) > 0 && !contains(s.errorReasons, a.ErrorReason) {
		return false
	}
	if len(s.phrases) > 0 {
		desc := strings.ToLower(a.Description)
		for _, p := range s.phrases {
			if strings.Contains(desc, p) {
				return true
			}
		}
		return false
	}
	return true
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// preset is everything a provider changes.
type preset struct {
	// clientID is the shape of the provider's client ids.
	clientID *regexp.Regexp
	// issuerPath, when set, is the only path an issuer may have.
	issuerPath *regexp.Regexp
	// extras are the optional form fields an owner may set, none of them secret.
	// `scope` is on every preset: it is sent as `openid` unless set.
	extras []string
	// signals are checked in order, first match wins, before the generic rules.
	signals []signal
	// form adjusts the request after the extras are copied into it.
	form func(f url.Values, extra map[string]string)
}

// anyClientID is a bounded printable string: client ids are free text for most
// providers (a Keycloak client id is whatever its admin typed).
var anyClientID = regexp.MustCompile(`^[\x21-\x7e]{1,256}$`)

var presets = map[string]preset{
	PresetOkta: {
		// Okta native apps: `0oa` and 17 more. Probed against a real org (issue
		// #383, "Okta password lane probed").
		clientID:   regexp.MustCompile(`^0oa[0-9A-Za-z]{17}$`),
		issuerPath: regexp.MustCompile(`^/oauth2/[0-9A-Za-z]{1,64}$`),
		extras:     []string{"scope"},
		signals: []signal{
			// 400 invalid_grant, "Resource owner password credentials authentication
			// denied by sign on policy": the right password, refused because the
			// app's sign-in policy wants more.
			{reason: ReasonMFARequired, errors: []string{"invalid_grant"}, phrases: []string{"sign on policy"}},
			// ⚠ NO LOCK SIGNAL: a locked Okta account answers exactly like a wrong
			// password ("The credentials provided were invalid."), probed in #383.
		},
	},

	PresetKeycloak: {
		// Direct Access Grants on a public client. Statuses vary by release (a bad
		// password is 401 in the source, 400 in one vendor's probe), so nothing here
		// keys on the status.
		//
		// Wrong password, unknown user AND a brute-force lockout are all
		// `invalid_grant` "Invalid user credentials": the admin guide says the
		// masking is deliberate, so there is no lock signal to match. Likewise a user
		// with OTP set up and no `totp` field cannot be told from a wrong password.
		// https://phasetwo.io/blog/keycloak-invalid-grant/ (probed on 26.7.3)
		clientID: anyClientID,
		extras:   []string{"scope"},
		signals: []signal{
			{reason: ReasonAccountDisabled, errors: []string{"invalid_grant"}, phrases: []string{"account disabled"}},
			// A required action is pending (VERIFY_PROFILE, UPDATE_PASSWORD, ...): the
			// person has to finish it in Keycloak's own pages before any token flows.
			{reason: ReasonActionRequired, errors: []string{"invalid_grant"}, phrases: []string{"not fully set up"}},
		},
	},

	PresetAuth0: {
		// A "Native" application, token endpoint authentication None, Password grant
		// on. https://auth0.com/docs/get-started/authentication-and-authorization-flow/
		// resource-owner-password-flow
		clientID: anyClientID,
		// `realm` switches to the password-realm grant (a named connection);
		// without it the tenant's "Default Directory" setting decides, and a tenant
		// that has none answers `invalid_request`. `audience` is the API the token
		// is for, needed when the tenant has no default audience.
		extras: []string{"audience", "realm", "scope"},
		signals: []signal{
			// 403 {"error":"mfa_required", "mfa_token": ...}: the password was right
			// and Auth0 wants a factor. https://auth0.com/docs/secure/
			// multi-factor-authentication/authenticate-using-ropg-flow-with-mfa
			{reason: ReasonMFARequired, errors: []string{"mfa_required"}},
			// 429 too_many_attempts, "Your account has been blocked after multiple
			// consecutive login attempts." (github.com/auth0/docs-v2, set-up-cors.mdx).
			// The same code also carries "We have detected suspicious login
			// behavior...", which is Auth0 throttling OUR address, not the person, so
			// only the account's own wording is matched; the other stays a 429.
			{reason: ReasonAccountLocked, errors: []string{"too_many_attempts"}, phrases: []string{"account has been blocked"}},
			// An administrator blocked the user. Documented as `blocked_user` for the
			// cross-origin endpoint and as 401 `unauthorized` "user is blocked" for the
			// legacy /oauth/ro; not confirmed for /oauth/token, so both are listed.
			{reason: ReasonAccountDisabled, errors: []string{"blocked_user"}},
			{reason: ReasonAccountDisabled, errors: []string{"unauthorized"}, phrases: []string{"user is blocked"}},
			// 403 access_denied is what an Action that denies the login says, and
			// what the cross-origin endpoint says for "Wrong email or password.".
			// Both are about the person. A wrong password on /oauth/token itself is
			// 403 invalid_grant "Wrong email or password.", the generic rule.
			{reason: ReasonInvalidCredentials, errors: []string{"access_denied", "invalid_user_password"}},
		},
		form: func(f url.Values, extra map[string]string) {
			if extra["realm"] != "" {
				f.Set("grant_type", "http://auth0.com/oauth/grant-type/password-realm")
			}
		},
	},

	PresetPing: {
		// PingFederate with a client whose authentication is None and whose
		// allowed grants include Resource Owner Password Credentials.
		// https://docs.pingidentity.com/pingfederate/13.1/administrators_reference_guide/
		// pf_configuring_oauth_clients.html
		clientID: anyClientID,
		// `validator_id` names the password credential validator to ask; with
		// several mapped and none named PingFederate tries each in turn.
		extras: []string{"validator_id", "scope"},
		// ⚠ NO SIGNALS: a refusal is `invalid_grant` whose error_description is
		// whatever the password credential validator said ("We didn't recognize the
		// username or password you entered..." for the LDAP one), so a lock or an
		// expiry is text of the customer's own directory. PingFederate's password
		// grant runs no second factor. Everything is a plain invalid_grant, which is
		// a rejection and keeps its slot. (pf_oauth_grant_type_param.html)
	},

	PresetFusionAuth: {
		// An application with the Password grant enabled and client authentication
		// not required: the Token API takes the password grant without a secret.
		// https://fusionauth.io/docs/apis/oauth/token
		clientID: anyClientID,
		extras:   []string{"scope"},
		// FusionAuth names the cause in `error_reason`, a documented closed list
		// (https://fusionauth.io/docs/apis/oauth/oauth-error), so the signals key on
		// it rather than on `error` or on text. Which `error` goes with which
		// reason is not documented; that is why none is matched.
		signals: []signal{
			{reason: ReasonMFARequired, errors: []string{"two_factor_required"}},
			{reason: ReasonMFARequired, errorReasons: []string{"multi_factor_challenge_required"}},
			{reason: ReasonAccountLocked, errorReasons: []string{"user_locked"}},
			{reason: ReasonAccountDisabled, errorReasons: []string{"user_expired", "login_prevented"}},
			{reason: ReasonActionRequired, errors: []string{"change_password_required"}},
			{reason: ReasonActionRequired, errorReasons: []string{
				"change_password_administrative", "change_password_breached", "change_password_expired",
				"change_password_validation", "email_verification_required", "phone_verification_required",
				"registration_required", "registration_verification_required",
			}},
			{reason: ReasonInvalidCredentials, errorReasons: []string{"invalid_user_credentials", "user_not_found"}},
		},
	},

	PresetGeneric: {
		// Any provider whose token endpoint takes a public client's password grant.
		// Nothing is known about its refusals beyond RFC 6749 5.2 and the codes
		// several vendors share.
		clientID: anyClientID,
		extras:   []string{"audience", "resource", "scope"},
		signals: []signal{
			// `mfa_required` is Auth0's and several others'; `two_factor_required` is
			// FusionAuth's. Both mean the password was right and a factor is wanted.
			{reason: ReasonMFARequired, errors: []string{"mfa_required", "two_factor_required"}},
			// OpenID Connect Core 3.1.2.6 codes: the provider needs the person to do
			// something in a browser, which a mail client cannot. Azure AD answers an
			// MFA-gated password grant with interaction_required.
			{reason: ReasonActionRequired, errors: []string{"interaction_required", "consent_required", "login_required"}},
		},
	},
}
