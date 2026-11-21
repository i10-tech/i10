package main

// HTTPS front for step-ca's ACME, using the probe certificate the phone
// already trusts. The Host header is kept, so step-ca's links point back here.

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
)

func init() {
	if len(os.Args) < 2 {
		return
	}
	dir := os.Args[1]
	target, _ := url.Parse("https://127.0.0.1:9000")
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	orig := rp.Director
	rp.Director = func(r *http.Request) {
		host := r.Host
		orig(r)
		r.Host = host
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		emit(0, "acme", "acme_req", map[string]any{"method": r.Method, "path": r.URL.Path, "ua": r.UserAgent(), "remote": r.RemoteAddr})
		rp.ServeHTTP(w, r)
	})
	go func() {
		err := http.ListenAndServeTLS("0.0.0.0:9444", dir+"/pki/server.pem", dir+"/pki/server.key", h)
		fmt.Fprintln(os.Stderr, "acme proxy:", err)
	}()
}
