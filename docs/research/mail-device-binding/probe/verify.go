package main

// Request verification and the one-time challenge for the over-the-air flow.
// Research code: it exists so the probe cannot be used to obtain a sealed
// code by anyone who can reach the port.

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	challengeTTL   = 10 * time.Minute
	maxChallenges  = 10000
	maxRequestBody = 1 << 20
)

// verifyCMS checks the CMS signature in der and builds the signer chain to
// root only (never the system store). untrusted may name a file of
// intermediates to help build the chain; it is skipped when missing. Any
// failure, including a missing root file, is an error.
func verifyCMS(der, root, untrusted, signerOut, attrsOut string) (*x509.Certificate, error) {
	args := []string{
		"cms", "-verify", "-inform", "DER", "-in", der,
		"-CAfile", root, "-no-CApath", "-no-CAstore", "-purpose", "any",
		"-signer", signerOut, "-out", attrsOut,
	}
	if untrusted != "" {
		if _, err := os.Stat(untrusted); err == nil {
			args = append(args, "-certfile", untrusted)
		}
	}
	if out, err := run("openssl", args...); err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(out))
	}
	b, err := os.ReadFile(signerOut)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("no signer certificate")
	}
	return x509.ParseCertificate(blk.Bytes)
}

// challenge is one issued Challenge. It is bound to the device serial by the
// first verified phase 2 request and consumed by the verified phase 3 request.
type challenge struct {
	expires         time.Time
	serial, product string
}

type challenges struct {
	mu  sync.Mutex
	now func() time.Time
	m   map[string]*challenge
}

func newChallenges() *challenges {
	return &challenges{now: time.Now, m: map[string]*challenge{}}
}

func (c *challenges) issue() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, v := range c.m {
		if now.After(v.expires) {
			delete(c.m, k)
		}
	}
	if len(c.m) >= maxChallenges {
		return "", errors.New("too many open challenges")
	}
	id := randHex(16)
	c.m[id] = &challenge{expires: now.Add(challengeTTL)}
	return id, nil
}

// live returns the unexpired challenge id, or nil. Callers hold c.mu.
func (c *challenges) live(id string) *challenge {
	ch := c.m[id]
	if ch == nil || c.now().After(ch.expires) {
		return nil
	}
	return ch
}

// bind ties an issued, unexpired challenge to a serial. Repeating it for the
// same serial is fine (the device may retry); a different serial is refused.
// A serial has at most one bound challenge: binding a new one drops any other,
// so the latest enrollment of a device is the one its final request completes.
func (c *challenges) bind(id, serial, product string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := c.live(id)
	if ch == nil {
		return errors.New("unknown or expired challenge")
	}
	if ch.serial != "" && ch.serial != serial {
		return errors.New("challenge bound to another serial")
	}
	for k, v := range c.m {
		if k != id && v.serial == serial {
			delete(c.m, k)
		}
	}
	ch.serial, ch.product = serial, product
	return nil
}

// consume uses up the challenge bound to serial. The final request need not
// echo CHALLENGE (Apple's sample phase 4 request carries only UDID, VERSION
// and MAC_ADDRESS_EN0), so id may be empty and the serial, taken from the
// certificate our CA issued, finds it. An echoed id must be that challenge.
func (c *challenges) consume(id, serial string) (string, error) {
	if serial == "" {
		// An unbound challenge has an empty serial too; never match it.
		return "", errors.New("no serial to find the challenge by")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		ch := c.live(k)
		if ch == nil || ch.serial != serial {
			continue
		}
		if id != "" && id != k {
			return "", errors.New("echoed challenge is not the one bound to this serial")
		}
		delete(c.m, k)
		return ch.product, nil
	}
	return "", errors.New("no unexpired challenge bound to this serial")
}
