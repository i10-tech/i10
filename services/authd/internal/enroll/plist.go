package enroll

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const (
	maxPlistBytes    = 32 << 10
	maxPlistKeys     = 32
	maxPlistKeyLen   = 64
	maxPlistValueLen = 512
	// maxChallengeDataB64 bounds the raw text inside <data> for CHALLENGE
	// (512 decoded bytes is ~684 base64 chars plus Apple's line wrapping).
	maxChallengeDataB64 = 1024
)

// ParseAttributesPlist strictly parses an Apple OTA device attributes plist.
//
// Only a flat <plist version="1.0"><dict>...</dict></plist> of <key>/<string>
// pairs is accepted, with one Review 1 exception: CHALLENGE may be either
// <string> or <data> (base64-encoded UTF-8), and nothing else may be <data>.
//
// Hostile XML constructs are refused outright:
//   - CDATA sections (<![CDATA[...]]>, which encoding/xml would otherwise merge
//     into CharData);
//   - DTD internal subsets and entity declarations (<!ENTITY, [, ]);
//   - custom XML entities (dec.Strict = true, dec.Entity = nil);
//   - comments and extra processing instructions;
//   - nested dicts/arrays, non-string types, attributes on inner tags,
//     duplicate keys, empty keys, NUL bytes, invalid UTF-8 and oversized inputs.
func ParseAttributesPlist(raw []byte) (map[string]string, error) {
	if len(raw) == 0 {
		return nil, errors.New("enroll: empty attributes plist")
	}
	if len(raw) > maxPlistBytes {
		return nil, fmt.Errorf("enroll: attributes plist exceeds %d bytes", maxPlistBytes)
	}
	if !utf8.Valid(raw) {
		return nil, errors.New("enroll: attributes plist is not valid UTF-8")
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return nil, errors.New("enroll: attributes plist contains NUL byte")
	}
	// ⚠ Go's encoding/xml merges CDATA into xml.CharData without emitting a
	// distinct token, so reject it on the raw XML bytes before decoding.
	if bytes.Contains(raw, []byte("<![CDATA[")) {
		return nil, errors.New("enroll: CDATA is not allowed in attributes plist")
	}

	dec := xml.NewDecoder(bytes.NewReader(raw))
	dec.Strict = true
	dec.Entity = nil

	seenXMLDecl := false
	seenDoctype := false

	// 1. Prolog: optional <?xml ...?>, optional <!DOCTYPE plist ...>, then <plist>.
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("enroll: plist prolog: %w", err)
		}
		switch t := tok.(type) {
		case xml.CharData:
			if len(bytes.TrimSpace(t)) != 0 {
				return nil, errors.New("enroll: unexpected text before <plist>")
			}
		case xml.ProcInst:
			if t.Target != "xml" || seenXMLDecl || seenDoctype {
				return nil, errors.New("enroll: unexpected processing instruction")
			}
			seenXMLDecl = true
		case xml.Directive:
			if seenDoctype {
				return nil, errors.New("enroll: duplicate DOCTYPE")
			}
			if err := validatePlistDoctype([]byte(t)); err != nil {
				return nil, err
			}
			seenDoctype = true
		case xml.Comment:
			return nil, errors.New("enroll: XML comments are not allowed in attributes plist")
		case xml.StartElement:
			if err := validatePlistRoot(t); err != nil {
				return nil, err
			}
			goto inPlist
		default:
			return nil, errors.New("enroll: unexpected token before <plist>")
		}
	}

inPlist:
	// 2. Inside <plist>: whitespace and exactly one <dict>.
	if err := expectStartElement(dec, "dict"); err != nil {
		return nil, err
	}

	// 3. Inside <dict>: flat <key>/<string> pairs (or <data> only for CHALLENGE).
	attrs := make(map[string]string, 8)
	for {
		tok, err := nextNonWhitespaceToken(dec)
		if err != nil {
			return nil, fmt.Errorf("enroll: plist dict: %w", err)
		}
		switch t := tok.(type) {
		case xml.EndElement:
			if t.Name.Local != "dict" || t.Name.Space != "" {
				return nil, errors.New("enroll: mismatched end element inside <dict>")
			}
			goto afterDict
		case xml.StartElement:
			if t.Name.Local != "key" || t.Name.Space != "" || len(t.Attr) != 0 {
				return nil, fmt.Errorf("enroll: expected <key>, got <%s>", t.Name.Local)
			}
			key, err := readSimpleText(dec, "key", maxPlistKeyLen)
			if err != nil {
				return nil, err
			}
			if key == "" {
				return nil, errors.New("enroll: empty plist key")
			}
			if _, dup := attrs[key]; dup {
				return nil, fmt.Errorf("enroll: duplicate plist key %q", key)
			}
			if len(attrs) >= maxPlistKeys {
				return nil, fmt.Errorf("enroll: too many plist keys (max %d)", maxPlistKeys)
			}

			valTok, err := nextNonWhitespaceToken(dec)
			if err != nil {
				return nil, fmt.Errorf("enroll: missing value for key %q: %w", key, err)
			}
			valStart, ok := valTok.(xml.StartElement)
			if !ok || valStart.Name.Space != "" || len(valStart.Attr) != 0 {
				return nil, fmt.Errorf("enroll: invalid value element for key %q", key)
			}

			var val string
			switch valStart.Name.Local {
			case "string":
				val, err = readSimpleText(dec, "string", maxPlistValueLen)
				if err != nil {
					return nil, err
				}
			case "data":
				if key != "CHALLENGE" {
					return nil, fmt.Errorf("enroll: <data> value not allowed for key %q", key)
				}
				rawB64, err := readSimpleText(dec, "data", maxChallengeDataB64)
				if err != nil {
					return nil, err
				}
				val, err = decodeChallengeData(rawB64)
				if err != nil {
					return nil, err
				}
			default:
				return nil, fmt.Errorf("enroll: disallowed value type <%s> for key %q", valStart.Name.Local, key)
			}
			attrs[key] = val
		default:
			return nil, errors.New("enroll: unexpected token inside <dict>")
		}
	}

afterDict:
	// 4. Close </plist> with no second child inside <plist>.
	tok, err := nextNonWhitespaceToken(dec)
	if err != nil {
		return nil, fmt.Errorf("enroll: expected </plist>: %w", err)
	}
	end, ok := tok.(xml.EndElement)
	if !ok || end.Name.Local != "plist" || end.Name.Space != "" {
		return nil, errors.New("enroll: expected </plist> after </dict>")
	}

	// 5. Epilog: only whitespace until EOF.
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return attrs, nil
		}
		if err != nil {
			return nil, fmt.Errorf("enroll: trailing XML error: %w", err)
		}
		cd, ok := tok.(xml.CharData)
		if !ok || len(bytes.TrimSpace(cd)) != 0 {
			return nil, errors.New("enroll: unexpected trailing content after </plist>")
		}
	}
}

func validatePlistDoctype(d []byte) error {
	trimmed := bytes.TrimSpace(d)
	if !bytes.HasPrefix(trimmed, []byte("DOCTYPE plist")) {
		return errors.New("enroll: disallowed XML directive")
	}
	// Refuse any internal DTD subset or entity declaration.
	if bytes.ContainsAny(trimmed, "[]") || bytes.Contains(bytes.ToUpper(trimmed), []byte("ENTITY")) {
		return errors.New("enroll: DTD internal subset or ENTITY is not allowed")
	}
	return nil
}

func validatePlistRoot(el xml.StartElement) error {
	if el.Name.Local != "plist" || el.Name.Space != "" {
		return fmt.Errorf("enroll: expected root <plist>, got <%s>", el.Name.Local)
	}
	for _, a := range el.Attr {
		if a.Name.Space == "" && a.Name.Local == "version" && a.Value == "1.0" {
			continue
		}
		return fmt.Errorf("enroll: unexpected attribute %q on <plist>", a.Name.Local)
	}
	return nil
}

func expectStartElement(dec *xml.Decoder, local string) error {
	tok, err := nextNonWhitespaceToken(dec)
	if err != nil {
		return fmt.Errorf("enroll: expected <%s>: %w", local, err)
	}
	start, ok := tok.(xml.StartElement)
	if !ok || start.Name.Local != local || start.Name.Space != "" || len(start.Attr) != 0 {
		return fmt.Errorf("enroll: expected <%s>", local)
	}
	return nil
}

func nextNonWhitespaceToken(dec *xml.Decoder) (xml.Token, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.CharData:
			if len(bytes.TrimSpace(t)) != 0 {
				return nil, errors.New("unexpected character data")
			}
		case xml.Comment:
			return nil, errors.New("XML comments are not allowed")
		case xml.ProcInst:
			return nil, errors.New("processing instructions are not allowed inside plist")
		case xml.Directive:
			return nil, errors.New("directives are not allowed inside plist")
		default:
			return tok, nil
		}
	}
}

// readSimpleText reads character data until </tag>, refusing any nested element,
// comment, processing instruction, NUL byte or length above maxLen.
func readSimpleText(dec *xml.Decoder, tag string, maxLen int) (string, error) {
	var buf strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", fmt.Errorf("enroll: read <%s>: %w", tag, err)
		}
		switch t := tok.(type) {
		case xml.CharData:
			if bytes.IndexByte(t, 0) >= 0 {
				return "", fmt.Errorf("enroll: NUL byte inside <%s>", tag)
			}
			if buf.Len()+len(t) > maxLen {
				return "", fmt.Errorf("enroll: <%s> exceeds %d bytes", tag, maxLen)
			}
			buf.Write(t)
		case xml.EndElement:
			if t.Name.Local != tag || t.Name.Space != "" {
				return "", fmt.Errorf("enroll: mismatched end tag </%s> for <%s>", t.Name.Local, tag)
			}
			return buf.String(), nil
		default:
			return "", fmt.Errorf("enroll: disallowed nested token inside <%s>", tag)
		}
	}
}

func decodeChallengeData(rawB64 string) (string, error) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\r', '\n':
			return -1
		default:
			return r
		}
	}, rawB64)
	decoded, err := base64.StdEncoding.DecodeString(cleaned)
	if err != nil {
		return "", fmt.Errorf("enroll: invalid base64 in CHALLENGE <data>: %w", err)
	}
	if len(decoded) > maxPlistValueLen {
		return "", fmt.Errorf("enroll: decoded CHALLENGE exceeds %d bytes", maxPlistValueLen)
	}
	if !utf8.Valid(decoded) || bytes.IndexByte(decoded, 0) >= 0 {
		return "", errors.New("enroll: decoded CHALLENGE is not valid UTF-8")
	}
	return string(decoded), nil
}
