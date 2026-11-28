package acmed

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const (
	cborMaxDepth     = 8
	cborMaxItems     = 64
	cborMaxStringLen = 32 * 1024
)

var (
	errMalformedCBOR  = errors.New("acmed: malformed CBOR attestation object")
	errUnsupportedFmt = errors.New("acmed: unsupported attestation format")
)

// AppleAttestationObj holds the parsed fields of a WebAuthn / ACME
// device-attest-01 Apple attestation object (`{"fmt": "apple", "attStmt": {"x5c": [...]}}`).
type AppleAttestationObj struct {
	Format string
	X5C    [][]byte
}

// ParseAppleAttestationCBOR strictly validates well-formedness of raw RFC 8949
// CBOR bytes (bounded depth, item count, string lengths, zero trailing bytes,
// no indefinite-length streams, no semantic tags) and extracts the Apple
// attestation object.
func ParseAppleAttestationCBOR(raw []byte) (*AppleAttestationObj, error) {
	if len(raw) == 0 || len(raw) > 64*1024 {
		return nil, errMalformedCBOR
	}
	dec := &cborDecoder{buf: raw}
	val, err := dec.readValue(0)
	if err != nil {
		return nil, err
	}
	if dec.pos != len(dec.buf) {
		return nil, fmt.Errorf("%w: %d trailing bytes", errMalformedCBOR, len(dec.buf)-dec.pos)
	}
	root, ok := val.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: top-level item must be a map", errMalformedCBOR)
	}
	fmtStr, ok := root["fmt"].(string)
	if !ok || fmtStr == "" {
		return nil, fmt.Errorf("%w: missing fmt", errMalformedCBOR)
	}
	if fmtStr != "apple" {
		return nil, fmt.Errorf("%w: %q", errUnsupportedFmt, fmtStr)
	}
	attStmt, ok := root["attStmt"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: missing attStmt map", errMalformedCBOR)
	}
	x5cAny, ok := attStmt["x5c"].([]any)
	if !ok || len(x5cAny) == 0 || len(x5cAny) > 8 {
		return nil, fmt.Errorf("%w: missing or invalid attStmt.x5c", errMalformedCBOR)
	}
	x5c := make([][]byte, len(x5cAny))
	for i, elem := range x5cAny {
		b, ok := elem.([]byte)
		if !ok || len(b) == 0 {
			return nil, fmt.Errorf("%w: x5c[%d] is not a non-empty byte string", errMalformedCBOR, i)
		}
		x5c[i] = b
	}
	return &AppleAttestationObj{Format: fmtStr, X5C: x5c}, nil
}

type cborDecoder struct {
	buf   []byte
	pos   int
	items int
}

func (d *cborDecoder) readByte() (byte, error) {
	if d.pos >= len(d.buf) {
		return 0, errMalformedCBOR
	}
	b := d.buf[d.pos]
	d.pos++
	return b, nil
}

func (d *cborDecoder) readBytes(n int) ([]byte, error) {
	if n < 0 || n > cborMaxStringLen || d.pos+n > len(d.buf) {
		return nil, errMalformedCBOR
	}
	out := make([]byte, n)
	copy(out, d.buf[d.pos:d.pos+n])
	d.pos += n
	return out, nil
}

func (d *cborDecoder) readArg(ai byte) (uint64, error) {
	switch {
	case ai < 24:
		return uint64(ai), nil
	case ai == 24:
		b, err := d.readByte()
		return uint64(b), err
	case ai == 25:
		b, err := d.readBytes(2)
		if err != nil {
			return 0, err
		}
		return uint64(binary.BigEndian.Uint16(b)), nil
	case ai == 26:
		b, err := d.readBytes(4)
		if err != nil {
			return 0, err
		}
		return uint64(binary.BigEndian.Uint32(b)), nil
	case ai == 27:
		b, err := d.readBytes(8)
		if err != nil {
			return 0, err
		}
		return binary.BigEndian.Uint64(b), nil
	default:
		// Reject reserved additional info (28..30) and indefinite length (31).
		return 0, errMalformedCBOR
	}
}

func (d *cborDecoder) readValue(depth int) (any, error) {
	if depth > cborMaxDepth {
		return nil, errMalformedCBOR
	}
	d.items++
	if d.items > cborMaxItems {
		return nil, errMalformedCBOR
	}
	initial, err := d.readByte()
	if err != nil {
		return nil, err
	}
	major := initial >> 5
	ai := initial & 0x1f

	switch major {
	case 0: // unsigned int
		return d.readArg(ai)
	case 1: // negative int
		n, err := d.readArg(ai)
		if err != nil {
			return nil, err
		}
		return -1 - int64(n), nil
	case 2: // byte string
		n, err := d.readArg(ai)
		if err != nil || n > cborMaxStringLen {
			return nil, errMalformedCBOR
		}
		return d.readBytes(int(n))
	case 3: // UTF-8 text string
		n, err := d.readArg(ai)
		if err != nil || n > cborMaxStringLen {
			return nil, errMalformedCBOR
		}
		b, err := d.readBytes(int(n))
		if err != nil || !utf8.Valid(b) {
			return nil, errMalformedCBOR
		}
		return string(b), nil
	case 4: // array
		n, err := d.readArg(ai)
		if err != nil || n > cborMaxItems {
			return nil, errMalformedCBOR
		}
		arr := make([]any, int(n))
		for i := 0; i < int(n); i++ {
			v, err := d.readValue(depth + 1)
			if err != nil {
				return nil, err
			}
			arr[i] = v
		}
		return arr, nil
	case 5: // map (we require string keys for attestation objects)
		n, err := d.readArg(ai)
		if err != nil || n > cborMaxItems {
			return nil, errMalformedCBOR
		}
		m := make(map[string]any, int(n))
		for i := 0; i < int(n); i++ {
			kAny, err := d.readValue(depth + 1)
			if err != nil {
				return nil, err
			}
			ks, ok := kAny.(string)
			if !ok {
				return nil, errMalformedCBOR
			}
			if _, dup := m[ks]; dup {
				return nil, errMalformedCBOR
			}
			v, err := d.readValue(depth + 1)
			if err != nil {
				return nil, err
			}
			m[ks] = v
		}
		return m, nil
	case 6:
		// ⚠ SEMANTIC TAGS ARE REFUSED. Apple's attestation object uses none, and
		// a tag changes how its value is read (a bignum, a date, a URI) in ways
		// this parser would otherwise have to get right.
		return nil, fmt.Errorf("%w: semantic tags are not allowed", errMalformedCBOR)
	case 7: // simple values / floats
		switch ai {
		case 20:
			return false, nil
		case 21:
			return true, nil
		case 22, 23:
			return nil, nil
		case 24:
			b, err := d.readByte()
			if err != nil || b < 32 {
				return nil, errMalformedCBOR
			}
			return b, nil
		case 25:
			_, err := d.readBytes(2)
			return nil, err
		case 26:
			_, err := d.readBytes(4)
			return nil, err
		case 27:
			_, err := d.readBytes(8)
			return nil, err
		default:
			return nil, errMalformedCBOR
		}
	default:
		return nil, errMalformedCBOR
	}
}

// EncodeAppleAttestationCBOR builds a canonical CBOR Apple attestation object
// `{"fmt":"apple","attStmt":{"x5c":[...]}}` (used by tests and enrollload).
func EncodeAppleAttestationCBOR(x5c [][]byte) []byte {
	var out []byte
	out = appendCBORHeader(out, 5, 2) // map(2)
	out = appendCBORText(out, "fmt")
	out = appendCBORText(out, "apple")
	out = appendCBORText(out, "attStmt")
	out = appendCBORHeader(out, 5, 1) // map(1)
	out = appendCBORText(out, "x5c")
	out = appendCBORHeader(out, 4, uint64(len(x5c)))
	for _, c := range x5c {
		out = appendCBORHeader(out, 2, uint64(len(c)))
		out = append(out, c...)
	}
	return out
}

func appendCBORHeader(dst []byte, major byte, n uint64) []byte {
	m := major << 5
	switch {
	case n < 24:
		return append(dst, m|byte(n))
	case n <= 0xff:
		return append(dst, m|24, byte(n))
	case n <= 0xffff:
		return binary.BigEndian.AppendUint16(append(dst, m|25), uint16(n))
	case n <= 0xffffffff:
		return binary.BigEndian.AppendUint32(append(dst, m|26), uint32(n))
	default:
		return binary.BigEndian.AppendUint64(append(dst, m|27), n)
	}
}

func appendCBORText(dst []byte, s string) []byte {
	dst = appendCBORHeader(dst, 3, uint64(len(s)))
	return append(dst, s...)
}

func cryptoRandReader() io.Reader {
	return rand.Reader
}
