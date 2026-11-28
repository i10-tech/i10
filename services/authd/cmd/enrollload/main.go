//go:build enrollload

// Command enrollload is the local load-test harness for enrollment at scale
// (I10-62). It is compiled ONLY with `-tags enrollload` and never shipped in
// production images, so synthetic Apple roots can never be injected into
// production enrolld, enrollctl, or acmed binaries.
//
// See docs/research/enrollment-load.md for exact commands and flags.
package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smallstep/pkcs7"

	"github.com/i10-tech/i10/services/authd/internal/acmed"
	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	"github.com/i10-tech/i10/services/authd/internal/enroll"
	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "enrollload: %v\n", err)
		os.Exit(1)
	}
}

type phaseStats struct {
	mu        sync.Mutex
	durations []time.Duration
}

func (p *phaseStats) record(d time.Duration) {
	p.mu.Lock()
	p.durations = append(p.durations, d)
	p.mu.Unlock()
}

func (p *phaseStats) summary() (count int, p50, p95, p99 time.Duration) {
	p.mu.Lock()
	ds := append([]time.Duration(nil), p.durations...)
	p.mu.Unlock()
	if len(ds) == 0 {
		return 0, 0, 0, 0
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
	pct := func(q float64) time.Duration {
		idx := int(float64(len(ds)-1) * q)
		return ds[idx]
	}
	return len(ds), pct(0.50), pct(0.95), pct(0.99)
}

type batchRecorder struct {
	mu      sync.Mutex
	byKind  map[string][]int
	latKind map[string][]time.Duration
}

func newBatchRecorder() *batchRecorder {
	return &batchRecorder{
		byKind:  make(map[string][]int),
		latKind: make(map[string][]time.Duration),
	}
}

func (b *batchRecorder) observe(kind string, size int, dur time.Duration) {
	b.mu.Lock()
	b.byKind[kind] = append(b.byKind[kind], size)
	b.latKind[kind] = append(b.latKind[kind], dur)
	b.mu.Unlock()
}

type pgStats struct {
	xactCommit   int64
	xactRollback int64
	stmtCalls    int64
	hasPgStat    bool
}

func readPGStats(ctx context.Context, pool *pgxpool.Pool) pgStats {
	var st pgStats
	_ = pool.QueryRow(ctx,
		`SELECT xact_commit, xact_rollback FROM pg_stat_database WHERE datname = current_database()`).
		Scan(&st.xactCommit, &st.xactRollback)
	var calls int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(calls), 0) FROM pg_stat_statements`).Scan(&calls); err == nil {
		st.stmtCalls = calls
		st.hasPgStat = true
	}
	return st
}

func run() error {
	var (
		pgDSN       = flag.String("postgres", envFirst("ENROLLLOAD_DATABASE_URL", "AUTHD_TEST_ENROLL_WRITER_DATABASE_URL"), "Postgres DSN for enroll_writer")
		adminDSN    = flag.String("admin-postgres", envFirst("ENROLLLOAD_ADMIN_DATABASE_URL", "AUTHD_TEST_DATABASE_URL"), "Optional admin Postgres DSN to seed synthetic accounts and read pg_stat_statements")
		redisURL    = flag.String("redis", envFirst("ENROLLLOAD_REDIS_URL", "ENROLL_TEST_REDIS_URL"), "i10-enroll-redis URL (redis://host:port)")
		redisUser   = flag.String("redis-user", os.Getenv("ENROLL_REDIS_USER"), "Redis ACL username")
		redisPass   = flag.String("redis-password", os.Getenv("ENROLL_REDIS_PASSWORD"), "Redis ACL password")
		devices     = flag.Int("devices", 100, "Total devices to enroll")
		concurrency = flag.Int("concurrency", 16, "Concurrent virtual devices")
		macRatio    = flag.Float64("mac-ratio", 0.5, "Fraction of devices running the Mac + ACME path (0.0..1.0)")
		maxBatch    = flag.Int("max-batch", 200, "Micro-batcher maxBatch")
		maxWait     = flag.Duration("max-wait", 5*time.Millisecond, "Micro-batcher maxWait")
		numUsers    = flag.Int("users", 50, "Distinct synthetic accounts to seed (when -admin-postgres is set)")
		userPrefix  = flag.String("user-prefix", "user_enrollload_", "Clerk user ID prefix for synthetic accounts")
	)
	flag.Parse()

	if *pgDSN == "" {
		return errors.New("-postgres (or ENROLLLOAD_DATABASE_URL / AUTHD_TEST_ENROLL_WRITER_DATABASE_URL) is required")
	}
	if *redisURL == "" {
		return errors.New("-redis (or ENROLLLOAD_REDIS_URL / ENROLL_TEST_REDIS_URL) is required")
	}
	if *devices < 1 || *concurrency < 1 || *macRatio < 0 || *macRatio > 1 || *numUsers < 1 {
		return errors.New("invalid numeric flag values")
	}

	ctx := context.Background()
	discardLog := slog.New(slog.NewTextHandler(io.Discard, nil))

	// Connect Redis.
	rc, err := enrollredis.NewClient(enrollredis.Config{
		URL:          *redisURL,
		Username:     *redisUser,
		Password:     *redisPass,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
		PoolSize:     max(32, *concurrency*2),
	})
	if err != nil {
		return fmt.Errorf("connect redis: %w", err)
	}
	defer rc.Close()
	if err := rc.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("ping redis: %w", err)
	}
	store := enrollredis.NewRedisStore(rc)

	// Connect Postgres as enroll_writer.
	writerPool, err := enrollctl.OpenEnrollWriterPool(ctx, *pgDSN)
	if err != nil {
		return fmt.Errorf("connect enroll_writer postgres: %w", err)
	}
	defer writerPool.Close()

	// Optionally seed accounts and snapshot Postgres stats via admin connection.
	var statsPool *pgxpool.Pool = writerPool
	var adminPool *pgxpool.Pool
	if *adminDSN != "" {
		adminPool, err = pgxpool.New(ctx, *adminDSN)
		if err != nil {
			return fmt.Errorf("connect admin postgres: %w", err)
		}
		defer adminPool.Close()
		statsPool = adminPool
		if err := seedAccounts(ctx, adminPool, *userPrefix, *numUsers); err != nil {
			return fmt.Errorf("seed accounts: %w", err)
		}
	}
	epochs, err := loadEpochs(ctx, statsPool, *userPrefix, *numUsers)
	if err != nil {
		return fmt.Errorf("read account epochs: %w", err)
	}

	// Build synthetic PKIs (ONLY inside enrollload process).
	pki, err := newLoadPKI()
	if err != nil {
		return fmt.Errorf("init load PKI: %w", err)
	}
	defer os.RemoveAll(pki.tmpDir)

	// Inject synthetic Apple OTA Phase 2 root (compiled in ONLY with -tags enrollload).
	enroll.SetAppleDeviceCAsForLoadTest([]*x509.Certificate{pki.appleOTACA})

	// Build shared key rings.
	edgeKeyRaw := make([]byte, 32)
	_, _ = rand.Read(edgeKeyRaw)
	edgeRing, err := enrolltoken.ParseRing("ENROLL_EDGE_HMAC_KEY", "1:"+base64.StdEncoding.EncodeToString(edgeKeyRaw))
	if err != nil {
		return err
	}
	acmeKeyRaw := make([]byte, 32)
	_, _ = rand.Read(acmeKeyRaw)
	acmeRing, err := enrolltoken.ParseRing("ENROLLCTL_ACME_PERMIT_KEYS", "1:"+base64.StdEncoding.EncodeToString(acmeKeyRaw))
	if err != nil {
		return err
	}
	pathKeyRaw := make([]byte, 32)
	_, _ = rand.Read(pathKeyRaw)
	pathRing, err := enrolltoken.ParseNonEmptyRing("ENROLL_ACME_PATH_KEYS", "1:"+base64.StdEncoding.EncodeToString(pathKeyRaw))
	if err != nil {
		return err
	}
	codeKeyRaw := make([]byte, 32)
	_, _ = rand.Read(codeKeyRaw)
	codeRing := keyring.Ring{1: codeKeyRaw}

	enrolldBearer := "enrollload-enrolld-bearer-token-0123456789"
	acmedBearer := "enrollload-acmed-bearer-token-0123456789"
	enrolldHash := sha256.Sum256([]byte(enrolldBearer))
	acmedHash := sha256.Sum256([]byte(acmedBearer))

	// Start micro-batcher.
	batches := newBatchRecorder()
	batcher := enrollctl.NewBatcher(writerPool, enrollctl.BatcherConfig{
		MaxBatch: *maxBatch,
		MaxWait:  *maxWait,
		Deadline: 4 * time.Second,
		Log:      discardLog,
		Observe:  batches.observe,
	})
	defer batcher.Close()

	// Start enrollctl HTTPS server (with synthetic Apple Enterprise Attestation verifier).
	signerLoader := &enrollctl.ProfileSignerLoader{
		CertFile: pki.profileCertPath,
		KeyFile:  pki.profileKeyPath,
		Log:      discardLog,
	}
	if err := signerLoader.Load(); err != nil {
		return fmt.Errorf("load profile signer: %w", err)
	}
	caIssuer, err := enrollctl.NewStaticDeviceCAIssuer(pki.devInterCert, pki.devInterKey)
	if err != nil {
		return fmt.Errorf("load device CA issuer: %w", err)
	}
	devTrust := enroll.NewStaticDeviceCABundle(pki.devTrust)
	appleAttestPool := x509.NewCertPool()
	appleAttestPool.AddCert(pki.appleAttestRoot)
	appleAttestVerifier := appleattest.NewVerifierForTest(appleAttestPool)

	// Start acmed + enrolld servers once we know their base URLs.
	var acmedURL string
	var enrolldURL string

	ctlHandler := enrollctl.NewHandler(enrollctl.HandlerDeps{
		Store:            store,
		Batcher:          batcher,
		EdgeLinkKeys:     edgeRing,
		ACMEPermitKeys:   acmeRing,
		ACMEPathKeys:     pathRing,
		DeviceCodeKeys:   codeRing,
		ProfileSigner:    signerLoader,
		DeviceCAIssuer:   caIssuer,
		DeviceCATrust:    devTrust,
		AppleAttest:      appleAttestVerifier,
		EnrolldTokens:    [][]byte{enrolldHash[:]},
		AcmedTokens:      [][]byte{acmedHash[:]},
		ProfileURL:       "https://ca.i10.tech/enroll/apple/profile",
		SCEPURL:          "https://ca.i10.tech/scep/apple-scep",
		ACMEDirectoryURL: "https://ca.i10.tech/acme/apple/directory",
		IMAPHost:         "mail.i10.tech",
		IMAPPort:         993,
		SMTPHost:         "mail.i10.tech",
		SMTPPort:         465,
		Organization:     "i10",
		CallTimeout:      5 * time.Second,
		Log:              discardLog,
	})
	ctlSrv := httptest.NewUnstartedServer(ctlHandler)
	ctlSrv.TLS = &tls.Config{Certificates: []tls.Certificate{pki.hooksTLSCert}, MinVersion: tls.VersionTLS12}
	ctlSrv.StartTLS()
	defer ctlSrv.Close()

	// Start enrolld HTTP server talking to enrollctl over HTTPS.
	apiClient, err := enroll.NewAPIClient(ctlSrv.URL, pki.hooksCACertPath, enrolldBearer, 10*time.Second)
	if err != nil {
		return fmt.Errorf("enrolld client: %w", err)
	}
	enrolldHandler, err := enroll.NewHandler(enroll.HandlerConfig{
		API:           apiClient,
		Trust:         devTrust.Current,
		EdgeLinkKeys:  edgeRing,
		MaxConcurrent: max(64, *concurrency*2),
		Log:           discardLog,
	})
	if err != nil {
		return fmt.Errorf("enrolld handler: %w", err)
	}
	enrolldSrv := httptest.NewServer(enrolldHandler)
	defer enrolldSrv.Close()
	enrolldURL = enrolldSrv.URL

	// Start acmed HTTP server talking to enrollctl over HTTPS.
	hooksCAPEM, err := os.ReadFile(pki.hooksCACertPath)
	if err != nil {
		return err
	}
	acmedClient, err := acmed.NewEnrollctlClient(ctlSrv.URL, acmedBearer, hooksCAPEM, 10*time.Second)
	if err != nil {
		return fmt.Errorf("acmed client: %w", err)
	}
	const acmeBase = "https://ca.i10.tech"
	nonceKey := make([]byte, 32)
	if _, err := rand.Read(nonceKey); err != nil {
		return err
	}
	nonceRing, err := enrolltoken.ParseNonEmptyRing("nonce", "1:"+base64.StdEncoding.EncodeToString(nonceKey))
	if err != nil {
		return err
	}
	acmedHandler := acmed.NewHandler(acmed.HandlerDeps{
		NonceKeys:          nonceRing,
		PathKeys:           pathRing,
		BaseURL:            acmeBase,
		Prefix:             acmed.DefaultPrefix,
		Store:              store,
		Finalizer:          acmedClient,
		AppleAttest:        appleAttestVerifier,
		MaxOrdersPerDevice: 5,
		Log:                discardLog,
	})
	acmedSrv := httptest.NewServer(acmedHandler)
	defer acmedSrv.Close()
	acmedURL = acmedSrv.URL

	// Pre-generate one RSA keypair per worker to avoid local CPU bottleneck in
	// SCEP keygen distorting server timings (each device gets a fresh key if
	// devices <= 200, otherwise generated per device).
	fmt.Printf("enrollload: devices=%d concurrency=%d mac_ratio=%.2f max_batch=%d max_wait=%s users=%d\n",
		*devices, *concurrency, *macRatio, *maxBatch, *maxWait, *numUsers)

	beforePG := readPGStats(ctx, statsPool)
	runStart := time.Now()

	var (
		p1Stats   phaseStats
		p2Stats   phaseStats
		p4Stats   phaseStats
		acmeStats phaseStats
		errCount  atomic.Int64
		macCount  atomic.Int64
		iosCount  atomic.Int64
	)

	workCh := make(chan int, *devices)
	for i := 0; i < *devices; i++ {
		workCh <- i
	}
	close(workCh)

	httpClient := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        max(64, *concurrency*2),
			MaxIdleConnsPerHost: max(64, *concurrency*2),
		},
	}

	var wg sync.WaitGroup
	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range workCh {
				isMac := float64(idx%100)/100.0 < *macRatio
				userIdx := idx % *numUsers
				uid := fmt.Sprintf("%s%d", *userPrefix, userIdx)
				email := loadEmail(*userPrefix, userIdx)
				if err := runOneDevice(ctx, deviceRunner{
					idx:        idx,
					isMac:      isMac,
					uid:        uid,
					email:      email,
					epoch:      epochs[userIdx],
					store:      store,
					edgeRing:   edgeRing,
					pki:        pki,
					httpClient: httpClient,
					enrolldURL: enrolldURL,
					acmedURL:   acmedURL,
					acmeBase:   acmeBase,
					p1Stats:    &p1Stats,
					p2Stats:    &p2Stats,
					p4Stats:    &p4Stats,
					acmeStats:  &acmeStats,
				}); err != nil {
					if errCount.Add(1) <= 10 {
						fmt.Fprintf(os.Stderr, "device %d (mac=%v) error: %v\n", idx, isMac, err)
					}
					continue
				}
				if isMac {
					macCount.Add(1)
				} else {
					iosCount.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	totalDur := time.Since(runStart)
	afterPG := readPGStats(ctx, statsPool)

	okTotal := iosCount.Load() + macCount.Load()
	rate := float64(okTotal) / totalDur.Seconds()

	fmt.Println("\n=== enrollload results ===")
	fmt.Printf("completed: %d/%d (ios=%d mac=%d errors=%d) in %s (%.1f devices/s)\n",
		okTotal, *devices, iosCount.Load(), macCount.Load(), errCount.Load(),
		totalDur.Round(time.Millisecond), rate)

	printPhase := func(name string, s *phaseStats) {
		n, p50, p95, p99 := s.summary()
		if n == 0 {
			return
		}
		fmt.Printf("  %-12s n=%-5d p50=%-8s p95=%-8s p99=%-8s\n",
			name, n, p50.Round(time.Microsecond), p95.Round(time.Microsecond), p99.Round(time.Microsecond))
	}
	fmt.Println("per-phase latency:")
	printPhase("phase1", &p1Stats)
	printPhase("phase2", &p2Stats)
	printPhase("phase4", &p4Stats)
	printPhase("mac_acme", &acmeStats)

	fmt.Println("micro-batcher batches:")
	for _, kind := range []string{"mint", "bind"} {
		sizes := batches.byKind[kind]
		if len(sizes) == 0 {
			continue
		}
		sort.Ints(sizes)
		sum := 0
		for _, sz := range sizes {
			sum += sz
		}
		p50 := sizes[len(sizes)/2]
		p95 := sizes[int(float64(len(sizes)-1)*0.95)]
		maxSz := sizes[len(sizes)-1]
		fmt.Printf("  %-8s batches=%-4d rows=%-5d avg=%.1f p50=%d p95=%d max=%d\n",
			kind, len(sizes), sum, float64(sum)/float64(len(sizes)), p50, p95, maxSz)
	}

	if okTotal > 0 {
		xacts := (afterPG.xactCommit - beforePG.xactCommit) + (afterPG.xactRollback - beforePG.xactRollback)
		fmt.Printf("postgres: xacts_delta=%d (%.2f/device)", xacts, float64(xacts)/float64(okTotal))
		if afterPG.hasPgStat && beforePG.hasPgStat {
			stmts := afterPG.stmtCalls - beforePG.stmtCalls
			fmt.Printf(" pg_stat_statements_delta=%d (%.2f/device)", stmts, float64(stmts)/float64(okTotal))
		}
		fmt.Println()
	}

	if errCount.Load() > 0 {
		return fmt.Errorf("%d devices failed", errCount.Load())
	}
	return nil
}

type deviceRunner struct {
	idx        int
	isMac      bool
	uid        string
	email      string
	epoch      int64 // the account's credential_epoch, as the API reads it
	store      enrollredis.Store
	edgeRing   *enrolltoken.Ring
	pki        *loadPKI
	httpClient *http.Client
	enrolldURL string
	acmedURL   string
	acmeBase   string
	p1Stats    *phaseStats
	p2Stats    *phaseStats
	p4Stats    *phaseStats
	acmeStats  *phaseStats
}

var (
	reSCEPChallenge = regexp.MustCompile(`<key>Challenge</key>\s*<string>([^<]+)</string>`)
	reEncryptedData = regexp.MustCompile(`(?s)<key>EncryptedPayloadContent</key>\s*<data>([^<]+)</data>`)
	reACMEOU        = regexp.MustCompile(`<string>OU</string>\s*<string>([^<]+)</string>`)
	reACMEDirectory = regexp.MustCompile(`<key>DirectoryURL</key>\s*<string>([^<]+)</string>`)
)

func runOneDevice(ctx context.Context, d deviceRunner) error {
	now := time.Now().UTC()
	eid, err := enrolltoken.NewUUIDv7At(now)
	if err != nil {
		return err
	}
	eidStr := enrolltoken.FormatUUID(eid)
	sess := enrollredis.Session{
		ID:            eidStr,
		ClerkUserID:   d.uid,
		Email:         d.email,
		ExpectedEpoch: d.epoch,
		CreatedBy:     d.uid,
		Status:        "open",
		CreatedAtMs:   now.UnixMilli(),
		ExpiresAtMs:   now.Add(15 * time.Minute).UnixMilli(),
		UpdatedAtMs:   now.UnixMilli(),
	}
	if err := d.store.CreateSession(ctx, sess, now); err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	tok, err := enrolltoken.SignLink(d.edgeRing, eid, now.Add(15*time.Minute))
	if err != nil {
		return fmt.Errorf("sign link: %w", err)
	}

	// Phase 1: GET /enroll/apple/<token>
	t0 := time.Now()
	resp1, err := d.httpClient.Get(d.enrolldURL + "/enroll/apple/" + tok)
	if err != nil {
		return fmt.Errorf("phase 1 GET: %w", err)
	}
	p1Body, _ := io.ReadAll(resp1.Body)
	resp1.Body.Close()
	d.p1Stats.record(time.Since(t0))
	if resp1.StatusCode != http.StatusOK || len(p1Body) == 0 {
		return fmt.Errorf("phase 1 status=%d len=%d", resp1.StatusCode, len(p1Body))
	}

	// Phase 2: POST Apple-signed plist
	serial := fmt.Sprintf("LOAD%08d", d.idx)
	udid := fmt.Sprintf("00008140-0000-0000-0000-%012d", d.idx)
	product, version, model := "iPhone17,2", "22A3354", "iPhone"
	if d.isMac {
		product, version, model = "Mac15,6", "26C5047e", "MacBook Pro"
	}
	p2Plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CHALLENGE</key><string>%s</string>
<key>UDID</key><string>%s</string>
<key>SERIAL</key><string>%s</string>
<key>PRODUCT</key><string>%s</string>
<key>VERSION</key><string>%s</string>
<key>DEVICE_NAME</key><string>Load Device %d</string>
<key>MODEL</key><string>%s</string>
</dict></plist>`, tok, udid, serial, product, version, d.idx, model)

	p2CMS, err := signCMS(d.pki.appleOTALeaf, d.pki.appleOTAKey, []byte(p2Plist))
	if err != nil {
		return fmt.Errorf("phase 2 sign: %w", err)
	}
	t0 = time.Now()
	resp2, err := d.httpClient.Post(d.enrolldURL+"/enroll/apple/profile", "application/pkcs7-signature", bytes.NewReader(p2CMS))
	if err != nil {
		return fmt.Errorf("phase 2 POST: %w", err)
	}
	p2Body, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	d.p2Stats.record(time.Since(t0))
	if resp2.StatusCode != http.StatusOK {
		return fmt.Errorf("phase 2 status=%d", resp2.StatusCode)
	}
	p2Inner, err := unwrapSignedCMS(p2Body)
	if err != nil {
		return fmt.Errorf("phase 2 unwrap signed profile: %w", err)
	}
	m := reSCEPChallenge.FindSubmatch(p2Inner)
	if len(m) != 2 {
		return errors.New("phase 2 SCEP profile missing Challenge")
	}
	scepChallenge := string(m[1])

	// Simulated SCEP: generate RSA-2048 key, issue SCEP cert from test device intermediate,
	// and write authorized SCEP key binding into Redis (as cahookrelay would).
	scepKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("scep keygen: %w", err)
	}
	scepCert, err := d.pki.issueSCEPLeaf(serial, &scepKey.PublicKey)
	if err != nil {
		return fmt.Errorf("issue scep leaf: %w", err)
	}
	spkiDER, err := x509.MarshalPKIXPublicKey(&scepKey.PublicKey)
	if err != nil {
		return err
	}
	keyHash := sha256.Sum256(spkiDER)
	keyHex := hex.EncodeToString(keyHash[:])
	// The two cahookrelay scripts step-ca's webhooks run, with the challenge
	// the device sent: the same Redis work as production SCEP.
	scepAt := time.Now()
	if dec, err := d.store.SCEPClaim(ctx, scepChallenge, keyHex, "load-tx-"+keyHex[:16], serial, scepAt); err != nil || !dec.Allow {
		return fmt.Errorf("scep claim: %v %v", dec.Outcome, err)
	}
	if dec, err := d.store.SCEPAuthorize(ctx, keyHex, serial, scepAt); err != nil || !dec.Allow {
		return fmt.Errorf("scep authorize: %v %v", dec.Outcome, err)
	}

	// Phase 4: POST SCEP-signed plist
	p4Plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>UDID</key><string>%s</string></dict></plist>`, udid)
	p4CMS, err := signCMS(scepCert, scepKey, []byte(p4Plist))
	if err != nil {
		return fmt.Errorf("phase 4 sign: %w", err)
	}
	t0 = time.Now()
	resp4, err := d.httpClient.Post(d.enrolldURL+"/enroll/apple/profile", "application/pkcs7-signature", bytes.NewReader(p4CMS))
	if err != nil {
		return fmt.Errorf("phase 4 POST: %w", err)
	}
	p4Body, _ := io.ReadAll(resp4.Body)
	resp4.Body.Close()
	d.p4Stats.record(time.Since(t0))
	if resp4.StatusCode != http.StatusOK {
		return fmt.Errorf("phase 4 status=%d", resp4.StatusCode)
	}

	if !d.isMac {
		return nil
	}

	// Mac ACME path: decrypt sealed profile to extract OU permit, then run full ACME flow against acmed.
	p4Inner, err := unwrapSignedCMS(p4Body)
	if err != nil {
		return fmt.Errorf("phase 4 unwrap signed profile: %w", err)
	}
	encMatch := reEncryptedData.FindSubmatch(p4Inner)
	if len(encMatch) != 2 {
		return errors.New("phase 4 sealed profile missing EncryptedPayloadContent")
	}
	b64Clean := strings.Join(strings.Fields(string(encMatch[1])), "")
	envDER, err := base64.StdEncoding.DecodeString(b64Clean)
	if err != nil {
		return fmt.Errorf("decode EncryptedPayloadContent: %w", err)
	}
	decryptedPlist, err := decryptEnvelopedData(envDER, scepKey)
	if err != nil {
		return fmt.Errorf("decrypt sealed profile: %w", err)
	}
	ouMatch := reACMEOU.FindSubmatch(decryptedPlist)
	if len(ouMatch) != 2 {
		return errors.New("decrypted Mac profile missing ACME OU permit")
	}
	permitOU := string(ouMatch[1])
	dirMatch := reACMEDirectory.FindSubmatch(decryptedPlist)
	if len(dirMatch) != 2 {
		return errors.New("decrypted Mac profile missing ACME DirectoryURL")
	}

	t0 = time.Now()
	if err := runMacACME(d, serial, udid, permitOU, string(dirMatch[1])); err != nil {
		return fmt.Errorf("mac acme: %w", err)
	}
	d.acmeStats.record(time.Since(t0))
	return nil
}

// runMacACME runs the ACME flow from the directory URL in the Mac's sealed
// profile (it carries the Mac's path token).
func runMacACME(d deviceRunner, serial, udid, permitOU, directoryURL string) error {
	// Rewrites configured https://ca.i10.tech/acme/apple/... URLs to local acmedSrv URL.
	rewrite := func(u string) string {
		return d.acmedURL + strings.TrimPrefix(u, d.acmeBase)
	}

	// 1. Directory
	dirResp, err := d.httpClient.Get(rewrite(directoryURL))
	if err != nil {
		return err
	}
	var dir map[string]string
	_ = json.NewDecoder(dirResp.Body).Decode(&dir)
	dirResp.Body.Close()
	if dirResp.StatusCode != http.StatusOK || dir["newOrder"] == "" {
		return fmt.Errorf("directory status=%d", dirResp.StatusCode)
	}

	// 2. new-nonce
	nonceReq, _ := http.NewRequest(http.MethodHead, rewrite(dir["newNonce"]), nil)
	nonceResp, err := d.httpClient.Do(nonceReq)
	if err != nil {
		return err
	}
	nonceResp.Body.Close()
	nonce := nonceResp.Header.Get("Replay-Nonce")
	if nonce == "" {
		return errors.New("missing initial Replay-Nonce")
	}

	acctKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	jwk := map[string]string{
		"crv": "P-256",
		"kty": "EC",
		"x":   base64.RawURLEncoding.EncodeToString(padBytes(acctKey.X.Bytes(), 32)),
		"y":   base64.RawURLEncoding.EncodeToString(padBytes(acctKey.Y.Bytes(), 32)),
	}

	postJWS := func(targetURL, kid string, payload any) (*http.Response, []byte, error) {
		hdr := map[string]any{
			"alg":   "ES256",
			"nonce": nonce,
			"url":   targetURL,
		}
		if kid == "" {
			hdr["jwk"] = jwk
		} else {
			hdr["kid"] = kid
		}
		hdrJSON, _ := json.Marshal(hdr)
		protB64 := base64.RawURLEncoding.EncodeToString(hdrJSON)
		var payB64 string
		if payload != nil {
			pb, _ := json.Marshal(payload)
			payB64 = base64.RawURLEncoding.EncodeToString(pb)
		}
		signingInput := protB64 + "." + payB64
		sum := sha256.Sum256([]byte(signingInput))
		r, s, err := ecdsa.Sign(rand.Reader, acctKey, sum[:])
		if err != nil {
			return nil, nil, err
		}
		sig := append(padBytes(r.Bytes(), 32), padBytes(s.Bytes(), 32)...)
		body, _ := json.Marshal(map[string]string{
			"protected": protB64,
			"payload":   payB64,
			"signature": base64.RawURLEncoding.EncodeToString(sig),
		})
		resp, err := d.httpClient.Post(rewrite(targetURL), "application/jose+json", bytes.NewReader(body))
		if err != nil {
			return nil, nil, err
		}
		rb, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if nextNonce := resp.Header.Get("Replay-Nonce"); nextNonce != "" {
			nonce = nextNonce
		}
		return resp, rb, nil
	}

	// 3. new-account: RFC 8555 7.1.2's object (macOS refuses one without
	// `orders`), then POST-as-GET on its orders list.
	resp, body, err := postJWS(dir["newAccount"], "", map[string]any{"termsOfServiceAgreed": true})
	if err != nil || (resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK) {
		return fmt.Errorf("new-account status=%d err=%v", statusOf(resp), err)
	}
	acctURL := resp.Header.Get("Location")
	var acct struct {
		Status  string   `json:"status"`
		Contact []string `json:"contact"`
		Orders  string   `json:"orders"`
	}
	if err := checkACMEJSON("new-account", resp, body, &acct, "status", "contact", "orders"); err != nil {
		return err
	}
	if acctURL == "" || acct.Status != "valid" || acct.Orders != acctURL+"/orders" {
		return fmt.Errorf("new-account Location=%q body=%s", acctURL, body)
	}
	resp, body, err = postJWS(acct.Orders, acctURL, nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("orders list status=%d err=%v body=%s", statusOf(resp), err, body)
	}
	var ordersList struct {
		Orders []string `json:"orders"`
	}
	if err := checkACMEJSON("orders list", resp, body, &ordersList, "orders"); err != nil {
		return err
	}

	// 4. new-order
	resp, body, err = postJWS(dir["newOrder"], acctURL, map[string]any{
		"identifiers": []map[string]string{{"type": "permanent-identifier", "value": serial}},
	})
	if err != nil || resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("new-order status=%d err=%v body=%s", statusOf(resp), err, body)
	}
	var order struct {
		Expires        string   `json:"expires"`
		Authorizations []string `json:"authorizations"`
		Finalize       string   `json:"finalize"`
	}
	if err := checkACMEJSON("new-order", resp, body, &order, orderFields...); err != nil {
		return err
	}
	if resp.Header.Get("Location") == "" || len(order.Authorizations) != 1 || !isRFC3339(order.Expires) {
		return fmt.Errorf("new-order Location=%q body=%s", resp.Header.Get("Location"), body)
	}

	// 5. authz POST-as-GET
	resp, body, err = postJWS(order.Authorizations[0], acctURL, nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("authz status=%d err=%v", statusOf(resp), err)
	}
	var authz struct {
		Expires    string            `json:"expires"`
		Challenges []json.RawMessage `json:"challenges"`
	}
	if err := checkACMEJSON("authz", resp, body, &authz, "identifier", "status", "expires", "challenges"); err != nil {
		return err
	}
	if len(authz.Challenges) != 1 || !isRFC3339(authz.Expires) {
		return fmt.Errorf("authz body=%s", body)
	}
	var chal struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	}
	if err := checkACMEFields("authz challenge", authz.Challenges[0], &chal, "type", "url", "status", "token"); err != nil {
		return err
	}

	// 6. Apple device-attest-01 challenge
	macKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return err
	}
	nonceHash := sha256.Sum256([]byte(chal.Token))
	attLeafDER, err := d.pki.issueAppleAttestLeaf(serial, udid, nonceHash[:], &macKey.PublicKey)
	if err != nil {
		return err
	}
	attObjCBOR := buildAppleAttObjCBOR([][]byte{attLeafDER, d.pki.appleAttestInter.Raw})
	resp, body, err = postJWS(chal.URL, acctURL, map[string]string{
		"attObj": base64.RawURLEncoding.EncodeToString(attObjCBOR),
	})
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("challenge status=%d err=%v body=%s", statusOf(resp), err, body)
	}
	var answered struct {
		Status    string `json:"status"`
		Validated string `json:"validated"`
	}
	if err := checkACMEJSON("challenge", resp, body, &answered, "type", "url", "status", "token", "validated"); err != nil {
		return err
	}
	upLink := `<` + order.Authorizations[0] + `>;rel="up"`
	if answered.Status != "valid" || !isRFC3339(answered.Validated) || !slices.Contains(resp.Header.Values("Link"), upLink) {
		return fmt.Errorf("challenge Link=%v body=%s", resp.Header.Values("Link"), body)
	}

	// 7. finalize with P-384 CSR
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{
			CommonName:         serial,
			OrganizationalUnit: []string{permitOU},
		},
	}, macKey)
	if err != nil {
		return err
	}
	resp, body, err = postJWS(order.Finalize, acctURL, map[string]string{
		"csr": base64.RawURLEncoding.EncodeToString(csrDER),
	})
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("finalize status=%d err=%v body=%s", statusOf(resp), err, body)
	}
	var finOrder struct {
		Status      string `json:"status"`
		Certificate string `json:"certificate"`
	}
	if err := checkACMEJSON("finalize", resp, body, &finOrder, slices.Concat(orderFields, []string{"certificate"})...); err != nil {
		return err
	}
	if finOrder.Status != "valid" || finOrder.Certificate == "" || resp.Header.Get("Location") == "" {
		return fmt.Errorf("finalize order not valid: %s", body)
	}

	// 8. fetch certificate
	resp, body, err = postJWS(finOrder.Certificate, acctURL, nil)
	if err != nil || resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("BEGIN CERTIFICATE")) ||
		resp.Header.Get("Content-Type") != "application/pem-certificate-chain" || resp.Header.Get("Replay-Nonce") == "" {
		return fmt.Errorf("cert fetch status=%d content-type=%q err=%v", statusOf(resp), contentTypeOf(resp), err)
	}
	return nil
}

// orderFields are the fields RFC 8555 7.1.3 requires of an order (`expires`
// for a pending or valid one, the only states this flow sees).
var orderFields = []string{"status", "expires", "identifiers", "authorizations", "finalize"}

// checkACMEJSON checks an ACME JSON answer as Apple's client reads it: an
// application/json body carrying each required field, with a Replay-Nonce
// (RFC 8555 6.5) and the directory as Link rel="index" (7.1). It decodes the
// body into v.
func checkACMEJSON(step string, resp *http.Response, body []byte, v any, required ...string) error {
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		return fmt.Errorf("%s: Content-Type=%q", step, ct)
	}
	if resp.Header.Get("Replay-Nonce") == "" {
		return fmt.Errorf("%s: no Replay-Nonce", step)
	}
	if !slices.ContainsFunc(resp.Header.Values("Link"), func(l string) bool { return strings.HasSuffix(l, `/directory>;rel="index"`) }) {
		return fmt.Errorf("%s: no Link rel=index: %v", step, resp.Header.Values("Link"))
	}
	return checkACMEFields(step, body, v, required...)
}

// checkACMEFields decodes a JSON object into v and checks that it carries
// each required field, none of them null.
func checkACMEFields(step string, raw []byte, v any, required ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return fmt.Errorf("%s: body %s: %w", step, raw, err)
	}
	for _, f := range required {
		if val, ok := fields[f]; !ok || string(val) == "null" {
			return fmt.Errorf("%s: required field %q missing in %s", step, f, raw)
		}
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("%s: body %s: %w", step, raw, err)
	}
	return nil
}

// isRFC3339 reports whether s is an RFC 3339 timestamp, as RFC 8555 requires
// of `expires` and `validated`.
func isRFC3339(s string) bool {
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

func statusOf(r *http.Response) int {
	if r == nil {
		return 0
	}
	return r.StatusCode
}

// contentTypeOf is statusOf for the Content-Type: "" when the request failed
// before any response.
func contentTypeOf(r *http.Response) string {
	if r == nil {
		return ""
	}
	return r.Header.Get("Content-Type")
}

// loadEmail is synthetic account i's address: unique per -user-prefix, since
// authd.accounts.email is unique.
func loadEmail(prefix string, i int) string {
	return fmt.Sprintf("%s%d@load.i10.invalid", strings.ToLower(prefix), i)
}

// seedAccounts upserts the synthetic accounts. A new row takes the column's
// default credential_epoch (microseconds since 1970, 16 digits), as a real
// account does, and an existing row keeps its own: the sessions carry
// whatever loadEpochs reads.
func seedAccounts(ctx context.Context, pool *pgxpool.Pool, prefix string, n int) error {
	for i := 0; i < n; i++ {
		uid := fmt.Sprintf("%s%d", prefix, i)
		email := loadEmail(prefix, i)
		_, err := pool.Exec(ctx, `
			INSERT INTO authd.accounts (clerk_user_id, email, active)
			VALUES ($1, $2, true)
			ON CONFLICT (clerk_user_id) DO UPDATE
			   SET email = EXCLUDED.email, active = true`,
			uid, email)
		if err != nil {
			return err
		}
	}
	return nil
}

// loadEpochs reads synthetic account i's credential_epoch into element i, so
// each session carries its account's real epoch, as the API's create does.
func loadEpochs(ctx context.Context, pool *pgxpool.Pool, prefix string, n int) ([]int64, error) {
	uids := make([]string, n)
	for i := range uids {
		uids[i] = fmt.Sprintf("%s%d", prefix, i)
	}
	rows, err := pool.Query(ctx,
		`SELECT clerk_user_id, credential_epoch FROM authd.accounts WHERE clerk_user_id = ANY($1)`, uids)
	if err != nil {
		return nil, err
	}
	byUID := make(map[string]int64, n)
	for rows.Next() {
		var uid string
		var epoch int64
		if err := rows.Scan(&uid, &epoch); err != nil {
			rows.Close()
			return nil, err
		}
		byUID[uid] = epoch
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	epochs := make([]int64, n)
	for i, uid := range uids {
		epoch, ok := byUID[uid]
		if !ok {
			return nil, fmt.Errorf("no authd.accounts row for %s (seed with -admin-postgres)", uid)
		}
		// A real epoch is microseconds since 1970 (16 digits). Older runs
		// seeded 1, and seedAccounts keeps an existing row's epoch.
		if epoch < 1_000_000_000_000_000 {
			return nil, fmt.Errorf("%s has credential_epoch %d, not a real microsecond epoch: delete the load accounts and reseed", uid, epoch)
		}
		epochs[i] = epoch
	}
	return epochs, nil
}

// ── Synthetic PKI & CMS/CBOR helpers (enrollload only) ──────────────────────

type loadPKI struct {
	tmpDir           string
	appleOTACA       *x509.Certificate
	appleOTALeaf     *x509.Certificate
	appleOTAKey      *rsa.PrivateKey
	appleAttestRoot  *x509.Certificate
	appleAttestInter *x509.Certificate
	appleAttestKey   *ecdsa.PrivateKey
	devInterCert     *x509.Certificate
	devInterKey      *ecdsa.PrivateKey
	devInterCertPath string
	devInterKeyPath  string
	devTrust         *enroll.DeviceTrust
	profileCertPath  string
	profileKeyPath   string
	hooksTLSCert     tls.Certificate
	hooksCACertPath  string
}

func newLoadPKI() (*loadPKI, error) {
	dir, err := os.MkdirTemp("", "enrollload-pki-*")
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()

	// 1. Synthetic Apple OTA Phase 2 Device CA + device leaf
	otaCAKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	otaCATpl := &x509.Certificate{
		SerialNumber:          big.NewInt(100),
		Subject:               pkix.Name{CommonName: "Load Apple iPhone Device CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	otaCADER, _ := x509.CreateCertificate(rand.Reader, otaCATpl, otaCATpl, &otaCAKey.PublicKey, otaCAKey)
	otaCACert, _ := x509.ParseCertificate(otaCADER)

	otaLeafKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	otaLeafTpl := &x509.Certificate{
		SerialNumber: big.NewInt(101),
		Subject:      pkix.Name{CommonName: "Load Apple Device"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	otaLeafDER, _ := x509.CreateCertificate(rand.Reader, otaLeafTpl, otaCACert, &otaLeafKey.PublicKey, otaCAKey)
	otaLeafCert, _ := x509.ParseCertificate(otaLeafDER)

	// 2. Synthetic Apple Enterprise Attestation Root + Intermediate
	attRootKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	attRootTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(200),
		Subject:               pkix.Name{CommonName: "Load Apple Enterprise Attestation Root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	attRootDER, _ := x509.CreateCertificate(rand.Reader, attRootTpl, attRootTpl, &attRootKey.PublicKey, attRootKey)
	attRootCert, _ := x509.ParseCertificate(attRootDER)

	attInterKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	attInterTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(201),
		Subject:               pkix.Name{CommonName: "Load Apple Enterprise Attestation Inter"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	attInterDER, _ := x509.CreateCertificate(rand.Reader, attInterTpl, attRootCert, &attInterKey.PublicKey, attRootKey)
	attInterCert, _ := x509.ParseCertificate(attInterDER)

	// 3. Synthetic Device Root CA + Intermediate CA (with production name constraints)
	devRootKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	devRootTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(300),
		Subject:               pkix.Name{CommonName: "Load Device Root CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	devRootDER, _ := x509.CreateCertificate(rand.Reader, devRootTpl, devRootTpl, &devRootKey.PublicKey, devRootKey)
	devRootCert, _ := x509.ParseCertificate(devRootDER)

	devInterKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	_, ipv4All, _ := net.ParseCIDR("0.0.0.0/0")
	_, ipv6All, _ := net.ParseCIDR("::/0")
	devInterTpl := &x509.Certificate{
		SerialNumber:                big.NewInt(301),
		Subject:                     pkix.Name{CommonName: "Load Device Intermediate CA"},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(10 * 365 * 24 * time.Hour),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		KeyUsage:                    x509.KeyUsageCertSign,
		PermittedDNSDomains:         []string{"i10-device-ca.i10-prod.svc", ".cluster.local"},
		ExcludedIPRanges:            []*net.IPNet{ipv4All, ipv6All},
		PermittedDNSDomainsCritical: true,
	}
	devInterDER, _ := x509.CreateCertificate(rand.Reader, devInterTpl, devRootCert, &devInterKey.PublicKey, devRootKey)
	devInterCert, _ := x509.ParseCertificate(devInterDER)
	devInterPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: devInterDER})
	devInterKeyDER, _ := x509.MarshalECPrivateKey(devInterKey)
	devInterKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: devInterKeyDER})

	devInterCertPath := filepath.Join(dir, "intermediate.crt")
	devInterKeyPath := filepath.Join(dir, "intermediate.key")
	_ = os.WriteFile(devInterCertPath, devInterPEM, 0o600)
	_ = os.WriteFile(devInterKeyPath, devInterKeyPEM, 0o600)

	bundlePEM := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: devRootDER}), devInterPEM...)
	devTrust, err := enroll.ParseDeviceTrustBundle(bundlePEM)
	if err != nil {
		return nil, err
	}

	// 4. Synthetic Profile Signing CA + ECDSA P-256 leaf
	profCAKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	profCATpl := &x509.Certificate{
		SerialNumber:          big.NewInt(400),
		Subject:               pkix.Name{CommonName: "Load Profile Signing Inter CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	profCADER, _ := x509.CreateCertificate(rand.Reader, profCATpl, profCATpl, &profCAKey.PublicKey, profCAKey)
	profCACert, _ := x509.ParseCertificate(profCADER)

	profLeafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	profLeafTpl := &x509.Certificate{
		SerialNumber: big.NewInt(401),
		Subject:      pkix.Name{CommonName: "profiles.i10.tech"},
		DNSNames:     []string{"profiles.i10.tech"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(90 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	profLeafDER, _ := x509.CreateCertificate(rand.Reader, profLeafTpl, profCACert, &profLeafKey.PublicKey, profCAKey)
	profChainPEM := append(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: profLeafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: profCADER})...,
	)
	profKeyDER, _ := x509.MarshalECPrivateKey(profLeafKey)
	profKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: profKeyDER})
	profCertPath := filepath.Join(dir, "profile.crt")
	profKeyPath := filepath.Join(dir, "profile.key")
	_ = os.WriteFile(profCertPath, profChainPEM, 0o600)
	_ = os.WriteFile(profKeyPath, profKeyPEM, 0o600)

	// 5. Synthetic Namespace Hooks CA + enrollctl loopback TLS cert
	hooksCAKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	hooksCATpl := &x509.Certificate{
		SerialNumber:          big.NewInt(500),
		Subject:               pkix.Name{CommonName: "Load Hooks CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	hooksCADER, _ := x509.CreateCertificate(rand.Reader, hooksCATpl, hooksCATpl, &hooksCAKey.PublicKey, hooksCAKey)
	hooksCACert, _ := x509.ParseCertificate(hooksCADER)

	hooksSrvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	hooksSrvTpl := &x509.Certificate{
		SerialNumber: big.NewInt(501),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	hooksSrvDER, _ := x509.CreateCertificate(rand.Reader, hooksSrvTpl, hooksCACert, &hooksSrvKey.PublicKey, hooksCAKey)
	hooksSrvKeyDER, _ := x509.MarshalECPrivateKey(hooksSrvKey)
	hooksTLSCert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: hooksSrvDER}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: hooksSrvKeyDER}),
	)
	if err != nil {
		return nil, err
	}
	hooksCAPath := filepath.Join(dir, "hooks-ca.crt")
	_ = os.WriteFile(hooksCAPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: hooksCADER}), 0o600)

	return &loadPKI{
		tmpDir:           dir,
		appleOTACA:       otaCACert,
		appleOTALeaf:     otaLeafCert,
		appleOTAKey:      otaLeafKey,
		appleAttestRoot:  attRootCert,
		appleAttestInter: attInterCert,
		appleAttestKey:   attInterKey,
		devInterCert:     devInterCert,
		devInterKey:      devInterKey,
		devInterCertPath: devInterCertPath,
		devInterKeyPath:  devInterKeyPath,
		devTrust:         devTrust,
		profileCertPath:  profCertPath,
		profileKeyPath:   profKeyPath,
		hooksTLSCert:     hooksTLSCert,
		hooksCACertPath:  hooksCAPath,
	}, nil
}

func (p *loadPKI) issueSCEPLeaf(serial string, pub *rsa.PublicKey) (*x509.Certificate, error) {
	now := time.Now().UTC()
	sn, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tpl := &x509.Certificate{
		SerialNumber: sn.Add(sn, big.NewInt(1)),
		Subject:      pkix.Name{CommonName: serial},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(7 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, p.devInterCert, pub, p.devInterKey)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

func (p *loadPKI) issueAppleAttestLeaf(serial, udid string, nonceDigest []byte, pub *ecdsa.PublicKey) ([]byte, error) {
	now := time.Now().UTC()
	sn, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tpl := &x509.Certificate{
		SerialNumber: sn.Add(sn, big.NewInt(1)),
		Subject:      pkix.Name{CommonName: serial},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtraExtensions: []pkix.Extension{
			// Raw bytes, as Apple writes them (step-ca challenge.go reads
			// string(ext.Value) and the nonce as ext.Value).
			{Id: appleattest.OIDAppleSerialNumber, Value: []byte(serial)},
			{Id: appleattest.OIDAppleUDID, Value: []byte(udid)},
			{Id: appleattest.OIDAppleNonce, Value: nonceDigest},
		},
	}
	return x509.CreateCertificate(rand.Reader, tpl, p.appleAttestInter, pub, p.appleAttestKey)
}

func signCMS(cert *x509.Certificate, key any, content []byte) ([]byte, error) {
	sd, err := pkcs7.NewSignedData(content)
	if err != nil {
		return nil, err
	}
	sd.SetDigestAlgorithm(pkcs7.OIDDigestAlgorithmSHA256)
	if err := sd.AddSigner(cert, key, pkcs7.SignerInfoConfig{}); err != nil {
		return nil, err
	}
	return sd.Finish()
}

func unwrapSignedCMS(der []byte) ([]byte, error) {
	p7, err := pkcs7.Parse(der)
	if err != nil {
		return nil, err
	}
	return p7.Content, nil
}

// decryptEnvelopedData decrypts CMS EnvelopedData (RSA PKCS#1 v1.5 + AES-256-CBC)
// produced by enrollctl's BuildSealedProfile.
func decryptEnvelopedData(der []byte, key *rsa.PrivateKey) ([]byte, error) {
	type contentInfo struct {
		ContentType asn1.ObjectIdentifier
		Content     asn1.RawValue `asn1:"explicit,tag:0"`
	}
	type issuerAndSerial struct {
		Issuer asn1.RawValue
		Serial *big.Int
	}
	type keyTransRecipientInfo struct {
		Version      int
		RID          issuerAndSerial
		KeyEncAlg    pkix.AlgorithmIdentifier
		EncryptedKey []byte
	}
	type encryptedContentInfo struct {
		ContentType      asn1.ObjectIdentifier
		ContentEncAlg    pkix.AlgorithmIdentifier
		EncryptedContent asn1.RawValue `asn1:"optional,tag:0"`
	}
	type envelopedData struct {
		Version              int
		RecipientInfos       []keyTransRecipientInfo `asn1:"set"`
		EncryptedContentInfo encryptedContentInfo
	}
	var ci contentInfo
	if _, err := asn1.Unmarshal(der, &ci); err != nil {
		return nil, err
	}
	var ed envelopedData
	if _, err := asn1.Unmarshal(ci.Content.Bytes, &ed); err != nil {
		return nil, err
	}
	if len(ed.RecipientInfos) == 0 {
		return nil, errors.New("no recipient infos")
	}
	cek, err := rsa.DecryptPKCS1v15(rand.Reader, key, ed.RecipientInfos[0].EncryptedKey)
	if err != nil {
		return nil, fmt.Errorf("rsa decrypt CEK: %w", err)
	}
	var iv []byte
	if _, err := asn1.Unmarshal(ed.EncryptedContentInfo.ContentEncAlg.Parameters.FullBytes, &iv); err != nil {
		return nil, fmt.Errorf("decode AES IV: %w", err)
	}
	ct := ed.EncryptedContentInfo.EncryptedContent.Bytes
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, errors.New("invalid ciphertext block length")
	}
	pt := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(pt, ct)
	pad := int(pt[len(pt)-1])
	if pad < 1 || pad > aes.BlockSize || pad > len(pt) {
		return nil, errors.New("invalid PKCS#7 padding")
	}
	return pt[:len(pt)-pad], nil
}

func buildAppleAttObjCBOR(x5c [][]byte) []byte {
	var b bytes.Buffer
	appendCborHead := func(major byte, n uint64) {
		m := major << 5
		switch {
		case n < 24:
			b.WriteByte(m | byte(n))
		case n <= 0xff:
			b.WriteByte(m | 24)
			b.WriteByte(byte(n))
		case n <= 0xffff:
			b.WriteByte(m | 25)
			b.WriteByte(byte(n >> 8))
			b.WriteByte(byte(n))
		default:
			b.WriteByte(m | 26)
			b.WriteByte(byte(n >> 24))
			b.WriteByte(byte(n >> 16))
			b.WriteByte(byte(n >> 8))
			b.WriteByte(byte(n))
		}
	}
	appendText := func(s string) {
		appendCborHead(3, uint64(len(s)))
		b.WriteString(s)
	}
	appendBytes := func(p []byte) {
		appendCborHead(2, uint64(len(p)))
		b.Write(p)
	}

	appendCborHead(5, 2) // map(2)
	appendText("fmt")
	appendText("apple")
	appendText("attStmt")
	appendCborHead(5, 1) // map(1)
	appendText("x5c")
	appendCborHead(4, uint64(len(x5c)))
	for _, c := range x5c {
		appendBytes(c)
	}
	return b.Bytes()
}

func padBytes(in []byte, size int) []byte {
	if len(in) >= size {
		return in[len(in)-size:]
	}
	out := make([]byte, size)
	copy(out[size-len(in):], in)
	return out
}

func envFirst(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}
