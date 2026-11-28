package enrollctl

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/enroll"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

const (
	// MaxBodyBytes caps every internal JSON request body to enrollctl.
	MaxBodyBytes = 64 * 1024

	// DefaultCallTimeout bounds every enrollctl HTTP handler call.
	DefaultCallTimeout = 5 * time.Second

	acmePermitLifetime = 10 * time.Minute
)

var (
	oidCommonName         = asn1.ObjectIdentifier{2, 5, 4, 3}
	oidOrganizationalUnit = asn1.ObjectIdentifier{2, 5, 4, 11}
)

// MintBinder abstracts Batcher so unit tests can drive Handler with or without Postgres.
type MintBinder interface {
	Mint(ctx context.Context, req MintRequest) MintResult
	BindMac(ctx context.Context, req BindMacRequest) BindMacResult
}

// HandlerDeps wires every dependency of enrollctl's internal :3443 HTTP surface.
type HandlerDeps struct {
	Store            enrollredis.Store
	Batcher          MintBinder
	EdgeLinkKeys     *enrolltoken.Ring
	ACMEPermitKeys   *enrolltoken.Ring
	ACMEPathKeys     *enrolltoken.Ring // ENROLL_ACME_PATH_KEYS: signs the Mac's ACME directory path token
	DeviceCodeKeys   keyring.Ring
	ProfileSigner    *ProfileSignerLoader
	DeviceCAIssuer   *DeviceCAIssuer
	DeviceCATrust    *enroll.DeviceCABundle
	AppleAttest      *appleattest.Verifier
	EnrolldTokens    [][]byte // SHA-256 hashes of accepted enrolld bearer tokens
	AcmedTokens      [][]byte // SHA-256 hashes of accepted acmed bearer tokens
	ProfileURL       string   // Phase 1 Profile Service POST URL (https://ca.i10.tech/enroll/apple/profile)
	SCEPURL          string   // Phase 2 SCEP URL (https://ca.i10.tech/scep/apple-scep)
	ACMEDirectoryURL string   // Mac ACME directory URL (https://ca.i10.tech/acme/apple/directory); each profile gets its own token before /directory
	IMAPHost         string
	IMAPPort         int
	SMTPHost         string
	SMTPPort         int
	Organization     string
	CallTimeout      time.Duration
	Now              func() time.Time
	Log              *slog.Logger
}

// Handler serves enrollctl's internal endpoints on :3443:
//   - /enrolld/peek, /enrolld/attest, /enrolld/finish (EnrolldTokens only)
//   - /acme/finalize (AcmedTokens only)
//
// Every authentication failure, bad method, unknown path, query string, or
// oversize body returns a bare 404 with an empty body.
type Handler struct {
	deps       HandlerDeps
	serialKey  [32]byte // random per-process key for non-reversible serial hashes in logs
	highestKid byte
	hasCodeKey bool
}

// NewHandler initializes a Handler with a random per-process serial-log key.
func NewHandler(deps HandlerDeps) *Handler {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.CallTimeout <= 0 {
		deps.CallTimeout = DefaultCallTimeout
	}
	if deps.AppleAttest == nil {
		deps.AppleAttest = appleattest.NewProductionVerifier()
	}
	if deps.ACMEDirectoryURL == "" {
		deps.ACMEDirectoryURL = DefaultACMEDirectoryURL
	}
	if deps.Organization == "" {
		deps.Organization = defaultOrganization
	}
	h := &Handler{deps: deps}
	_, _ = rand.Read(h.serialKey[:])
	for kid := range deps.DeviceCodeKeys {
		if !h.hasCodeKey || kid > h.highestKid {
			h.highestKid = kid
			h.hasCodeKey = true
		}
	}
	return h
}

func (h *Handler) hashSerialForLog(serial string) string {
	if serial == "" {
		return ""
	}
	mac := hmac.New(sha256.New, h.serialKey[:])
	mac.Write([]byte(serial))
	return hex.EncodeToString(mac.Sum(nil)[:8])
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			if h.deps.Log != nil {
				h.deps.Log.Error("enrollctl panic recovered", "path", r.URL.Path, "panic", fmt.Sprint(rec))
			}
			w.WriteHeader(http.StatusInternalServerError)
		}
	}()

	if r.Method != http.MethodPost || r.URL.RawQuery != "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	var allowedTokens [][]byte
	switch r.URL.Path {
	case "/enrolld/peek", "/enrolld/attest", "/enrolld/finish":
		allowedTokens = h.deps.EnrolldTokens
	case "/acme/finalize":
		allowedTokens = h.deps.AcmedTokens
	default:
		w.WriteHeader(http.StatusNotFound)
		return
	}

	if !checkBearer(r.Header.Get("Authorization"), allowedTokens) {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	body, ok := readBoundedBody(r.Body, MaxBodyBytes)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.deps.CallTimeout)
	defer cancel()

	switch r.URL.Path {
	case "/enrolld/peek":
		h.handlePeek(ctx, w, body)
	case "/enrolld/attest":
		h.handleAttest(ctx, w, body)
	case "/enrolld/finish":
		h.handleFinish(ctx, w, body)
	case "/acme/finalize":
		h.handleACMEFinalize(ctx, w, body)
	}
}

func checkBearer(header string, hashes [][]byte) bool {
	if len(hashes) == 0 {
		return false
	}
	tok, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || len(tok) < 16 {
		return false
	}
	got := sha256.Sum256([]byte(tok))
	matched := 0
	for _, want := range hashes {
		if len(want) == 32 && subtle.ConstantTimeCompare(got[:], want) == 1 {
			matched = 1
		}
	}
	return matched == 1
}

func readBoundedBody(r io.Reader, max int) ([]byte, bool) {
	lr := io.LimitReader(r, int64(max)+1)
	b, err := io.ReadAll(lr)
	if err != nil || len(b) == 0 || len(b) > max {
		return nil, false
	}
	return b, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// ── /enrolld/peek ────────────────────────────────────────────────────────────

type peekRequest struct {
	Token string `json:"token"`
}

type peekResponse struct {
	Live    bool   `json:"live"`
	Profile string `json:"profile,omitempty"` // base64 DER CMS SignedData
}

func (h *Handler) handlePeek(ctx context.Context, w http.ResponseWriter, body []byte) {
	start := time.Now()
	var req peekRequest
	if err := json.Unmarshal(body, &req); err != nil || req.Token == "" {
		writeJSON(w, http.StatusOK, peekResponse{Live: false})
		return
	}
	now := h.deps.Now().UTC()
	// Verify the edge link token AGAIN before touching Redis so a compromised
	// enrolld cannot probe Redis with a forged or expired token.
	claims, err := enrolltoken.VerifyLink(h.deps.EdgeLinkKeys, req.Token, now)
	if err != nil {
		h.logPhase("peek", "invalid_token", "", "", start)
		writeJSON(w, http.StatusOK, peekResponse{Live: false})
		return
	}
	sess, err := h.deps.Store.GetSession(ctx, claims.EnrollmentID)
	if err != nil {
		h.logPhase("peek", "redis_error", "", "", start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if sess == nil || (sess.Status != "open" && sess.Status != "attested") || now.UnixMilli() >= sess.ExpiresAtMs {
		h.logPhase("peek", "not_live", "", "", start)
		writeJSON(w, http.StatusOK, peekResponse{Live: false})
		return
	}
	// A SCEP refusal cahookrelay recorded is terminal here too (it may not
	// write the session itself).
	refusal, err := h.deps.Store.GetSCEPRefusal(ctx, claims.EnrollmentID)
	if err != nil {
		h.logPhase("peek", "redis_error", "", "", start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if refusal != "" {
		h.logPhase("peek", "scep_refused", "", "", start)
		writeJSON(w, http.StatusOK, peekResponse{Live: false})
		return
	}

	plistXML, err := RenderPhase1Profile(h.deps.ProfileURL, req.Token, h.deps.Organization)
	if err != nil {
		h.logPhase("peek", "render_error", "", "", start)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	signed, err := h.deps.ProfileSigner.Sign(plistXML)
	if err != nil {
		h.logPhase("peek", "signer_unavailable", "", "", start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	h.logPhase("peek", "live", "", "", start)
	writeJSON(w, http.StatusOK, peekResponse{
		Live:    true,
		Profile: base64.StdEncoding.EncodeToString(signed),
	})
}

// ── /enrolld/attest ──────────────────────────────────────────────────────────

type attestRequest struct {
	Token             string  `json:"token"`
	UDID              string  `json:"udid"`
	Serial            string  `json:"serial"`
	Product           string  `json:"product"`
	Version           string  `json:"version"`
	DeviceName        *string `json:"deviceName"`
	Model             *string `json:"model"`
	AppleSignerSha256 string  `json:"appleSignerSha256"`
}

type attestResponse struct {
	Outcome string `json:"outcome"` // "scep" | "refused"
	Reason  string `json:"reason,omitempty"`
	Profile string `json:"profile,omitempty"` // base64 DER CMS SignedData
}

func (h *Handler) handleAttest(ctx context.Context, w http.ResponseWriter, body []byte) {
	start := time.Now()
	var req attestRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusOK, attestResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	if !validAttestRequest(&req) {
		h.logPhase("attest", "bad_body", "", "", start)
		writeJSON(w, http.StatusOK, attestResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	now := h.deps.Now().UTC()
	claims, err := enrolltoken.VerifyLink(h.deps.EdgeLinkKeys, req.Token, now)
	if err != nil {
		reason := "invalid_token"
		if errors.Is(err, enrolltoken.ErrExpired) {
			reason = "enrollment_expired"
		}
		h.logPhase("attest", reason, req.Product, req.Serial, start)
		writeJSON(w, http.StatusOK, attestResponse{Outcome: "refused", Reason: reason})
		return
	}

	// Check profile signer availability before mutating Redis state.
	if err := h.deps.ProfileSigner.CheckAvailable(); err != nil {
		h.logPhase("attest", "signer_unavailable", req.Product, req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	plat := ClassifyApplePlatform(req.Product, req.Version)

	var chalPlain string
	var chalHashHex string
	if plat.OK {
		var rawChal [32]byte
		if _, err := rand.Read(rawChal[:]); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		chalPlain = base64.RawURLEncoding.EncodeToString(rawChal[:])
		chalSum := sha256.Sum256([]byte(chalPlain))
		chalHashHex = hex.EncodeToString(chalSum[:])
	} else {
		// Unused placeholder key name is never written when refusal != "";
		// pass a valid key suffix so Redis KEYS[] ACL stays valid.
		chalHashHex = "0000000000000000000000000000000000000000000000000000000000000000"
	}

	udidSum := sha256.Sum256([]byte(req.UDID))
	devName := ""
	if req.DeviceName != nil {
		devName = strings.TrimSpace(*req.DeviceName)
	}
	res, err := h.deps.Store.AttestSession(ctx, enrollredis.AttestInput{
		EID:               claims.EnrollmentID,
		Now:               now,
		Serial:            req.Serial,
		UDIDSha256:        hex.EncodeToString(udidSum[:]),
		AppleSignerSha256: strings.ToLower(req.AppleSignerSha256),
		Product:           req.Product,
		OSVersion:         req.Version,
		DeviceName:        devName,
		Platform:          plat.Platform,
		NewChalHash:       chalHashHex,
		RefusalCode:       plat.Refusal,
	})
	if err != nil {
		h.logPhase("attest", "redis_error", req.Product, req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if res.Outcome != "scep" {
		h.logPhase("attest", res.Reason, req.Product, req.Serial, start)
		writeJSON(w, http.StatusOK, attestResponse{Outcome: "refused", Reason: res.Reason})
		return
	}

	scepXML, err := RenderSCEPProfile(h.deps.SCEPURL, res.Serial, chalPlain, h.deps.Organization)
	if err != nil {
		h.logPhase("attest", "render_error", req.Product, req.Serial, start)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	signed, err := h.deps.ProfileSigner.Sign(scepXML)
	if err != nil {
		h.logPhase("attest", "signer_unavailable", req.Product, req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	h.logPhase("attest", "scep", req.Product, req.Serial, start)
	writeJSON(w, http.StatusOK, attestResponse{
		Outcome: "scep",
		Profile: base64.StdEncoding.EncodeToString(signed),
	})
}

func validAttestRequest(r *attestRequest) bool {
	if r.Token == "" || len(r.Token) > 128 {
		return false
	}
	if !isPrintableASCII(r.UDID, 1, 128) || !isValidSerial(r.Serial) || !isPrintableASCII(r.Product, 1, 64) || !isPrintableASCII(r.Version, 1, 64) {
		return false
	}
	if r.DeviceName != nil && !isSafeDeviceName(*r.DeviceName, 128) {
		return false
	}
	if r.Model != nil && !isPrintableASCII(*r.Model, 0, 64) {
		return false
	}
	if len(r.AppleSignerSha256) != 64 {
		return false
	}
	for i := 0; i < len(r.AppleSignerSha256); i++ {
		c := r.AppleSignerSha256[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func isPrintableASCII(s string, minLen, maxLen int) bool {
	if len(s) < minLen || len(s) > maxLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func isSafeDeviceName(s string, maxLen int) bool {
	if len(s) > maxLen {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

func isValidSerial(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// ── /enrolld/finish ──────────────────────────────────────────────────────────

type finishRequest struct {
	CertDer string  `json:"certDer"` // base64 DER of the Phase 4 SCEP leaf cert
	UDID    *string `json:"udid"`
}

type finishResponse struct {
	Outcome string `json:"outcome"` // "sealed" | "refused"
	Reason  string `json:"reason,omitempty"`
	Profile string `json:"profile,omitempty"` // base64 DER CMS SignedData (encrypt-then-sign)
}

// finishReply writes the one answer of a /enrolld/finish call, and logs it.
type finishReply struct {
	h     *Handler
	w     http.ResponseWriter
	start time.Time
}

func (r finishReply) refuse(reason, product, serial string) {
	r.h.logPhase("finish", reason, product, serial, r.start)
	writeJSON(r.w, http.StatusOK, finishResponse{Outcome: "refused", Reason: reason})
}

func (r finishReply) unavailable(reason, product, serial string) {
	r.h.logPhase("finish", reason, product, serial, r.start)
	r.w.WriteHeader(http.StatusServiceUnavailable)
}

func (r finishReply) sealed(outcome, product, serial, profileB64 string) {
	r.h.logPhase("finish", outcome, product, serial, r.start)
	writeJSON(r.w, http.StatusOK, finishResponse{Outcome: "sealed", Profile: profileB64})
}

// finishSubject is what prepareFinish established: the verified Phase 4 leaf,
// its key hash and serial, and the session its SCEP binding vouches for.
type finishSubject struct {
	leaf       *x509.Certificate
	keyHashHex string
	serial     string
	sess       *enrollredis.Session
}

// sealedProfile is the device a finish is about to mint and the signed profile
// that delivers its code.
type sealedProfile struct {
	devID      string
	codeHash   []byte
	profileB64 string
}

// postCommitTimeout bounds the seal after a committed mint (every attempt and
// the waits between them), and separately the release of the sealing marker.
// Both run under context.WithoutCancel: a device whose connection dropped
// after the commit must still find its sealed profile on a retry.
const postCommitTimeout = 2 * time.Second

// sealAttemptTimeout bounds one SealSession attempt, so one hung socket cannot
// spend the whole postCommitTimeout: 3 attempts and both waits take at most
// 1.4 s.
const sealAttemptTimeout = 400 * time.Millisecond

// noticeTimeout bounds the notice after the seal, on its own clock, so a slow
// seal does not starve it.
const noticeTimeout = 500 * time.Millisecond

// sealRetryBackoff is the wait before each retry of SealSession after a
// commit: 3 attempts in all, well inside postCommitTimeout.
var sealRetryBackoff = []time.Duration{50 * time.Millisecond, 150 * time.Millisecond}

// MaxCallTimeout is the exclusive upper bound of CallTimeout: a sealing
// marker holder lives at most CallTimeout (its wait before the mint) plus the
// batch deadline and takenGrace (the mint), postCommitTimeout (the seal) and
// noticeTimeout (the notice), and must release its marker before the marker's
// SealingTTLSec ends, or a second attempt could acquire it and mint again.
const MaxCallTimeout = enrollredis.SealingTTLSec*time.Second - DefaultBatchDeadline - takenGrace - postCommitTimeout - noticeTimeout

// MaxHandlerDuration is the longest one call can run with callTimeout
// (HandlerDeps.CallTimeout): a finish's marker holder lives CallTimeout plus
// the mint, seal and notice (as in MaxCallTimeout), and then releases the
// marker under its own postCommitTimeout before the handler returns and the
// response's last bytes go out. The server's WriteTimeout must exceed it.
func MaxHandlerDuration(callTimeout time.Duration) time.Duration {
	return callTimeout + DefaultBatchDeadline + takenGrace + postCommitTimeout + noticeTimeout + postCommitTimeout
}

func (h *Handler) handleFinish(ctx context.Context, w http.ResponseWriter, body []byte) {
	r := finishReply{h: h, w: w, start: time.Now()}
	var req finishRequest
	if err := json.Unmarshal(body, &req); err != nil || req.CertDer == "" {
		writeJSON(w, http.StatusOK, finishResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	certDER, err := base64.StdEncoding.DecodeString(req.CertDer)
	if err != nil || len(certDER) == 0 {
		writeJSON(w, http.StatusOK, finishResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	now := h.deps.Now().UTC()
	subj, ok := h.prepareFinish(ctx, r, certDER, req.UDID, now)
	if !ok {
		return
	}
	sp, ok := h.buildSealedProfile(r, subj, now)
	if !ok {
		return
	}
	h.commitFinish(ctx, r, subj, sp, now)
}

// prepareFinish verifies the Phase 4 leaf, answers a retry from the sealed
// cache, and checks the SCEP binding and the session. It answers and returns
// false for anything but a finish that may go on to seal and mint.
func (h *Handler) prepareFinish(ctx context.Context, r finishReply, certDER []byte, udid *string, now time.Time) (*finishSubject, bool) {
	// Independently re-verify the SCEP leaf certificate (L1 rules: chains
	// through mounted device intermediate to root, valid now, RSA >= 2048,
	// CA:FALSE, explicit emailProtection EKU only, NO SAN extension, valid CN).
	leaf, keyHashHex, reason := verifyPhase4SCEPLeaf(certDER, h.deps.DeviceCATrust, now)
	if reason != "" {
		r.refuse(reason, "", "")
		return nil, false
	}
	serial := leaf.Subject.CommonName

	kb, err := h.deps.Store.GetSCEPKeyBinding(ctx, keyHashHex)
	if err != nil {
		r.unavailable("redis_error", "", serial)
		return nil, false
	}
	if kb == nil {
		r.refuse("permit_not_found", "", serial)
		return nil, false
	}

	// M2 sealed retry cache first: 0 Postgres, 0 crypto on a retry from the
	// same key. Only a fully checked finish below ever fills it.
	cached, err := h.deps.Store.GetSealedCache(ctx, kb.EID)
	if err != nil {
		r.unavailable("redis_error", "", serial)
		return nil, false
	}
	if cached != nil {
		if cached.KeySha256 == keyHashHex {
			r.sealed("sealed_retry", "", serial, cached.ProfileB64)
			return nil, false
		}
		r.refuse("scep_key_conflict", "", serial)
		return nil, false
	}

	sess, reason, err := h.checkSCEPBinding(ctx, kb, keyHashHex, serial, now)
	if err != nil {
		r.unavailable("redis_error", "", serial)
		return nil, false
	}
	if reason != "" {
		product := ""
		if sess != nil {
			product = sess.Product
		}
		r.refuse(reason, product, serial)
		return nil, false
	}
	if udid != nil && *udid != "" {
		uSum := sha256.Sum256([]byte(*udid))
		if hex.EncodeToString(uSum[:]) != sess.UDIDSha256 {
			r.refuse("udid_mismatch", sess.Product, serial)
			return nil, false
		}
	}
	return &finishSubject{leaf: leaf, keyHashHex: keyHashHex, serial: serial, sess: sess}, true
}

// buildSealedProfile makes the device id, its code and code hash, the Mac
// ACME permit, and the profile encrypted to the SCEP leaf and signed.
//
// ⚠ SEAL AND SIGN BEFORE THE MINT. A signer or encryption failure leaves
// nothing minted, and a minted device always has its profile. No crypto runs
// inside a Postgres transaction. The code's secret bytes and the Code value
// are zeroed on return; dc.String()'s copy is a Go string, which cannot be
// zeroed, and lives only until BuildSealedMobileConfig has encrypted it.
func (h *Handler) buildSealedProfile(r finishReply, subj *finishSubject, now time.Time) (*sealedProfile, bool) {
	sess, serial := subj.sess, subj.serial
	if !h.hasCodeKey {
		r.unavailable("keys_not_configured", sess.Product, serial)
		return nil, false
	}
	if sess.Platform == "macos" && h.deps.ACMEPermitKeys.Len() == 0 {
		r.unavailable("acme_permit_keys_not_configured", sess.Product, serial)
		return nil, false
	}
	if sess.Platform == "macos" && h.deps.ACMEPathKeys.Len() == 0 {
		r.unavailable("acme_path_keys_not_configured", sess.Product, serial)
		return nil, false
	}

	devUUIDBytes, err := enrolltoken.NewUUIDv7At(now)
	if err != nil {
		r.w.WriteHeader(http.StatusInternalServerError)
		return nil, false
	}
	devID := enrolltoken.FormatUUID(devUUIDBytes)
	var secretBytes [32]byte
	defer clear(secretBytes[:])
	if _, err := rand.Read(secretBytes[:]); err != nil {
		r.w.WriteHeader(http.StatusInternalServerError)
		return nil, false
	}
	dc := devicecode.New(devUUIDBytes, secretBytes)
	defer func() { dc = devicecode.Code{} }()
	codeHash := devicecode.Hash(h.deps.DeviceCodeKeys[h.highestKid], dc)

	var acmePermit, acmeDirURL string
	if sess.Platform == "macos" {
		acmePermit, err = enrolltoken.SignACMEPermit(h.deps.ACMEPermitKeys, devUUIDBytes, now.Add(acmePermitLifetime))
		if err != nil {
			r.unavailable("acme_permit_sign_error", sess.Product, serial)
			return nil, false
		}
		// The Mac's ACME window: a directory URL only this profile carries
		// (enrolltoken/acmepath.go). acmed refuses every request without it.
		pathToken, err := enrolltoken.SignACMEPath(h.deps.ACMEPathKeys, devUUIDBytes, serial, now.Add(enrolltoken.ACMEPathLifetime))
		if err != nil {
			r.unavailable("acme_path_sign_error", sess.Product, serial)
			return nil, false
		}
		acmeDirURL = ACMEDirectoryFor(h.deps.ACMEDirectoryURL, pathToken)
	}

	sealedXML, err := BuildSealedMobileConfig(SealedProfileInput{
		DeviceID:         devID,
		Email:            sess.Email,
		Platform:         sess.Platform,
		Serial:           serial,
		DeviceCode:       dc.String(),
		ACMEPermit:       acmePermit,
		IMAPHost:         h.deps.IMAPHost,
		IMAPPort:         h.deps.IMAPPort,
		SMTPHost:         h.deps.SMTPHost,
		SMTPPort:         h.deps.SMTPPort,
		Organization:     h.deps.Organization,
		ACMEDirectoryURL: acmeDirURL,
	}, subj.leaf)
	if err != nil {
		h.logPhase("finish", "seal_error", sess.Product, serial, r.start)
		r.w.WriteHeader(http.StatusInternalServerError)
		return nil, false
	}
	signedDER, err := h.deps.ProfileSigner.Sign(sealedXML)
	if err != nil {
		r.unavailable("signer_unavailable", sess.Product, serial)
		return nil, false
	}
	return &sealedProfile{
		devID:      devID,
		codeHash:   codeHash,
		profileB64: base64.StdEncoding.EncodeToString(signedDER),
	}, true
}

// commitFinish acquires the sealing marker, mints the device, and after the
// commit seals the session and queues the notice.
//
// ⚠ ONLY THE ATTEMPT HOLDING THE MARKER MINTS. Two finishes for one
// enrollment (a device retrying while its first request is still in flight)
// would otherwise both mint: the loser of the batcher's race got
// enrollment_conflict, saw no sealed cache, and could not tell a seal in
// flight from a lost one. An attempt that does not acquire the marker answers
// from the sealed cache or with 503 seal_in_flight, and never mints. The
// holder releases the marker when it is done (ClearSealing, compare and
// delete), so a failed mint does not block the next attempt for
// SealingTTLSec.
func (h *Handler) commitFinish(ctx context.Context, r finishReply, subj *finishSubject, sp *sealedProfile, now time.Time) {
	sess, serial := subj.sess, subj.serial
	attempt, err := randomAttemptToken()
	if err != nil {
		r.w.WriteHeader(http.StatusInternalServerError)
		return
	}
	acquired, err := h.deps.Store.MarkSealing(ctx, sess.ID, attempt)
	if err != nil {
		r.unavailable("redis_error", sess.Product, serial)
		return
	}
	if !acquired {
		h.answerFromSealedCache(ctx, r, subj, "seal_in_flight")
		return
	}
	defer h.releaseSealing(ctx, sess.ID, attempt)

	mintRes := h.deps.Batcher.Mint(ctx, mintRequestFor(sess, sp, int16(h.highestKid)))
	if mintRes.Err != nil {
		r.unavailable("db_unavailable", sess.Product, serial)
		return
	}
	if !mintRes.OK {
		if mintRes.RefusalCode == "enrollment_conflict" {
			h.answerMintConflict(ctx, r, subj, now)
			return
		}
		_ = h.deps.Store.MarkSessionRefused(ctx, sess.ID, mintRes.RefusalCode, now)
		r.refuse(mintRes.RefusalCode, sess.Product, serial)
		return
	}

	// The device row exists now: the writes below must happen even if the
	// caller has gone, so a retry finds the sealed cache.
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), postCommitTimeout)
	defer cancel()
	// Mark session sealed and cache the M2 retry bytes (120s) in one atomic
	// Redis Lua script, retried on a brief Redis failure.
	if attempts, err := h.sealAfterCommit(pctx, sess, enrollredis.SealedCache{
		KeySha256:  subj.keyHashHex,
		DeviceID:   sp.devID,
		ProfileB64: sp.profileB64,
	}, now); err != nil {
		// Device is already minted in Postgres; return the signed profile rather
		// than stranding the user, and log the cache failure loudly.
		if h.deps.Log != nil {
			h.deps.Log.Error("enrollctl seal redis update failed after commit", "device_id", sp.devID, "attempts", attempts, slog.Any("err", err))
		}
	}

	// Best-effort post-seal notice email event on Redis stream `enroll:notice`.
	serialLast4 := serial
	if len(serialLast4) > 4 {
		serialLast4 = serialLast4[len(serialLast4)-4:]
	}
	nctx, ncancel := context.WithTimeout(context.WithoutCancel(ctx), noticeTimeout)
	defer ncancel()
	if err := h.deps.Store.EnqueueNotice(nctx, enrollredis.NoticeEvent{
		DeviceID:    sp.devID,
		Email:       sess.Email,
		Platform:    sess.Platform,
		Model:       sess.Product,
		SerialLast4: serialLast4,
	}); err != nil && h.deps.Log != nil {
		h.deps.Log.Warn("enrollctl failed to enqueue notice event", "device_id", sp.devID, slog.Any("err", err))
	}

	r.sealed("sealed", sess.Product, serial, sp.profileB64)
}

// sealAfterCommit runs SealSession up to len(sealRetryBackoff)+1 times, each
// attempt under its own sealAttemptTimeout inside ctx, and stops early once
// ctx is done. It returns how many attempts ran. seal_session.lua overwrites
// the session and the cache, so a retry after an attempt that did reach Redis
// is idempotent.
func (h *Handler) sealAfterCommit(ctx context.Context, sess *enrollredis.Session, cache enrollredis.SealedCache, now time.Time) (int, error) {
	for i := 0; ; i++ {
		actx, cancel := context.WithTimeout(ctx, sealAttemptTimeout)
		err := h.deps.Store.SealSession(actx, sess, cache, now)
		cancel()
		if err == nil || i == len(sealRetryBackoff) || ctx.Err() != nil {
			return i + 1, err
		}
		if h.deps.Log != nil {
			h.deps.Log.Warn("enrollctl seal redis update failed after commit, retrying", "device_id", cache.DeviceID, "attempt", i+1, slog.Any("err", err))
		}
		t := time.NewTimer(sealRetryBackoff[i])
		select {
		case <-ctx.Done():
			t.Stop()
			return i + 1, err
		case <-t.C:
		}
	}
}

// releaseSealing clears this attempt's marker, even when the caller has gone.
func (h *Handler) releaseSealing(ctx context.Context, eid, attempt string) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), postCommitTimeout)
	defer cancel()
	if err := h.deps.Store.ClearSealing(cctx, eid, attempt); err != nil && h.deps.Log != nil {
		h.deps.Log.Warn("enrollctl failed to clear the sealing marker", "enrollment_id", eid, slog.Any("err", err))
	}
}

// answerFromSealedCache answers from the enrollment's sealed cache: the same
// key gets its profile, another key is refused scep_key_conflict. With no
// cache it answers 503 with reason (the device retries).
func (h *Handler) answerFromSealedCache(ctx context.Context, r finishReply, subj *finishSubject, reason string) {
	sess, serial := subj.sess, subj.serial
	cached, err := h.deps.Store.GetSealedCache(ctx, sess.ID)
	if err != nil {
		r.unavailable("redis_error", sess.Product, serial)
		return
	}
	if cached == nil {
		r.unavailable(reason, sess.Product, serial)
		return
	}
	if cached.KeySha256 == subj.keyHashHex {
		r.sealed("sealed_retry", sess.Product, serial, cached.ProfileB64)
		return
	}
	r.refuse("scep_key_conflict", sess.Product, serial)
}

// answerMintConflict answers the marker holder whose mint found this
// enrollment already minted:
//   - its sealed bytes are cached: the same key gets them, another key is
//     refused scep_key_conflict;
//   - nothing is cached: the earlier attempt that minted it has finished
//     (only a marker holder mints, and this attempt holds the marker, so that
//     attempt released it or outlived SealingTTLSec, which is far beyond the
//     batcher's worst case plus the seal), and its seal was lost. Waiting
//     changes nothing. Refuse enrollment_conflict and mark the session
//     refused, so the console tells the person to start again. The orphan
//     device row is never used, so the hourly prune deletes it.
func (h *Handler) answerMintConflict(ctx context.Context, r finishReply, subj *finishSubject, now time.Time) {
	sess, serial := subj.sess, subj.serial
	cached, err := h.deps.Store.GetSealedCache(ctx, sess.ID)
	if err != nil {
		r.unavailable("redis_error", sess.Product, serial)
		return
	}
	if cached != nil {
		if cached.KeySha256 == subj.keyHashHex {
			r.sealed("sealed_retry", sess.Product, serial, cached.ProfileB64)
			return
		}
		r.refuse("scep_key_conflict", sess.Product, serial)
		return
	}
	_ = h.deps.Store.MarkSessionRefused(ctx, sess.ID, "enrollment_conflict", now)
	r.refuse("enrollment_conflict", sess.Product, serial)
}

func mintRequestFor(sess *enrollredis.Session, sp *sealedProfile, codeKid int16) MintRequest {
	var devNamePtr, modelPtr, serialPtr *string
	if sess.DeviceName != "" {
		devNamePtr = &sess.DeviceName
	}
	if sess.Product != "" {
		modelPtr = &sess.Product
	}
	if sess.Serial != "" {
		serialPtr = &sess.Serial
	}
	return MintRequest{
		DeviceID:      sp.devID,
		EnrollmentID:  sess.ID,
		ClerkUserID:   sess.ClerkUserID,
		Email:         sess.Email,
		TenantID:      sess.TenantID,
		ExpectedEpoch: sess.ExpectedEpoch,
		Platform:      sess.Platform,
		DeviceName:    devNamePtr,
		Model:         modelPtr,
		Serial:        serialPtr,
		CodeHash:      sp.codeHash,
		CodeKid:       codeKid,
		CreatedBy:     sess.CreatedBy,
	}
}

func randomAttemptToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// checkSCEPBinding decides whether the SCEP key binding kb, for the Phase 4
// certificate whose key hashes to keyHashHex, may mint: it returns the session
// it vouches for, or a refusal reason.
//
// ⚠ cahookrelay WROTE kb AND MAY BE COMPROMISED, so nothing in kb is trusted
// beyond what this checks against state only the API and enrollctl write:
//   - the binding is for THIS certificate's key and step-ca authorized it;
//   - no SCEP refusal was recorded for the session (it is applied here);
//   - the session exists, is kb's, is attested and unexpired;
//   - sha256(kb.Challenge) is the session's CURRENT scep_chal_hash: a binding
//     can name a session only with a challenge plaintext step-ca sent, and only
//     the latest one (an attest retry retires the earlier ones);
//   - the serial is the session's, the binding's and the certificate's.
//
// This stops a party who can only write Redis. It does NOT stop a compromised
// relay or step-ca: they receive every in-flight challenge in plaintext, so a
// binding of a victim's session to their own key passes every check here.
// That is inherent to SCEP (docs/research/enrollment-at-scale.md 6.5).
func (h *Handler) checkSCEPBinding(ctx context.Context, kb *enrollredis.SCEPKeyBinding, keyHashHex, serial string, now time.Time) (*enrollredis.Session, string, error) {
	if kb.KeySha256 != keyHashHex {
		return nil, "scep_key_conflict", nil
	}
	if kb.Status != "authorized" {
		return nil, "permit_not_authorized", nil
	}
	refusal, err := h.deps.Store.GetSCEPRefusal(ctx, kb.EID)
	if err != nil {
		return nil, "", err
	}
	sess, err := h.deps.Store.GetSession(ctx, kb.EID)
	if err != nil {
		return nil, "", err
	}
	if sess == nil || sess.ID != kb.EID {
		return nil, "enrollment_not_found", nil
	}
	if refusal != "" {
		_ = h.deps.Store.MarkSessionRefused(ctx, sess.ID, refusal, now)
		return sess, refusal, nil
	}
	if sess.Status != "attested" {
		return sess, "enrollment_" + sess.Status, nil
	}
	if now.UnixMilli() >= sess.ExpiresAtMs {
		return sess, "enrollment_expired", nil
	}
	chalHash := enrollredis.HashChallenge(kb.Challenge)
	if kb.Challenge == "" || sess.SCEPChalHash == "" ||
		subtle.ConstantTimeCompare([]byte(chalHash), []byte(sess.SCEPChalHash)) != 1 ||
		kb.ChalHash != sess.SCEPChalHash {
		return sess, "scep_challenge_mismatch", nil
	}
	if sess.Serial != serial || kb.Serial != serial {
		return sess, "serial_mismatch", nil
	}
	return sess, "", nil
}

// verifyPhase4SCEPLeaf enforces every L1 rule on the Phase 4 SCEP certificate.
func verifyPhase4SCEPLeaf(certDER []byte, trust *enroll.DeviceCABundle, now time.Time) (*x509.Certificate, string, string) {
	if trust == nil || trust.Current() == nil {
		return nil, "", "device_ca_not_configured"
	}
	leaf, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, "", "invalid_cert_der"
	}
	if leaf.IsCA {
		return nil, "", "cert_is_ca"
	}
	pub, ok := leaf.PublicKey.(*rsa.PublicKey)
	if !ok || pub.N.BitLen() < 2048 {
		return nil, "", "cert_not_rsa"
	}
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return nil, "", "cert_not_valid_now"
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageEmailProtection || len(leaf.UnknownExtKeyUsage) != 0 {
		return nil, "", "cert_bad_eku"
	}
	for _, ext := range leaf.Extensions {
		if ext.Id.Equal(oidExtSubjectAltName) {
			return nil, "", "cert_has_san"
		}
	}
	if !isValidSerial(leaf.Subject.CommonName) {
		return nil, "", "cert_bad_cn"
	}
	if err := trust.Current().VerifyPhase4Leaf(leaf, now); err != nil {
		return nil, "", "cert_untrusted"
	}
	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return leaf, hex.EncodeToString(sum[:]), ""
}

// ── /acme/finalize ───────────────────────────────────────────────────────────

type acmeFinalizeRequest struct {
	Serial         string   `json:"serial"`
	OU             string   `json:"ou"`
	CSRDer         string   `json:"csrDer"`         // base64 DER of PKCS#10 CSR
	AttestationX5C []string `json:"attestationX5c"` // base64 DER cert chain (leaf first)
}

type acmeFinalizeResponse struct {
	Outcome string `json:"outcome"` // "issued" | "refused"
	Reason  string `json:"reason,omitempty"`
	CertPEM string `json:"certPem,omitempty"` // leaf + intermediate PEM
}

// handleACMEFinalize independently re-verifies every cryptographic proof
// without trusting acmed:
//   - x5c chains to pinned Apple Enterprise Attestation Root CA
//   - leaf Apple serial extension == serial
//   - CSR signature valid and CSR public key SPKI == attested leaf public key SPKI
//   - CSR subject has ONLY CN == serial and one OU == ou
//   - OU permit token verifies under ENROLLCTL_ACME_PERMIT_KEYS (MAC + exp + device_id)
//   - micro-batcher locks account -> device, enforces bindRefusal + deviceKeyRefusal + #536 conflict rule
//   - issues 26280h Mac client cert from the device intermediate (apple.tpl rules)
//
// Security property: a compromised acmed cannot get a certificate for any key
// Apple did not attest for that serial, and cannot bind anything without a live
// permit that only the Mac received inside its encrypted profile.
func (h *Handler) handleACMEFinalize(ctx context.Context, w http.ResponseWriter, body []byte) {
	start := time.Now()
	var req acmeFinalizeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	if !isValidSerial(req.Serial) || req.OU == "" || req.CSRDer == "" || len(req.AttestationX5C) == 0 || len(req.AttestationX5C) > 8 {
		h.logPhase("acme_finalize", "bad_body", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "bad_body"})
		return
	}
	now := h.deps.Now().UTC()

	// 1. Independently verify the OU permit MAC + expiry + device id.
	permit, err := enrolltoken.VerifyACMEPermit(h.deps.ACMEPermitKeys, req.OU, now)
	if err != nil {
		reason := "invalid_permit"
		if errors.Is(err, enrolltoken.ErrExpired) {
			reason = "permit_expired"
		}
		h.logPhase("acme_finalize", reason, "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: reason})
		return
	}

	// 2. Decode and independently verify the Apple Enterprise Attestation x5c chain.
	x5c := make([][]byte, len(req.AttestationX5C))
	for i, b64 := range req.AttestationX5C {
		der, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(der) == 0 {
			h.logPhase("acme_finalize", "bad_attestation", "", req.Serial, start)
			writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "bad_attestation"})
			return
		}
		x5c[i] = der
	}
	attData, err := h.deps.AppleAttest.VerifyChain(x5c, now)
	if err != nil {
		h.logPhase("acme_finalize", "attestation_untrusted", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "attestation_untrusted"})
		return
	}
	if attData.SerialNumber != req.Serial {
		h.logPhase("acme_finalize", "attestation_serial_mismatch", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "attestation_serial_mismatch"})
		return
	}

	// 3. Parse CSR, check signature, check subject (ONLY CN=serial + 1 OU=req.OU),
	//    and verify CSR public key equals the Apple-attested leaf public key.
	csrDER, err := base64.StdEncoding.DecodeString(req.CSRDer)
	if err != nil || len(csrDER) == 0 {
		h.logPhase("acme_finalize", "bad_csr", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "bad_csr"})
		return
	}
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil || csr.CheckSignature() != nil {
		h.logPhase("acme_finalize", "invalid_csr", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "invalid_csr"})
		return
	}
	if reason := ValidateMacACMECSRSubject(csr, req.Serial, req.OU); reason != "" {
		h.logPhase("acme_finalize", reason, "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: reason})
		return
	}
	csrSPKI, err := x509.MarshalPKIXPublicKey(csr.PublicKey)
	if err != nil {
		h.logPhase("acme_finalize", "invalid_csr_key", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "invalid_csr_key"})
		return
	}
	csrKeyHash := sha256.Sum256(csrSPKI)
	if !bytes.Equal(csrKeyHash[:], attData.PublicKeySha256[:]) {
		h.logPhase("acme_finalize", "csr_key_mismatch", "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: "csr_key_mismatch"})
		return
	}

	if h.deps.DeviceCAIssuer == nil {
		h.logPhase("acme_finalize", "issuer_not_configured", "", req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	// 4. Bind the attested key to the Mac device row through the micro-batcher.
	bindRes := h.deps.Batcher.BindMac(ctx, BindMacRequest{
		DeviceID:  permit.DeviceID,
		Serial:    req.Serial,
		KeySha256: csrKeyHash[:],
	})
	if bindRes.Err != nil {
		h.logPhase("acme_finalize", "db_unavailable", "", req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if !bindRes.OK {
		h.logPhase("acme_finalize", bindRes.RefusalCode, "", req.Serial, start)
		writeJSON(w, http.StatusOK, acmeFinalizeResponse{Outcome: "refused", Reason: bindRes.RefusalCode})
		return
	}

	// 5. Issue the Mac client certificate from the device intermediate (outside DB tx!).
	_, chainPEM, err := h.deps.DeviceCAIssuer.IssueMacACMECert(csr.PublicKey, req.Serial, req.OU, now)
	if err != nil {
		h.logPhase("acme_finalize", "issue_error", "", req.Serial, start)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	h.logPhase("acme_finalize", "issued", "", req.Serial, start)
	writeJSON(w, http.StatusOK, acmeFinalizeResponse{
		Outcome: "issued",
		CertPEM: chainPEM,
	})
}

// ValidateMacACMECSRSubject verifies that csr carries CN == expectedSerial,
// exactly one OU (matching expectedOU when non-empty), and no unexpected
// subject attributes.
func ValidateMacACMECSRSubject(csr *x509.CertificateRequest, expectedSerial, expectedOU string) string {
	if csr.Subject.CommonName != expectedSerial {
		return "csr_cn_mismatch"
	}
	if len(csr.Subject.OrganizationalUnit) != 1 {
		return "csr_ou_count"
	}
	if expectedOU != "" && csr.Subject.OrganizationalUnit[0] != expectedOU {
		return "csr_ou_mismatch"
	}
	if len(csr.Subject.Country) > 0 ||
		len(csr.Subject.Organization) > 0 ||
		len(csr.Subject.Locality) > 0 ||
		len(csr.Subject.Province) > 0 ||
		len(csr.Subject.StreetAddress) > 0 ||
		len(csr.Subject.PostalCode) > 0 ||
		csr.Subject.SerialNumber != "" {
		return "csr_unexpected_subject"
	}
	// Check every raw RDN attribute is strictly CN (2.5.4.3) or OU (2.5.4.11)
	// and each appears exactly once.
	cnCount, ouCount := 0, 0
	for _, atv := range csr.Subject.Names {
		switch {
		case atv.Type.Equal(oidCommonName):
			cnCount++
		case atv.Type.Equal(oidOrganizationalUnit):
			ouCount++
		default:
			return "csr_unexpected_subject"
		}
	}
	if cnCount != 1 || ouCount != 1 {
		return "csr_unexpected_subject"
	}
	return ""
}

func (h *Handler) logPhase(phase, outcome, product, serial string, start time.Time) {
	if h.deps.Log == nil {
		return
	}
	attrs := []any{
		"phase", phase,
		"outcome", outcome,
		"duration_ms", time.Since(start).Milliseconds(),
	}
	if product != "" {
		attrs = append(attrs, "product", product)
	}
	if serial != "" {
		attrs = append(attrs, "serial_hash", h.hashSerialForLog(serial))
	}
	h.deps.Log.Info("enrollctl request", attrs...)
}
