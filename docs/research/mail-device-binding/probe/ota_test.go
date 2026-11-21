package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestRepliesArePlists(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(dir+"/enroll.plist", []byte(enrollReply("SERIAL123", "chal")), 0o600)
	if out, err := exec.Command("plutil", "-lint", dir+"/enroll.plist").CombinedOutput(); err != nil {
		t.Fatalf("enroll: %s", out)
	}
	src, _ := os.ReadFile("ota.go")
	if strings.Count(string(src), "com.apple.security.acme") != 1 || strings.Count(string(src), "com.apple.security.scep") != 1 {
		t.Fatal("expected one acme (sealed) and one scep (enroll) payload")
	}
}
