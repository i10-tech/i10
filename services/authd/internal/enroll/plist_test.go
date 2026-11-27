package enroll

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func TestParseAttributesPlistValid(t *testing.T) {
	token := strings.Repeat("A", 43)
	raw := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CHALLENGE</key>
	<string>%s</string>
	<key>DEVICE_NAME</key>
	<string>Alice’s &amp; Bob&apos;s MacBook Pro</string>
	<key>MODEL</key>
	<string>MacBookPro</string>
	<key>PRODUCT</key>
	<string>MacBookPro18,3</string>
	<key>SERIAL</key>
	<string>C02XYZ123456</string>
	<key>UDID</key>
	<string></string>
	<key>VERSION</key>
	<string>24B83</string>
</dict>
</plist>
`, token)

	attrs, err := ParseAttributesPlist([]byte(raw))
	if err != nil {
		t.Fatalf("ParseAttributesPlist: %v", err)
	}
	if attrs["CHALLENGE"] != token {
		t.Fatalf("CHALLENGE = %q, want %q", attrs["CHALLENGE"], token)
	}
	if attrs["DEVICE_NAME"] != "Alice’s & Bob's MacBook Pro" {
		t.Fatalf("DEVICE_NAME = %q", attrs["DEVICE_NAME"])
	}
	if attrs["UDID"] != "" {
		t.Fatalf("UDID = %q, want empty", attrs["UDID"])
	}
	if attrs["PRODUCT"] != "MacBookPro18,3" {
		t.Fatalf("PRODUCT = %q", attrs["PRODUCT"])
	}
}

func TestParseAttributesPlistChallengeData(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE"
	b64 := base64.StdEncoding.EncodeToString([]byte(token))
	wrapped := "\n\t" + b64[:20] + "\n\t" + b64[20:] + "\n"
	raw := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CHALLENGE</key>
  <data>%s</data>
  <key>UDID</key>
  <string>U-1</string>
</dict></plist>`, wrapped)

	attrs, err := ParseAttributesPlist([]byte(raw))
	if err != nil {
		t.Fatalf("ParseAttributesPlist with CHALLENGE <data>: %v", err)
	}
	if attrs["CHALLENGE"] != token {
		t.Fatalf("CHALLENGE = %q, want %q", attrs["CHALLENGE"], token)
	}
}

func TestParseAttributesPlistHostileInputs(t *testing.T) {
	validB64 := base64.StdEncoding.EncodeToString([]byte("hello"))
	nulB64 := base64.StdEncoding.EncodeToString([]byte("abc\x00def"))

	var tooManyKeys strings.Builder
	tooManyKeys.WriteString(`<plist version="1.0"><dict>`)
	for i := 0; i <= maxPlistKeys; i++ {
		fmt.Fprintf(&tooManyKeys, `<key>K%d</key><string>v</string>`, i)
	}
	tooManyKeys.WriteString(`</dict></plist>`)

	cases := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"oversized raw plist", `<plist version="1.0"><dict><key>A</key><string>` + strings.Repeat("x", maxPlistBytes) + `</string></dict></plist>`},
		{"invalid UTF-8", "<plist version=\"1.0\"><dict><key>A</key><string>\xff\xfe</string></dict></plist>"},
		{"NUL byte", "<plist version=\"1.0\"><dict><key>A</key><string>a\x00b</string></dict></plist>"},
		{"DTD internal subset entity", `<?xml version="1.0"?><!DOCTYPE plist [ <!ENTITY xxe "pwn"> ]><plist version="1.0"><dict><key>UDID</key><string>&xxe;</string></dict></plist>`},
		{"DTD billion laughs", `<?xml version="1.0"?><!DOCTYPE plist [ <!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;"> ]><plist version="1.0"><dict><key>UDID</key><string>&b;</string></dict></plist>`},
		{"undefined custom entity", `<plist version="1.0"><dict><key>UDID</key><string>&custom;</string></dict></plist>`},
		{"CDATA inside string", `<plist version="1.0"><dict><key>UDID</key><string><![CDATA[secret]]></string></dict></plist>`},
		{"CDATA inside key", `<plist version="1.0"><dict><key><![CDATA[UDID]]></key><string>x</string></dict></plist>`},
		{"nested dict", `<plist version="1.0"><dict><key>UDID</key><dict><key>A</key><string>B</string></dict></dict></plist>`},
		{"nested array", `<plist version="1.0"><dict><key>UDID</key><array><string>A</string></array></dict></plist>`},
		{"nested element inside string", `<plist version="1.0"><dict><key>UDID</key><string>a<b>c</b></string></dict></plist>`},
		{"nested element inside key", `<plist version="1.0"><dict><key>U<b>D</b></key><string>a</string></dict></plist>`},
		{"integer value", `<plist version="1.0"><dict><key>VERSION</key><integer>1</integer></dict></plist>`},
		{"real value", `<plist version="1.0"><dict><key>VERSION</key><real>1.5</real></dict></plist>`},
		{"boolean true value", `<plist version="1.0"><dict><key>VERSION</key><true/></dict></plist>`},
		{"boolean false value", `<plist version="1.0"><dict><key>VERSION</key><false/></dict></plist>`},
		{"date value", `<plist version="1.0"><dict><key>VERSION</key><date>2026-01-01T00:00:00Z</date></dict></plist>`},
		{"data value for non-CHALLENGE key", `<plist version="1.0"><dict><key>SERIAL</key><data>` + validB64 + `</data></dict></plist>`},
		{"invalid base64 in CHALLENGE data", `<plist version="1.0"><dict><key>CHALLENGE</key><data>!!!not-base64!!!</data></dict></plist>`},
		{"NUL byte decoded in CHALLENGE data", `<plist version="1.0"><dict><key>CHALLENGE</key><data>` + nulB64 + `</data></dict></plist>`},
		{"duplicate key", `<plist version="1.0"><dict><key>SERIAL</key><string>A</string><key>SERIAL</key><string>B</string></dict></plist>`},
		{"duplicate CHALLENGE string and data", `<plist version="1.0"><dict><key>CHALLENGE</key><string>A</string><key>CHALLENGE</key><data>` + validB64 + `</data></dict></plist>`},
		{"empty key", `<plist version="1.0"><dict><key></key><string>A</string></dict></plist>`},
		{"dangling key without value", `<plist version="1.0"><dict><key>UDID</key></dict></plist>`},
		{"value without key", `<plist version="1.0"><dict><string>A</string></dict></plist>`},
		{"huge value", `<plist version="1.0"><dict><key>UDID</key><string>` + strings.Repeat("x", maxPlistValueLen+1) + `</string></dict></plist>`},
		{"huge key", `<plist version="1.0"><dict><key>` + strings.Repeat("K", maxPlistKeyLen+1) + `</key><string>x</string></dict></plist>`},
		{"too many keys", tooManyKeys.String()},
		{"XML comment", `<plist version="1.0"><!-- hi --><dict><key>UDID</key><string>A</string></dict></plist>`},
		{"extra processing instruction", `<?xml version="1.0"?><?evil foo?><plist version="1.0"><dict/></plist>`},
		{"wrong root tag", `<dict><key>UDID</key><string>A</string></dict>`},
		{"wrong plist version", `<plist version="2.0"><dict/></plist>`},
		{"attribute on dict", `<plist version="1.0"><dict id="1"/></plist>`},
		{"attribute on string", `<plist version="1.0"><dict><key>A</key><string id="1">x</string></dict></plist>`},
		{"second dict inside plist", `<plist version="1.0"><dict/><dict/></plist>`},
		{"trailing element after plist", `<plist version="1.0"><dict/></plist><extra/>`},
		{"trailing text after plist", `<plist version="1.0"><dict/></plist>junk`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := ParseAttributesPlist([]byte(tc.raw)); err == nil {
				t.Fatalf("accepted hostile plist %q, got %#v", tc.name, got)
			}
		})
	}
}
