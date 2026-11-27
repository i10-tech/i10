package enroll

import (
	"bytes"
	"crypto/rand"
	"encoding/xml"
	"errors"
	"fmt"
)

const (
	// ContentTypeMobileConfig is the MIME type Apple devices recognize as an
	// installable configuration profile.
	ContentTypeMobileConfig = "application/x-apple-aspen-config"

	profileOrganization = "i10"
)

// RenderPhase1Profile renders the Apple "Profile Service" configuration
// profile served on GET /enroll/apple/<token>.
//
// Review 1 rule: Challenge is sent as <string>. Every interpolated value is
// XML-escaped.
func RenderPhase1Profile(profileURL, token string) ([]byte, error) {
	if profileURL == "" {
		return nil, errors.New("enroll: empty profile URL")
	}
	if token == "" {
		return nil, errors.New("enroll: empty phase 1 challenge token")
	}
	uuid, err := newUUIDv4Upper()
	if err != nil {
		return nil, err
	}
	escURL, err := xmlEscape(profileURL)
	if err != nil {
		return nil, err
	}
	escToken, err := xmlEscape(token)
	if err != nil {
		return nil, err
	}
	escOrg, err := xmlEscape(profileOrganization)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	fmt.Fprintf(&buf, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>%s</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>VERSION</string>
      <string>PRODUCT</string>
      <string>SERIAL</string>
      <string>DEVICE_NAME</string>
      <string>MODEL</string>
    </array>
    <key>Challenge</key>
    <string>%s</string>
  </dict>
  <key>PayloadOrganization</key>
  <string>%s</string>
  <key>PayloadDisplayName</key>
  <string>i10 Mail Enrollment</string>
  <key>PayloadDescription</key>
  <string>Enrolls this device for i10 Mail.</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>%s</string>
  <key>PayloadIdentifier</key>
  <string>tech.i10.mail-device.enroll.service</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`, escURL, escToken, escOrg, uuid)
	return buf.Bytes(), nil
}

// RenderSCEPProfile renders the phase 2 SCEP-only Configuration profile.
//
// ⚠ SCEP PAYLOAD ONLY (section 4). Putting any additional payload (such as
// ACME or Mail) inside this response causes iOS/macOS to abort with "The
// enrollment server did not provision a valid identity certificate" without
// contacting SCEP. KeyIsExtractable is false (Review 1 rules). Every
// interpolated value is XML-escaped.
func RenderSCEPProfile(scepURL, serial, challenge string) ([]byte, error) {
	if scepURL == "" {
		return nil, errors.New("enroll: empty SCEP URL")
	}
	if serial == "" {
		return nil, errors.New("enroll: empty SCEP subject serial")
	}
	if challenge == "" {
		return nil, errors.New("enroll: empty SCEP challenge")
	}
	outerUUID, err := newUUIDv4Upper()
	if err != nil {
		return nil, err
	}
	payloadUUID, err := newUUIDv4Upper()
	if err != nil {
		return nil, err
	}
	escURL, err := xmlEscape(scepURL)
	if err != nil {
		return nil, err
	}
	escSerial, err := xmlEscape(serial)
	if err != nil {
		return nil, err
	}
	escChallenge, err := xmlEscape(challenge)
	if err != nil {
		return nil, err
	}
	escOrg, err := xmlEscape(profileOrganization)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	fmt.Fprintf(&buf, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>tech.i10.mail-device.enroll.scep</string>
  <key>PayloadUUID</key>
  <string>%s</string>
  <key>PayloadDisplayName</key>
  <string>i10 Mail Enrollment Key</string>
  <key>PayloadOrganization</key>
  <string>%s</string>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.scep</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>tech.i10.mail-device.enroll.scep.identity</string>
      <key>PayloadUUID</key>
      <string>%s</string>
      <key>PayloadDisplayName</key>
      <string>i10 Enrollment Identity</string>
      <key>PayloadOrganization</key>
      <string>%s</string>
      <key>PayloadContent</key>
      <dict>
        <key>URL</key>
        <string>%s</string>
        <key>Subject</key>
        <array>
          <array>
            <array>
              <string>CN</string>
              <string>%s</string>
            </array>
          </array>
        </array>
        <key>Challenge</key>
        <string>%s</string>
        <key>Keysize</key>
        <integer>2048</integer>
        <key>Key Type</key>
        <string>RSA</string>
        <key>Key Usage</key>
        <integer>5</integer>
        <key>KeyIsExtractable</key>
        <false/>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`, outerUUID, escOrg, payloadUUID, escOrg, escURL, escSerial, escChallenge)
	return buf.Bytes(), nil
}

func xmlEscape(s string) (string, error) {
	var buf bytes.Buffer
	if err := xml.EscapeText(&buf, []byte(s)); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func newUUIDv4Upper() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("enroll: generate UUID: %w", err)
	}
	b[6] = (b[6] & 0x0F) | 0x40
	b[8] = (b[8] & 0x3F) | 0x80
	return fmt.Sprintf("%08X-%04X-%04X-%04X-%012X",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
