# PowerDNS — the authoritative nameserver for delegated subdomains

This serves the zones `apps/api` writes into the `pdns` schema when a customer
chooses "Delegate to i10" for a domain. Until it existed, that whole path was
inert: the API wrote zones nothing read, and the console told customers to point
NS records at `ns1.i10.tech`, which resolved to Cloudflare's HTTP proxy and
answered nothing on port 53.

## What it needs that is not in this directory

Three things have to exist outside the repo before the pod is useful. The first
is done; the other two need a hand on a console this repository cannot reach.

### 1. Doppler: the database role's password — **done**

CNPG creates the `pdns` Postgres role from `platform-db/cluster.yaml` and reads
its password from the `i10-pdns-db-role` Secret, which the Doppler operator syncs.

This is already in place:

- Doppler config **`prod_pdns_db`** created in the `prod` environment, holding
  `PDNS_DB_USERNAME=pdns` and a freshly generated 32-byte
  `PDNS_DB_PASSWORD`.
- A service token `k8s-i10-pdns-db` scoped to that config, stored as the
  Kubernetes Secret `doppler-token-i10-pdns-db` in `i10-prod`.

> ⚠ ITS OWN CONFIG, NOT `prod_platform` — an earlier draft of this file said
> otherwise and was wrong. Every database role here has a dedicated config:
> `prod_api_db`, `prod_authd_db`, `prod_stalwart_db`. Putting a role's password
> in the shared platform config would hand it to every workload that reads
> `prod_platform`, which is the opposite of why these roles are separate.

> ⚠ `PDNS_DB_USERNAME` must be exactly `pdns`. CNPG matches the managed role by
> the `name:` in `cluster.yaml`, and the Secret is what the role's password is
> reconciled _to_ — a mismatch produces a role whose password is set from one
> place and used from another, which fails only at connection time.

### 2. Cloudflare: the nameserver addresses, unproxied

`ns1.i10.tech` and `ns2.i10.tech` currently resolve to `104.21.27.97` and
`172.67.169.27` — Cloudflare's HTTP anycast addresses, because the records are
proxied. **A proxied record cannot serve DNS.** Cloudflare's proxy terminates
HTTP and HTTPS; it does not forward UDP/53, so `dig @ns1.i10.tech` times out and
every delegated zone is unreachable however correct its contents.

Set both names on **both** address families, proxy **off** (grey cloud):

| Name  | Type | Value                   | Proxy    |
| ----- | ---- | ----------------------- | -------- |
| `ns1` | A    | `178.105.164.132`       | DNS only |
| `ns1` | AAAA | `2a01:4f8:1c18:45fb::1` | DNS only |
| `ns2` | A    | `178.105.164.132`       | DNS only |
| `ns2` | AAAA | `2a01:4f8:1c18:45fb::1` | DNS only |

> ⚠ ALL FOUR, NOT ONE EACH. A delegation names nameserver HOSTNAMES, and a
> resolver has to turn one into an address it can actually reach. Give `ns1`
> only an A record and `ns2` only an AAAA, and an IPv4-only resolver can never
> use `ns2` while an IPv6-only resolver can never use `ns1` — each of them is
> down to a single nameserver, and the one lookup that picks the wrong name
> costs a timeout and a retry before it recovers. Some resolvers cache that
> absence. Both names on both families is the only configuration where every
> resolver sees two usable nameservers.

> ⚠ BOTH NAMES POINT AT ONE MACHINE, AND THAT IS THE APPEARANCE OF REDUNDANCY
> RATHER THAN THE FACT OF IT. Resolvers expect more than one nameserver and will
> retry the second, so two names are required — but there is one host behind
> them, and it is a single point of failure for every delegated customer's mail
> DNS. `apps/api/src/env.ts` has said this since `MAIL_NAMESERVERS` was written.
> A second node, or a hidden-primary/secondary pair, is the real fix.

### 3. The firewall: UDP and TCP 53 inbound

The pod claims `hostPort: 53` on both protocols. Whatever filters the node has
to allow both — TCP as well as UDP, because a response over 512 bytes sets the
truncated bit and the resolver retries over TCP. A UDP-only rule produces a
nameserver that works until an answer gets slightly larger, which is the hardest
shape of DNS fault to see.

`systemd-resolved` on this host binds only `127.0.0.53` and `127.0.0.54`, so it
does not conflict with a bind on the public interface. Confirmed 2026-09-18.

## Checking it

From anywhere, once a customer has a delegated domain:

```bash
dig +short @ns1.i10.tech SOA mail.<their-domain>
```

An SOA means the delegation is being served. A timeout means one of the three
things above is missing. The console says which: an unverified delegated domain
now shows a diagnosis from `/console/domains/:id/delegation`, and
`nameserversAnswering: false` is the case where the fault is ours.

## What it deliberately does not do

- **No DNSSEC.** `--dnssec=no`. With it on, PowerDNS expects `ordername` and
  `auth` maintained on every record, and `apps/api/src/domains/powerdns.ts` does
  not write them. Turning it on before that writer does produces a zone that
  answers NXDOMAIN for names that exist.
- **No AXFR.** `--disable-axfr=yes`. There is no secondary to transfer to, and an
  open transfer hands anybody the full list of customer domains.
- **No recursion.** An authoritative server that recurses is an open resolver,
  which is an amplification reflector with our address on it.
- **No API.** The webserver is on for the health probe only. Zones are written by
  `apps/api` as rows, in the same transaction as the domain they belong to;
  a second write path through PowerDNS's REST API would be a second source of
  truth for the same zone.
