# Argo CD at argo.i10.tech, tailnet only

The Argo CD UI is reachable at `https://argo.i10.tech` from devices on the
tailnet, and from nowhere else. Off the tailnet the name behaves exactly like a
hostname nobody uses: Traefik's plain `404 page not found`, and `REFUSED` from
our nameserver.

## The rules this design keeps

1. **No public DNS record.** `argo.i10.tech` is not in Cloudflare or in
   `infra/tofu/stacks/dns`. Publicly it falls inside the proxied `*.i10.tech`
   wildcard like any made-up name. The certificate is the `*.i10.tech`
   wildcard, so Certificate Transparency logs never show the name.
2. **Off the tailnet, nothing reveals anything is there.** Not a 403, not a
   login page. The response body must match a random hostname's 404 byte for
   byte.
3. **The tailnet check lives in the Traefik match rule**, not in an
   `ipAllowList` middleware. A middleware answers 403. A request that matches
   no router gets Traefik's default 404, which is what an unknown host gets.

## How a request gets there

```
tailnet device
  │  DNS: argo.i10.tech?
  ├─► Tailscale split DNS (argo.i10.tech → 100.127.102.63)
  │     └─► i10 PowerDNS on psl-vps, hostPort 53
  │           source is 100.x / fd7a: → "tailnet" view
  │           answers A 100.127.102.63, AAAA fd7a:115c:a1e0::9932:663f
  │
  │  HTTPS to 100.127.102.63:443, over WireGuard
  └─► Traefik, hostPort 443 (source address preserved: 100.x)
        Host(`argo.i10.tech`) && ClientIP(tailnet ranges) → argocd-server:80

anyone else
  │  DNS: argo.i10.tech → Cloudflare (the proxied wildcard)
  └─► Cloudflare → Traefik, source is a Cloudflare address
        no router matches → "404 page not found"
  │  DNS asked of our nameserver directly → REFUSED (same as any unhosted name)
```

## Why each piece is shaped this way

### Resolution: a PowerDNS view, not a public record and not a second resolver

Through the proxied wildcard, `argo.i10.tech` resolves to Cloudflare for
everyone. A tailnet device asking public DNS would therefore reach Traefik
through Cloudflare, with a Cloudflare source address, and get the 404. Tailnet
devices must resolve the name to the box's **tailnet** address instead.

PSL never solved this problem, because it never had it. The `infra/.env.example`
comment in the PSL repo about "Tailscale Split DNS" is stale: runbook step 11.3
says "No Split DNS, no dnsmasq". PSL's wildcard was **unproxied** and pointed at
the box's public IP, and the box advertised that IP as a `/32` subnet route so
tailnet traffic to it went through WireGuard. Neither holds here: `*.i10.tech`
is proxied, and psl-vps advertises no routes (`AdvertiseRoutes: null`,
checked 2026-11-05).

A second resolver on the box is not possible either. PowerDNS holds
`hostPort: 53` on the tailnet addresses `100.127.102.63` and
`fd7a:115c:a1e0::9932:663f` (each `hostPort` names its `hostIP`; see
`infra/k8s/i10/powerdns/README.md`), so port 53 there is already taken.
⚠ If the node's tailnet address ever changes, those two `hostIP` pairs in
`powerdns/deployment.yaml` must change with it, or this view goes silent.
Tailscale's own DNS cannot serve a
custom record (tailscale/tailscale#1543; only Headscale has `extra_records`).

So the resolver **is** PowerDNS, using its views feature (5.0+):

- `infra/k8s/i10/powerdns/configmap.yaml` launches `gpgsql,lmdb` with
  `views=yes`. Customer zones stay in `gpgsql`, untouched.
- An init container builds a fresh LMDB file from the ConfigMap on every pod
  start: one zone variant, `argo.i10.tech..tailnet`, and the networks
  `100.64.0.0/10` and `fd7a:115c:a1e0::/48` mapped to the view `tailnet`.
  Nothing about the view lives outside git, and nothing writes to it at run
  time.
- A query from a tailnet source gets the variant. A query from anywhere else
  bypasses views entirely, finds no `argo.i10.tech` zone, and is answered
  `REFUSED`, which is what the server says today for any name it does not host.

Measured locally against the committed config (real `gpgsql` backend, the init
script run as uid 953 on a read-only root, 2026-11-05):

| Query                         | Tailnet source              | Any other source |
| ----------------------------- | --------------------------- | ---------------- |
| `argo.i10.tech A`             | `100.127.102.63`            | `REFUSED`        |
| `argo.i10.tech AAAA`          | `fd7a:115c:a1e0::9932:663f` | `REFUSED`        |
| `zz-random.i10.tech A`        | `REFUSED`                   | `REFUSED`        |
| a customer zone (gpgsql)      | answered                    | answered         |
| outside, over TCP             |                             | `REFUSED`        |
| outside, ECS claiming 100.64/ |                             | `REFUSED`        |

The last row matters: views select by the EDNS client subnet when one is
present, but only when `edns-subnet-processing` is on. It is off (the default),
so a stranger cannot claim a tailnet subnet to get the answer.

⚠ **Views are marked experimental**, on the server that answers for customers'
mail DNS. What limits the exposure: customer zones are not in any view, and
PowerDNS documents that zones outside a view answer "as in a non-views setup";
the table above confirms it for both sources. If views misbehave, removing
`lmdb` from `launch` and `views=yes` returns the server to exactly its previous
shape.

### Source address: Traefik holds :443 itself

Before this change Traefik logged every client as `10.42.0.25`, the k3s
klipper svclb pod. klipper MASQUERADEs, so no `ClientIP()` rule could ever
match a tailnet device. PSL's earlier answer, `externalTrafficPolicy: Local`,
does not help on this cluster: a throwaway `Local` LoadBalancer still delivered
`10.42.0.78` (measured 2026-11-05). A throwaway pod with a plain `hostPort` saw
the real `100.117.249.126` and `fd7a:115c:a1e0::d932:f97e`.

So Traefik now binds `hostPort` 80/443 directly and its Service is `ClusterIP`.
This lives in the PSL repo (`infra/k8s/argocd/apps/traefik.yaml`), which owns
the shared edge. Two consequences are designed in there:

- **The container ports are 80/443 too.** ufw's routed rules match the port
  after the DNAT, and the node allows routed 80 and 443 only. A
  hostPort 443 → containerPort 8443 packet would hit `deny (routed)`. A pod
  sysctl (`net.ipv4.ip_unprivileged_port_start=0`) lets uid 65532 bind them
  with every capability still dropped.
- **`maxSurge: 0`.** On one node, a surge pod cannot bind ports the old pod
  holds, so every rollout would wedge. Each Traefik rollout now costs a few
  seconds with no edge.

Every app behind Traefik now sees real client addresses, which for i10's
proxied hosts means Cloudflare's addresses instead of one constant `10.42.x`.
No Traefik middleware filters by IP (checked 2026-11-05).

### The route: in the `argocd` namespace, in the PSL repo

`infra/k8s/platform/argocd-ui/ingressroute.yaml` in the PSL repo. It cannot be
in this repo: Traefik runs with `allowCrossNamespace: false`, so a route must
sit beside the Service it targets, and the `i10` AppProject cannot deploy into
`argocd`. The other way around it, Traefik's ExternalName services, would let
any namespace route to any service in the cluster.

The route names no TLS secret, because `i10-tech-tls` lives in `i10-prod`.
Traefik picks certificates by SNI from every one it has loaded, so the wildcard
that i10's own routes load serves this host too. A random `*.i10.tech` host
already gets that certificate today, which is how this was confirmed.

### Argo serves plain HTTP behind Traefik (`server.insecure`)

Traefik terminates TLS with the wildcard and speaks HTTP to `argocd-server`,
like every other route on this edge (Stalwart included), and as Argo's own docs
recommend behind Traefik. The alternative was a `serversTransport` with
`insecureSkipVerify` against Argo's self-signed certificate: encryption that
proves nothing. The flag is set in `argocd-cmd-params-cm`, which is hand-managed
like the rest of the Argo install; the PSL repo's `infra/k8s/README.md` records
it.

## What lives where

| Piece                                      | Where                                                   |
| ------------------------------------------ | ------------------------------------------------------- |
| PowerDNS view, zone, 5.1.5 upgrade         | this repo, `infra/k8s/i10/powerdns/`                    |
| Traefik hostPort edge                      | PSL repo, `infra/k8s/argocd/apps/traefik.yaml`          |
| The IngressRoute and its Application       | PSL repo, `infra/k8s/platform/argocd-ui/`               |
| `server.insecure`                          | `argocd-cmd-params-cm`, by hand; recorded in PSL README |
| Split DNS `argo.i10.tech → 100.127.102.63` | Tailscale admin console, DNS page                       |

The zone hard-codes psl-vps's tailnet addresses. They change only if the
machine is removed from the tailnet and re-added; `tailscale ip` on the box
prints the current pair, and the zone in the ConfigMap must follow.

## Checking it

From a tailnet device:

```bash
dig +short argo.i10.tech                     # 100.127.102.63
dig +short @100.127.102.63 argo.i10.tech     # same, straight from PowerDNS
curl -sI https://argo.i10.tech | head -1     # HTTP/2 200
```

From off the tailnet (or from a tailnet device, forcing the public paths):

```bash
dig +norec @178.105.164.132 argo.i10.tech    # status: REFUSED
r=zz-$RANDOM.i10.tech
cmp <(curl -sk --resolve argo.i10.tech:443:104.21.27.97 https://argo.i10.tech/) \
    <(curl -sk --resolve $r:443:104.21.27.97 https://$r/) && echo identical
```

## Known limits

- A browser set to its own secure DNS provider (custom DoH in Chrome or
  Firefox) skips Tailscale's split DNS and gets the public answer, so the 404.
  Secure DNS on "automatic" or off works.
- One machine answers for both `ns1` and `ns2`, as before; nothing here changes
  that.
