package enroll

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestProbeRefRealDeviceCaptures verifies real device OTA captures when
// ENROLL_PROBE_REF points at a local directory containing root.crt,
// intermediate.crt, and the four req-0{1..4}-*.der probe files. Skips cleanly
// when ENROLL_PROBE_REF is unset so no real device data is ever committed.
func TestProbeRefRealDeviceCaptures(t *testing.T) {
	dir := os.Getenv("ENROLL_PROBE_REF")
	if dir == "" {
		t.Skip("ENROLL_PROBE_REF not set")
	}
	dir = resolveProbeRefDir(t, dir)

	rootPEM, err := os.ReadFile(filepath.Join(dir, "root.crt"))
	if err != nil {
		t.Fatalf("read root.crt: %v", err)
	}
	interPEM, err := os.ReadFile(filepath.Join(dir, "intermediate.crt"))
	if err != nil {
		t.Fatalf("read intermediate.crt: %v", err)
	}
	bundle := append(append([]byte{}, rootPEM...), '\n')
	bundle = append(bundle, interPEM...)
	trust, err := ParseDeviceTrustBundle(bundle)
	if err != nil {
		t.Fatalf("ParseDeviceTrustBundle(root.crt + intermediate.crt): %v", err)
	}

	// Use the probe's capture timestamp so SCEP leaf expiry (7 days) never
	// causes this local verification test to bit-rot after the capture date.
	probeNow := time.Date(2026, 11, 27, 2, 35, 0, 0, time.UTC)

	cases := []struct {
		pattern    string
		wantPhase  Phase
		expectChal bool
		expectMac  bool
	}{
		{pattern: "req-01-*.der", wantPhase: Phase2Apple, expectChal: true},
		{pattern: "req-02-*.der", wantPhase: Phase4DeviceCA},
		{pattern: "req-03-*.der", wantPhase: Phase2Apple, expectChal: true, expectMac: true},
		{pattern: "req-04-*.der", wantPhase: Phase4DeviceCA, expectMac: true},
	}

	for _, tc := range cases {
		matches, err := filepath.Glob(filepath.Join(dir, tc.pattern))
		if err != nil {
			t.Fatalf("glob %s: %v", tc.pattern, err)
		}
		if len(matches) != 1 {
			t.Fatalf("glob %s in %s matched %d files, want 1", tc.pattern, dir, len(matches))
		}
		path := matches[0]
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			cms, err := ParseAndVerifyCMS(raw)
			if err != nil {
				t.Fatalf("ParseAndVerifyCMS: %v", err)
			}
			phase, err := ClassifySigner(cms, trust, probeNow)
			if err != nil {
				t.Fatalf("ClassifySigner: %v", err)
			}
			if phase != tc.wantPhase {
				t.Fatalf("phase = %v, want %v", phase, tc.wantPhase)
			}
			attrs, err := ParseAttributesPlist(cms.Content)
			if err != nil {
				t.Fatalf("ParseAttributesPlist: %v", err)
			}
			if tc.expectChal {
				for _, k := range []string{"CHALLENGE", "UDID", "SERIAL", "PRODUCT", "VERSION"} {
					if attrs[k] == "" {
						t.Fatalf("missing required phase 2 attribute %s", k)
					}
				}
			} else {
				if attrs["UDID"] == "" {
					t.Fatal("missing UDID in phase 4 attributes")
				}
				if attrs["CHALLENGE"] != "" {
					t.Fatal("unexpected CHALLENGE in phase 4 attributes")
				}
			}
			if tc.expectMac {
				if attrs["DEVICE_NAME"] == "" || attrs["MODEL"] == "" {
					t.Fatal("expected Mac DEVICE_NAME and MODEL attributes")
				}
				if _, ok := attrs["NotOnConsole"]; ok {
					t.Fatal("boolean NotOnConsole should not appear in string attrs map")
				}
			}
		})
	}
}

func resolveProbeRefDir(t *testing.T, dir string) string {
	t.Helper()
	if filepath.IsAbs(dir) {
		return dir
	}
	if st, err := os.Stat(dir); err == nil && st.IsDir() {
		return dir
	}
	wd, err := os.Getwd()
	if err != nil {
		return dir
	}
	for cur := wd; ; {
		cand := filepath.Join(cur, dir)
		if st, err := os.Stat(cand); err == nil && st.IsDir() {
			return cand
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return dir
}
