package enrollctl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"fmt"
	"math/big"
)

var (
	oidCMSData          = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}
	oidCMSSignedData    = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	oidCMSEnvelopedData = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 3}
	oidRSAEncryption    = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidAES256CBC        = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}
)

type cmsContentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,tag:0"`
}

type cmsIssuerAndSerialNumber struct {
	Issuer       asn1.RawValue
	SerialNumber *big.Int
}

type cmsKeyTransRecipientInfo struct {
	Version                int
	RID                    cmsIssuerAndSerialNumber
	KeyEncryptionAlgorithm pkix.AlgorithmIdentifier
	EncryptedKey           []byte
}

type cmsEncryptedContentInfo struct {
	ContentType                asn1.ObjectIdentifier
	ContentEncryptionAlgorithm pkix.AlgorithmIdentifier
	EncryptedContent           asn1.RawValue `asn1:"optional,tag:0"`
}

type cmsEnvelopedData struct {
	Version              int
	RecipientInfos       []cmsKeyTransRecipientInfo `asn1:"set"`
	EncryptedContentInfo cmsEncryptedContentInfo
}

// EncryptCMSEnvelopedData wraps plaintext in DER-encoded RFC 5652 CMS
// EnvelopedData encrypted to recipient's RSA public key using RSAES-PKCS1-v1_5,
// IssuerAndSerialNumber, and AES-256-CBC with PKCS#7 padding.
//
// Matches apps/api/src/mail-devices/cms.ts and Apple's EncryptedPayloadContent
// decryption requirements (verified with `openssl cms -decrypt -inform DER`).
func EncryptCMSEnvelopedData(plaintext []byte, recipient *x509.Certificate) ([]byte, error) {
	if recipient == nil {
		return nil, errors.New("enrollctl: nil recipient certificate")
	}
	pub, ok := recipient.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("enrollctl: recipient key is not RSA")
	}
	if pub.N.BitLen() < 2048 {
		return nil, errors.New("enrollctl: recipient RSA key smaller than 2048 bits")
	}

	cek := make([]byte, 32)
	defer clear(cek) // on every return, including the early errors below
	if _, err := rand.Read(cek); err != nil {
		return nil, fmt.Errorf("enrollctl: generate cek: %w", err)
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return nil, fmt.Errorf("enrollctl: generate iv: %w", err)
	}

	encKey, err := rsa.EncryptPKCS1v15(rand.Reader, pub, cek)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: rsa encrypt cek: %w", err)
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	padded := pkcs7Pad(plaintext, aes.BlockSize)
	defer clear(padded) // a copy of the plaintext profile
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	ivDER, err := asn1.Marshal(iv)
	if err != nil {
		return nil, err
	}

	env := cmsEnvelopedData{
		Version: 0,
		RecipientInfos: []cmsKeyTransRecipientInfo{
			{
				Version: 0,
				RID: cmsIssuerAndSerialNumber{
					Issuer:       asn1.RawValue{FullBytes: recipient.RawIssuer},
					SerialNumber: recipient.SerialNumber,
				},
				KeyEncryptionAlgorithm: pkix.AlgorithmIdentifier{
					Algorithm:  oidRSAEncryption,
					Parameters: asn1.NullRawValue,
				},
				EncryptedKey: encKey,
			},
		},
		EncryptedContentInfo: cmsEncryptedContentInfo{
			ContentType: oidCMSData,
			ContentEncryptionAlgorithm: pkix.AlgorithmIdentifier{
				Algorithm:  oidAES256CBC,
				Parameters: asn1.RawValue{FullBytes: ivDER},
			},
			// Implicit [0] primitive OCTET STRING (class=context-specific, tag=0, compound=false).
			EncryptedContent: asn1.RawValue{
				Class:      asn1.ClassContextSpecific,
				Tag:        0,
				IsCompound: false,
				Bytes:      ciphertext,
			},
		},
	}

	envDER, err := asn1.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: marshal EnvelopedData: %w", err)
	}

	ci := cmsContentInfo{
		ContentType: oidCMSEnvelopedData,
		Content: asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      envDER,
		},
	}
	return asn1.Marshal(ci)
}

// DecryptCMSEnvelopedData decrypts DER-encoded CMS EnvelopedData produced by
// EncryptCMSEnvelopedData (used by tests and enrollload).
func DecryptCMSEnvelopedData(der []byte, key *rsa.PrivateKey) ([]byte, error) {
	var ci cmsContentInfo
	rest, err := asn1.Unmarshal(der, &ci)
	if err != nil || len(rest) != 0 {
		return nil, errors.New("enrollctl: invalid CMS ContentInfo")
	}
	if !ci.ContentType.Equal(oidCMSEnvelopedData) {
		return nil, errors.New("enrollctl: not EnvelopedData")
	}
	var env cmsEnvelopedData
	rest, err = asn1.Unmarshal(ci.Content.Bytes, &env)
	if err != nil || len(rest) != 0 {
		return nil, errors.New("enrollctl: invalid EnvelopedData")
	}
	if len(env.RecipientInfos) != 1 {
		return nil, errors.New("enrollctl: expected 1 RecipientInfo")
	}
	ri := env.RecipientInfos[0]
	if !ri.KeyEncryptionAlgorithm.Algorithm.Equal(oidRSAEncryption) {
		return nil, errors.New("enrollctl: unsupported key encryption algorithm")
	}
	cek, err := rsa.DecryptPKCS1v15(rand.Reader, key, ri.EncryptedKey)
	if err != nil {
		return nil, fmt.Errorf("enrollctl: rsa decrypt cek: %w", err)
	}
	if !env.EncryptedContentInfo.ContentEncryptionAlgorithm.Algorithm.Equal(oidAES256CBC) {
		return nil, errors.New("enrollctl: unsupported content encryption algorithm")
	}
	var iv []byte
	if rest, err := asn1.Unmarshal(env.EncryptedContentInfo.ContentEncryptionAlgorithm.Parameters.FullBytes, &iv); err != nil || len(rest) != 0 || len(iv) != aes.BlockSize {
		return nil, errors.New("enrollctl: invalid AES-256-CBC IV")
	}
	ct := env.EncryptedContentInfo.EncryptedContent.Bytes
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, errors.New("enrollctl: invalid ciphertext length")
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ct)
	return pkcs7Unpad(plain, aes.BlockSize)
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - (len(data) % blockSize)
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errors.New("enrollctl: bad pkcs7 length")
	}
	pad := int(data[len(data)-1])
	if pad <= 0 || pad > blockSize {
		return nil, errors.New("enrollctl: bad pkcs7 padding")
	}
	for i := len(data) - pad; i < len(data); i++ {
		if int(data[i]) != pad {
			return nil, errors.New("enrollctl: bad pkcs7 padding bytes")
		}
	}
	return data[:len(data)-pad], nil
}
