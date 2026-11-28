package enrollctl

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"fmt"
	"sort"
	"time"
)

var (
	oidDigestSHA256    = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidECDSAWithSHA256 = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
	oidRSAWithSHA256   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidAttrContentType = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 3}
	oidAttrMessageDig  = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 4}
	oidAttrSigningTime = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 5}
)

type cmsEncapContentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,tag:0"`
}

type cmsAttribute struct {
	Type   asn1.ObjectIdentifier
	Values asn1.RawValue `asn1:"set"`
}

type cmsSignerInfo struct {
	Version            int
	SID                cmsIssuerAndSerialNumber
	DigestAlgorithm    pkix.AlgorithmIdentifier
	SignedAttrs        asn1.RawValue `asn1:"optional,tag:0"`
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Signature          []byte
}

type cmsSignedData struct {
	Version          int
	DigestAlgorithms []pkix.AlgorithmIdentifier `asn1:"set"`
	EncapContentInfo cmsEncapContentInfo
	Certificates     asn1.RawValue   `asn1:"optional,tag:0"`
	SignerInfos      []cmsSignerInfo `asn1:"set"`
}

// SignCMSSignedData produces DER-encoded RFC 5652 CMS SignedData wrapping
// content as encapsulated id-data with:
//   - SHA-256 digest algorithm
//   - signed attributes: contentType, messageDigest, signingTime (DER-sorted)
//   - ONE SignerInfo (ECDSA P-256 with SHA-256; RSA-SHA256 also supported)
//   - full certificate chain (chain[0] leaf + intermediates) in certificates[0]
//
// Verified against `openssl cms -verify -inform DER` and iOS/macOS profile
// installation (docs/research/enrollment-at-scale.md section 3).
func SignCMSSignedData(content []byte, chain []*x509.Certificate, signer crypto.Signer, now time.Time) ([]byte, error) {
	if len(chain) == 0 || chain[0] == nil {
		return nil, errors.New("enrollctl: empty signing certificate chain")
	}
	if signer == nil {
		return nil, errors.New("enrollctl: nil signer")
	}
	leaf := chain[0]

	var sigAlg pkix.AlgorithmIdentifier
	switch signer.Public().(type) {
	case *ecdsa.PublicKey:
		sigAlg = pkix.AlgorithmIdentifier{Algorithm: oidECDSAWithSHA256}
	case *rsa.PublicKey:
		sigAlg = pkix.AlgorithmIdentifier{Algorithm: oidRSAWithSHA256, Parameters: asn1.NullRawValue}
	default:
		return nil, fmt.Errorf("enrollctl: unsupported signer public key type %T", signer.Public())
	}

	contentDigest := sha256.Sum256(content)

	// Build the three mandatory/recommended signed attributes and sort them
	// lexicographically by encoded DER bytes per X.690 11.6 (SET OF DER rule).
	attrCT, err := marshalAttr(oidAttrContentType, oidCMSData)
	if err != nil {
		return nil, err
	}
	attrMD, err := marshalAttr(oidAttrMessageDig, contentDigest[:])
	if err != nil {
		return nil, err
	}
	attrST, err := marshalSigningTimeAttr(now.UTC())
	if err != nil {
		return nil, err
	}
	attrs := [][]byte{attrCT, attrMD, attrST}
	sort.Slice(attrs, func(i, j int) bool {
		return bytes.Compare(attrs[i], attrs[j]) < 0
	})
	var attrConcat []byte
	for _, a := range attrs {
		attrConcat = append(attrConcat, a...)
	}

	// RFC 5652 section 5.4: digest is computed over the DER encoding of the
	// EXPLICIT SET OF Attribute (universal tag 0x31), NOT the [0] IMPLICIT tag.
	attrsSetDER, err := asn1.Marshal(asn1.RawValue{
		Class:      asn1.ClassUniversal,
		Tag:        asn1.TagSet,
		IsCompound: true,
		Bytes:      attrConcat,
	})
	if err != nil {
		return nil, err
	}
	attrsDigest := sha256.Sum256(attrsSetDER)

	sigBytes, err := signer.Sign(rand.Reader, attrsDigest[:], crypto.SHA256)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: sign CMS attributes: %w", err)
	}

	// Concatenate raw DER bytes of every certificate in chain (leaf + intermediates)
	// inside [0] IMPLICIT CertificateSet.
	var certsBytes []byte
	for _, c := range chain {
		if c == nil || len(c.Raw) == 0 {
			return nil, errors.New("enrollctl: nil certificate in chain")
		}
		certsBytes = append(certsBytes, c.Raw...)
	}

	contentOctet, err := asn1.Marshal(content)
	if err != nil {
		return nil, err
	}

	sha256Alg := pkix.AlgorithmIdentifier{Algorithm: oidDigestSHA256}
	sd := cmsSignedData{
		Version:          1,
		DigestAlgorithms: []pkix.AlgorithmIdentifier{sha256Alg},
		EncapContentInfo: cmsEncapContentInfo{
			ContentType: oidCMSData,
			Content: asn1.RawValue{
				Class:      asn1.ClassContextSpecific,
				Tag:        0,
				IsCompound: true,
				Bytes:      contentOctet,
			},
		},
		Certificates: asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      certsBytes,
		},
		SignerInfos: []cmsSignerInfo{
			{
				Version: 1,
				SID: cmsIssuerAndSerialNumber{
					Issuer:       asn1.RawValue{FullBytes: leaf.RawIssuer},
					SerialNumber: leaf.SerialNumber,
				},
				DigestAlgorithm: sha256Alg,
				SignedAttrs: asn1.RawValue{
					Class:      asn1.ClassContextSpecific,
					Tag:        0,
					IsCompound: true,
					Bytes:      attrConcat,
				},
				SignatureAlgorithm: sigAlg,
				Signature:          sigBytes,
			},
		},
	}

	sdDER, err := asn1.Marshal(sd)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: marshal SignedData: %w", err)
	}
	ci := cmsContentInfo{
		ContentType: oidCMSSignedData,
		Content: asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      sdDER,
		},
	}
	return asn1.Marshal(ci)
}

func marshalAttr(oid asn1.ObjectIdentifier, val any) ([]byte, error) {
	valDER, err := asn1.Marshal(val)
	if err != nil {
		return nil, err
	}
	return asn1.Marshal(cmsAttribute{
		Type: oid,
		Values: asn1.RawValue{
			Class:      asn1.ClassUniversal,
			Tag:        asn1.TagSet,
			IsCompound: true,
			Bytes:      valDER,
		},
	})
}

func marshalSigningTimeAttr(t time.Time) ([]byte, error) {
	// RFC 5652 section 11.3: UTCTime for years 1950..2049, GeneralizedTime thereafter.
	var valDER []byte
	var err error
	if t.Year() >= 1950 && t.Year() <= 2049 {
		valDER, err = asn1.MarshalWithParams(t.UTC(), "utc")
	} else {
		valDER, err = asn1.MarshalWithParams(t.UTC(), "generalized")
	}
	if err != nil {
		return nil, err
	}
	return asn1.Marshal(cmsAttribute{
		Type: oidAttrSigningTime,
		Values: asn1.RawValue{
			Class:      asn1.ClassUniversal,
			Tag:        asn1.TagSet,
			IsCompound: true,
			Bytes:      valDER,
		},
	})
}
