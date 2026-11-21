// mailcert-probe: a throwaway IMAP/SMTP server that records what each mail
// app reveals: TLS ClientHello, whether it presents a client certificate,
// SNI, IMAP ID, SMTP EHLO, auth mechanism and reconnect pattern.
package main

import (
	"bufio"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	logMu   sync.Mutex
	logFile *os.File
	connSeq atomic.Int64
	hellos  sync.Map // remote addr -> map[string]any
)

func emit(conn int64, port string, event string, kv map[string]any) {
	rec := map[string]any{"t": time.Now().Format("15:04:05.000"), "conn": conn, "port": port, "event": event}
	for k, v := range kv {
		rec[k] = v
	}
	b, _ := json.Marshal(rec)
	logMu.Lock()
	defer logMu.Unlock()
	fmt.Println(string(b))
	logFile.Write(append(b, '\n'))
}

func short(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:6])
}

func u16s(v []uint16) string {
	p := make([]string, len(v))
	for i, x := range v {
		p[i] = strconv.Itoa(int(x))
	}
	return strings.Join(p, ",")
}

func helloRecord(h *tls.ClientHelloInfo) map[string]any {
	ciphers := append([]uint16(nil), h.CipherSuites...)
	sort.Slice(ciphers, func(i, j int) bool { return ciphers[i] < ciphers[j] })
	exts := append([]uint16(nil), h.Extensions...)
	sort.Slice(exts, func(i, j int) bool { return exts[i] < exts[j] })
	sigs := make([]uint16, len(h.SignatureSchemes))
	for i, s := range h.SignatureSchemes {
		sigs[i] = uint16(s)
	}
	curves := make([]uint16, len(h.SupportedCurves))
	for i, c := range h.SupportedCurves {
		curves[i] = uint16(c)
	}
	canon := strings.Join([]string{u16s(h.SupportedVersions), u16s(ciphers), u16s(exts), u16s(sigs), u16s(curves), strings.Join(h.SupportedProtos, ",")}, "|")
	return map[string]any{
		"sni": h.ServerName, "alpn": h.SupportedProtos, "versions": u16s(h.SupportedVersions),
		"ciphers": u16s(h.CipherSuites), "exts_in_order": u16s(h.Extensions), "sigalgs": u16s(sigs),
		"curves": u16s(curves), "fp": short(canon),
	}
}

type listener struct {
	port    string
	proto   string // imap | smtp
	require bool
}

func tlsConfig(serverCert tls.Certificate, pool *x509.CertPool, require bool) *tls.Config {
	base := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientCAs:    pool,
		ClientAuth:   tls.VerifyClientCertIfGiven,
		MinVersion:   tls.VersionTLS12,
	}
	if require {
		base.ClientAuth = tls.RequireAndVerifyClientCert
	}
	base.GetConfigForClient = func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		hellos.Store(h.Conn.RemoteAddr().String(), helloRecord(h))
		return nil, nil
	}
	return base
}

func serve(l listener, cfg *tls.Config) {
	ln, err := net.Listen("tcp", "0.0.0.0:"+l.port)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen", l.port, err)
		os.Exit(1)
	}
	for {
		raw, err := ln.Accept()
		if err != nil {
			continue
		}
		go handle(l, cfg, raw)
	}
}

func handle(l listener, cfg *tls.Config, raw net.Conn) {
	id := connSeq.Add(1)
	defer raw.Close()
	remote := raw.RemoteAddr().String()
	mode := "request"
	if l.require {
		mode = "require"
	}
	emit(id, l.port, "connect", map[string]any{"remote": remote, "proto": l.proto, "cert_mode": mode})
	pc := &peekConn{Conn: raw, r: bufio.NewReader(raw)}
	raw.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, perr := pc.r.Peek(1)
	raw.SetReadDeadline(time.Time{})
	if ne, ok := perr.(net.Error); ok && ne.Timeout() {
		emit(id, l.port, "client_silent_starting_plaintext", nil)
		if !plainUntilStartTLS(id, l, pc) {
			return
		}
	}
	tc := tls.Server(pc, cfg)
	tc.SetDeadline(time.Now().Add(120 * time.Second))
	herr := tc.Handshake()
	hk, _ := hellos.LoadAndDelete(remote)
	if herr != nil {
		emit(id, l.port, "tls_fail", map[string]any{"err": herr.Error(), "hello": hk})
		return
	}
	st := tc.ConnectionState()
	var certs []map[string]any
	for _, c := range st.PeerCertificates {
		fp := sha256.Sum256(c.Raw)
		certs = append(certs, map[string]any{"subject": c.Subject.CommonName, "sha256": hex.EncodeToString(fp[:8])})
	}
	emit(id, l.port, "tls_ok", map[string]any{
		"version": fmt.Sprintf("%x", st.Version), "cipher": tls.CipherSuiteName(st.CipherSuite),
		"resumed": st.DidResume, "client_certs": certs, "hello": hk,
	})
	tc.SetDeadline(time.Time{})
	start := time.Now()
	upgraded := perr != nil
	if l.proto == "imap" {
		imapSessionG(id, l.port, tc, len(certs) > 0, !upgraded)
	} else {
		smtpSessionG(id, l.port, tc, len(certs) > 0, !upgraded)
	}
	emit(id, l.port, "close", map[string]any{"secs": int(time.Since(start).Seconds())})
}

// ---------- IMAP ----------

type imapConn struct {
	r *bufio.Reader
	w *bufio.Writer
	c net.Conn
}

func (ic *imapConn) send(s string) {
	ic.w.WriteString(s + "\r\n")
	ic.w.Flush()
}

// readCommand reads one command line, resolving literals {n} and {n+}.
func (ic *imapConn) readCommand() (string, error) {
	var full strings.Builder
	for {
		line, err := ic.r.ReadString('\n')
		if err != nil {
			return "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasSuffix(line, "}") {
			if i := strings.LastIndex(line, "{"); i >= 0 {
				spec := line[i+1 : len(line)-1]
				plus := strings.HasSuffix(spec, "+")
				n, err := strconv.Atoi(strings.TrimSuffix(spec, "+"))
				if err == nil {
					full.WriteString(line[:i])
					if !plus {
						ic.send("+ go ahead")
					}
					buf := make([]byte, n)
					if _, err := ioReadFull(ic.r, buf); err != nil {
						return "", err
					}
					full.WriteString(strconv.Quote(string(buf)))
					continue
				}
			}
		}
		full.WriteString(line)
		return full.String(), nil
	}
}

func ioReadFull(r *bufio.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

// tokens splits an IMAP line into atoms, quoted strings and parenthesized groups.
func tokens(s string) []string {
	var out []string
	i := 0
	for i < len(s) {
		switch {
		case s[i] == ' ':
			i++
		case s[i] == '"':
			j := i + 1
			var b strings.Builder
			for j < len(s) && s[j] != '"' {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				b.WriteByte(s[j])
				j++
			}
			out = append(out, b.String())
			i = j + 1
		case s[i] == '(':
			depth, j := 0, i
			for j < len(s) {
				if s[j] == '(' {
					depth++
				} else if s[j] == ')' {
					depth--
					if depth == 0 {
						break
					}
				}
				j++
			}
			out = append(out, s[i:min(j+1, len(s))])
			i = j + 1
		default:
			j := i
			for j < len(s) && s[j] != ' ' {
				j++
			}
			out = append(out, s[i:j])
			i = j
		}
	}
	return out
}

const capsPre = "IMAP4rev1 ID IDLE LITERAL+ SASL-IR AUTH=PLAIN"
const capsPost = "IMAP4rev1 ID IDLE LITERAL+ NAMESPACE UIDPLUS SPECIAL-USE"

func imapSessionG(id int64, port string, c net.Conn, hasCert bool, greet bool) {
	ic := &imapConn{r: bufio.NewReader(c), w: bufio.NewWriter(c), c: c}
	capsPre := capsPre
	if hasCert {
		capsPre += " AUTH=EXTERNAL"
	}
	if greet {
		ic.send("* OK [CAPABILITY " + capsPre + "] i10 probe ready")
	}
	authed := false
	for {
		line, err := ic.readCommand()
		if err != nil {
			return
		}
		tk := tokens(line)
		if len(tk) < 2 {
			ic.send("* BAD empty")
			continue
		}
		tag, cmd := tk[0], strings.ToUpper(tk[1])
		args := tk[2:]
		if cmd == "UID" && len(args) > 0 {
			cmd = "UID " + strings.ToUpper(args[0])
			args = args[1:]
		}
		logged := line
		switch cmd {
		case "LOGIN":
			user := ""
			if len(args) > 0 {
				user = args[0]
			}
			logged = tag + " LOGIN " + user + " <redacted>"
			emit(id, port, "imap_login", map[string]any{"mech": "LOGIN", "user": user, "has_cert": hasCert})
		case "AUTHENTICATE":
			logged = tag + " AUTHENTICATE " + strings.Join(args[:min(1, len(args))], " ") + " <redacted>"
		}
		emit(id, port, "imap_cmd", map[string]any{"line": logged})

		switch cmd {
		case "CAPABILITY":
			if authed {
				ic.send("* CAPABILITY " + capsPost)
			} else {
				ic.send("* CAPABILITY " + capsPre)
			}
			ic.send(tag + " OK done")
		case "ID":
			emit(id, port, "imap_id", map[string]any{"params": strings.Join(args, " ")})
			ic.send(`* ID ("name" "i10-probe" "version" "0")`)
			ic.send(tag + " OK id done")
		case "LOGIN":
			authed = true
			ic.send(tag + " OK [CAPABILITY " + capsPost + "] logged in")
		case "AUTHENTICATE":
			mech := ""
			if len(args) > 0 {
				mech = strings.ToUpper(args[0])
			}
			payload := ""
			if len(args) > 1 {
				payload = args[1]
			} else {
				ic.send("+ ")
				l, err := ic.r.ReadString('\n')
				if err != nil {
					return
				}
				payload = strings.TrimSpace(l)
			}
			user := ""
			if dec, err := base64.StdEncoding.DecodeString(payload); err == nil {
				parts := strings.Split(string(dec), "\x00")
				if mech == "PLAIN" && len(parts) >= 2 {
					user = parts[1]
				} else {
					user = string(dec)
				}
			}
			emit(id, port, "imap_login", map[string]any{"mech": mech, "user": user, "has_cert": hasCert})
			authed = true
			ic.send(tag + " OK [CAPABILITY " + capsPost + "] authenticated")
		case "NAMESPACE":
			ic.send(`* NAMESPACE (("" "/")) NIL NIL`)
			ic.send(tag + " OK done")
		case "LIST", "LSUB", "XLIST":
			if len(args) >= 2 && args[1] == "" {
				ic.send(`* ` + cmd + ` (\Noselect) "/" ""`)
			} else {
				ic.send(`* ` + cmd + ` (\HasNoChildren) "/" INBOX`)
				ic.send(`* ` + cmd + ` (\HasNoChildren \Sent) "/" Sent`)
				ic.send(`* ` + cmd + ` (\HasNoChildren \Drafts) "/" Drafts`)
				ic.send(`* ` + cmd + ` (\HasNoChildren \Trash) "/" Trash`)
			}
			ic.send(tag + " OK done")
		case "SELECT", "EXAMINE":
			ic.send(`* FLAGS (\Seen \Answered \Flagged \Deleted \Draft)`)
			ic.send(`* OK [PERMANENTFLAGS (\Seen \Answered \Flagged \Deleted \Draft \*)] ok`)
			ic.send("* 0 EXISTS")
			ic.send("* 0 RECENT")
			ic.send("* OK [UIDVALIDITY 1] ok")
			ic.send("* OK [UIDNEXT 1] ok")
			ic.send(tag + " OK [READ-WRITE] selected")
		case "STATUS":
			mbox := "INBOX"
			if len(args) > 0 {
				mbox = args[0]
			}
			ic.send(`* STATUS "` + mbox + `" (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1 UNSEEN 0)`)
			ic.send(tag + " OK done")
		case "SEARCH", "UID SEARCH":
			ic.send("* SEARCH")
			ic.send(tag + " OK done")
		case "IDLE":
			ic.send("+ idling")
			emit(id, port, "imap_idle", nil)
			for {
				l, err := ic.r.ReadString('\n')
				if err != nil {
					return
				}
				if strings.EqualFold(strings.TrimSpace(l), "DONE") {
					break
				}
			}
			ic.send(tag + " OK idle done")
		case "LOGOUT":
			ic.send("* BYE bye")
			ic.send(tag + " OK bye")
			return
		default:
			ic.send(tag + " OK done")
		}
	}
}

// ---------- SMTP ----------

func smtpSession(id int64, port string, c net.Conn, hasCert bool) {
	smtpSessionG(id, port, c, hasCert, true)
}

func smtpSessionG(id int64, port string, c net.Conn, hasCert bool, greet bool) {
	r := bufio.NewReader(c)
	w := bufio.NewWriter(c)
	send := func(s string) { w.WriteString(s + "\r\n"); w.Flush() }
	readLine := func() (string, error) {
		l, err := r.ReadString('\n')
		return strings.TrimRight(l, "\r\n"), err
	}
	if greet {
		send("220 i10 probe ESMTP")
	}
	for {
		line, err := readLine()
		if err != nil {
			return
		}
		up := strings.ToUpper(line)
		logged := line
		if strings.HasPrefix(up, "AUTH ") {
			f := strings.Fields(line)
			logged = "AUTH " + f[1] + " <redacted>"
		}
		emit(id, port, "smtp_cmd", map[string]any{"line": logged})
		switch {
		case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
			emit(id, port, "smtp_ehlo", map[string]any{"name": strings.TrimSpace(line[4:])})
			send("250-i10 probe")
			if hasCert {
				send("250-AUTH PLAIN LOGIN EXTERNAL")
			} else {
				send("250-AUTH PLAIN LOGIN")
			}
			send("250-SIZE 52428800")
			send("250-8BITMIME")
			send("250 ENHANCEDSTATUSCODES")
		case strings.HasPrefix(up, "AUTH "):
			f := strings.Fields(line)
			mech := strings.ToUpper(f[1])
			user := ""
			switch mech {
			case "PLAIN":
				p := ""
				if len(f) > 2 {
					p = f[2]
				} else {
					send("334 ")
					p, _ = readLine()
				}
				if dec, err := base64.StdEncoding.DecodeString(p); err == nil {
					parts := strings.Split(string(dec), "\x00")
					if len(parts) >= 2 {
						user = parts[1]
					}
				}
			case "LOGIN":
				u := ""
				if len(f) > 2 {
					u = f[2]
				} else {
					send("334 VXNlcm5hbWU6")
					u, _ = readLine()
				}
				if dec, err := base64.StdEncoding.DecodeString(u); err == nil {
					user = string(dec)
				}
				send("334 UGFzc3dvcmQ6")
				readLine()
			case "EXTERNAL":
				if len(f) == 2 {
					send("334 ")
					readLine()
				}
			}
			emit(id, port, "smtp_login", map[string]any{"mech": mech, "user": user, "has_cert": hasCert})
			send("235 2.7.0 ok")
		case strings.HasPrefix(up, "DATA"):
			send("354 go")
			for {
				l, err := readLine()
				if err != nil || l == "." {
					break
				}
			}
			send("250 2.0.0 queued")
		case strings.HasPrefix(up, "QUIT"):
			send("221 bye")
			return
		default:
			send("250 ok")
		}
	}
}

func main() {
	dir := os.Args[1]
	var err error
	logFile, err = os.OpenFile(dir+"/events.jsonl", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		panic(err)
	}
	serverCert, err := tls.LoadX509KeyPair(dir+"/pki/server.pem", dir+"/pki/server.key")
	if err != nil {
		panic(err)
	}
	caPEM, err := os.ReadFile(dir + "/pki/ca.pem")
	if err != nil {
		panic(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	for _, f := range []string{"/stepca/certs/root_ca.crt", "/stepca/certs/intermediate_ca.crt"} {
		if b, err := os.ReadFile(dir + f); err == nil {
			pool.AppendCertsFromPEM(b)
		}
	}

	ls := []listener{
		{"9993", "imap", false}, {"9994", "imap", true},
		{"9465", "smtp", false}, {"9466", "smtp", true},
	}
	for _, l := range ls {
		go serve(l, tlsConfig(serverCert, pool, l.require))
	}
	go serveStartTLS("9587", tlsConfig(serverCert, pool, false))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		emit(0, "9080", "http", map[string]any{"path": r.URL.Path, "remote": r.RemoteAddr, "ua": r.UserAgent()})
		if strings.HasSuffix(r.URL.Path, ".mobileconfig") {
			w.Header().Set("Content-Type", "application/x-apple-aspen-config")
		}
		http.FileServer(http.Dir(dir+"/serve")).ServeHTTP(w, r)
	}))
	fmt.Println("probe up: imaps 9993 (cert requested) 9994 (cert required), smtps 9465/9466, http 9080")
	panic(http.ListenAndServe("0.0.0.0:9080", nil))
}

// serveStartTLS: plain SMTP that upgrades with STARTTLS, then logs like the others.
func serveStartTLS(port string, cfg *tls.Config) {
	ln, err := net.Listen("tcp", "0.0.0.0:"+port)
	if err != nil {
		panic(err)
	}
	for {
		raw, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(raw net.Conn) {
			defer raw.Close()
			id := connSeq.Add(1)
			remote := raw.RemoteAddr().String()
			emit(id, port, "connect", map[string]any{"remote": remote, "proto": "smtp-starttls"})
			r := bufio.NewReader(raw)
			w := bufio.NewWriter(raw)
			send := func(s string) { w.WriteString(s + "\r\n"); w.Flush() }
			send("220 i10 probe ESMTP")
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				l = strings.TrimRight(l, "\r\n")
				emit(id, port, "smtp_cmd", map[string]any{"line": l, "pre_tls": true})
				up := strings.ToUpper(l)
				switch {
				case strings.HasPrefix(up, "EHLO"):
					send("250-i10 probe")
					send("250 STARTTLS")
				case strings.HasPrefix(up, "STARTTLS"):
					send("220 2.0.0 go ahead")
					tc := tls.Server(raw, cfg)
					tc.SetDeadline(time.Now().Add(120 * time.Second))
					herr := tc.Handshake()
					hk, _ := hellos.LoadAndDelete(remote)
					if herr != nil {
						emit(id, port, "tls_fail", map[string]any{"err": herr.Error(), "hello": hk})
						return
					}
					tc.SetDeadline(time.Time{})
					st := tc.ConnectionState()
					var certs []map[string]any
					for _, c := range st.PeerCertificates {
						certs = append(certs, map[string]any{"subject": c.Subject.CommonName})
					}
					emit(id, port, "tls_ok", map[string]any{"client_certs": certs, "hello": hk})
					smtpSessionG(id, port, tc, len(certs) > 0, false)
					return
				case strings.HasPrefix(up, "QUIT"):
					send("221 bye")
					return
				default:
					send("250 ok")
				}
			}
		}(raw)
	}
}

type peekConn struct {
	net.Conn
	r *bufio.Reader
}

func (p *peekConn) Read(b []byte) (int, error) { return p.r.Read(b) }

// plainUntilStartTLS speaks plaintext IMAP or SMTP until the client asks for STARTTLS.
func plainUntilStartTLS(id int64, l listener, pc *peekConn) bool {
	w := bufio.NewWriter(pc.Conn)
	send := func(s string) { w.WriteString(s + "\r\n"); w.Flush() }
	if l.proto == "imap" {
		send("* OK [CAPABILITY IMAP4rev1 ID STARTTLS LOGINDISABLED] i10 probe ready")
	} else {
		send("220 i10 probe ESMTP")
	}
	for {
		line, err := pc.r.ReadString('\n')
		if err != nil {
			return false
		}
		line = strings.TrimRight(line, "\r\n")
		emit(id, l.port, "plain_cmd", map[string]any{"line": line})
		f := strings.Fields(line)
		if l.proto == "imap" {
			if len(f) < 2 {
				send("* BAD")
				continue
			}
			switch strings.ToUpper(f[1]) {
			case "CAPABILITY":
				send("* CAPABILITY IMAP4rev1 ID STARTTLS LOGINDISABLED")
				send(f[0] + " OK done")
			case "ID":
				emit(id, l.port, "imap_id", map[string]any{"params": strings.Join(f[2:], " "), "pre_tls": true})
				send(`* ID ("name" "i10-probe")`)
				send(f[0] + " OK done")
			case "STARTTLS":
				send(f[0] + " OK begin TLS")
				return true
			case "LOGOUT":
				send("* BYE")
				send(f[0] + " OK")
				return false
			default:
				send(f[0] + " NO use STARTTLS first")
			}
		} else {
			up := strings.ToUpper(line)
			switch {
			case strings.HasPrefix(up, "EHLO"):
				send("250-i10 probe")
				send("250 STARTTLS")
			case strings.HasPrefix(up, "STARTTLS"):
				send("220 2.0.0 go ahead")
				return true
			case strings.HasPrefix(up, "QUIT"):
				send("221 bye")
				return false
			default:
				send("530 5.7.0 STARTTLS first")
			}
		}
	}
}
