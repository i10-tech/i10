package ldapsrv

import (
	"context"
	"log/slog"
	"net/netip"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// DeviceStore is what the device lane reads and writes (*projection.Postgres in
// production): the device row by id, the two clock stamps the `authd` role
// may write (`first_used_at`, `last_used_at`, and no other column of the row),
// and a Mac's liveness rows (`authd.mail_device_cert_binds`).
type DeviceStore interface {
	DeviceByID(ctx context.Context, id string) (*projection.DeviceCredential, error)
	ClaimDeviceFirstUse(ctx context.Context, id string) (bool, error)
	TouchDevice(ctx context.Context, id string) error
	RecordMacLive(ctx context.Context, deviceID string, at netip.Prefix, key []byte) error
	MacLive(ctx context.Context, deviceID string, at netip.Prefix, key []byte) (bool, error)
	MacLiveFamilies(ctx context.Context, deviceID string, key []byte) ([]int32, error)
}

// Reasons the device lane refuses a bind, beside gate's. Stable log reason codes.
const (
	reasonDeviceUnknown = "device_unknown"
	reasonDeviceBadCode = "device_code_bad"
	reasonDeviceExpired = "device_code_expired_unused"
	reasonDeviceIdle    = "device_code_idle"

	// The Mac rules (#383 PR 3, docs/research/mail-device-binding.md section 11).
	// reasonCertMismatch: the token's certificate key is not the row's, or the
	// row is not a Mac.
	reasonCertMismatch = "device_cert_mismatch"
	// reasonCertRequired: a Mac's code on IMAP with no certificate behind it,
	// outside its initial 10-minute install grace (once the grace ends or the
	// first certificate session is recorded, a code alone never reads a Mac's
	// mail).
	reasonCertRequired = "device_cert_required"
	// reasonCertSerial: the certificate's subject CN is not the serial Apple
	// attested for the row (revision 5): a key written into a row by someone
	// with the API's database role still needs a certificate for that Mac.
	reasonCertSerial = "device_cert_serial_mismatch"
	// reasonCertSessionMissing: a Mac's code on SMTP outside its initial
	// 10-minute install grace with no certificate-verified IMAP session of that
	// Mac, under its current key, recently enough (and from the same address
	// while AUTHD_MAC_SMTP_SAME_ADDRESS is on). Unavailable, not invalid
	// credentials: Mail should keep the message and retry.
	reasonCertSessionMissing = "device_cert_session_missing"
)

// deviceBind answers a person bind whose token is in device_code or external
// mode (#383). The bind token, the account row and gate.Refusal have all passed
// before it is called; claims are what the token's MAC covered
// (bindtoken.Unwrap), the device among them: for a code, the one the password
// names ("" when it is not a well-formed code); for external, the row the front
// found by the certificate's key.
//
// ⚠ IT NEVER REACHES A VERIFIER, THE CREDENTIAL CACHE, A FLIGHT, THE
// IDENTICAL-FAILURE MEMORY OR THE FAILURE BUDGET. A device code is i10's own
// secret and a Mac's certificate is proved to the front: no identity provider
// knows either, so none is asked, and nothing here can lock out the person's
// real account. A malformed code is refused here, so a truncated code never
// reaches Clerk or a company's directory either.
//
// ⚠ THE ORDER IS A SECURITY PROPERTY:
//
//	device_code: per-DN throttle -> parse -> key ring -> row by id ->
//	  gate.DeviceRefusal (with the certificate key the token carries, or the
//	  row's key for SMTP or a code-only Mac install-grace bind) -> serial ->
//	  key id -> constant-time hash compare -> SMTP liveness (a Mac outside
//	  install grace) -> first-use claim -> idle limit -> touch -> IMAP liveness
//	  write (a Mac with a proved certificate; never on a grace bind)
//	external:    per-DN throttle -> row by id -> gate.DeviceRefusal (with the
//	  token's key) -> serial -> first-use claim -> idle limit -> touch ->
//	  IMAP liveness write
//
// Nothing is written before every check passed, so a refused bind changes no
// row; the first-use claim is what starts a code's life, and only a bind that
// opened may start it.
//
// ⚠ OUR FAULTS ARE UNAVAILABLE, NEVER INVALID CREDENTIALS. No ring, a key id the
// ring does not hold, or a database error says nothing about the code, and an
// iPhone told "wrong password" asks its owner for a code they have never seen.
func (s *Server) deviceBind(ctx context.Context, w ldap.ResponseWriter, dn string, account *projection.Account,
	claims bindtoken.Claims) {
	uid, deviceID := account.ClerkUserID, claims.DeviceID
	attrs := []any{"uid", uid, "device", deviceID, "mode", claims.Mode.String(), "proto", claims.Protocol.String()}
	refuse := func(reason string, extra ...any) {
		s.log.Info("bind rejected", append(append([]any{"reason", reason}, attrs...), extra...)...)
		w.Write(ldap.NewBindResponse(ldap.LDAPResultInvalidCredentials))
	}
	unavailable := func(msg string, extra ...any) {
		s.log.Error(msg, append(append([]any{}, attrs...), extra...)...)
		s.respondUnavailable(w, "authentication backend temporarily unavailable")
	}

	if s.limiter != nil && !s.limiter.Allow(dn) {
		s.log.Warn("bind throttled", "dn", dn, "lane", "device")
		res := ldap.NewBindResponse(ldap.LDAPResultBusy)
		res.SetDiagnosticMessage("too many authentication attempts, slow down")
		w.Write(res)
		return
	}
	external := claims.Mode == bindtoken.ModeExternal
	var code devicecode.Code
	if !external {
		var err error
		code, err = devicecode.Parse(claims.Password)
		if err != nil || deviceID == "" {
			refuse(devicecode.ErrMalformed.Error())
			return
		}
		if len(s.deviceKeys) == 0 {
			unavailable("bind: no device code keys (MAIL_DEVICE_CODE_KEYS): device sign-ins are unavailable",
				"reason", "device_code_no_keys")
			return
		}
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
	mac := dev.Platform == gate.Macos
	// Mac install grace: a newly enrolled Mac with a bound ACME key, inside its
	// 10-minute UUIDv7 window and before its first certificate session is
	// recorded, may sign in with its code alone (no certificate in the token) on
	// IMAP and SMTP so macOS profile install verification succeeds. Once the
	// grace expires or any certificate session is recorded, PR 3's rules apply
	// in full. An external bind or a bind that carries a certificate is never
	// treated as a grace bind.
	grace := mac && !external && claims.CertKey == nil && dev.MacInstallGrace

	// ⚠ THE KEY A BIND STANDS ON (gate.DeviceRefusal's held): on IMAP, the
	// certificate key the front proved, carried in the token; on SMTP (which
	// never carries one) or a code-only Mac bind in install grace, the row's own
	// key so every other gate rule (account, address, workspace, bound key,
	// revocation) still applies. Outside the grace, the SMTP liveness rule below
	// requires a recent certificate session under that key.
	held := claims.CertKey
	if mac && (claims.Protocol == bindtoken.SMTP || grace) {
		held = dev.CertKey
	}
	if reason := gate.DeviceRefusal(&dev.Device, account, held); reason != "" {
		if reason == gate.DeviceKeyChanged {
			reason = reasonCertMismatch
			if claims.CertKey == nil {
				// Only an IMAP code on a Mac outside its install grace gets
				// here with no key: a code alone.
				reason = reasonCertRequired
			}
		}
		refuse(reason)
		return
	}
	// ⚠ THE SERIAL, WHENEVER A CERTIFICATE IS BEHIND THE BIND AND THE ROW HAS ONE.
	if claims.CertKey != nil && dev.Serial != "" && claims.CertCN != dev.Serial {
		refuse(reasonCertSerial)
		return
	}

	if !external {
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
	}

	if mac && claims.Protocol == bindtoken.SMTP && !grace {
		if !s.macSMTPLive(ctx, dev, claims, attrs) {
			s.respondUnavailable(w, "authentication backend temporarily unavailable")
			return
		}
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

	// ⚠ A MAC'S CERTIFICATE SESSION IS WHAT LETS IT SEND, so a successful IMAP
	// bind with a proved certificate records it. A grace bind has no proved
	// certificate and MUST NOT write a liveness row. Best effort: the bind is
	// already right, and a failed write costs only the next SMTP bind, which the
	// next IMAP bind (Mail reconnects within the hour) repairs.
	if mac && claims.Protocol == bindtoken.IMAP && claims.CertKey != nil {
		if err := s.devices.RecordMacLive(ctx, deviceID, projection.MacLivePrefix(claims.Addr), dev.CertKey); err != nil {
			s.log.Warn("bind: could not record a Mac's certificate session", append(attrs, slog.Any("err", err))...)
		}
	}
	source := "device"
	if external {
		source = "cert"
	}
	logAttrs := []any{"uid", uid, "mail", account.Email, "source", source, "device", deviceID,
		"proto", claims.Protocol.String(), "family", family(claims.Addr)}
	if grace {
		logAttrs = append(logAttrs, "grace", true)
	}
	s.log.Info("bind succeeded", logAttrs...)
	w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
}

// macSMTPLive is the SMTP rule for a Mac's code: a certificate-verified IMAP
// bind of this device under its current key, within projection.MacLiveWindow,
// from the same /32 or /64 unless the same-address part is switched off
// (AUTHD_MAC_SMTP_SAME_ADDRESS=false). It answers false when the bind must be
// refused unavailable, having logged why.
func (s *Server) macSMTPLive(ctx context.Context, dev *projection.DeviceCredential, claims bindtoken.Claims, attrs []any) bool {
	var at netip.Prefix
	if !s.macSMTPAnyAddress {
		at = projection.MacLivePrefix(claims.Addr)
	}
	live, err := s.devices.MacLive(ctx, dev.ID, at, dev.CertKey)
	if err != nil {
		s.log.Error("bind: could not read a Mac's certificate sessions", append(attrs, slog.Any("err", err))...)
		return false
	}
	if live {
		return true
	}
	// ⚠ LOGGED WITH THE FAMILIES SEEN, so the real-device probe can tell a
	// dual-stack split (IMAP over IPv6, SMTP over IPv4) from a Mac that is offline.
	fams, err := s.devices.MacLiveFamilies(ctx, dev.ID, dev.CertKey)
	extra := []any{"reason", reasonCertSessionMissing, "family", family(claims.Addr), "liveFamilies", fams,
		"sameAddress", !s.macSMTPAnyAddress}
	if err != nil {
		extra = append(extra, slog.Any("familiesErr", err))
	}
	s.log.Info("bind refused unavailable", append(attrs, extra...)...)
	return false
}

func family(a netip.Addr) int {
	switch {
	case a.Is4():
		return 4
	case a.Is6():
		return 6
	}
	return 0
}
