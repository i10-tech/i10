package keyring

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// TestParseKeyVectors pins what ParseKey accepts. The same file drives
// apps/api's parser (test/key-parse-vectors.test.ts), so a key Doppler holds
// means the same in Go and TypeScript.
func TestParseKeyVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/parse-key-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name      string `json:"name"`
		Input     string `json:"input"`
		ID        int    `json:"id"`
		SecretHex string `json:"secret_hex"`
		Error     bool   `json:"error"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		k, err := ParseKey("TEST_KEYS", v.Input)
		if v.Error {
			if err == nil {
				t.Errorf("%s: accepted, want an error", v.Name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", v.Name, err)
			continue
		}
		if int(k.ID) != v.ID || hex.EncodeToString(k.Secret) != v.SecretHex {
			t.Errorf("%s: got id %d secret %x", v.Name, k.ID, k.Secret)
		}
	}
}
