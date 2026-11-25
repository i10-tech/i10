package ldapsrv

import (
	"context"
	"log/slog"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// DeviceStore is what the device lane reads and writes (*projection.Postgres in
// production): the device row by id, and the two clock stamps the `authd` role
// may write (`first_used_at`, `last_used_at`, and no other column).
type DeviceStore interface {
	DeviceByID(ctx context.Context, id string) (*projection.DeviceCredential, error)
	ClaimDeviceFirstUse(ctx context.Context, id string) (bool, error)
	TouchDevice(ctx context.Context, id string) error
}

// Reasons the device lane refuses a bind, beside gate's. Stable log reason codes.
const (
	reasonDeviceUnknown = "device_unknown"
	reasonDeviceBadCode = "device_code_bad"
	reasonDeviceExpired = "device_code_expired_unused"
	reasonDeviceIdle    = "device_code_idle"
)

// deviceBind answers a person bind whose password starts with the reserved
// device code prefix (#383). The bind token, the account row and gate.Refusal
// have all passed before it is called; deviceID is the device the token's MAC
// covered (bindtoken.Unwrap), "" when the password is not a well-formed code.
//
// ⚠ IT NEVER REACHES A VERIFIER, THE CREDENTIAL CACHE, A FLIGHT, THE
// IDENTICAL-FAILURE MEMORY OR THE FAILURE BUDGET. A device code is i10's own
// secret: no identity provider knows it, so none is asked, and nothing it does
// can lock out the person's real account. A malformed one is refused here, so a
// truncated code never reaches Clerk or a company's directory either.
//
// ⚠ THE ORDER IS A SECURITY PROPERTY:
//
//	per-DN throttle -> parse -> key ring -> row by id -> gate.DeviceRefusal ->
//	key id -> constant-time hash compare -> first-use claim -> idle limit -> touch
//
// Nothing is written before the hash matched, so a wrong code changes no row;
// the first-use claim is what starts a code's life, and only a code that opened
// may start it.
//
// ⚠ OUR FAULTS ARE UNAVAILABLE, NEVER INVALID CREDENTIALS. No ring, a key id the
// ring does not hold, or a database error says nothing about the code, and an
// iPhone told "wrong password" asks its owner for a code they have never seen.
func (s *Server) deviceBind(ctx context.Context, w ldap.ResponseWriter, dn string, account *projection.Account,
	password, deviceID string) {
	uid := account.ClerkUserID
	refuse := func(reason string) {
		s.log.Info("bind rejected", "reason", reason, "uid", uid, "device", deviceID)
		w.Write(ldap.NewBindResponse(ldap.LDAPResultInvalidCredentials))
	}
	unavailable := func(msg string, attrs ...any) {
		s.log.Error(msg, append([]any{"uid", uid, "device", deviceID}, attrs...)...)
		s.respondUnavailable(w, "authentication backend temporarily unavailable")
	}

	if s.limiter != nil && !s.limiter.Allow(dn) {
		s.log.Warn("bind throttled", "dn", dn, "lane", "device")
		res := ldap.NewBindResponse(ldap.LDAPResultBusy)
		res.SetDiagnosticMessage("too many authentication attempts, slow down")
		w.Write(res)
		return
	}
	code, err := devicecode.Parse(password)
	if err != nil || deviceID == "" {
		refuse(devicecode.ErrMalformed.Error())
		return
	}
	if len(s.deviceKeys) == 0 {
		unavailable("bind: no device code keys (MAIL_DEVICE_CODE_KEYS): device sign-ins are unavailable",
			"reason", "device_code_no_keys")
		return
	}
	if s.devices == nil {
		unavailable("bind: no device store: device sign-ins are unavailable", "reason", "device_store_missing")
		return
	}

	dev, err := s.devices.DeviceByID(ctx, deviceID)
	if err != nil {
		unavailable("bind: device lookup failed", slog.Any("err", err))
		return
	}
	if dev == nil {
		refuse(reasonDeviceUnknown)
		return
	}
	if reason := gate.DeviceRefusal(&dev.Device, account); reason != "" {
		refuse(reason)
		return
	}
	var key []byte
	if dev.CodeKID >= 0 && dev.CodeKID <= 255 {
		key = s.deviceKeys[byte(dev.CodeKID)]
	}
	if key == nil {
		unavailable("bind: a device code is hashed under a key this authd does not hold",
			"reason", "device_code_unknown_key", "kid", dev.CodeKID)
		return
	}
	// The hash covers the id the code names, so it opens only for the row the
	// token named: deviceID and code.ID() are the same string, read by the same
	// parser, and a row whose id differed would not match its own hash.
	if !devicecode.Matches(key, code, dev.CodeHash) {
		refuse(reasonDeviceBadCode)
		return
	}

	if !dev.Used {
		claimed, err := s.devices.ClaimDeviceFirstUse(ctx, deviceID)
		if err != nil {
			unavailable("bind: could not record a device code's first use", slog.Any("err", err))
			return
		}
		if !claimed {
			refuse(reasonDeviceExpired)
			return
		}
	} else {
		if dev.Idle {
			refuse(reasonDeviceIdle)
			return
		}
		// The touch only keeps a device in use ahead of the idle prune, a day's
		// slack against a 90-day limit, so a failed one costs nothing today and
		// must not turn a good code away: the next bind tries it again.
		if dev.TouchDue {
			if err := s.devices.TouchDevice(ctx, deviceID); err != nil {
				s.log.Warn("bind: could not record a device's last sign-in", "uid", uid, "device", deviceID,
					slog.Any("err", err))
			}
		}
	}
	s.log.Info("bind succeeded", "uid", uid, "mail", account.Email, "source", "device", "device", deviceID)
	w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
}
