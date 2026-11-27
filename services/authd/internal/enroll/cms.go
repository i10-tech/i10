package enroll

import (
	"bytes"
	"crypto"
	_ "crypto/sha1" // needed for crypto.SHA1.New() on Apple phase 2 CMS
	_ "crypto/sha256"
	_ "crypto/sha512"
	"crypto/subtle"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"fmt"
	"math/big"
	"slices"
)

const (
	// MaxBodyBytes caps incoming device POST bodies before any ASN.1 or XML
	// work runs (docs/research/mail-device-binding.md section 12).
	MaxBodyBytes = 64 << 10

	maxASN1Depth     = 32
	maxASN1Nodes     = 4096
	maxDERBytes      = MaxBodyBytes * 2
	maxCMSCerts      = 16
	maxSignedAttrs   = 32
	maxOctetSegments = 256
)

var (
	oidData            = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}
	oidSignedData      = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	oidAttrContentType = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 3}
	oidAttrMsgDigest   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 4}

	oidDigestSHA1   = asn1.ObjectIdentifier{1, 3, 14, 3, 2, 26}
	oidDigestSHA256 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidDigestSHA384 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 2}
	oidDigestSHA512 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 3}

	oidSigRSA       = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidSigRSASHA1   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 5}
	oidSigRSASHA256 = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidSigRSASHA384 = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 12}
	oidSigRSASHA512 = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 13}
)

// VerifiedCMS is the result of parsing a CMS SignedData message and verifying
// its single SignerInfo's signature over its signed attributes (Review 1 rule
// H1). It does NOT verify the signer certificate's chain or dates; phase
// routing does that next.
type VerifiedCMS struct {
	// Signer is the single certificate matched by SignerInfo.IssuerAndSerialNumber.
	// Callers must use this exact object for CA verification, hashes, CN and DER.
	Signer *x509.Certificate
	// Content is the encapsulated id-data payload whose digest matched the
	// signed messageDigest attribute.
	Content []byte
	// SigAlg is the verified RSA signature algorithm used in SignerInfo.
	SigAlg x509.SignatureAlgorithm
}

type cmsContentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,optional,tag:0"`
}

type cmsSignedData struct {
	Version          int
	DigestAlgorithms []pkix.AlgorithmIdentifier `asn1:"set"`
	EncapContentInfo cmsContentInfo
	Certificates     asn1.RawValue   `asn1:"optional,tag:0"`
	CRLs             asn1.RawValue   `asn1:"optional,tag:1"`
	SignerInfos      []cmsSignerInfo `asn1:"set"`
}

type cmsIssuerAndSerial struct {
	Issuer       asn1.RawValue
	SerialNumber *big.Int
}

type cmsAttribute struct {
	Raw   asn1.RawContent
	Type  asn1.ObjectIdentifier
	Value asn1.RawValue `asn1:"set"`
}

type cmsSignerInfo struct {
	Version            int
	SID                cmsIssuerAndSerial
	DigestAlgorithm    pkix.AlgorithmIdentifier
	SignedAttrs        []cmsAttribute `asn1:"optional,tag:0"`
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Signature          []byte
	UnsignedAttrs      []cmsAttribute `asn1:"optional,tag:1"`
}

// ParseAndVerifyCMS parses a BER- or DER-encoded CMS SignedData message and
// performs the complete RFC 5652 / Review 1 rule H1 SignerInfo verification:
//   - bounded size, depth-bounded linear BER-to-DER normalization, panic guard;
//   - exactly one SignerInfo (v1 IssuerAndSerialNumber);
//   - signer certificate selected by IssuerAndSerialNumber from the embedded
//     certificate set (refusing conflicting duplicates);
//   - required signed attributes content-type (matching id-data) and
//     messageDigest (matching hash of encapsulated content), each unique;
//   - re-encoding of signed attributes as a DER SET OF (tag 0x31, sorted);
//   - direct verification with Signer.CheckSignature without checking
//     signingTime against the leaf certificate's validity dates.
//
// ⚠ WHY THIS DOES NOT CALL github.com/smallstep/pkcs7.Parse OR Verify:
// In smallstep/pkcs7 v0.2.3, PKCS7.Signers exposes an unexported signerInfo
// type (and PKCS7.raw is unexported), so callers cannot inspect
// DigestAlgorithm, DigestEncryptionAlgorithm, AuthenticatedAttributes or
// EncryptedDigest to verify SignerInfo themselves. All three pkcs7.Verify*
// methods also compare signingTime against the leaf's validity dates (breaking
// Apple's expired 2007-2014 device chain), skip the content-type attribute
// check, and pkcs7.Parse uses an unbounded recursive ber2der that allocates
// quadratically on nested indefinite-length tags and ignores trailing bytes.
// smallstep/pkcs7 v0.2.3 is pinned and used in tests to produce real CMS
// fixtures for interop verification.
func ParseAndVerifyCMS(raw []byte) (res *VerifiedCMS, err error) {
	defer func() {
		if r := recover(); r != nil {
			res = nil
			err = errors.New("enroll: panic while parsing CMS SignedData")
		}
	}()

	if len(raw) == 0 {
		return nil, errors.New("enroll: empty CMS body")
	}
	if len(raw) > MaxBodyBytes {
		return nil, fmt.Errorf("enroll: CMS body exceeds %d bytes", MaxBodyBytes)
	}

	der, err := berToDER(raw)
	if err != nil {
		return nil, fmt.Errorf("enroll: invalid ASN.1 BER/DER: %w", err)
	}

	var ci cmsContentInfo
	rest, err := asn1.Unmarshal(der, &ci)
	if err != nil {
		return nil, fmt.Errorf("enroll: parse ContentInfo: %w", err)
	}
	if len(rest) != 0 {
		return nil, errors.New("enroll: trailing bytes after ContentInfo")
	}
	if !ci.ContentType.Equal(oidSignedData) {
		return nil, errors.New("enroll: ContentInfo is not SignedData")
	}
	if ci.Content.Class != asn1.ClassContextSpecific || ci.Content.Tag != 0 || !ci.Content.IsCompound || len(ci.Content.Bytes) == 0 {
		return nil, errors.New("enroll: missing SignedData content")
	}

	var sd cmsSignedData
	rest, err = asn1.Unmarshal(ci.Content.Bytes, &sd)
	if err != nil {
		return nil, fmt.Errorf("enroll: parse SignedData: %w", err)
	}
	if len(rest) != 0 {
		return nil, errors.New("enroll: trailing bytes after SignedData")
	}
	if !sd.EncapContentInfo.ContentType.Equal(oidData) {
		return nil, errors.New("enroll: encapsulated content type is not id-data")
	}
	content, err := extractEncapData(sd.EncapContentInfo.Content)
	if err != nil {
		return nil, err
	}

	if len(sd.SignerInfos) != 1 {
		return nil, fmt.Errorf("enroll: expected exactly 1 SignerInfo, got %d", len(sd.SignerInfos))
	}
	si := sd.SignerInfos[0]
	if si.Version != 1 {
		return nil, fmt.Errorf("enroll: unsupported SignerInfo version %d", si.Version)
	}
	if si.SID.SerialNumber == nil ||
		si.SID.Issuer.Class != asn1.ClassUniversal ||
		si.SID.Issuer.Tag != asn1.TagSequence ||
		!si.SID.Issuer.IsCompound ||
		len(si.SID.Issuer.FullBytes) == 0 {
		return nil, errors.New("enroll: malformed IssuerAndSerialNumber")
	}

	certs, err := parseCMSCertificates(sd.Certificates)
	if err != nil {
		return nil, err
	}
	signer, err := selectSignerCert(certs, si.SID)
	if err != nil {
		return nil, err
	}

	hashAlg, sigAlg, err := resolveCMSSigAlg(si.DigestAlgorithm, si.SignatureAlgorithm)
	if err != nil {
		return nil, err
	}

	if len(si.SignedAttrs) == 0 {
		return nil, errors.New("enroll: missing signed attributes")
	}
	if len(si.SignedAttrs) > maxSignedAttrs {
		return nil, fmt.Errorf("enroll: too many signed attributes (%d)", len(si.SignedAttrs))
	}
	if err := verifySignedAttrs(si.SignedAttrs, sd.EncapContentInfo.ContentType, hashAlg, content); err != nil {
		return nil, err
	}

	signedAttrsDER, err := encodeSignedAttrsDERSet(si.SignedAttrs)
	if err != nil {
		return nil, err
	}
	if len(si.Signature) == 0 {
		return nil, errors.New("enroll: empty signature value")
	}
	if err := signer.CheckSignature(sigAlg, signedAttrsDER, si.Signature); err != nil {
		return nil, fmt.Errorf("enroll: CMS signature verification failed: %w", err)
	}

	return &VerifiedCMS{
		Signer:  signer,
		Content: content,
		SigAlg:  sigAlg,
	}, nil
}

func extractEncapData(raw asn1.RawValue) ([]byte, error) {
	if raw.Class != asn1.ClassContextSpecific || raw.Tag != 0 || !raw.IsCompound || len(raw.Bytes) == 0 {
		return nil, errors.New("enroll: missing or detached encapsulated content")
	}
	var oct asn1.RawValue
	rest, err := asn1.Unmarshal(raw.Bytes, &oct)
	if err != nil {
		return nil, fmt.Errorf("enroll: parse encapsulated content: %w", err)
	}
	if len(rest) != 0 {
		return nil, errors.New("enroll: trailing bytes in encapsulated content")
	}
	var out []byte
	segments := 0
	if err := collectOctetString(oct, &out, &segments, 0); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("enroll: empty encapsulated content")
	}
	return out, nil
}

func collectOctetString(v asn1.RawValue, out *[]byte, segments *int, depth int) error {
	if depth > 8 {
		return errors.New("enroll: constructed OCTET STRING nested too deeply")
	}
	if v.Class != asn1.ClassUniversal || v.Tag != asn1.TagOctetString {
		return errors.New("enroll: encapsulated content is not an OCTET STRING")
	}
	if !v.IsCompound {
		*segments++
		if *segments > maxOctetSegments {
			return errors.New("enroll: too many OCTET STRING segments")
		}
		if len(*out)+len(v.Bytes) > MaxBodyBytes {
			return errors.New("enroll: encapsulated content exceeds limit")
		}
		*out = append(*out, v.Bytes...)
		return nil
	}
	rem := v.Bytes
	for len(rem) > 0 {
		var child asn1.RawValue
		var err error
		rem, err = asn1.Unmarshal(rem, &child)
		if err != nil {
			return fmt.Errorf("enroll: parse constructed OCTET STRING chunk: %w", err)
		}
		if err := collectOctetString(child, out, segments, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func parseCMSCertificates(raw asn1.RawValue) ([]*x509.Certificate, error) {
	if len(raw.FullBytes) == 0 {
		return nil, errors.New("enroll: SignedData carries no certificates")
	}
	if raw.Class != asn1.ClassContextSpecific || raw.Tag != 0 || !raw.IsCompound || len(raw.Bytes) == 0 {
		return nil, errors.New("enroll: malformed SignedData certificates field")
	}
	certs, err := x509.ParseCertificates(raw.Bytes)
	if err != nil {
		return nil, fmt.Errorf("enroll: parse SignedData certificates: %w", err)
	}
	if len(certs) == 0 {
		return nil, errors.New("enroll: SignedData carries no certificates")
	}
	if len(certs) > maxCMSCerts {
		return nil, fmt.Errorf("enroll: SignedData carries too many certificates (%d)", len(certs))
	}
	return certs, nil
}

func selectSignerCert(certs []*x509.Certificate, sid cmsIssuerAndSerial) (*x509.Certificate, error) {
	var found *x509.Certificate
	for _, c := range certs {
		if c.SerialNumber != nil &&
			c.SerialNumber.Cmp(sid.SerialNumber) == 0 &&
			bytes.Equal(c.RawIssuer, sid.Issuer.FullBytes) {
			if found != nil && !bytes.Equal(found.Raw, c.Raw) {
				return nil, errors.New("enroll: conflicting certificates match IssuerAndSerialNumber")
			}
			found = c
		}
	}
	if found == nil {
		return nil, errors.New("enroll: no certificate matches SignerInfo IssuerAndSerialNumber")
	}
	return found, nil
}

func resolveCMSSigAlg(digest, sig pkix.AlgorithmIdentifier) (crypto.Hash, x509.SignatureAlgorithm, error) {
	if !validNullOrAbsentParams(digest.Parameters) {
		return 0, 0, errors.New("enroll: unexpected digest algorithm parameters")
	}
	if !validNullOrAbsentParams(sig.Parameters) {
		return 0, 0, errors.New("enroll: unexpected signature algorithm parameters")
	}
	switch {
	case digest.Algorithm.Equal(oidDigestSHA1):
		if sig.Algorithm.Equal(oidSigRSA) || sig.Algorithm.Equal(oidSigRSASHA1) {
			return crypto.SHA1, x509.SHA1WithRSA, nil
		}
	case digest.Algorithm.Equal(oidDigestSHA256):
		if sig.Algorithm.Equal(oidSigRSA) || sig.Algorithm.Equal(oidSigRSASHA256) {
			return crypto.SHA256, x509.SHA256WithRSA, nil
		}
	case digest.Algorithm.Equal(oidDigestSHA384):
		if sig.Algorithm.Equal(oidSigRSA) || sig.Algorithm.Equal(oidSigRSASHA384) {
			return crypto.SHA384, x509.SHA384WithRSA, nil
		}
	case digest.Algorithm.Equal(oidDigestSHA512):
		if sig.Algorithm.Equal(oidSigRSA) || sig.Algorithm.Equal(oidSigRSASHA512) {
			return crypto.SHA512, x509.SHA512WithRSA, nil
		}
	}
	return 0, 0, errors.New("enroll: unsupported or mismatched CMS digest/signature algorithm")
}

func validNullOrAbsentParams(p asn1.RawValue) bool {
	if len(p.FullBytes) == 0 {
		return true
	}
	return p.Class == asn1.ClassUniversal && p.Tag == asn1.TagNull && !p.IsCompound && len(p.Bytes) == 0
}

// verifySignedAttrs enforces RFC 5652 section 5.3 / Review 1 rule H1:
// content-type and messageDigest must each appear exactly once, each with
// exactly one value in its SET, matching the encapsulated content type and
// digest. signingTime is deliberately never compared to certificate dates.
func verifySignedAttrs(attrs []cmsAttribute, expectedCT asn1.ObjectIdentifier, hashAlg crypto.Hash, content []byte) error {
	var (
		ctCount int
		mdCount int
		gotCT   asn1.ObjectIdentifier
		gotMD   []byte
	)
	for _, attr := range attrs {
		if attr.Value.Class != asn1.ClassUniversal || attr.Value.Tag != asn1.TagSet || !attr.Value.IsCompound {
			return errors.New("enroll: signed attribute value is not a SET")
		}
		switch {
		case attr.Type.Equal(oidAttrContentType):
			ctCount++
			if ctCount > 1 {
				return errors.New("enroll: duplicate content-type signed attribute")
			}
			rest, err := asn1.Unmarshal(attr.Value.Bytes, &gotCT)
			if err != nil || len(rest) != 0 {
				return errors.New("enroll: invalid content-type signed attribute")
			}
		case attr.Type.Equal(oidAttrMsgDigest):
			mdCount++
			if mdCount > 1 {
				return errors.New("enroll: duplicate messageDigest signed attribute")
			}
			rest, err := asn1.Unmarshal(attr.Value.Bytes, &gotMD)
			if err != nil || len(rest) != 0 {
				return errors.New("enroll: invalid messageDigest signed attribute")
			}
		}
	}
	if ctCount != 1 {
		return errors.New("enroll: missing content-type signed attribute")
	}
	if !gotCT.Equal(expectedCT) {
		return errors.New("enroll: content-type signed attribute does not match encapsulated content")
	}
	if mdCount != 1 {
		return errors.New("enroll: missing messageDigest signed attribute")
	}
	h := hashAlg.New()
	_, _ = h.Write(content)
	computed := h.Sum(nil)
	if subtle.ConstantTimeCompare(gotMD, computed) != 1 {
		return errors.New("enroll: messageDigest signed attribute mismatch")
	}
	return nil
}

// encodeSignedAttrsDERSet re-encodes SignerInfo.signedAttrs as a universal DER
// SET OF Attribute (tag 0x31, elements sorted lexicographically per X.690
// section 11.6 and RFC 5652 section 5.4).
func encodeSignedAttrsDERSet(attrs []cmsAttribute) ([]byte, error) {
	encoded := make([][]byte, len(attrs))
	total := 0
	for i, a := range attrs {
		if len(a.Raw) == 0 {
			return nil, errors.New("enroll: empty signed attribute")
		}
		encoded[i] = a.Raw
		total += len(a.Raw)
	}
	slices.SortFunc(encoded, bytes.Compare)

	out := make([]byte, 0, 1+derLengthSize(total)+total)
	out = append(out, 0x31)
	out = appendDERLength(out, total)
	for _, elem := range encoded {
		out = append(out, elem...)
	}
	return out, nil
}

// ---- depth-bounded, linear-time BER-to-DER normalizer ----

type berNode struct {
	tagBytes    []byte
	constructed bool
	primitive   []byte
	children    []berNode
	bodyLen     int
	totalLen    int
}

// berToDER converts a single BER TLV (including indefinite-length constructed
// elements that Apple's CMS encoder or OpenSSL may emit) to canonical definite
// DER lengths in O(n) time and memory, with strict depth, node count and
// trailing-byte checks.
func berToDER(ber []byte) ([]byte, error) {
	if len(ber) == 0 {
		return nil, errors.New("empty BER input")
	}
	nodes := 0
	root, next, err := parseBERNode(ber, 0, 0, &nodes)
	if err != nil {
		return nil, err
	}
	if next != len(ber) {
		return nil, errors.New("trailing bytes after root ASN.1 element")
	}
	if root.totalLen > maxDERBytes {
		return nil, errors.New("DER output exceeds limit")
	}
	out := make([]byte, 0, root.totalLen)
	out = writeBERNode(out, &root)
	return out, nil
}

func parseBERNode(ber []byte, offset, depth int, nodes *int) (berNode, int, error) {
	if depth > maxASN1Depth {
		return berNode{}, 0, errors.New("ASN.1 nesting depth exceeded")
	}
	*nodes++
	if *nodes > maxASN1Nodes {
		return berNode{}, 0, errors.New("ASN.1 node limit exceeded")
	}
	if offset >= len(ber) {
		return berNode{}, 0, errors.New("unexpected end of BER input")
	}

	tagStart := offset
	b0 := ber[offset]
	offset++
	constructed := (b0 & 0x20) != 0
	if b0&0x1F == 0x1F {
		// High-tag-number form (X.690 section 8.1.2.4).
		if offset >= len(ber) {
			return berNode{}, 0, errors.New("truncated high-tag-number")
		}
		if ber[offset] == 0x80 {
			return berNode{}, 0, errors.New("non-minimal high-tag-number")
		}
		for i := 0; ; i++ {
			if i >= 4 {
				return berNode{}, 0, errors.New("high-tag-number too long")
			}
			if offset >= len(ber) {
				return berNode{}, 0, errors.New("truncated high-tag-number")
			}
			tb := ber[offset]
			offset++
			if tb&0x80 == 0 {
				break
			}
		}
	}
	tagBytes := ber[tagStart:offset]

	if offset >= len(ber) {
		return berNode{}, 0, errors.New("truncated BER length")
	}
	lb := ber[offset]
	offset++

	indefinite := false
	length := 0
	switch {
	case lb < 0x80:
		length = int(lb)
	case lb == 0x80:
		if !constructed {
			return berNode{}, 0, errors.New("indefinite length on primitive BER element")
		}
		indefinite = true
	default:
		n := int(lb & 0x7F)
		if n == 0 || n > 4 {
			return berNode{}, 0, errors.New("invalid BER length octet count")
		}
		if offset+n > len(ber) {
			return berNode{}, 0, errors.New("truncated BER long length")
		}
		if ber[offset] == 0 {
			return berNode{}, 0, errors.New("BER length has leading zero")
		}
		if n == 4 && ber[offset] > 0x7F {
			return berNode{}, 0, errors.New("BER length overflows 31-bit integer")
		}
		for i := 0; i < n; i++ {
			length = (length << 8) | int(ber[offset])
			offset++
		}
		if length < 0 || length > len(ber)-offset {
			return berNode{}, 0, errors.New("BER length exceeds available input")
		}
	}

	if !constructed {
		if offset+length > len(ber) {
			return berNode{}, 0, errors.New("BER primitive exceeds available input")
		}
		prim := ber[offset : offset+length]
		total := len(tagBytes) + derLengthSize(length) + length
		return berNode{
			tagBytes:    tagBytes,
			constructed: false,
			primitive:   prim,
			bodyLen:     length,
			totalLen:    total,
		}, offset + length, nil
	}

	var children []berNode
	bodyLen := 0
	if indefinite {
		for {
			if offset+2 > len(ber) {
				return berNode{}, 0, errors.New("missing indefinite-length EOC terminator")
			}
			if ber[offset] == 0x00 && ber[offset+1] == 0x00 {
				offset += 2
				break
			}
			child, next, err := parseBERNode(ber, offset, depth+1, nodes)
			if err != nil {
				return berNode{}, 0, err
			}
			bodyLen += child.totalLen
			if bodyLen > maxDERBytes {
				return berNode{}, 0, errors.New("DER body exceeds limit")
			}
			children = append(children, child)
			offset = next
		}
	} else {
		end := offset + length
		if end > len(ber) {
			return berNode{}, 0, errors.New("BER constructed element exceeds available input")
		}
		for offset < end {
			child, next, err := parseBERNode(ber, offset, depth+1, nodes)
			if err != nil {
				return berNode{}, 0, err
			}
			if next > end {
				return berNode{}, 0, errors.New("BER child exceeds parent length")
			}
			bodyLen += child.totalLen
			if bodyLen > maxDERBytes {
				return berNode{}, 0, errors.New("DER body exceeds limit")
			}
			children = append(children, child)
			offset = next
		}
		if offset != end {
			return berNode{}, 0, errors.New("BER constructed length mismatch")
		}
	}

	total := len(tagBytes) + derLengthSize(bodyLen) + bodyLen
	return berNode{
		tagBytes:    tagBytes,
		constructed: true,
		children:    children,
		bodyLen:     bodyLen,
		totalLen:    total,
	}, offset, nil
}

func writeBERNode(out []byte, n *berNode) []byte {
	out = append(out, n.tagBytes...)
	out = appendDERLength(out, n.bodyLen)
	if !n.constructed {
		return append(out, n.primitive...)
	}
	for i := range n.children {
		out = writeBERNode(out, &n.children[i])
	}
	return out
}

func derLengthSize(n int) int {
	if n < 0x80 {
		return 1
	}
	size := 1
	for v := n; v > 0; v >>= 8 {
		size++
	}
	return size
}

func appendDERLength(out []byte, n int) []byte {
	if n < 0x80 {
		return append(out, byte(n))
	}
	var buf [8]byte
	i := len(buf)
	for v := n; v > 0; v >>= 8 {
		i--
		buf[i] = byte(v)
	}
	numBytes := len(buf) - i
	out = append(out, byte(0x80|numBytes))
	return append(out, buf[i:]...)
}
