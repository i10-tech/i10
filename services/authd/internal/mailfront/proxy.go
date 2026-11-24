package mailfront

import (
	"crypto/tls"
	"encoding/binary"
	"net"
)

// The PROXY protocol v2 signature and the values this front sends.
var proxySignature = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A}

const (
	proxyVersionProxy = 0x21 // version 2, command PROXY
	proxyTCP4         = 0x11
	proxyTCP6         = 0x21

	pp2TypeSSL           = 0x20
	pp2SubtypeSSLVersion = 0x21
	pp2ClientSSL         = 0x01
)

// proxyHeader is the PROXY v2 header that tells Stalwart who the client is
// and, when ssl is not nil, that it spoke TLS.
//
// ⚠ THE SSL TLV IS WHAT MAKES STALWART TREAT A CONNECTION AS TLS, AND TLS IS
// WHAT TURNS ON BEARER SIGN-INS. Stalwart accepts OAUTHBEARER and XOAUTH2 only
// on a TLS connection (common/src/auth/sasl.rs:83, unchanged in v1.2.0), and a bearer
// token is checked by Stalwart alone, never by authd, so it never carries the
// front's bind token. So:
//
//   - IMAP goes upstream WITHOUT the TLV. The plan sets Imap.allowPlainTextAuth,
//     so LOGIN and AUTHENTICATE PLAIN still work on the cleartext loopback
//     listener, and both bearer mechanisms are answered "require a TLS
//     connection" (probed on v1.1.0 and v1.2.0, 2026-11-23, docs/research/mail-device-
//     binding.md section 9). Without that setting IMAP would advertise
//     LOGINDISABLED and refuse every sign-in.
//   - SMTP keeps the TLV: Stalwart offers no AUTH on a connection it thinks is
//     cleartext. The plan's MtaStageAuth.saslMechanisms offers PLAIN and LOGIN
//     only on 465 instead.
//
// ⚠ dst IS THE ADDRESS THE CLIENT CONNECTED TO, AND STALWART READS ITS PORT AS
// `local_port`. Probed: with the same loopback listener, a header claiming
// destination port 4999 made `local_port == 465` expressions false. The plan's
// 465 rules therefore hold because this is the front's own 465 socket.
func proxyHeader(src, dst net.Addr, ssl *tls.ConnectionState) []byte {
	s, _ := src.(*net.TCPAddr)
	d, _ := dst.(*net.TCPAddr)
	var addr []byte
	family := byte(proxyTCP6)
	switch {
	case s == nil || d == nil:
		// Cannot happen for a TCP listener. LOCAL with no address would make
		// Stalwart use the front's own address, so refuse to guess: an
		// unspecified IPv6 pair is at least honest about it.
		addr = make([]byte, 36)
	case s.IP.To4() != nil && d.IP.To4() != nil:
		family = proxyTCP4
		addr = append(addr, s.IP.To4()...)
		addr = append(addr, d.IP.To4()...)
		addr = binary.BigEndian.AppendUint16(addr, uint16(s.Port))
		addr = binary.BigEndian.AppendUint16(addr, uint16(d.Port))
	default:
		addr = append(addr, s.IP.To16()...)
		addr = append(addr, d.IP.To16()...)
		addr = binary.BigEndian.AppendUint16(addr, uint16(s.Port))
		addr = binary.BigEndian.AppendUint16(addr, uint16(d.Port))
	}

	var tlv []byte
	if ssl != nil {
		tlv = sslTLV(ssl.Version)
	}
	out := make([]byte, 0, 16+len(addr)+len(tlv))
	out = append(out, proxySignature...)
	out = append(out, proxyVersionProxy, family)
	out = binary.BigEndian.AppendUint16(out, uint16(len(addr)+len(tlv)))
	out = append(out, addr...)
	return append(out, tlv...)
}

// sslTLV is PP2_TYPE_SSL: the client spoke TLS at this version.
func sslTLV(v uint16) []byte {
	version := []byte(tlsVersionName(v))
	sub := []byte{pp2SubtypeSSLVersion}
	sub = binary.BigEndian.AppendUint16(sub, uint16(len(version)))
	sub = append(sub, version...)
	// client: PP2_CLIENT_SSL only (no client certificate yet); verify: 0.
	ssl := append([]byte{pp2ClientSSL, 0, 0, 0, 0}, sub...)
	tlv := []byte{pp2TypeSSL}
	tlv = binary.BigEndian.AppendUint16(tlv, uint16(len(ssl)))
	return append(tlv, ssl...)
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "TLSv1.3"
	case tls.VersionTLS12:
		return "TLSv1.2"
	}
	return "TLS"
}
