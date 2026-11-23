// mailfront-scale measures the mail front with many idle signed-in IMAP
// connections. It plays both ends: a fake Stalwart on the front's upstream
// address (it reads the PROXY header, accepts any LOGIN and sits in IDLE), and
// the clients, which sign in as bench_<k> (u<k>@t<1+k%20000>.bench.test, the
// seed in ../sweep-seed.sql) and IDLE. It prints when they are all
// in, with each sign-in's latency and why any failed, then holds them until
// killed (or exits, with -hold=false); the front's CPU and memory are read from
// /proc by the caller.
//
//	mailfront-scale -upstream 127.0.0.1:1993 -front <pod ip>:993 -n 1000
//
// -c is how many clients dial at once: 64 fills the front steadily, -c equal
// to -n is every client reconnecting at the same moment (a restart).
package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	upstream := flag.String("upstream", "127.0.0.1:1993", "where the fake Stalwart listens")
	front := flag.String("front", "", "the front's IMAP address")
	n := flag.Int("n", 100, "connections")
	c := flag.Int("c", 64, "clients dialing at once")
	hold := flag.Bool("hold", true, "hold the connections open after they are in")
	offset := flag.Int("domain-offset", 0, "skip this many seed domains (600 skips the 500 that require SSO)")
	flag.Parse()

	ln, err := net.Listen("tcp", *upstream)
	if err != nil {
		log.Fatal(err)
	}
	go fakeStalwart(ln)

	var in atomic.Int64
	var wg sync.WaitGroup
	var mu sync.Mutex
	var lat []time.Duration
	failures := map[string]int{}
	start := time.Now()
	sem := make(chan struct{}, *c)
	for i := 0; i < *n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			// Accounts 1+25j+20000m are clustered 25 to a domain; skip the
			// seed's suspended (k%997==7) and payment-held (k%1499==11) ones.
			k := (i/25+*offset)%20000 + 20000*(i%25) + 1
			for k%997 == 7 || k%1499 == 11 {
				k += 20000
			}
			began := time.Now()
			err := idle(*front, fmt.Sprintf("u%d@t%d.bench.test", k, 1+k%20000))
			took := time.Since(began)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures[failureKind(err)]++
				return
			}
			lat = append(lat, took)
			in.Add(1)
		}(i)
	}
	wg.Wait()
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	pct := func(p int) time.Duration {
		if len(lat) == 0 {
			return 0
		}
		return lat[(len(lat)-1)*p/100].Round(time.Millisecond)
	}
	fmt.Printf("READY %d/%d in %s sign-in p50=%s p95=%s p99=%s max=%s failures=%v\n",
		in.Load(), *n, time.Since(start).Round(time.Millisecond), pct(50), pct(95), pct(99), pct(100), failures)
	if *hold {
		select {}
	}
}

// failureKind buckets a failed sign-in by what the client saw, without the
// per-connection detail (addresses, ports) that would make every one unique.
func failureKind(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "login:"):
		return "login refused: " + strings.SplitN(strings.TrimPrefix(s, "login: "), " ", 3)[0]
	case strings.Contains(s, "reset"), strings.Contains(s, "EOF"), strings.Contains(s, "broken pipe"):
		return "closed by the front"
	case strings.Contains(s, "timeout"):
		return "timeout"
	default:
		return s
	}
}

func idle(addr, user string) error {
	c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		return err
	}
	r := bufio.NewReader(c)
	if _, err := r.ReadString('\n'); err != nil {
		return err
	}
	fmt.Fprintf(c, "a LOGIN %s pw\r\n", user)
	l, err := r.ReadString('\n')
	if err != nil || !strings.HasPrefix(l, "a OK") {
		return fmt.Errorf("login: %q %v", l, err)
	}
	fmt.Fprint(c, "b IDLE\r\n")
	if l, err := r.ReadString('\n'); err != nil || !strings.HasPrefix(l, "+") {
		return fmt.Errorf("idle: %q %v", l, err)
	}
	go func() { _, _ = io.Copy(io.Discard, r); os.Stderr.WriteString("closed: " + user + "\n") }()
	return nil
}

func fakeStalwart(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			r := bufio.NewReader(c)
			head := make([]byte, 16)
			if _, err := io.ReadFull(r, head); err != nil {
				return
			}
			if _, err := io.CopyN(io.Discard, r, int64(binary.BigEndian.Uint16(head[14:]))); err != nil {
				return
			}
			fmt.Fprint(c, "* OK [CAPABILITY IMAP4rev2 LITERAL+ AUTH=PLAIN] ready\r\n")
			for {
				line, err := r.ReadString('\n')
				if err != nil {
					return
				}
				tag, rest, _ := strings.Cut(strings.TrimRight(line, "\r\n"), " ")
				switch {
				case strings.HasPrefix(rest, "LOGIN"):
					// The front sends LOGIN as two LITERAL+ literals.
					for strings.HasSuffix(strings.TrimRight(line, "\r\n"), "+}") {
						body := strings.TrimRight(line, "\r\n")
						var sz int
						fmt.Sscanf(body[strings.LastIndexByte(body, '{')+1:], "%d", &sz)
						if _, err := io.CopyN(io.Discard, r, int64(sz)); err != nil {
							return
						}
						if line, err = r.ReadString('\n'); err != nil {
							return
						}
					}
					fmt.Fprintf(c, "%s OK [CAPABILITY IMAP4rev2 IDLE] Authentication successful\r\n", tag)
				case strings.HasPrefix(rest, "IDLE"):
					fmt.Fprint(c, "+ idling\r\n")
				default:
					fmt.Fprintf(c, "%s OK done\r\n", tag)
				}
			}
		}()
	}
}
