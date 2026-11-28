package enrollctl

import (
	"strconv"
	"strings"
)

// PlatformDecision is the outcome of classifying an Apple device's attested
// PRODUCT and VERSION attributes (ported verbatim from
// apps/api/src/mail-devices/platform.ts).
type PlatformDecision struct {
	OK       bool
	Platform string // "ios" | "ipados" | "macos"
	Refusal  string // "mac_not_apple_silicon" | "macos_too_old" | "unsupported_product"
}

// Minimum macOS Darwin/OS build major that supports com.apple.security.acme
// hardware-bound attestation (macOS 14 Sonoma = 23A344).
const minMacOSBuildMajor = 23

// Apple silicon Mac model identifiers prior to the unified `Mac<N>,<M>` naming
// scheme (M1 / M1 Pro / M1 Max / M2 first-generation models). Every `Mac13,*`
// and newer identifier is Apple silicon; `Mac12,*` and older named families
// outside this map are Intel.
var legacyAppleSiliconMacs = map[string]bool{
	"MacBookPro17,1": true,
	"MacBookPro18,1": true,
	"MacBookPro18,2": true,
	"MacBookPro18,3": true,
	"MacBookPro18,4": true,
	"MacBookAir10,1": true,
	"Macmini9,1":     true,
	"iMac21,1":       true,
	"iMac21,2":       true,
}

func isValidModelPair(s string) (int, bool) {
	majorStr, minorStr, ok := strings.Cut(s, ",")
	if !ok || majorStr == "" || minorStr == "" {
		return 0, false
	}
	if !allDigits(majorStr) || !allDigits(minorStr) {
		return 0, false
	}
	major, err := strconv.Atoi(majorStr)
	if err != nil {
		return 0, false
	}
	return major, true
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isIntelMacFamily(product string) bool {
	for _, prefix := range []string{"MacBookPro", "MacBookAir", "MacBook", "Macmini", "MacPro", "iMacPro", "iMac"} {
		if rest, ok := strings.CutPrefix(product, prefix); ok {
			_, valid := isValidModelPair(rest)
			return valid
		}
	}
	return false
}

// ParseAppleBuildMajor extracts the leading integer major from an Apple OS
// build string such as "23A344" -> 23 or "25A5279m" -> 25.
func ParseAppleBuildMajor(version string) (int, bool) {
	v := strings.TrimSpace(version)
	i := 0
	for i < len(v) && v[i] >= '0' && v[i] <= '9' {
		i++
	}
	if i == 0 || i >= len(v) {
		return 0, false
	}
	// Next byte must be an uppercase ASCII letter (e.g. 'A'..'Z'), followed by digits (and optional trailing letter).
	if v[i] < 'A' || v[i] > 'Z' {
		return 0, false
	}
	j := i + 1
	for j < len(v) && v[j] >= '0' && v[j] <= '9' {
		j++
	}
	if j == i+1 {
		return 0, false
	}
	// Optional trailing lowercase letter(s) like "25A5279m" or "26C5047e"
	for j < len(v) {
		if v[j] < 'a' || v[j] > 'z' {
			return 0, false
		}
		j++
	}
	n, err := strconv.Atoi(v[:i])
	if err != nil {
		return 0, false
	}
	return n, true
}

// ClassifyApplePlatform maps Apple's attested PRODUCT and VERSION attributes
// to a mail device platform or refusal code, matching apps/api's platform.ts.
func ClassifyApplePlatform(product, osVersion string) PlatformDecision {
	p := strings.TrimSpace(product)
	if rest, ok := strings.CutPrefix(p, "iPhone"); ok {
		if _, valid := isValidModelPair(rest); valid {
			return PlatformDecision{OK: true, Platform: "ios"}
		}
	}
	if rest, ok := strings.CutPrefix(p, "iPad"); ok {
		if _, valid := isValidModelPair(rest); valid {
			return PlatformDecision{OK: true, Platform: "ipados"}
		}
	}

	isAppleSilicon := false
	isMac := false

	if legacyAppleSiliconMacs[p] {
		isMac = true
		isAppleSilicon = true
	} else if rest, ok := strings.CutPrefix(p, "MacBookPro"); ok {
		if major, valid := isValidModelPair(rest); valid {
			isMac = true
			if major >= 19 {
				isAppleSilicon = true
			}
		}
	} else if rest, ok := strings.CutPrefix(p, "Mac"); ok {
		if major, valid := isValidModelPair(rest); valid {
			isMac = true
			if major >= 13 {
				isAppleSilicon = true
			}
		} else if isIntelMacFamily(p) {
			isMac = true
		}
	} else if isIntelMacFamily(p) {
		isMac = true
	}

	if !isMac {
		return PlatformDecision{OK: false, Refusal: "unsupported_product"}
	}
	if !isAppleSilicon {
		return PlatformDecision{OK: false, Refusal: "mac_not_apple_silicon"}
	}
	major, ok := ParseAppleBuildMajor(osVersion)
	if !ok || major < minMacOSBuildMajor {
		return PlatformDecision{OK: false, Refusal: "macos_too_old"}
	}
	return PlatformDecision{OK: true, Platform: "macos"}
}
