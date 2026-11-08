// Package egress decides which addresses authd may connect to on a tenant's
// behalf.
//
// ⚠ EVERY HOST AUTHD DIALS FOR A BIND WAS CHOSEN BY A CUSTOMER'S ADMIN: the LDAP
// server of a pass-through connection (internal/passthrough) and the token
// endpoint of an OIDC one (internal/oidc). Left unchecked, either is a way to make this pod
// connect to the cluster, the node or the cloud metadata service, so both go
// through Vet.
package egress

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

// blocked is every range authd may not connect to: the same list as the API's
// egress guard (apps/api/src/webhooks/egress.ts, which vets the host when a
// setup test runs). The API and authd must agree, or a host the setup test
// accepted would be refused at the first bind - or worse, the reverse.
var blocked = mustPrefixes(
	// IPv4
	"0.0.0.0/8",       // "this network", including 0.0.0.0
	"10.0.0.0/8",      // RFC 1918
	"100.64.0.0/10",   // shared address space (CGNAT)
	"127.0.0.0/8",     // loopback
	"169.254.0.0/16",  // link-local, which is where cloud metadata lives
	"172.16.0.0/12",   // RFC 1918
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // documentation
	"192.88.99.0/24",  // deprecated 6to4 relay anycast
	"192.168.0.0/16",  // RFC 1918
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // documentation
	"203.0.113.0/24",  // documentation
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // reserved, including 255.255.255.255
	// IPv6
	"::/128",         // unspecified
	"::1/128",        // loopback
	"::/96",          // deprecated IPv4-compatible form
	"64:ff9b::/96",   // NAT64, which can embed any IPv4 address
	"64:ff9b:1::/48", // local-use NAT64
	"100::/64",       // discard
	"2001::/32",      // Teredo, which tunnels IPv4 inside IPv6
	"2001:db8::/32",  // documentation
	"2002::/16",      // 6to4, which embeds an IPv4 address
	"3fff::/20",      // documentation
	"5f00::/16",      // segment routing (SRv6)
	"fc00::/7",       // unique local
	"fe80::/10",      // link-local
	"ff00::/8",       // multicast
)

func mustPrefixes(specs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(specs))
	for i, s := range specs {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// Permitted reports whether authd may connect to the address.
//
// ⚠ AN IPv4-MAPPED IPv6 ADDRESS IS JUDGED AS THE IPv4 ADDRESS IT CARRIES.
// ::ffff:127.0.0.1 is loopback; judging it as IPv6 would call it public.
func Permitted(addr netip.Addr) bool {
	addr = addr.WithZone("").Unmap()
	if !addr.IsValid() {
		return false
	}
	for _, p := range blocked {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

// Resolver is the part of net.Resolver the guard needs.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

var (
	// ErrBlocked: the host is, or resolves to, an address we will not connect to.
	ErrBlocked = errors.New("egress: host is not a public address")
	// ErrUnresolved: DNS had no answer.
	ErrUnresolved = errors.New("egress: host did not resolve")
)

// Vet resolves host and returns the one address to connect to.
//
// ⚠ ONE NON-PUBLIC ADDRESS REFUSES THE WHOLE HOST, as in the API's guard. An
// answer that mixes public and private addresses is the shape a rebinding
// attack takes, not a configuration anybody needs.
//
// ⚠ THE CALLER DIALS THE ADDRESS RETURNED HERE, never the name again: a name
// that resolves somewhere else a moment later must not redirect the connection.
// IPv4 is preferred, as in the API.
func Vet(ctx context.Context, r Resolver, host string) (netip.Addr, error) {
	bare := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	var addrs []netip.Addr
	if literal, err := netip.ParseAddr(bare); err == nil {
		addrs = []netip.Addr{literal}
	} else {
		resolved, err := r.LookupNetIP(ctx, "ip", bare)
		if err != nil {
			return netip.Addr{}, fmt.Errorf("%w: %v", ErrUnresolved, errName(err))
		}
		addrs = resolved
	}
	if len(addrs) == 0 {
		return netip.Addr{}, ErrUnresolved
	}
	for _, a := range addrs {
		if !Permitted(a) {
			return netip.Addr{}, ErrBlocked
		}
	}
	for _, a := range addrs {
		if a.Unmap().Is4() {
			return a.Unmap(), nil
		}
	}
	return addrs[0], nil
}

// errName is an error's type, never its message: a resolver's message can name
// the host and the nameserver.
func errName(err error) string { return fmt.Sprintf("%T", err) }
