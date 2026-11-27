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

func TestParseAttributesPlistMacBooleans(t *testing.T) {
	token := strings.Repeat("B", 43)
	for _, notOnConsole := range []bool{false, true} {
		raw := makeMacAttributesPlist(token, "11111111-2222-3333-4444-555555555555",
			"C02MAC999999", "Mac15,6", "26C5047e", "Alice's MacBook Pro", "MacBook Pro", notOnConsole)
		attrs, err := ParseAttributesPlist(raw)
		if err != nil {
			t.Fatalf("ParseAttributesPlist(notOnConsole=%v): %v", notOnConsole, err)
		}
		if attrs["CHALLENGE"] != token || attrs["DEVICE_NAME"] != "Alice's MacBook Pro" ||
			attrs["MODEL"] != "MacBook Pro" || attrs["PRODUCT"] != "Mac15,6" ||
			attrs["SERIAL"] != "C02MAC999999" || attrs["VERSION"] != "26C5047e" ||
			attrs["UserShortName"] != "testuser" {
			t.Fatalf("unexpected Mac attrs: %#v", attrs)
		}
		if _, ok := attrs["NotOnConsole"]; ok {
			t.Fatalf("boolean NotOnConsole should be ignored, got %q", attrs["NotOnConsole"])
		}
	}

	// Explicit empty start+end boolean form (<true></true>, <false></false>) is valid XML.
	raw := `<plist version="1.0"><dict><key>A</key><true></true><key>B</key><false></false><key>UDID</key><string>U1</string></dict></plist>`
	attrs, err := ParseAttributesPlist([]byte(raw))
	if err != nil || attrs["UDID"] != "U1" || len(attrs) != 1 {
		t.Fatalf("explicit empty booleans: (%#v, %v)", attrs, err)
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

	var tooManyBoolKeys strings.Builder
	tooManyBoolKeys.WriteString(`<plist version="1.0"><dict>`)
	for i := 0; i <= maxPlistKeys; i++ {
		fmt.Fprintf(&tooManyBoolKeys, `<key>B%d</key><false/>`, i)
	}
	tooManyBoolKeys.WriteString(`</dict></plist>`)

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
		{"non-empty boolean true", `<plist version="1.0"><dict><key>NotOnConsole</key><true>1</true></dict></plist>`},
		{"whitespace in boolean false", `<plist version="1.0"><dict><key>NotOnConsole</key><false> </false></dict></plist>`},
		{"nested element in boolean true", `<plist version="1.0"><dict><key>NotOnConsole</key><true><x/></true></dict></plist>`},
		{"attribute on boolean false", `<plist version="1.0"><dict><key>NotOnConsole</key><false id="1"/></dict></plist>`},
		{"duplicate boolean key", `<plist version="1.0"><dict><key>NotOnConsole</key><false/><key>NotOnConsole</key><true/></dict></plist>`},
		{"duplicate string and boolean key", `<plist version="1.0"><dict><key>UDID</key><string>U1</string><key>UDID</key><false/></dict></plist>`},
		{"too many boolean keys", tooManyBoolKeys.String()},
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
