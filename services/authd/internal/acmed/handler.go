package acmed

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
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

	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

const (
	// MaxBodyBytes caps every ACME request body.
	MaxBodyBytes = 64 * 1024

	// DefaultBaseURL is the configured public origin for URL validation and links.
	// acmed NEVER derives URLs from the incoming HTTP Host header.
	DefaultBaseURL = "https://ca.i10.tech"
	// DefaultPrefix is the ACME path prefix routed by Traefik.
	DefaultPrefix = "/acme/apple"

	// defaultStateLifetime is how long an order, authorization and issued
	// certificate live at most: a sealed Mac's ACME window. An object never
	// outlives the path token it was made under. Each save keeps the object's
	// remaining lifetime.
	defaultStateLifetime      = enrolltoken.ACMEPathLifetime
	defaultMaxOrdersPerDevice = 20
	defaultRequestTimeout     = 10 * time.Second
)

// Every ACME URL is under a Mac's path token: <base><prefix>/d/<token>/...
//
// ⚠ THE TOKEN IS VERIFIED BEFORE ANYTHING ELSE (enrolltoken.VerifyACMEPath:
// encoding, key id, MAC, expiry), with no Redis call. A missing, bad, expired
// or unknown-key token is a bare 404 with no Replay-Nonce. Only a sealed Mac's
// encrypted profile carries a token, so without one nobody reaches Redis. The
// token names a device id and a serial: new-order must be for that serial,
// and every order, authorization and certificate records the device id and
// refuses a request under another device's token (as well as another
// account's).
//
// Nonce spend rule, for every JWS handler:
//   - The nonce is always checked statelessly first (its own MAC and expiry).
//   - A read-only request (POST-as-GET on an account, order, authorization,
//     challenge or certificate, and a challenge response that changes nothing
//     because the challenge and its order are already done) spends NO nonce,
//     like newAccount. A replay of it changes nothing.
//   - A request that changes state spends its nonce inside the one script
//     that makes the change, after every check that can refuse it and before
//     its first write: new-order in acme_create_order.lua (after the device's
//     order cap), a challenge response in acme_answer_challenge.lua (after
//     payload validation and the attestation check in Go, and the pending
//     check in the script), finalize's claim of a ready order in
//     acme_move_order.lua (after the CSR, subject and key checks in Go). A
//     refusal writes nothing.
//
// Every transition is one compare-and-set script, so of N concurrent requests
// on one object exactly one moves it and spends; the rest change nothing.
// Finalize claims the order (ready -> processing) BEFORE it calls enrollctl,
// and completes it from processing only (to valid with the certificate, to
// invalid, or back to ready when enrollctl is unavailable); a finalize that
// finds it processing gets orderNotReady with Retry-After.
//
// So with a valid path token, Redis holds at most (devices sealed in the last
// 10 minutes) x MaxOrdersPerDevice orders with their authorizations and
// certificates, plus the nonces their state changes spent; without one,
// nothing.

// HandlerDeps configures the ACME server.
type HandlerDeps struct {
	Store              enrollredis.Store
	Finalizer          Finalizer
	AppleAttest        *appleattest.Verifier
	NonceKeys          *enrolltoken.Ring // ACMED_NONCE_KEYS: MACs the stateless Replay-Nonces and account URLs
	PathKeys           *enrolltoken.Ring // ENROLL_ACME_PATH_KEYS: verifies the Mac path tokens enrollctl signs
	BaseURL            string            // configured scheme+host (e.g. https://ca.i10.tech); NEVER from Host
	Prefix             string            // e.g. /acme/apple
	StateLifetime      time.Duration
	MaxOrdersPerDevice int // ACMED_MAX_ORDERS_PER_DEVICE
	RequestTimeout     time.Duration
	CompleteTimeout    time.Duration // 0 means completeTimeout; tests shorten it
	Now                func() time.Time
	Log                *slog.Logger
}

// Handler serves the RFC 8555 ACME subset used by macOS com.apple.security.acme.
type Handler struct {
	deps      HandlerDeps
	nonces    nonceMinter
	baseURL   string
	prefix    string
	serialKey [32]byte
}

// NewHandler creates an ACME HTTP handler.
func NewHandler(deps HandlerDeps) *Handler {
	if deps.BaseURL == "" {
		deps.BaseURL = DefaultBaseURL
	}
	if deps.Prefix == "" {
		deps.Prefix = DefaultPrefix
	}
	if deps.StateLifetime <= 0 {
		deps.StateLifetime = defaultStateLifetime
	}
	if deps.MaxOrdersPerDevice <= 0 {
		deps.MaxOrdersPerDevice = defaultMaxOrdersPerDevice
	}
	if deps.RequestTimeout <= 0 {
		deps.RequestTimeout = defaultRequestTimeout
	}
	if deps.CompleteTimeout <= 0 {
		deps.CompleteTimeout = completeTimeout
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.AppleAttest == nil {
		deps.AppleAttest = appleattest.NewProductionVerifier()
	}
	h := &Handler{
		deps:    deps,
		nonces:  nonceMinter{ring: deps.NonceKeys},
		baseURL: strings.TrimRight(deps.BaseURL, "/"),
		prefix:  "/" + strings.Trim(deps.Prefix, "/"),
	}
	_, _ = rand.Read(h.serialKey[:])
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

// route is one request's verified path token and the URLs under it.
type route struct {
	base   string // <BaseURL><Prefix>/d/<token>
	claims enrolltoken.ACMEPathClaims
}

func (rt route) url(subpath string) string { return rt.base + subpath }

// exchange is one request's response writer and route.
type exchange struct {
	w  http.ResponseWriter
	rt route
}

// owns reports whether an object recorded under (accountID, deviceID) belongs
// to this request's account and path token.
func (x exchange) owns(a *authed, accountID, deviceID string) bool {
	return accountID == a.acct.Thumbprint && deviceID == x.rt.claims.DeviceID
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			// ⚠ NEVER THE PATH OR THE PANIC VALUE: the path carries the Mac's
			// path token (and its serial), and a panic value can carry request
			// data. Only the value's type is logged.
			if h.deps.Log != nil {
				h.deps.Log.Error("acmed panic recovered", "panic_type", fmt.Sprintf("%T", rec))
			}
			w.WriteHeader(http.StatusInternalServerError)
		}
	}()

	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.URL.RawQuery != "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	rt, sub, ok := h.verifyRoute(r.URL.Path)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	x := exchange{w: w, rt: rt}

	ctx, cancel := context.WithTimeout(r.Context(), h.deps.RequestTimeout)
	defer cancel()

	// Public unauthenticated endpoints: directory and new-nonce.
	switch sub {
	case "/directory":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		h.handleDirectory(x, r)
		return
	case "/new-nonce":
		if r.Method != http.MethodHead && r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		h.handleNewNonce(x, r)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if ct != "application/jose+json" {
		h.writeProblem(x, newProblem(http.StatusUnsupportedMediaType, ProblemMalformed, "Content-Type must be application/jose+json"))
		return
	}
	body, ok := readBounded(r.Body, MaxBodyBytes)
	if !ok {
		h.writeProblem(x, newProblem(http.StatusRequestEntityTooLarge, ProblemMalformed, "request body empty or too large"))
		return
	}

	// Route POST endpoints.
	switch {
	case sub == "/new-account":
		h.handleNewAccount(x, body)
	case strings.HasPrefix(sub, accountPath):
		h.handleAccount(x, body, sub)
	case sub == "/new-order":
		h.handleNewOrder(ctx, x, body)
	case strings.HasPrefix(sub, "/authz/"):
		authzID := strings.TrimPrefix(sub, "/authz/")
		if !isSafeID(authzID) {
			h.writeProblem(x, newProblem(http.StatusNotFound, ProblemMalformed, "authorization not found"))
			return
		}
		h.handleAuthz(ctx, x, body, authzID)
	case strings.HasPrefix(sub, "/challenge/"):
		rest := strings.TrimPrefix(sub, "/challenge/")
		authzID, chalID, found := strings.Cut(rest, "/")
		if !found || !isSafeID(authzID) || !isSafeID(chalID) {
			h.writeProblem(x, newProblem(http.StatusNotFound, ProblemMalformed, "challenge not found"))
			return
		}
		h.handleChallenge(ctx, x, body, authzID, chalID)
	case strings.HasPrefix(sub, "/order/") && strings.HasSuffix(sub, "/finalize"):
		orderID := strings.TrimSuffix(strings.TrimPrefix(sub, "/order/"), "/finalize")
		if !isSafeID(orderID) {
			h.writeProblem(x, newProblem(http.StatusNotFound, ProblemMalformed, "order not found"))
			return
		}
		h.handleFinalize(ctx, x, body, orderID)
	case strings.HasPrefix(sub, "/order/"):
		orderID := strings.TrimPrefix(sub, "/order/")
		if !isSafeID(orderID) {
			h.writeProblem(x, newProblem(http.StatusNotFound, ProblemMalformed, "order not found"))
			return
		}
		h.handleOrder(ctx, x, body, orderID)
	case strings.HasPrefix(sub, "/certificate/"):
		certID := strings.TrimPrefix(sub, "/certificate/")
		if !isSafeID(certID) {
			h.writeProblem(x, newProblem(http.StatusNotFound, ProblemMalformed, "certificate not found"))
			return
		}
		h.handleCertificate(ctx, x, body, certID)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// verifyRoute splits <prefix>/d/<token><sub> and verifies the token, with no
// Redis call. ok is false for any path that is not under a valid, unexpired
// token.
func (h *Handler) verifyRoute(path string) (route, string, bool) {
	rest, ok := strings.CutPrefix(path, h.prefix+enrolltoken.ACMEPathSegment)
	if !ok {
		return route{}, "", false
	}
	token, sub, ok := strings.Cut(rest, "/")
	if !ok {
		return route{}, "", false
	}
	claims, err := enrolltoken.VerifyACMEPath(h.deps.PathKeys, token, h.deps.Now())
	if err != nil {
		return route{}, "", false
	}
	return route{base: h.baseURL + h.prefix + enrolltoken.ACMEPathSegment + token, claims: claims}, "/" + sub, true
}

func (h *Handler) handleDirectory(x exchange, r *http.Request) {
	w := x.w
	dir := map[string]string{
		"newNonce":   x.rt.url("/new-nonce"),
		"newAccount": x.rt.url("/new-account"),
		"newOrder":   x.rt.url("/new-order"),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(dir)
	}
}

func (h *Handler) handleNewNonce(x exchange, r *http.Request) {
	w := x.w
	nonce, err := h.issueNonce()
	if err != nil {
		h.writeProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "nonce unavailable"))
		return
	}
	w.Header().Set("Replay-Nonce", nonce)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Link", fmt.Sprintf("<%s>;rel=\"index\"", x.rt.url("/directory")))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}

// checkNonce checks the JWS's Replay-Nonce statelessly (length, alphabet, MAC,
// expiry), so no nonce acmed did not issue reaches Redis. It returns how long
// the nonce still lives.
func (h *Handler) checkNonce(nonce string) (time.Duration, *Problem) {
	left, err := h.nonces.check(nonce, h.deps.Now())
	if err != nil {
		return 0, newProblem(http.StatusBadRequest, ProblemBadNonce, "invalid or expired Replay-Nonce")
	}
	return left, nil
}

// authed is a request whose JWS verified under an account URL acmed issued,
// with a nonce that verified statelessly. Nothing has touched Redis yet.
type authed struct {
	jws       *ParsedJWS
	acct      *account
	nonceLeft time.Duration
}

// authenticate verifies a JWS carrying a `kid`, in this order, WITHOUT ANY
// REDIS CALL:
//  1. structure, alg allowlist and the configured URL;
//  2. the Replay-Nonce's own MAC and expiry;
//  3. the account URL's MAC (accountDoesNotExist otherwise) and the signature
//     under the key it names.
//
// The URL is the one under this request's path token. The caller then checks
// the request's own authorization, and spends the nonce only by the spend
// rule at the top of this file.
func (h *Handler) authenticate(x exchange, body []byte, subpath string) (*authed, *Problem) {
	parsed, err := ParseFlattenedJWS(body, x.rt.url(subpath), false)
	if err != nil {
		return nil, asProblem(err)
	}
	left, prob := h.checkNonce(parsed.Header.Nonce)
	if prob != nil {
		return nil, prob
	}
	acct := h.parseAccountURL(x.rt, parsed.Header.KID)
	if acct == nil {
		return nil, newProblem(http.StatusBadRequest, ProblemAccountDoesNotExist, "account does not exist")
	}
	if err := parsed.VerifySignature(acct.Pub); err != nil {
		return nil, asProblem(err)
	}
	return &authed{jws: parsed, acct: acct, nonceLeft: left}, nil
}

// nonceSpendMargin keeps a spent nonce's key past the nonce's own expiry, so a
// replica whose clock runs behind still finds it spent.
const nonceSpendMargin = 60 * time.Second

// spendTTL is how long the request's spent nonce is kept. A state change
// spends it only inside the script that makes the change.
func (a *authed) spendTTL() time.Duration { return a.nonceLeft + nonceSpendMargin }

// newAccountPayload is what newAccount reads. `contact` is ignored: an account
// is its key and nothing the client chose.
type newAccountPayload struct {
	TermsOfServiceAgreed bool `json:"termsOfServiceAgreed,omitempty"`
	OnlyReturnExisting   bool `json:"onlyReturnExisting,omitempty"`
}

// handleNewAccount answers the account URL for the JWS's key. ⚠ IT WRITES
// NOTHING AND SPENDS NO NONCE: it is idempotent, and every key "exists", so
// onlyReturnExisting answers 200 with the same URL.
func (h *Handler) handleNewAccount(x exchange, body []byte) {
	parsed, err := ParseFlattenedJWS(body, x.rt.url("/new-account"), true)
	if err != nil {
		h.writeProblem(x, asProblem(err))
		return
	}
	if _, prob := h.checkNonce(parsed.Header.Nonce); prob != nil {
		h.writeProblem(x, prob)
		return
	}
	if err := parsed.VerifySignature(parsed.PubKey); err != nil {
		h.writeProblem(x, asProblem(err))
		return
	}
	var pay newAccountPayload
	if len(parsed.Payload) > 0 {
		if err := json.Unmarshal(parsed.Payload, &pay); err != nil {
			h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "invalid newAccount payload"))
			return
		}
	}
	acctURL, err := h.accountURL(x.rt, parsed.RawJWK)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "account key unavailable"))
		return
	}
	status := http.StatusCreated
	if pay.OnlyReturnExisting {
		status = http.StatusOK
	}
	h.writeACMEJSON(x, status, acctURL, "", map[string]any{"status": "valid"})
}

// handleAccount answers POST-as-GET on an account URL. Like newAccount it
// writes nothing and spends no nonce: a replay of it changes nothing.
func (h *Handler) handleAccount(x exchange, body []byte, sub string) {
	a, prob := h.authenticate(x, body, sub)
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	if a.acct.URL != x.rt.url(sub) {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "account mismatch"))
		return
	}
	if len(a.jws.Payload) != 0 {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "account endpoint supports POST-as-GET only"))
		return
	}
	h.writeACMEJSON(x, http.StatusOK, a.acct.URL, "", map[string]any{"status": "valid"})
}

type acmeIdentifier struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type newOrderPayload struct {
	Identifiers []acmeIdentifier `json:"identifiers"`
}

func (h *Handler) handleNewOrder(ctx context.Context, x exchange, body []byte) {
	a, prob := h.authenticate(x, body, "/new-order")
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	var pay newOrderPayload
	if len(a.jws.Payload) == 0 || json.Unmarshal(a.jws.Payload, &pay) != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "invalid newOrder payload"))
		return
	}
	if len(pay.Identifiers) != 1 {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "order must contain exactly one identifier"))
		return
	}
	id := pay.Identifiers[0]
	if id.Type != "permanent-identifier" {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemUnsupportedIdentifier, "only permanent-identifier is supported"))
		return
	}
	if !isValidSerial(id.Value) {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemRejectedIdentifier, "invalid permanent-identifier"))
		return
	}
	// The path token is this request's authorization, and it covers one
	// serial: no Redis call for any other.
	if id.Value != x.rt.claims.Serial {
		h.logEvent("new_order", "serial_not_allowed", id.Value)
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemRejectedIdentifier, "device is not eligible for ACME enrollment"))
		return
	}

	orderID, err := randomID()
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusInternalServerError, ProblemServerInternal, "id generation failed"))
		return
	}
	authzID, err := randomID()
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusInternalServerError, ProblemServerInternal, "id generation failed"))
		return
	}
	chalID, err := randomID()
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusInternalServerError, ProblemServerInternal, "id generation failed"))
		return
	}
	chalToken, err := randomID()
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusInternalServerError, ProblemServerInternal, "token generation failed"))
		return
	}

	now := h.deps.Now().UTC()
	exp := now.Add(h.deps.StateLifetime)
	if x.rt.claims.ExpiresAt.Before(exp) {
		exp = x.rt.claims.ExpiresAt
	}
	dev := x.rt.claims.DeviceID

	order := enrollredis.ACMEOrder{
		ID:        orderID,
		AccountID: a.acct.Thumbprint,
		DeviceID:  dev,
		Status:    "pending",
		Expires:   exp,
		Serial:    id.Value,
		AuthzID:   authzID,
	}
	authz := enrollredis.ACMEAuthz{
		ID:         authzID,
		AccountID:  a.acct.Thumbprint,
		DeviceID:   dev,
		OrderID:    orderID,
		Status:     "pending",
		Expires:    exp,
		Serial:     id.Value,
		ChalID:     chalID,
		ChalToken:  chalToken,
		ChalStatus: "pending",
	}

	// The script checks the device's cap, then spends the nonce, then writes.
	st, err := h.deps.Store.CreateACMEOrder(ctx, order, authz, a.jws.Header.Nonce, a.spendTTL(), h.deps.MaxOrdersPerDevice, now)
	if err != nil {
		h.writeStoreProblem(x, err, "order")
		return
	}
	switch st {
	case "OK":
	case "order_cap_exceeded":
		h.logEvent("new_order", "order_cap_exceeded", id.Value)
		h.writeAuthedProblem(x, newProblem(http.StatusTooManyRequests, ProblemRateLimited, "too many orders for this device"))
		return
	case "bad_nonce":
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadNonce, "Replay-Nonce already used"))
		return
	default:
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "unexpected order store status"))
		return
	}

	h.logEvent("new_order", "created", id.Value)
	h.writeACMEJSON(x, http.StatusCreated, x.rt.url("/order/"+order.ID), "", h.renderOrder(x.rt, order))
}

// handleAuthz is POST-as-GET on an authorization: read-only, no nonce spent.
func (h *Handler) handleAuthz(ctx context.Context, x exchange, body []byte, authzID string) {
	a, prob := h.authenticate(x, body, "/authz/"+authzID)
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	if len(a.jws.Payload) != 0 {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "authz supports POST-as-GET only"))
		return
	}
	authz, err := h.deps.Store.GetACMEAuthz(ctx, authzID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "authz store unavailable"))
		return
	}
	if authz == nil || !x.owns(a, authz.AccountID, authz.DeviceID) {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "authorization not found"))
		return
	}
	h.writeACMEJSON(x, http.StatusOK, "", "", h.renderAuthz(x.rt, *authz))
}

type challengePayload struct {
	AttObj string `json:"attObj"`
	Error  string `json:"error"`
}

func (h *Handler) handleChallenge(ctx context.Context, x exchange, body []byte, authzID, chalID string) {
	a, prob := h.authenticate(x, body, "/challenge/"+authzID+"/"+chalID)
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	authz, err := h.deps.Store.GetACMEAuthz(ctx, authzID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "authz store unavailable"))
		return
	}
	if authz == nil || !x.owns(a, authz.AccountID, authz.DeviceID) || authz.ChalID != chalID {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "challenge not found"))
		return
	}
	now := h.deps.Now().UTC()
	if !now.Before(authz.Expires) {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, "authorization expired"))
		return
	}
	upLink := x.rt.url("/authz/" + authz.ID)

	// POST-as-GET poll: read-only, no nonce spent.
	if len(a.jws.Payload) == 0 {
		h.writeACMEJSON(x, http.StatusOK, "", upLink, h.renderChallenge(x.rt, *authz))
		return
	}
	// Already validated: idempotent, and it finishes an order an earlier
	// writer left pending. Only that finishing write spends the nonce.
	if authz.ChalStatus == "valid" {
		h.answerValidChallenge(ctx, x, a, authz, upLink)
		return
	}
	if authz.ChalStatus != "pending" {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "challenge is not pending"))
		return
	}

	// Payload validation. A malformed response is refused before the spend and
	// writes nothing; the challenge stays pending for a corrected retry.
	var pay challengePayload
	if err := json.Unmarshal(a.jws.Payload, &pay); err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "invalid challenge payload"))
		return
	}
	var attObj *AppleAttestationObj
	if pay.Error == "" {
		attBytes, err := base64.RawURLEncoding.DecodeString(pay.AttObj)
		if err != nil || len(attBytes) == 0 || bytes.Equal(attBytes, []byte("{}")) {
			h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadAttestationStatement, "invalid attObj"))
			return
		}
		if attObj, err = ParseAppleAttestationCBOR(attBytes); err != nil {
			h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadAttestationStatement, "invalid attestation object"))
			return
		}
	}

	// The attestation is checked before any state (pure CPU); the answer,
	// valid or invalid, is then one script.
	ans, refusal := h.verifyChallengeAnswer(authz, pay, attObj, now)
	ans.AuthzID, ans.OrderID, ans.ChalID = authz.ID, authz.OrderID, authz.ChalID
	ans.AccountID, ans.DeviceID = a.acct.Thumbprint, x.rt.claims.DeviceID
	ans.Nonce, ans.NonceTTL = a.jws.Header.Nonce, a.spendTTL()
	res, err := h.deps.Store.AnswerACMEChallenge(ctx, ans)
	if err != nil {
		h.writeStoreProblem(x, err, "authz")
		return
	}
	switch res.Outcome {
	case enrollredis.ACMEOK:
	case enrollredis.ACMENotPending:
		// Another answer moved it first. This one spent nothing.
		if res.Status == "valid" {
			if cur, err := h.deps.Store.GetACMEAuthz(ctx, authzID); err == nil && cur != nil {
				h.answerValidChallenge(ctx, x, a, cur, upLink)
				return
			}
		}
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "challenge is not pending"))
		return
	case enrollredis.ACMEBadNonce:
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadNonce, "Replay-Nonce already used"))
		return
	case enrollredis.ACMEOrderMissing:
		h.writeStoreProblem(x, errOrderMissing, "order")
		return
	default:
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "challenge not found"))
		return
	}
	if refusal != nil {
		h.writeAuthedProblem(x, refusal)
		return
	}
	authz.ChalStatus, authz.Status = "valid", "valid"
	authz.AttestedKeySha256, authz.AttestedX5CB64, authz.ValidatedAt = ans.AttestedKeySha256, ans.AttestedX5CB64, ans.ValidatedAt
	h.logEvent("challenge", "valid", authz.Serial)
	h.writeACMEJSON(x, http.StatusOK, "", upLink, h.renderChallenge(x.rt, *authz))
}

// verifyChallengeAnswer checks a challenge response's attestation, with no
// state. It returns the answer to record and, for an invalid one, the
// problem to send.
func (h *Handler) verifyChallengeAnswer(authz *enrollredis.ACMEAuthz, pay challengePayload, attObj *AppleAttestationObj, now time.Time) (enrollredis.ACMEChallengeAnswer, *Problem) {
	if pay.Error != "" {
		return enrollredis.ACMEChallengeAnswer{ErrorType: ProblemRejectedIdentifier, ErrorMsg: "client reported attestation error"},
			newProblem(http.StatusForbidden, ProblemRejectedIdentifier, "attestation rejected")
	}
	data, err := h.deps.AppleAttest.VerifyChallenge(attObj.X5C, authz.Serial, authz.ChalToken, now)
	if err != nil {
		detail := "apple attestation verification failed"
		switch {
		case errors.Is(err, appleattest.ErrMissingNonce):
			detail = "attestation leaf missing nonce extension"
		case errors.Is(err, appleattest.ErrNonceMismatch):
			detail = "attestation nonce mismatch"
		case errors.Is(err, appleattest.ErrSerialMismatch):
			detail = "attestation serial mismatch"
		}
		h.logEvent("challenge", detail, authz.Serial)
		return enrollredis.ACMEChallengeAnswer{ErrorType: ProblemBadAttestationStatement, ErrorMsg: detail},
			newProblem(http.StatusBadRequest, ProblemBadAttestationStatement, detail)
	}
	x5cB64 := make([]string, len(attObj.X5C))
	for i, c := range attObj.X5C {
		x5cB64[i] = base64.StdEncoding.EncodeToString(c)
	}
	return enrollredis.ACMEChallengeAnswer{
		Valid:             true,
		AttestedKeySha256: data.PublicKeyHex,
		AttestedX5CB64:    x5cB64,
		ValidatedAt:       now.Format(time.RFC3339),
	}, nil
}

// answerValidChallenge answers a response to a challenge that is already
// valid. When its order is past pending nothing changes and no nonce is
// spent; when the order is still pending, one compare-and-set moves it to
// ready and spends the nonce (a burst of these moves it once).
func (h *Handler) answerValidChallenge(ctx context.Context, x exchange, a *authed, authz *enrollredis.ACMEAuthz, upLink string) {
	order, err := h.deps.Store.GetACMEOrder(ctx, authz.OrderID)
	if err != nil {
		h.writeStoreProblem(x, err, "order")
		return
	}
	if order == nil {
		h.writeStoreProblem(x, errOrderMissing, "order")
		return
	}
	if order.Status == "pending" {
		res, err := h.deps.Store.MoveACMEOrder(ctx, enrollredis.ACMEOrderMove{
			OrderID: order.ID, AccountID: a.acct.Thumbprint, DeviceID: x.rt.claims.DeviceID,
			From: "pending", To: "ready", Nonce: a.jws.Header.Nonce, NonceTTL: a.spendTTL(),
		})
		if err != nil {
			h.writeStoreProblem(x, err, "order")
			return
		}
		switch res.Outcome {
		case enrollredis.ACMEOK, enrollredis.ACMEConflict: // moved, here or by another request
		case enrollredis.ACMEBadNonce:
			h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadNonce, "Replay-Nonce already used"))
			return
		default:
			h.writeStoreProblem(x, errOrderMissing, "order")
			return
		}
	}
	h.writeACMEJSON(x, http.StatusOK, "", upLink, h.renderChallenge(x.rt, *authz))
}

// errOrderMissing is a valid authz whose order is gone: answered as 503.
var errOrderMissing = errors.New("acmed: the authorization's order is missing")

type finalizePayload struct {
	CSR string `json:"csr"`
}

func (h *Handler) handleFinalize(ctx context.Context, x exchange, body []byte, orderID string) {
	a, prob := h.authenticate(x, body, "/order/"+orderID+"/finalize")
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	order, err := h.deps.Store.GetACMEOrder(ctx, orderID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "order store unavailable"))
		return
	}
	if order == nil || !x.owns(a, order.AccountID, order.DeviceID) {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "order not found"))
		return
	}
	now := h.deps.Now().UTC()
	if !now.Before(order.Expires) {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, "order expired"))
		return
	}
	if order.Status == "processing" {
		h.writeOrderProcessing(x)
		return
	}
	if order.Status != "ready" {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemOrderNotReady, "order is not ready for finalization"))
		return
	}
	authz, err := h.deps.Store.GetACMEAuthz(ctx, order.AuthzID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "authz store unavailable"))
		return
	}
	if authz == nil || !x.owns(a, authz.AccountID, authz.DeviceID) || authz.Status != "valid" || authz.AttestedKeySha256 == "" || len(authz.AttestedX5CB64) == 0 {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemOrderNotReady, "authorization is not valid"))
		return
	}
	if !now.Before(authz.Expires) {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, "authorization expired"))
		return
	}

	csrDER, ou, prob := h.checkFinalizeCSR(a, order, authz)
	if prob != nil {
		h.writeAuthedProblem(x, prob)
		return
	}
	// Every check that can refuse is done: claim the order (ready ->
	// processing) and spend the nonce in one script. Only the claimant calls
	// enrollctl.
	move := enrollredis.ACMEOrderMove{OrderID: order.ID, AccountID: a.acct.Thumbprint, DeviceID: x.rt.claims.DeviceID}
	claim := move
	claim.From, claim.To, claim.Nonce, claim.NonceTTL = "ready", "processing", a.jws.Header.Nonce, a.spendTTL()
	res, err := h.deps.Store.MoveACMEOrder(ctx, claim)
	if err != nil {
		h.writeStoreProblem(x, err, "order")
		return
	}
	switch res.Outcome {
	case enrollredis.ACMEOK:
	case enrollredis.ACMEConflict:
		if res.Status == "processing" {
			h.writeOrderProcessing(x)
			return
		}
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemOrderNotReady, "order is not ready for finalization"))
		return
	case enrollredis.ACMEBadNonce:
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemBadNonce, "Replay-Nonce already used"))
		return
	default:
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "order not found"))
		return
	}

	// The order is this request's until it completes it, from processing
	// only, even if the client has gone. The completion's clock starts once
	// enrollctl has answered, so a slow enrollctl call cannot spend it.
	complete := func(m enrollredis.ACMEOrderMove) (enrollredis.ACMEResult, error) {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.deps.CompleteTimeout)
		defer cancel()
		m.From = "processing"
		return h.deps.Store.MoveACMEOrder(cctx, m)
	}

	finResp, err := h.deps.Finalizer.Finalize(ctx, FinalizeRequest{
		Serial:         order.Serial,
		OU:             ou,
		CSRDer:         base64.StdEncoding.EncodeToString(csrDER),
		AttestationX5C: authz.AttestedX5CB64,
	})
	if err != nil {
		h.logEvent("finalize", "upstream_unavailable", order.Serial)
		back := move
		back.To = "ready"
		if _, err := complete(back); err != nil && h.deps.Log != nil {
			h.deps.Log.Warn("acmed could not return an order to ready", slog.Any("err", err))
		}
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "issuance backend unavailable"))
		return
	}
	if finResp.Outcome != "issued" || finResp.CertPEM == "" {
		h.logEvent("finalize", "refused:"+finResp.Reason, order.Serial)
		refused := move
		refused.To, refused.ErrorType, refused.ErrorMsg = "invalid", ProblemUnauthorized, "enrollment authorization refused"
		if _, err := complete(refused); err != nil && h.deps.Log != nil {
			h.deps.Log.Warn("acmed could not mark a refused order invalid", slog.Any("err", err))
		}
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, "certificate issuance refused"))
		return
	}

	certID, err := randomID()
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusInternalServerError, ProblemServerInternal, "id generation failed"))
		return
	}
	issued := move
	issued.To, issued.CertID, issued.Now = "valid", certID, h.deps.Now().UTC()
	issued.Cert = &enrollredis.ACMECert{AccountID: a.acct.Thumbprint, DeviceID: order.DeviceID, PEM: finResp.CertPEM, Expires: order.Expires}
	res, err = complete(issued)
	if err != nil {
		h.writeStoreProblem(x, err, "order")
		return
	}
	if res.Outcome != enrollredis.ACMEOK {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, "order expired"))
		return
	}
	order.Status, order.CertID = "valid", certID

	h.logEvent("finalize", "valid", order.Serial)
	h.writeACMEJSON(x, http.StatusOK, x.rt.url("/order/"+order.ID), "", h.renderOrder(x.rt, *order))
}

// completeTimeout bounds the write that completes a claimed order (valid,
// invalid, or back to ready), which runs even after the client has gone so
// the order does not stay processing until it expires. It starts when
// enrollctl answers.
const completeTimeout = 2 * time.Second

// MaxHandlerDuration is the longest one request can run with requestTimeout
// (HandlerDeps.RequestTimeout): a finalize spends up to requestTimeout up to
// and including the enrollctl call, then completeTimeout on the one write that
// completes the order. The server's WriteTimeout must exceed it.
func MaxHandlerDuration(requestTimeout time.Duration) time.Duration {
	return requestTimeout + completeTimeout
}

// orderRetryAfter is the Retry-After (seconds) on an order that is
// processing: enrollctl answers well within it.
const orderRetryAfter = "1"

// writeOrderProcessing refuses a finalize of an order another finalize has
// claimed: orderNotReady with Retry-After. It spends and writes nothing.
func (h *Handler) writeOrderProcessing(x exchange) {
	x.w.Header().Set("Retry-After", orderRetryAfter)
	h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemOrderNotReady, "order is processing"))
}

// checkFinalizeCSR checks a finalize payload's CSR: it parses and is
// self-signed, its subject is the order's serial with one OU (the permit),
// and its key is the one Apple attested. It returns the CSR's DER and OU.
func (h *Handler) checkFinalizeCSR(a *authed, order *enrollredis.ACMEOrder, authz *enrollredis.ACMEAuthz) ([]byte, string, *Problem) {
	var pay finalizePayload
	if len(a.jws.Payload) == 0 || json.Unmarshal(a.jws.Payload, &pay) != nil || pay.CSR == "" {
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "missing csr")
	}
	csrDER, err := base64.RawURLEncoding.DecodeString(pay.CSR)
	if err != nil || len(csrDER) == 0 {
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "invalid base64url csr")
	}
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil || csr.CheckSignature() != nil {
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "invalid CSR or signature")
	}
	if reason := enrollctl.ValidateMacACMECSRSubject(csr, order.Serial, ""); reason != "" {
		h.logEvent("finalize", reason, order.Serial)
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "CSR subject does not match policy: "+reason)
	}
	csrSPKI, err := x509.MarshalPKIXPublicKey(csr.PublicKey)
	if err != nil {
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "invalid CSR public key")
	}
	csrKeySum := sha256.Sum256(csrSPKI)
	if hex.EncodeToString(csrKeySum[:]) != authz.AttestedKeySha256 {
		h.logEvent("finalize", "csr_key_mismatch", order.Serial)
		return nil, "", newProblem(http.StatusBadRequest, ProblemBadCSR, "CSR public key does not match attested key")
	}
	return csrDER, csr.Subject.OrganizationalUnit[0], nil
}

// handleOrder is POST-as-GET on an order: read-only, no nonce spent.
func (h *Handler) handleOrder(ctx context.Context, x exchange, body []byte, orderID string) {
	a, prob := h.authenticate(x, body, "/order/"+orderID)
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	if len(a.jws.Payload) != 0 {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "order endpoint supports POST-as-GET only"))
		return
	}
	order, err := h.deps.Store.GetACMEOrder(ctx, orderID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "order store unavailable"))
		return
	}
	if order == nil || !x.owns(a, order.AccountID, order.DeviceID) {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "order not found"))
		return
	}
	if order.Status == "processing" {
		x.w.Header().Set("Retry-After", orderRetryAfter) // RFC 8555 7.4: the client polls
	}
	h.writeACMEJSON(x, http.StatusOK, x.rt.url("/order/"+order.ID), "", h.renderOrder(x.rt, *order))
}

// handleCertificate serves an issued chain to the account and device that
// finalized its order, and to no other (as step-ca does). Read-only, no nonce
// spent.
func (h *Handler) handleCertificate(ctx context.Context, x exchange, body []byte, certID string) {
	a, prob := h.authenticate(x, body, "/certificate/"+certID)
	if prob != nil {
		h.writeProblem(x, prob)
		return
	}
	if len(a.jws.Payload) != 0 {
		h.writeAuthedProblem(x, newProblem(http.StatusBadRequest, ProblemMalformed, "certificate endpoint supports POST-as-GET only"))
		return
	}
	cert, err := h.deps.Store.GetACMECert(ctx, certID)
	if err != nil {
		h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, "cert store unavailable"))
		return
	}
	if cert == nil || !x.owns(a, cert.AccountID, cert.DeviceID) {
		h.writeAuthedProblem(x, newProblem(http.StatusUnauthorized, ProblemUnauthorized, "certificate not found"))
		return
	}
	w := x.w
	if nonce, err := h.issueNonce(); err == nil {
		w.Header().Set("Replay-Nonce", nonce)
	}
	w.Header().Set("Content-Type", "application/pem-certificate-chain")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Link", fmt.Sprintf("<%s>;rel=\"index\"", x.rt.url("/directory")))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(cert.PEM))
}

func (h *Handler) renderOrder(rt route, o enrollredis.ACMEOrder) map[string]any {
	m := map[string]any{
		"status":         o.Status,
		"expires":        o.Expires.UTC().Format(time.RFC3339),
		"identifiers":    []acmeIdentifier{{Type: "permanent-identifier", Value: o.Serial}},
		"authorizations": []string{rt.url("/authz/" + o.AuthzID)},
		"finalize":       rt.url("/order/" + o.ID + "/finalize"),
	}
	if o.CertID != "" {
		m["certificate"] = rt.url("/certificate/" + o.CertID)
	}
	if o.ErrorType != "" {
		m["error"] = map[string]string{"type": o.ErrorType, "detail": o.ErrorMsg}
	}
	return m
}

func (h *Handler) renderAuthz(rt route, a enrollredis.ACMEAuthz) map[string]any {
	return map[string]any{
		"identifier": acmeIdentifier{Type: "permanent-identifier", Value: a.Serial},
		"status":     a.Status,
		"expires":    a.Expires.UTC().Format(time.RFC3339),
		"challenges": []map[string]any{h.renderChallenge(rt, a)},
	}
}

func (h *Handler) renderChallenge(rt route, a enrollredis.ACMEAuthz) map[string]any {
	c := map[string]any{
		"type":   "device-attest-01",
		"status": a.ChalStatus,
		"token":  a.ChalToken,
		"url":    rt.url("/challenge/" + a.ID + "/" + a.ChalID),
	}
	if a.ValidatedAt != "" {
		c["validated"] = a.ValidatedAt
	}
	if a.ErrorType != "" {
		c["error"] = map[string]string{"type": a.ErrorType, "detail": a.ErrorMsg}
	}
	return c
}

// issueNonce mints a stateless Replay-Nonce: no Redis write.
func (h *Handler) issueNonce() (string, error) {
	return h.nonces.issue(h.deps.Now())
}

// writeACMEJSON answers a JWS-authenticated request, so it carries a fresh
// Replay-Nonce.
func (h *Handler) writeACMEJSON(x exchange, status int, location, upLink string, body any) {
	w := x.w
	if nonce, err := h.issueNonce(); err == nil {
		w.Header().Set("Replay-Nonce", nonce)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Link", fmt.Sprintf("<%s>;rel=\"index\"", x.rt.url("/directory")))
	if upLink != "" {
		w.Header().Add("Link", fmt.Sprintf("<%s>;rel=\"up\"", upLink))
	}
	if location != "" {
		w.Header().Set("Location", location)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeProblem answers a request whose JWS did not verify (or that has none).
//
// ⚠ A Replay-Nonce GOES ONLY ON A badNonce PROBLEM HERE, never on a 404, 413,
// 415 or malformed answer. Nonces cost nothing to issue, but the rule keeps
// anything acmed hands out tied to a request that proved a key.
func (h *Handler) writeProblem(x exchange, p *Problem) {
	h.writeProblemDoc(x, p, p.Type == ProblemBadNonce)
}

// writeAuthedProblem answers a request whose JWS verified, with a fresh
// Replay-Nonce.
func (h *Handler) writeAuthedProblem(x exchange, p *Problem) {
	h.writeProblemDoc(x, p, true)
}

func (h *Handler) writeProblemDoc(x exchange, p *Problem, withNonce bool) {
	w := x.w
	if withNonce {
		if nonce, err := h.issueNonce(); err == nil {
			w.Header().Set("Replay-Nonce", nonce)
		}
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Link", fmt.Sprintf("<%s>;rel=\"index\"", x.rt.url("/directory")))
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// writeStoreProblem answers a failed store call of an authenticated request:
// an object past its own expiry is refused, anything else is 503.
func (h *Handler) writeStoreProblem(x exchange, err error, what string) {
	if errors.Is(err, enrollredis.ErrExpired) {
		h.writeAuthedProblem(x, newProblem(http.StatusForbidden, ProblemUnauthorized, what+" expired"))
		return
	}
	h.writeAuthedProblem(x, newProblem(http.StatusServiceUnavailable, ProblemServerInternal, what+" store unavailable"))
}

func (h *Handler) logEvent(step, outcome, serial string) {
	if h.deps.Log == nil {
		return
	}
	attrs := []any{"step", step, "outcome", outcome}
	if serial != "" {
		attrs = append(attrs, "serial_hash", h.hashSerialForLog(serial))
	}
	h.deps.Log.Info("acmed request", attrs...)
}

func asProblem(err error) *Problem {
	var p *Problem
	if errors.As(err, &p) {
		return p
	}
	return newProblem(http.StatusBadRequest, ProblemMalformed, "malformed request")
}

func randomID() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func readBounded(r io.Reader, max int) ([]byte, bool) {
	b, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil || len(b) == 0 || len(b) > max {
		return nil, false
	}
	return b, true
}

func isSafeID(s string) bool {
	if len(s) < 8 || len(s) > 64 {
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
