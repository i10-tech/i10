package enrollctl

import "testing"

func TestClassifyApplePlatform(t *testing.T) {
	// Ported verbatim from apps/api/test/mail-device-enrollment.test.ts.
	cases := []struct {
		product string
		version string
		want    PlatformDecision
	}{
		// iPhones -> ios regardless of OS build
		{"iPhone17,2", "22A3354", PlatformDecision{OK: true, Platform: "ios"}},
		{"iPhone12,1", "18A1", PlatformDecision{OK: true, Platform: "ios"}},
		{"iPhone16,2", "", PlatformDecision{OK: true, Platform: "ios"}},
		{" iPhone15,3 ", "21F79", PlatformDecision{OK: true, Platform: "ios"}},
		// iPads -> ipados regardless of OS build
		{"iPad16,6", "22B83", PlatformDecision{OK: true, Platform: "ipados"}},
		{"iPad8,1", "17F75", PlatformDecision{OK: true, Platform: "ipados"}},
		// Apple silicon Macs on macOS 14+ (build major >= 23)
		{"MacBookPro17,1", "23A344", PlatformDecision{OK: true, Platform: "macos"}},
		{"MacBookPro18,1", "23F79", PlatformDecision{OK: true, Platform: "macos"}},
		{"MacBookPro18,4", "24D70", PlatformDecision{OK: true, Platform: "macos"}},
		{"MacBookPro19,1", "25A5279m", PlatformDecision{OK: true, Platform: "macos"}},
		{"MacBookAir10,1", "23A344", PlatformDecision{OK: true, Platform: "macos"}},
		{"Macmini9,1", "24A335", PlatformDecision{OK: true, Platform: "macos"}},
		{"iMac21,1", "23C71", PlatformDecision{OK: true, Platform: "macos"}},
		{"iMac21,2", "24B83", PlatformDecision{OK: true, Platform: "macos"}},
		{"Mac13,1", "23A344", PlatformDecision{OK: true, Platform: "macos"}},
		{"Mac14,2", "24D70", PlatformDecision{OK: true, Platform: "macos"}},
		{"Mac15,6", "24G2091", PlatformDecision{OK: true, Platform: "macos"}},
		{"Mac16,1", "25A5279m", PlatformDecision{OK: true, Platform: "macos"}},
		// Intel Macs (even on macOS 14/15 builds) -> mac_not_apple_silicon
		{"MacBookPro16,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacBookPro16,4", "23F79", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacBookPro17,2", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacBookAir9,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacBookAir10,2", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"Macmini8,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"Macmini9,2", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"iMac20,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"iMac20,2", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"iMacPro1,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacPro7,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"MacBook10,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		{"Mac12,1", "24D70", PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}},
		// Apple silicon Macs on macOS < 14 or unparseable build -> macos_too_old
		{"Mac14,2", "22G74", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		{"MacBookPro18,3", "21H1320", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		{"MacBookAir10,1", "22A380", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		{"Macmini9,1", "14.5", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		{"iMac21,1", "", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		{"Mac15,3", "not-a-build", PlatformDecision{OK: false, Refusal: "macos_too_old"}},
		// Unsupported products
		{"AppleTV14,1", "22J357", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"Watch7,5", "22R349", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"RealityDevice14,1", "22N320", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"iPod9,1", "19H386", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"iPhone", "22A3354", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"MacBookPro", "24D70", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"Windows", "11", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
		{"", "24D70", PlatformDecision{OK: false, Refusal: "unsupported_product"}},
	}

	for _, tc := range cases {
		got := ClassifyApplePlatform(tc.product, tc.version)
		if got != tc.want {
			t.Errorf("ClassifyApplePlatform(%q, %q) = %+v, want %+v", tc.product, tc.version, got, tc.want)
		}
	}
}

func TestParseAppleBuildMajor(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"23A344", 23, true},
		{"24D70", 24, true},
		{"25A5279m", 25, true},
		{"14.0", 0, false},
		{"", 0, false},
	} {
		got, ok := ParseAppleBuildMajor(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseAppleBuildMajor(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
