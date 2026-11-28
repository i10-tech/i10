package enrollctl

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

const (
	// ContentTypeMobileConfig is the MIME type Apple devices recognize as an
	// installable configuration profile.
	ContentTypeMobileConfig = "application/x-apple-aspen-config"

	// DefaultACMEDirectoryURL is the production acmed directory URL a Mac's
	// own directory URL is derived from (ACMEDirectoryFor).
	DefaultACMEDirectoryURL = "https://ca.i10.tech/acme/apple/directory"

	defaultOrganization = "i10"
)

// RenderPhase1Profile renders the Apple "Profile Service" configuration
// profile served on GET /enroll/apple/<token>.
//
// Review 1 rule: Challenge is sent as <string>. Every interpolated value is
// XML-escaped. enrollctl renders only from fixed templates and never signs
// caller-supplied bytes.
func RenderPhase1Profile(profileURL, token, organization string) ([]byte, error) {
	if profileURL == "" {
		return nil, errors.New("enrollctl: empty profile URL")
	}
	if token == "" {
		return nil, errors.New("enrollctl: empty phase 1 challenge token")
	}
	if organization == "" {
		organization = defaultOrganization
	}
	u, err := newUUIDv4Upper()
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
	escOrg, err := xmlEscape(organization)
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
`, escURL, escToken, escOrg, u)
	return buf.Bytes(), nil
}

// RenderSCEPProfile renders the Phase 2 SCEP-only Configuration profile.
//
// ⚠ SCEP PAYLOAD ONLY (mail-device-binding.md section 12). Putting any
// additional payload inside this response causes iOS/macOS to abort without
// contacting SCEP. KeyIsExtractable is false (Review 1 rules).
func RenderSCEPProfile(scepURL, serial, challenge, organization string) ([]byte, error) {
	if scepURL == "" {
		return nil, errors.New("enrollctl: empty SCEP URL")
	}
	if serial == "" {
		return nil, errors.New("enrollctl: empty SCEP subject serial")
	}
	if challenge == "" {
		return nil, errors.New("enrollctl: empty SCEP challenge")
	}
	if organization == "" {
		organization = defaultOrganization
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
	escOrg, err := xmlEscape(organization)
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

// SealedProfileInput holds the fixed-template fields for the Phase 4 sealed
// `.mobileconfig` profile (ported verbatim from apps/api/src/mail-devices/sealed-profile.ts).
type SealedProfileInput struct {
	DeviceID     string
	Email        string
	DisplayName  string
	Platform     string // ios | ipados | macos
	Serial       string
	DeviceCode   string // never logged
	ACMEPermit   string // required for macos (<= 50 base64url chars, placed in Subject OU)
	IMAPHost     string
	IMAPPort     int
	SMTPHost     string
	SMTPPort     int
	Organization string
	// ACMEDirectoryURL is the Mac's own directory URL, carrying its path token
	// (ACMEDirectoryFor); required for macos.
	ACMEDirectoryURL string
}

// ACMEDirectoryFor is a Mac's own ACME directory URL: the configured
// directory URL (ending in /directory) with the path token before
// /directory, https://<host>/acme/apple/d/<token>/directory.
func ACMEDirectoryFor(directoryURL, pathToken string) string {
	return strings.TrimSuffix(directoryURL, "/directory") + enrolltoken.ACMEPathSegment + pathToken + "/directory"
}

// BuildInnerPayloadsPlist constructs the inner XML plist (<array> of payload
// dicts) encrypted inside EncryptedPayloadContent.
func BuildInnerPayloadsPlist(in SealedProfileInput) ([]byte, error) {
	if in.DeviceID == "" || in.Email == "" || in.DeviceCode == "" {
		return nil, errors.New("enrollctl: missing required sealed profile fields")
	}
	org := in.Organization
	if org == "" {
		org = defaultOrganization
	}
	displayName := in.DisplayName
	if displayName == "" {
		displayName = in.Email
	}
	identifier := "tech.i10.mail-device." + in.DeviceID
	mailIdentifier := identifier + ".mail"

	mailPayload := plistDict{
		{"PayloadType", plistStr("com.apple.mail.managed")},
		{"PayloadVersion", plistInt(1)},
		{"PayloadIdentifier", plistStr(mailIdentifier)},
		{"PayloadUUID", plistStr(uuidFromSeed(mailIdentifier))},
		{"PayloadDisplayName", plistStr(displayName)},
		{"PayloadOrganization", plistStr(org)},
		{"EmailAccountType", plistStr("EmailTypeIMAP")},
		{"EmailAccountName", plistStr(displayName)},
		{"EmailAccountDescription", plistStr(in.Email)},
		{"EmailAddress", plistStr(in.Email)},
		{"IncomingMailServerHostName", plistStr(in.IMAPHost)},
		{"IncomingMailServerPortNumber", plistInt(in.IMAPPort)},
		{"IncomingMailServerUseSSL", plistBool(true)},
		{"IncomingMailServerAuthentication", plistStr("EmailAuthPassword")},
		{"IncomingMailServerUsername", plistStr(in.Email)},
		{"IncomingPassword", plistStr(in.DeviceCode)},
		{"OutgoingMailServerHostName", plistStr(in.SMTPHost)},
		{"OutgoingMailServerPortNumber", plistInt(in.SMTPPort)},
		{"OutgoingMailServerUseSSL", plistBool(true)},
		{"OutgoingMailServerAuthentication", plistStr("EmailAuthPassword")},
		{"OutgoingMailServerUsername", plistStr(in.Email)},
		{"OutgoingPassword", plistStr(in.DeviceCode)},
		{"OutgoingPasswordSameAsIncomingPassword", plistBool(true)},
	}

	payloads := plistArray{mailPayload}

	if in.Platform == "macos" {
		if in.ACMEPermit == "" {
			return nil, errors.New("enrollctl: macos sealed profile requires ACMEPermit")
		}
		dirURL := in.ACMEDirectoryURL
		if !strings.Contains(dirURL, enrolltoken.ACMEPathSegment) {
			return nil, errors.New("enrollctl: macos sealed profile requires a per-device ACME directory URL")
		}
		acmeIdentifier := identifier + ".acme"
		acmePayload := plistDict{
			{"PayloadType", plistStr("com.apple.security.acme")},
			{"PayloadVersion", plistInt(1)},
			{"PayloadIdentifier", plistStr(acmeIdentifier)},
			{"PayloadUUID", plistStr(uuidFromSeed(acmeIdentifier))},
			{"PayloadDisplayName", plistStr(org + " Secure Enclave key")},
			{"PayloadOrganization", plistStr(org)},
			{"DirectoryURL", plistStr(dirURL)},
			{"ClientIdentifier", plistStr(in.Serial)},
			{"KeyType", plistStr("ECSECPrimeRandom")},
			{"KeySize", plistInt(384)},
			{"HardwareBound", plistBool(true)},
			{"Attest", plistBool(true)},
			// Two single-value RDNs: CN = serial, OU = ACME permit token.
			{"Subject", plistArray{
				plistArray{plistArray{plistStr("CN"), plistStr(in.Serial)}},
				plistArray{plistArray{plistStr("OU"), plistStr(in.ACMEPermit)}},
			}},
			// id-kp-clientAuth
			{"ExtendedKeyUsage", plistArray{plistStr("1.3.6.1.5.5.7.3.2")}},
		}
		payloads = append(payloads, acmePayload)
	}

	return wrapPlist(payloads)
}

// BuildSealedMobileConfig constructs the encrypted outer `.mobileconfig` XML
// bytes with EncryptedPayloadContent CMS-encrypted to recipient's RSA key.
// The caller then wraps the returned bytes in CMS SignedData (encrypt-then-sign).
func BuildSealedMobileConfig(in SealedProfileInput, recipient *x509.Certificate) ([]byte, error) {
	innerXML, err := BuildInnerPayloadsPlist(in)
	if err != nil {
		return nil, err
	}
	// The inner plist holds the device code in clear; it never leaves here.
	defer clear(innerXML)
	cmsDER, err := EncryptCMSEnvelopedData(innerXML, recipient)
	if err != nil {
		return nil, err
	}
	org := in.Organization
	if org == "" {
		org = defaultOrganization
	}
	identifier := "tech.i10.mail-device." + in.DeviceID
	scope := "System"
	if in.Platform == "macos" {
		scope = "User"
	}
	outer := plistDict{
		{"PayloadType", plistStr("Configuration")},
		{"PayloadVersion", plistInt(1)},
		{"PayloadIdentifier", plistStr(identifier)},
		{"PayloadUUID", plistStr(uuidFromSeed(identifier))},
		{"PayloadDisplayName", plistStr(fmt.Sprintf("%s Mail (%s)", org, in.Email))},
		{"PayloadDescription", plistStr(fmt.Sprintf("Configures %s for Mail on this device.", in.Email))},
		{"PayloadOrganization", plistStr(org)},
		{"PayloadRemovalDisallowed", plistBool(false)},
		{"PayloadScope", plistStr(scope)},
		{"EncryptedPayloadContent", plistData(cmsDER)},
	}
	return wrapPlist(outer)
}

// uuidFromSeed produces a deterministic v4-shaped lowercase UUID matching
// apps/api/src/mail-devices/sealed-profile.ts byte for byte.
func uuidFromSeed(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	h := hex.EncodeToString(sum[:])
	vNibble, _ := strconv.ParseInt(h[16:17], 16, 64)
	variantChar := "89ab"[vNibble%4]
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" + string(variantChar) + h[17:20] + "-" + h[20:32]
}

// Minimal deterministic XML plist serializer matching sealed-profile.ts.

type plistValue interface {
	writePlist(buf *bytes.Buffer, depth int) error
}

type plistEntry struct {
	Key string
	Val plistValue
}

type plistDict []plistEntry
type plistArray []plistValue
type plistStr string
type plistInt int
type plistBool bool
type plistData []byte

func (d plistDict) writePlist(buf *bytes.Buffer, depth int) error {
	pad := strings.Repeat("\t", depth)
	childPad := strings.Repeat("\t", depth+1)
	buf.WriteString(pad + "<dict>\n")
	for _, e := range d {
		escK, err := xmlEscape(e.Key)
		if err != nil {
			return err
		}
		buf.WriteString(childPad + "<key>" + escK + "</key>\n")
		if err := e.Val.writePlist(buf, depth+1); err != nil {
			return err
		}
		buf.WriteByte('\n')
	}
	buf.WriteString(pad + "</dict>")
	return nil
}

func (a plistArray) writePlist(buf *bytes.Buffer, depth int) error {
	pad := strings.Repeat("\t", depth)
	buf.WriteString(pad + "<array>\n")
	for _, v := range a {
		if err := v.writePlist(buf, depth+1); err != nil {
			return err
		}
		buf.WriteByte('\n')
	}
	buf.WriteString(pad + "</array>")
	return nil
}

func (s plistStr) writePlist(buf *bytes.Buffer, depth int) error {
	esc, err := xmlEscape(string(s))
	if err != nil {
		return err
	}
	buf.WriteString(strings.Repeat("\t", depth) + "<string>" + esc + "</string>")
	return nil
}

func (n plistInt) writePlist(buf *bytes.Buffer, depth int) error {
	buf.WriteString(strings.Repeat("\t", depth) + "<integer>" + strconv.Itoa(int(n)) + "</integer>")
	return nil
}

func (b plistBool) writePlist(buf *bytes.Buffer, depth int) error {
	if b {
		buf.WriteString(strings.Repeat("\t", depth) + "<true/>")
	} else {
		buf.WriteString(strings.Repeat("\t", depth) + "<false/>")
	}
	return nil
}

func (raw plistData) writePlist(buf *bytes.Buffer, depth int) error {
	buf.WriteString(strings.Repeat("\t", depth) + "<data>" + base64.StdEncoding.EncodeToString(raw) + "</data>")
	return nil
}

func wrapPlist(root plistValue) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	buf.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	buf.WriteString("<plist version=\"1.0\">\n")
	if err := root.writePlist(&buf, 0); err != nil {
		return nil, err
	}
	buf.WriteString("\n</plist>\n")
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
		return "", fmt.Errorf("enrollctl: generate UUID: %w", err)
	}
	b[6] = (b[6] & 0x0F) | 0x40
	b[8] = (b[8] & 0x3F) | 0x80
	return fmt.Sprintf("%08X-%04X-%04X-%04X-%012X",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
