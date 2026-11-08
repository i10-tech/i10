package egress

import (
	"context"
	"errors"
	"net/netip"
	"testing"
)

func TestPermittedRefusesEveryNonPublicRange(t *testing.T) {
	for _, a := range []string{
		"127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.5.4", "172.31.255.255",
		"192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "0.0.0.0",
		"0.1.2.3", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
		"::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
		"64:ff9b::7f00:1", "2002:7f00:1::", "2001::1",
		// IPv4 carried inside IPv6 is judged as the IPv4 address it is.
		"::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:0.0.0.0",
		"::127.0.0.1",
	} {
		if Permitted(netip.MustParseAddr(a)) {
			t.Errorf("%s was permitted", a)
		}
	}
	// A zone does not hide a link-local address.
	if Permitted(netip.MustParseAddr("fe80::1%eth0")) {
		t.Error("a link-local address with a zone was permitted")
	}
	if Permitted(netip.Addr{}) {
		t.Error("the zero address was permitted")
	}
}

func TestPermittedAllowsPublicAddresses(t *testing.T) {
	for _, a := range []string{"93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"} {
		if !Permitted(netip.MustParseAddr(a)) {
			t.Errorf("%s was refused", a)
		}
	}
}

type fakeResolver struct {
	answers map[string][]netip.Addr
	err     error
	asked   int
}

func (f *fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	f.asked++
	if f.err != nil {
		return nil, f.err
	}
	return f.answers[host], nil
}

func TestVetRefusesWhatResolvesAnywhereNonPublic(t *testing.T) {
	r := &fakeResolver{answers: map[string][]netip.Addr{
		"loop.acme.test":    {netip.MustParseAddr("127.0.0.1")},
		"meta.acme.test":    {netip.MustParseAddr("169.254.169.254")},
		"private.acme.test": {netip.MustParseAddr("10.1.2.3")},
		// One bad address refuses the whole name: the shape of rebinding.
		"mixed.acme.test": {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("192.168.0.9")},
		"v6.acme.test":    {netip.MustParseAddr("::1")},
	}}
	for _, host := range []string{"loop.acme.test", "meta.acme.test", "private.acme.test", "mixed.acme.test", "v6.acme.test"} {
		if _, err := Vet(context.Background(), r, host); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", host, err)
		}
	}
}

func TestVetRefusesLiteralsWithoutAskingDNS(t *testing.T) {
	r := &fakeResolver{}
	for _, host := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "[::1]", "0.0.0.0", "::ffff:127.0.0.1"} {
		if _, err := Vet(context.Background(), r, host); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", host, err)
		}
	}
	if r.asked != 0 {
		t.Errorf("DNS was asked %d times for an address literal", r.asked)
	}
}

func TestVetOutcomes(t *testing.T) {
	ctx := context.Background()
	if _, err := Vet(ctx, &fakeResolver{err: errors.New("nxdomain")}, "x.acme.test"); !errors.Is(err, ErrUnresolved) {
		t.Errorf("DNS failure: err = %v, want ErrUnresolved", err)
	}
	if _, err := Vet(ctx, &fakeResolver{}, "empty.acme.test"); !errors.Is(err, ErrUnresolved) {
		t.Errorf("no addresses: err = %v, want ErrUnresolved", err)
	}
	r := &fakeResolver{answers: map[string][]netip.Addr{
		"ok.acme.test": {netip.MustParseAddr("2606:4700:4700::1111"), netip.MustParseAddr("93.184.216.34")},
	}}
	got, err := Vet(ctx, r, "ok.acme.test")
	if err != nil || got != netip.MustParseAddr("93.184.216.34") {
		t.Errorf("Vet = %v, %v; want the IPv4 address", got, err)
	}
	lit, err := Vet(ctx, r, "8.8.8.8")
	if err != nil || lit != netip.MustParseAddr("8.8.8.8") {
		t.Errorf("Vet(literal) = %v, %v", lit, err)
	}
}
