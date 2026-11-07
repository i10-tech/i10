package passthrough

import "testing"

func TestRenderFilterEscapesTheAddress(t *testing.T) {
	for _, tc := range []struct{ template, address, want string }{
		{"(mail={email})", "ada@acme.test", "(mail=ada@acme.test)"},
		{"(mail={email})", "*", `(mail=\2a)`},
		{"(mail={email})", "x)(uid=*", `(mail=x\29\28uid=\2a)`},
		{"(mail={email})", `a\b`, `(mail=a\5cb)`},
		{"(mail={email})", "a\x00b", `(mail=a\00b)`},
		{"(|(mail={email})(uid={email}))", "*", `(|(mail=\2a)(uid=\2a))`},
		// Not read as a replacement pattern.
		{"(mail={email})", "$&${1}", `(mail=$&${1})`},
	} {
		if got := RenderFilter(tc.template, tc.address); got != tc.want {
			t.Errorf("RenderFilter(%q, %q) = %q, want %q", tc.template, tc.address, got, tc.want)
		}
	}
}
