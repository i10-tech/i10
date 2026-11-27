package enroll

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/asn1"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync/atomic"
	"time"
)

// Phase identifies which OTA device POST a verified CMS SignedData belongs to.
// Routing is decided exclusively by which CA issued the signer certificate,
// never by attributes inside the plist.
type Phase int

const (
	PhaseUnknown Phase = iota
	Phase2Apple
	Phase4DeviceCA
)

var oidExtensionSubjectAltName = asn1.ObjectIdentifier{2, 5, 29, 17}

// DeviceTrust holds the parsed roots and intermediates from the mounted device
// CA public trust bundle (i10-device-ca-trust's bundle.pem). Roots and
// intermediates are kept separate so x509.Verify always validates the full
// leaf -> intermediate -> root path and can refuse certificates issued
// directly by the root (such as the SCEP decrypter certificate).
type DeviceTrust struct {
	roots         *x509.CertPool
	intermediates *x509.CertPool
	interCerts    []*x509.Certificate
	rootCount     int
}

// ParseDeviceTrustBundle parses a PEM bundle containing at least one
// self-signed device root CA and at least one device intermediate CA.
// Non-CA certificates or trailing non-PEM bytes are refused.
func ParseDeviceTrustBundle(raw []byte) (*DeviceTrust, error) {
	certs, err := parseStrictPEMCerts(raw)
	if err != nil {
		return nil, fmt.Errorf("enroll: device CA bundle: %w", err)
	}
	dt := &DeviceTrust{
		roots:         x509.NewCertPool(),
		intermediates: x509.NewCertPool(),
	}
	for _, c := range certs {
		if !c.IsCA {
			return nil, fmt.Errorf("enroll: device CA bundle contains non-CA certificate %q", c.Subject.CommonName)
		}
		if isSelfSignedRoot(c) {
			dt.roots.AddCert(c)
			dt.rootCount++
		} else {
			dt.intermediates.AddCert(c)
			dt.interCerts = append(dt.interCerts, c)
		}
	}
	if dt.rootCount == 0 {
		return nil, errors.New("enroll: device CA bundle has no self-signed root CA")
	}
	if len(dt.interCerts) == 0 {
		return nil, errors.New("enroll: device CA bundle has no intermediate CA")
	}
	return dt, nil
}

func isSelfSignedRoot(c *x509.Certificate) bool {
	if !bytes.Equal(c.RawSubject, c.RawIssuer) {
		return false
	}
	return c.CheckSignatureFrom(c) == nil
}

// DeviceCABundle watches the mounted device CA trust bundle PEM file and
// reloads it periodically so year-7 CA rotation needs no pod restart.
type DeviceCABundle struct {
	File string
	Log  *slog.Logger

	cur atomic.Pointer[DeviceTrust]
	pem []byte
}

// Load reads File and updates the active trust bundle. Unlike mailfront's
// optional bundle, enrolld requires a valid bundle to verify phase 4 requests.
func (b *DeviceCABundle) Load() error {
	raw, err := os.ReadFile(b.File)
	if err != nil {
		return fmt.Errorf("enroll: read device CA bundle: %w", err)
	}
	if bytes.Equal(raw, b.pem) && b.cur.Load() != nil {
		return nil
	}
	dt, err := ParseDeviceTrustBundle(raw)
	if err != nil {
		return err
	}
	b.cur.Store(dt)
	b.pem = raw
	if b.Log != nil {
		b.Log.Info("device CA bundle loaded", "roots", dt.rootCount, "intermediates", len(dt.interCerts))
	}
	return nil
}

// Current returns the currently loaded DeviceTrust, or nil if never loaded.
func (b *DeviceCABundle) Current() *DeviceTrust {
	if b == nil {
		return nil
	}
	return b.cur.Load()
}

// Watch re-reads File every interval until ctx ends. A broken or partial file
// keeps the previous bundle and retries on the next tick.
func (b *DeviceCABundle) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := b.Load(); err != nil && b.Log != nil {
				b.Log.Warn("device CA bundle reload failed, keeping the current one", slog.Any("err", err))
			}
		}
	}
}

// ClassifySigner decides the OTA phase of a verified CMS message strictly by
// who issued its signer certificate:
//   - Phase2Apple: issued by a pinned Apple device CA (issuer bytes equal,
//     leaf and CMS signatures are SHA1WithRSA or SHA256WithRSA, leaf signature
//     verified directly via ca.CheckSignature, validity dates ignored for this
//     chain only).
//   - Phase4DeviceCA: verifies via x509.Verify against the mounted device root
//     through a mounted device intermediate at now (refusing certificates issued
//     directly by the root such as the SCEP decrypter), non-CA leaf, explicit
//     ExtKeyUsageEmailProtection, and no SAN extension of any kind (including
//     unparsed otherName SANs such as ACME permanentIdentifier).
//   - Anything else returns PhaseUnknown and an error.
func ClassifySigner(cms *VerifiedCMS, trust *DeviceTrust, now time.Time) (Phase, error) {
	if cms == nil || cms.Signer == nil {
		return PhaseUnknown, errors.New("enroll: missing CMS signer")
	}
	if isApplePhase2Signer(cms) {
		return Phase2Apple, nil
	}
	if err := verifyPhase4Signer(cms.Signer, trust, now); err == nil {
		return Phase4DeviceCA, nil
	}
	return PhaseUnknown, errors.New("enroll: signer verified against neither pinned Apple device CA nor device CA")
}

func isApplePhase2Signer(cms *VerifiedCMS) bool {
	if cms.SigAlg != x509.SHA1WithRSA && cms.SigAlg != x509.SHA256WithRSA {
		return false
	}
	leaf := cms.Signer
	if leaf.IsCA {
		return false
	}
	if leaf.SignatureAlgorithm != x509.SHA1WithRSA && leaf.SignatureAlgorithm != x509.SHA256WithRSA {
		return false
	}
	// ⚠ DATES IGNORED ON THE APPLE DEVICE CA PATH ONLY. The pinned Apple iPhone
	// Device CA expired in 2014 and Apple's OTA guide instructs servers to
	// ignore validity dates on device certificates signed by it.
	for _, ca := range appleDeviceCAs {
		if !bytes.Equal(leaf.RawIssuer, ca.RawSubject) {
			continue
		}
		if err := ca.CheckSignature(leaf.SignatureAlgorithm, leaf.RawTBSCertificate, leaf.Signature); err == nil {
			return true
		}
	}
	return false
}

// verifyPhase4Signer enforces Review 1 rule L1 on a phase 4 SCEP leaf.
func verifyPhase4Signer(leaf *x509.Certificate, trust *DeviceTrust, now time.Time) error {
	if trust == nil {
		return errors.New("enroll: no device CA trust bundle loaded")
	}
	if leaf.IsCA {
		return errors.New("enroll: phase 4 signer must not be a CA certificate")
	}
	// Go's x509.Verify accepts certificates with an empty EKU list; L1 requires
	// emailProtection to be listed explicitly.
	if !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageEmailProtection) {
		return errors.New("enroll: phase 4 signer lacks explicit emailProtection EKU")
	}
	// ⚠ CHECK RAW EXTENSIONS FOR OID 2.5.29.17, NOT ONLY PARSED SAN SLICES.
	// ACME certificates carry an otherName (permanentIdentifier) SAN that Go's
	// crypto/x509 does not populate into DNSNames/IPAddresses/EmailAddresses/URIs.
	if hasAnySANExtension(leaf) {
		return errors.New("enroll: phase 4 signer must carry no SAN extension")
	}

	chains, err := leaf.Verify(x509.VerifyOptions{
		Roots:         trust.roots,
		Intermediates: trust.intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
	})
	if err != nil {
		return fmt.Errorf("enroll: phase 4 chain verification failed: %w", err)
	}

	// ⚠ MUST BE ISSUED BY A MOUNTED DEVICE INTERMEDIATE (chain length 3:
	// [leaf, intermediate, root]). Certificates issued directly by the root
	// (the SCEP decrypter cert) produce a 2-element chain and are refused.
	for _, chain := range chains {
		if len(chain) != 3 {
			continue
		}
		if isKnownIntermediate(chain[1], trust.interCerts) {
			return nil
		}
	}
	return errors.New("enroll: phase 4 signer was not issued by the device intermediate")
}

func hasAnySANExtension(c *x509.Certificate) bool {
	if len(c.DNSNames) > 0 || len(c.EmailAddresses) > 0 || len(c.IPAddresses) > 0 || len(c.URIs) > 0 {
		return true
	}
	for _, ext := range c.Extensions {
		if ext.Id.Equal(oidExtensionSubjectAltName) {
			return true
		}
	}
	return false
}

func isKnownIntermediate(cert *x509.Certificate, list []*x509.Certificate) bool {
	for _, ic := range list {
		if bytes.Equal(cert.Raw, ic.Raw) {
			return true
		}
	}
	return false
}
