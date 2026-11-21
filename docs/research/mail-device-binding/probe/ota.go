package main

// Over-the-air profile enrollment probe.
// Phase 1: serve a "Profile Service" payload asking for device attributes.
// Phase 2: the device POSTs its attributes as CMS SignedData; we record who
// signed it, then answer with a mail profile whose payload is encrypted to
// that signer certificate, so only that device can open it.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const otaHost = "ota.192-168-1-45.sslip.io"

// otaServer holds what the enrollment endpoints need. The phase of a request
// is decided by which root verified its CMS signature, never by a name.
type otaServer struct {
	dir       string
	appleRoot string // phase 2 requests chain to this
	stepRoot  string // phase 3 requests chain to this
	stepInter string // optional intermediates for the step chain
	chals     *challenges
}

func newOTAServer(dir string) *otaServer {
	return &otaServer{
		dir:       dir,
		appleRoot: dir + "/pki/apple-root.pem",
		stepRoot:  dir + "/stepca/certs/root_ca.crt",
		stepInter: dir + "/stepca/certs/intermediate_ca.crt",
		chals:     newChallenges(),
	}
}

func init() {
	if len(os.Args) < 2 {
		return
	}
	dir := os.Args[1]
	s := newOTAServer(dir)
	mux := http.NewServeMux()
	mux.HandleFunc("/ota/enroll.mobileconfig", s.phase1)
	mux.HandleFunc("/ota/profile", s.phase2)
	http.HandleFunc("/ota/enroll.mobileconfig", s.phase1)
	http.HandleFunc("/ota/profile", s.phase2)
	go func() {
		err := http.ListenAndServeTLS("0.0.0.0:9443", dir+"/pki/server.pem", dir+"/pki/server.key", mux)
		fmt.Fprintln(os.Stderr, "ota https:", err)
	}()
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *otaServer) phase1(w http.ResponseWriter, r *http.Request) {
	emit(0, "ota", "ota_phase1_download", map[string]any{"remote": r.RemoteAddr, "ua": r.UserAgent(), "tls": r.TLS != nil})
	chal, err := s.chals.issue()
	if err != nil {
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	scheme := "https"
	port := "9443"
	if r.URL.Query().Get("plain") == "1" {
		scheme, port = "http", "9080"
	}
	url := fmt.Sprintf("%s://%s:%s/ota/profile", scheme, otaHost, port)
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key><string>%s</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string><string>VERSION</string><string>PRODUCT</string>
      <string>SERIAL</string><string>DEVICE_NAME</string><string>MODEL</string>
    </array>
    <key>Challenge</key><string>%s</string>
  </dict>
  <key>PayloadOrganization</key><string>i10 probe</string>
  <key>PayloadDisplayName</key><string>i10 device enrollment probe (delete me)</string>
  <key>PayloadDescription</key><string>Throwaway test of over-the-air enrollment.</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadUUID</key><string>%s</string>
  <key>PayloadIdentifier</key><string>test.i10.probe.ota.service</string>
  <key>PayloadType</key><string>Profile Service</string>
</dict>
</plist>`, url, chal, strings.ToUpper(uuidish()))
	w.Header().Set("Content-Type", "application/x-apple-aspen-config")
	w.Write([]byte(body))
}

func uuidish() string {
	h := randHex(16)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func run(name string, args ...string) (string, error) {
	var out bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// attr reads one string attribute from a verified attributes plist.
func attr(plistPath, key string) string {
	out, err := run("plutil", "-extract", key, "raw", plistPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func reject(w http.ResponseWriter, r *http.Request, reason string, kv map[string]any) {
	rec := map[string]any{"remote": r.RemoteAddr, "ua": r.UserAgent(), "reason": reason}
	for k, v := range kv {
		rec[k] = v
	}
	emit(0, "ota", "ota_rejected", rec)
	http.Error(w, "rejected", http.StatusBadRequest)
}

// phase2 handles both device POSTs. Which root verified the CMS chain decides
// the phase: Apple Root CA means phase 2 (the device's own certificate), the
// step CA root means phase 3 (the SCEP certificate we issued). Anything that
// verifies against neither gets a 400 and no profile.
func (s *otaServer) phase2(w http.ResponseWriter, r *http.Request) {
	dir := s.dir
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil || len(body) > maxRequestBody {
		reject(w, r, "unreadable or oversized body", nil)
		return
	}
	base := fmt.Sprintf("%s/ota/req-%s-%s", dir, time.Now().Format("150405"), randHex(3))
	os.MkdirAll(dir+"/ota", 0o700)
	os.WriteFile(base+".der", body, 0o600)

	signer, errApple := verifyCMS(base+".der", s.appleRoot, "", base+".signer.pem", base+".attrs.plist")
	phase := 2
	if errApple != nil {
		var errStep error
		signer, errStep = verifyCMS(base+".der", s.stepRoot, s.stepInter, base+".signer.pem", base+".attrs.plist")
		if errStep != nil {
			reject(w, r, "signature or chain verifies against neither root",
				map[string]any{"apple_err": errApple.Error(), "step_err": errStep.Error(), "bytes": len(body)})
			return
		}
		phase = 3
	}

	chain, _ := run("openssl", "pkcs7", "-inform", "DER", "-in", base+".der", "-print_certs", "-noout")
	signerInfo, _ := run("openssl", "x509", "-in", base+".signer.pem", "-noout", "-subject", "-issuer", "-dates", "-ext", "keyUsage,extendedKeyUsage")
	keyAlg, _ := run("sh", "-c", "openssl x509 -in "+base+".signer.pem -noout -text | grep -m1 'Public Key Algorithm'")
	plist, _ := os.ReadFile(base + ".attrs.plist")
	emit(0, "ota", "ota_phase2_attributes", map[string]any{
		"remote": r.RemoteAddr, "ua": r.UserAgent(), "ctype": r.Header.Get("Content-Type"), "bytes": len(body),
		"phase": phase, "verified": true,
		"chain": chain, "signer": signerInfo, "signer_key": strings.TrimSpace(keyAlg), "attributes": string(plist),
	})

	chal := attr(base+".attrs.plist", "CHALLENGE")
	serial := attr(base+".attrs.plist", "SERIAL")
	product := attr(base+".attrs.plist", "PRODUCT")

	if phase == 2 {
		if chal == "" || serial == "" {
			reject(w, r, "attributes lack CHALLENGE or SERIAL", map[string]any{"phase": phase})
			return
		}
		if err := s.chals.bind(chal, serial, product); err != nil {
			reject(w, r, err.Error(), map[string]any{"phase": phase})
			return
		}
		scepChal, _ := os.ReadFile(dir + "/scep-challenge.txt")
		reply := enrollReply(serial, strings.TrimSpace(string(scepChal)))
		os.WriteFile(base+".enroll-reply.plist", []byte(reply), 0o600)
		emit(0, "ota", "ota_phase2_enroll_reply", map[string]any{"client_identifier": serial})
		w.Header().Set("Content-Type", "application/x-apple-aspen-config")
		w.Write([]byte(reply))
		return
	}

	// Phase 3: the device need not echo CHALLENGE or SERIAL here (Apple's
	// sample final request has neither), so the enrollment is found from the
	// certificate step-ca issued: its CN is the serial phase 2 bound. Whatever
	// the device does echo must agree.
	//
	// ⚠ ONLY AS STRONG AS THE SCEP CHALLENGE. With the probe's static one, anyone
	// who holds it can get a certificate for any CN and finish an enrollment
	// whose phase 2 is pending for that serial. Production resolves this request
	// by the certificate a per-enrollment SCEPCHALLENGE webhook allowed, never by
	// a name (see README).
	cn := signer.Subject.CommonName
	if serial != "" && serial != cn {
		reject(w, r, "signer CN does not match SERIAL", map[string]any{"phase": phase, "cn": cn, "serial": serial})
		return
	}
	serial = cn
	product, err = s.chals.consume(chal, serial)
	if err != nil {
		reject(w, r, err.Error(), map[string]any{"phase": phase})
		return
	}

	// The mail account the device gets, with a code nobody is shown.
	code := "ota-" + randHex(12)
	os.WriteFile(base+".code.txt", []byte(code), 0o600)
	inner := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>PayloadType</key><string>com.apple.mail.managed</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadIdentifier</key><string>test.i10.probe.ota.mail</string>
    <key>PayloadUUID</key><string>%s</string>
    <key>PayloadDisplayName</key><string>i10 probe C (sealed code)</string>
    <key>EmailAccountDescription</key><string>i10 probe C (sealed code)</string>
    <key>EmailAccountName</key><string>i10 probe</string>
    <key>EmailAccountType</key><string>EmailTypeIMAP</string>
    <key>EmailAddress</key><string>probe-ota@i10.test</string>
    <key>IncomingMailServerAuthentication</key><string>EmailAuthPassword</string>
    <key>IncomingMailServerHostName</key><string>ota-mail.192-168-1-45.sslip.io</string>
    <key>IncomingMailServerPortNumber</key><integer>9993</integer>
    <key>IncomingMailServerUseSSL</key><true/>
    <key>IncomingMailServerUsername</key><string>probe-ota@i10.test</string>
    <key>IncomingPassword</key><string>%s</string>
    <key>OutgoingMailServerAuthentication</key><string>EmailAuthPassword</string>
    <key>OutgoingMailServerHostName</key><string>ota-mail.192-168-1-45.sslip.io</string>
    <key>OutgoingMailServerPortNumber</key><integer>9587</integer>
    <key>OutgoingMailServerUseSSL</key><true/>
    <key>OutgoingMailServerUsername</key><string>probe-ota@i10.test</string>
    <key>OutgoingPassword</key><string>%s</string>
  </dict>
    <dict>
      <key>PayloadType</key><string>com.apple.security.acme</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>test.i10.probe.ota.acme</string>
      <key>PayloadUUID</key><string>%[5]s</string>
      <key>PayloadDisplayName</key><string>i10 Secure Enclave key</string>
      <key>DirectoryURL</key><string>https://acme.192-168-1-45.sslip.io:9444/acme/apple-acme/directory</string>
      <key>ClientIdentifier</key><string>%[6]s</string>
      <key>KeyType</key><string>ECSECPrimeRandom</string>
      <key>KeySize</key><integer>384</integer>
      <key>HardwareBound</key><true/>
      <key>Attest</key><true/>
      <key>Subject</key><array><array><array><string>CN</string><string>%[6]s</string></array></array></array>
      <key>ExtendedKeyUsage</key><array><string>1.3.6.1.5.5.7.3.2</string></array>
    </dict>
</array>
</plist>`, strings.ToUpper(uuidish()), code, code, "", strings.ToUpper(uuidish()), serial)
	scope := "System"
	if strings.HasPrefix(product, "Mac") {
		// Mac: its own host and address, plus identity preferences that make
		// the keychain present the Secure Enclave key to that host.
		scope = "User"
		inner = strings.ReplaceAll(inner, "ota-mail.192-168-1-45.sslip.io", "mac-ota.192-168-1-45.sslip.io")
		inner = strings.ReplaceAll(inner, "probe-ota@i10.test", "probe-mac-ota@i10.test")
		inner = strings.ReplaceAll(inner, "i10 probe C (sealed code)", "i10 probe Mac D (sealed + Secure Enclave)")
		acmeUUID := between(inner, "<key>PayloadIdentifier</key><string>test.i10.probe.ota.acme</string>\n      <key>PayloadUUID</key><string>", "</string>")
		var prefs strings.Builder
		for i, name := range []string{"mac-ota.192-168-1-45.sslip.io", "imaps://mac-ota.192-168-1-45.sslip.io:9993", "imap://mac-ota.192-168-1-45.sslip.io"} {
			fmt.Fprintf(&prefs, `    <dict>
      <key>PayloadType</key><string>com.apple.security.identitypreference</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>test.i10.probe.ota.idpref.%d</string>
      <key>PayloadUUID</key><string>%s</string>
      <key>Name</key><string>%s</string>
      <key>PayloadCertificateUUID</key><string>%s</string>
    </dict>
`, i, strings.ToUpper(uuidish()), name, acmeUUID)
		}
		inner = strings.Replace(inner, "</array>\n</plist>", prefs.String()+"</array>\n</plist>", 1)
	}
	emit(0, "ota", "ota_phase3_platform", map[string]any{"product": product, "scope": scope})
	os.WriteFile(base+".inner.plist", []byte(inner), 0o600)

	encOut, encErr := run("openssl", "cms", "-encrypt", "-binary", "-outform", "DER", "-aes-256-cbc", "-in", base+".inner.plist", "-out", base+".enc.der", base+".signer.pem")
	if encErr != nil {
		// Never fall back to sending the code in the clear.
		os.Remove(base + ".code.txt")
		emit(0, "ota", "ota_encrypt_failed", map[string]any{"enc_err": encErr.Error(), "enc_out": strings.TrimSpace(encOut)})
		http.Error(w, "encryption failed", http.StatusInternalServerError)
		return
	}
	enc, _ := os.ReadFile(base + ".enc.der")
	payloadKey := "EncryptedPayloadContent"
	payloadVal := "<data>" + b64(enc) + "</data>"
	emit(0, "ota", "ota_phase2_reply", map[string]any{"encrypted": true, "enc_out": strings.TrimSpace(encOut)})

	outer := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>test.i10.probe.ota.final</string>
  <key>PayloadUUID</key><string>%s</string>
  <key>PayloadDisplayName</key><string>i10 sealed mail probe (delete me)</string>
  <key>PayloadDescription</key><string>Mail account whose code was encrypted to this device.</string>
  <key>PayloadScope</key><string>%s</string>
  <key>%s</key>%s
</dict>
</plist>`, strings.ToUpper(uuidish()), scope, payloadKey, payloadVal)
	w.Header().Set("Content-Type", "application/x-apple-aspen-config")
	w.Write([]byte(outer))
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// enrollReply asks the device for two device-made keys: a Secure Enclave key
// attested by Apple (ACME device-attest-01) and a SCEP key, the documented
// identity for the phase 3 request that the sealed profile is encrypted to.
func enrollReply(serial, scepChallenge string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>test.i10.probe.ota.keys</string>
  <key>PayloadUUID</key><string>%s</string>
  <key>PayloadDisplayName</key><string>i10 device keys probe (delete me)</string>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.security.scep</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>test.i10.probe.ota.scep</string>
      <key>PayloadUUID</key><string>%s</string>
      <key>PayloadDisplayName</key><string>i10 enrollment key</string>
      <key>PayloadContent</key>
      <dict>
        <key>URL</key><string>http://192.168.1.45:9001/scep/scep</string>
        <key>Subject</key><array><array><array><string>CN</string><string>%s</string></array></array></array>
        <key>Challenge</key><string>%s</string>
        <key>Keysize</key><integer>2048</integer>
        <key>Key Type</key><string>RSA</string>
        <key>Key Usage</key><integer>5</integer>
      </dict>
    </dict>
  </array>
</dict>
</plist>`, strings.ToUpper(uuidish()), strings.ToUpper(uuidish()), serial, scepChallenge)
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	return s[:strings.Index(s, b)]
}
