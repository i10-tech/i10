package enrollctl

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"sync/atomic"
	"time"
)

const (
	// MacACMECertValidity matches infra/k8s/i10/device-ca/config/apple.tpl (3 years).
	MacACMECertValidity = 26280 * time.Hour
	// MacACMECertBackdate matches step-ca's 1-minute NotBefore clock-skew grace.
	MacACMECertBackdate = 1 * time.Minute
)

var (
	oidExtSubjectAltName   = asn1.ObjectIdentifier{2, 5, 29, 17}
	oidPermanentIdentifier = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 8, 3}
)

// DeviceCAIssuer holds the mounted device intermediate certificate and private
// key used by enrollctl /acme/finalize to sign Mac ACME client certificates.
type DeviceCAIssuer struct {
	CertFile string
	KeyFile  string
	Log      *slog.Logger

	cur     atomic.Pointer[deviceCAState]
	certPEM []byte
	keyPEM  []byte
}

type deviceCAState struct {
	inter    *x509.Certificate
	interPEM []byte
	signer   crypto.Signer
}

// NewStaticDeviceCAIssuer constructs an in-memory issuer (for tests and enrollload).
func NewStaticDeviceCAIssuer(inter *x509.Certificate, signer crypto.Signer) (*DeviceCAIssuer, error) {
	if inter == nil || signer == nil || !inter.IsCA {
		return nil, errors.New("enrollctl: invalid device intermediate CA")
	}
	interPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: inter.Raw})
	iss := &DeviceCAIssuer{}
	iss.cur.Store(&deviceCAState{inter: inter, interPEM: interPEM, signer: signer})
	return iss, nil
}

// Load reads CertFile and KeyFile and updates the active intermediate issuer.
func (d *DeviceCAIssuer) Load() error {
	certPEM, err := os.ReadFile(d.CertFile)
	if err != nil {
		return fmt.Errorf("enrollctl: read device intermediate cert: %w", err)
	}
	keyPEM, err := os.ReadFile(d.KeyFile)
	if err != nil {
		return fmt.Errorf("enrollctl: read device intermediate key: %w", err)
	}
	if bytes.Equal(certPEM, d.certPEM) && bytes.Equal(keyPEM, d.keyPEM) && d.cur.Load() != nil {
		return nil
	}
	chain, err := parseCertChainStrict(certPEM)
	if err != nil {
		return fmt.Errorf("enrollctl: parse device intermediate cert: %w", err)
	}
	if len(chain) != 1 || !chain[0].IsCA {
		return errors.New("enrollctl: device intermediate cert file must contain exactly one CA certificate")
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("enrollctl: device intermediate keypair mismatch: %w", err)
	}
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return errors.New("enrollctl: device intermediate key does not implement crypto.Signer")
	}
	d.cur.Store(&deviceCAState{
		inter:    chain[0],
		interPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: chain[0].Raw}),
		signer:   signer,
	})
	d.certPEM = certPEM
	d.keyPEM = keyPEM
	if d.Log != nil {
		d.Log.Info("device CA intermediate loaded",
			"subject", chain[0].Subject.String(),
			"notAfter", chain[0].NotAfter.UTC().Format(time.RFC3339))
	}
	return nil
}

// Watch reloads the device intermediate cert and key every interval until ctx ends.
func (d *DeviceCAIssuer) Watch(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := d.Load(); err != nil && d.Log != nil {
				d.Log.Warn("device CA intermediate reload failed, keeping previous", slog.Any("err", err))
			}
		}
	}
}

// IssueMacACMECert signs a Mac client certificate matching
// infra/k8s/i10/device-ca/config/apple.tpl:
//   - Subject: CN = serial, OU = [ou]
//   - SAN: one otherName permanentIdentifier (OID 1.3.6.1.5.5.7.8.3) = serial
//     (and NO DNS, IP, URI, or email SANs, keeping it compatible with the
//     intermediate's name constraints and mailfront's verifyClientCert)
//   - KeyUsage: digitalSignature only
//   - ExtKeyUsage: clientAuth only
//   - Validity: 26280h (3 years, capped to intermediate NotAfter; refuses if
//     intermediate is expired)
//   - SerialNumber: random 159-bit positive integer (>= 128 bits of entropy)
//   - SKI + AKI set explicitly
//
// Returns leaf + intermediate PEM chain.
func (d *DeviceCAIssuer) IssueMacACMECert(pub crypto.PublicKey, serial, ou string, now time.Time) (leafDER []byte, chainPEM string, err error) {
	st := d.cur.Load()
	if st == nil {
		return nil, "", errors.New("enrollctl: device CA intermediate not loaded")
	}
	now = now.UTC()
	if now.Before(st.inter.NotBefore) || !now.Before(st.inter.NotAfter) {
		return nil, "", errors.New("enrollctl: device CA intermediate is not valid now")
	}
	notBefore := now.Add(-MacACMECertBackdate)
	if notBefore.Before(st.inter.NotBefore) {
		notBefore = st.inter.NotBefore
	}
	notAfter := now.Add(MacACMECertValidity)
	if notAfter.After(st.inter.NotAfter) {
		notAfter = st.inter.NotAfter
	}
	if !notAfter.After(now) {
		return nil, "", errors.New("enrollctl: device CA intermediate has insufficient lifetime")
	}

	sanExt, err := permanentIdentifierSANExtension(serial)
	if err != nil {
		return nil, "", err
	}
	serialNum, err := randomCertSerial()
	if err != nil {
		return nil, "", err
	}
	ski, err := computeSKI(pub)
	if err != nil {
		return nil, "", err
	}
	aki := st.inter.SubjectKeyId
	if len(aki) == 0 {
		aki, err = computeSKI(st.inter.PublicKey)
		if err != nil {
			return nil, "", err
		}
	}

	tmpl := &x509.Certificate{
		SerialNumber: serialNum,
		Subject: pkix.Name{
			CommonName:         serial,
			OrganizationalUnit: []string{ou},
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		SubjectKeyId:          ski,
		AuthorityKeyId:        aki,
		ExtraExtensions:       []pkix.Extension{sanExt},
	}

	leafDER, err = x509.CreateCertificate(rand.Reader, tmpl, st.inter, pub, st.signer)
	if err != nil {
		return nil, "", fmt.Errorf("enrollctl: create Mac ACME cert: %w", err)
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	return leafDER, string(leafPEM) + string(st.interPEM), nil
}

// permanentIdentifierSANExtension encodes RFC 4043 PermanentIdentifier inside
// SubjectAltName GeneralNames[0] otherName, matching step-ca x509util:
//
//	GeneralNames ::= SEQUENCE {
//	  [0] IMPLICIT OtherName {
//	    type-id OBJECT IDENTIFIER (1.3.6.1.5.5.7.8.3),
//	    value [0] EXPLICIT SEQUENCE {
//	      identifierValue UTF8String (serial)
//	    }
//	  }
//	}
func permanentIdentifierSANExtension(serial string) (pkix.Extension, error) {
	type permIDValue struct {
		IdentifierValue string `asn1:"utf8"`
	}
	type otherName struct {
		TypeID asn1.ObjectIdentifier
		Value  permIDValue `asn1:"explicit,tag:0"`
	}
	onDER, err := asn1.Marshal(otherName{
		TypeID: oidPermanentIdentifier,
		Value:  permIDValue{IdentifierValue: serial},
	})
	if err != nil {
		return pkix.Extension{}, fmt.Errorf("enrollctl: marshal otherName: %w", err)
	}
	// Replace outer SEQUENCE tag (0x30) with [0] IMPLICIT constructed tag (0xA0).
	var inner asn1.RawValue
	if _, err := asn1.Unmarshal(onDER, &inner); err != nil {
		return pkix.Extension{}, err
	}
	generalName := asn1.RawValue{
		Class:      asn1.ClassContextSpecific,
		Tag:        0,
		IsCompound: true,
		Bytes:      inner.Bytes,
	}
	sanVal, err := asn1.Marshal([]asn1.RawValue{generalName})
	if err != nil {
		return pkix.Extension{}, fmt.Errorf("enrollctl: marshal SAN: %w", err)
	}
	return pkix.Extension{
		Id:       oidExtSubjectAltName,
		Critical: false,
		Value:    sanVal,
	}, nil
}

// randomCertSerial generates a positive random 159-bit serial number with the
// top byte in [0x40, 0x7f] (always positive in ASN.1 DER without sign padding,
// always >= 158 bits > 128 bits).
func randomCertSerial() (*big.Int, error) {
	var b [20]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	b[0] = (b[0] & 0x3f) | 0x40
	return new(big.Int).SetBytes(b[:]), nil
}

func computeSKI(pub crypto.PublicKey) ([]byte, error) {
	spki, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(spki)
	return sum[:20], nil
}
