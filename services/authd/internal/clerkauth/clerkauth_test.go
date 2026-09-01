package clerkauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The response bodies below are the real ones, captured by probing a live Clerk
// development instance. None of this behaviour is documented, so the tests are
// the record of what was actually observed.
func TestVerifyStatusMapping(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		want    Outcome
		wantErr bool
	}{
		{
			name:   "verified",
			status: http.StatusOK,
			body:   `{"verified":true}`,
			want:   Verified,
		},
		{
			name:   "wrong password",
			status: http.StatusUnprocessableEntity,
			body:   `{"errors":[{"message":"incorrect password","code":"form_password_incorrect"}]}`,
			want:   Rejected,
		},
		{
			// An OAuth-only user who has not set a password yet. This must be a
			// clean rejection: if it degraded to Unavailable, every such user
			// would look like an outage instead of a wrong password.
			name:   "no password set",
			status: http.StatusBadRequest,
			body:   `{"errors":[{"message":"no password set","long_message":"This user does not have a password set for their account","code":"no_password_set"}]}`,
			want:   Rejected,
		},
		{
			// A 400 we do not recognise is a contract change or our own bug.
			// Guessing "wrong password" would hide it forever.
			name:    "unrecognised 400",
			status:  http.StatusBadRequest,
			body:    `{"errors":[{"code":"something_new"}]}`,
			want:    Unavailable,
			wantErr: true,
		},
		{
			name:    "rate limited",
			status:  http.StatusTooManyRequests,
			body:    `{}`,
			want:    Unavailable,
			wantErr: true,
		},
		{
			name:    "clerk down",
			status:  http.StatusInternalServerError,
			body:    `{}`,
			want:    Unavailable,
			wantErr: true,
		},
		{
			name:    "our own key is bad",
			status:  http.StatusUnauthorized,
			body:    `{}`,
			want:    Unavailable,
			wantErr: true,
		},
		{
			// The projection knows a user Clerk does not: drift, not a password
			// answer.
			name:    "user missing from clerk",
			status:  http.StatusNotFound,
			body:    `{"errors":[{"code":"resource_not_found"}]}`,
			want:    Unavailable,
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Bearer sk_test_x" {
					t.Errorf("Authorization = %q", got)
				}
				if !strings.HasSuffix(r.URL.Path, "/users/user_123/verify_password") {
					t.Errorf("path = %q", r.URL.Path)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			got, err := New(srv.URL, "sk_test_x", time.Second).
				Verify(context.Background(), "user_123", "hunter2")
			if got != tc.want {
				t.Errorf("outcome = %v, want %v", got, tc.want)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, wantErr = %v", err, tc.wantErr)
			}
		})
	}
}

// A network failure is not evidence about the password.
func TestVerifyTransportFailureIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing is listening now

	got, err := New(url, "sk_test_x", 500*time.Millisecond).
		Verify(context.Background(), "user_123", "hunter2")
	if got != Unavailable {
		t.Fatalf("outcome = %v, want Unavailable", got)
	}
	if err == nil {
		t.Fatal("expected an error describing the transport failure")
	}
}

func TestVerifyTimeoutIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	got, _ := New(srv.URL, "sk_test_x", 20*time.Millisecond).
		Verify(context.Background(), "user_123", "hunter2")
	if got != Unavailable {
		t.Fatalf("outcome = %v, want Unavailable", got)
	}
}

// The password must never reach an error string, which is where it would leak
// into logs.
func TestErrorsDoNotContainThePassword(t *testing.T) {
	const secret = "correct-horse-battery-staple"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := New(srv.URL, "sk_test_x", time.Second).
		Verify(context.Background(), "user_123", secret)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("password leaked into the error: %v", err)
	}
}

func TestVerifySendsPasswordAsJSON(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		got = string(buf)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, _ = New(srv.URL, "sk_test_x", time.Second).
		Verify(context.Background(), "user_123", `a"quote\and\\slash`)
	if want := `{"password":"a\"quote\\and\\\\slash"}`; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}
