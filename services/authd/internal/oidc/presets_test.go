package oidc

import (
	"strings"
	"testing"
)

// A signal with no criterion would match every refusal, and turn the first one in
// a preset's table into the answer for all of them.
func TestEverySignalSaysWhatItMatches(t *testing.T) {
	for name, p := range presets {
		for i, s := range p.signals {
			if s.reason == "" {
				t.Errorf("%s signal %d has no reason", name, i)
			}
			if s.status == 0 && len(s.errors) == 0 && len(s.errorReasons) == 0 && len(s.phrases) == 0 {
				t.Errorf("%s signal %d (%s) matches everything", name, i, s.reason)
			}
			for _, ph := range s.phrases {
				if ph != strings.ToLower(ph) {
					t.Errorf("%s signal %d phrase %q is not lower-case, so it can never match", name, i, ph)
				}
			}
			for _, e := range s.errors {
				if e != strings.ToLower(e) {
					t.Errorf("%s signal %d error %q is not lower-case", name, i, e)
				}
			}
		}
	}
}

// A preset that is in the map but not in PresetNames would validate and never be
// offered; one in PresetNames and not in the map would be offered and refused.
func TestPresetNamesAreExactlyThePresets(t *testing.T) {
	names := PresetNames()
	if len(names) != len(presets) {
		t.Fatalf("%d names for %d presets", len(names), len(presets))
	}
	for _, n := range names {
		p, ok := presets[n]
		if !ok {
			t.Errorf("%s is listed but has no preset", n)
			continue
		}
		if p.clientID == nil {
			t.Errorf("%s has no client id rule", n)
		}
		// `scope` is on every preset, and nothing may let an owner set a field the
		// request owns.
		if !contains(p.extras, "scope") {
			t.Errorf("%s does not take a scope", n)
		}
		for _, e := range p.extras {
			switch e {
			case "grant_type", "username", "password", "client_id", "client_secret", "client_assertion", "client_assertion_type":
				t.Errorf("%s lets an owner set %q", n, e)
			}
		}
	}
}
