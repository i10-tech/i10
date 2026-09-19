import type { DnsProvider } from "./types.js"

/**
 * Every DNS host i10 can recognise.
 *
 * ⚠ THE NAMESERVER PATTERNS WERE RESOLVED LIVE, NOT REMEMBERED. Where a pattern
 * is stated in a provider's documentation but was not confirmed against a real
 * zone, the row says so in `unverified`. The distinction matters because a
 * wrong pattern does not fail loudly — it silently reports the wrong company's
 * name and shows a customer a "Connect" dialog for a service they do not use.
 *
 * ⚠ ORDER IS IRRELEVANT TO CORRECTNESS AND IS ALPHABETICAL FOR REVIEW. Matching
 * is by longest pattern with a backend tiebreak (see `detectProvider`), not by
 * position, so a row added in the wrong place cannot shadow another.
 *
 * ⚠ `nsDelegation: true` MEANS "THIS UI HAS AN NS RECORD TYPE", NOT "THIS
 * SOFTWARE SUPPORTS NS RECORDS". Every authoritative server supports them; what
 * varies is whether the customer-facing editor exposes one. The flag answers
 * the question the customer actually has, which is whether they will find the
 * control we are about to tell them to click.
 *
 * ⚠ AND DELEGATION IS THE DEFAULT PATH, NOT THE FALLBACK. Twenty-two of the
 * providers below have no usable per-customer API at all, and the two largest
 * registrars gate theirs behind spend thresholds. NS delegation works wherever
 * an NS record can be created, which is almost everywhere — and it removes the
 * entire class of bug documented on `ProviderApi.replacesZone`.
 */
export const PROVIDERS: DnsProvider[] = [
  {
    slug: "akamai-edge-dns",
    name: "Akamai Edge DNS",
    kind: "authoritative",
    /*
     * ⚠ A DIFFERENT PRODUCT FROM LINODE, DESPITE AKAMAI OWNING BOTH. Edge DNS
     * is the enterprise service with EdgeGrid-signed requests; Linode's is the
     * cloud one with an ordinary bearer token, and their credentials are not
     * interchangeable. Collapsing them into one row would offer an Edge DNS
     * customer a connect flow that cannot authenticate.
     */
    nameserverPatterns: ["akam.net", "akamaidns.com"],
    nsDelegation: true,
    api: {
      docs: "https://techdocs.akamai.com/edge-dns/reference/edge-dns-api",
      auth: "key-secret",
      scope: "EdgeGrid client token with DNS—Zone Record Management",
      zoneScoped: false,
    },
    manualPath:
      "Akamai Control Center → Edge DNS Zone Management → your zone → Add record",
  },
  {
    slug: "alibaba-dns",
    name: "Alibaba Cloud DNS",
    kind: "authoritative",
    nameserverPatterns: ["alidns.com", "hichina.com", "aliyun.com"],
    nsDelegation: true,
    api: {
      docs: "https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord",
      // ⚠ RPC-STYLE WITH HMAC-SHA1 REQUEST SIGNING, not a bearer token. The
      // signing key is the secret with a trailing `&`, which is easy to get
      // wrong and produces an error that says nothing useful.
      auth: "key-secret",
      scope: "AliyunDNSFullAccess (RAM), or an STS token",
      zoneScoped: false,
    },
    manualPath: "Alibaba Cloud DNS console → Resolve → Add Record",
  },
  {
    slug: "azure-dns",
    name: "Azure DNS",
    kind: "authoritative",
    nameserverPatterns: [
      "azure-dns.com",
      "azure-dns.net",
      "azure-dns.org",
      "azure-dns.info",
    ],
    nsDelegation: true,
    api: {
      docs: "https://learn.microsoft.com/en-us/rest/api/dns/record-sets/create-or-update",
      auth: "oauth",
      scope: "DNS Zone Contributor on the zone",
      zoneScoped: true,
      /*
       * ⚠ OAUTH, AND STILL NOT ONE CLICK. Entra ID gives us a real
       * authorization-code flow, and then the customer has to supply a
       * subscription id and a resource group before we can find their zone.
       * That is a form, not a button, and the connect dialog treats it as one
       * rather than promising a single click and then asking three questions.
       */
      oauth: {
        authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: ["https://management.azure.com/.default"],
      },
    },
    manualPath: "Azure portal → DNS zones → your zone → + Record set",
  },
  {
    slug: "bluehost",
    name: "Bluehost",
    kind: "registrar",
    nameserverPatterns: ["bluehost.com"],
    nsDelegation: true,
    api: null,
    manualPath: "Domains → your domain → DNS → Add Record",
    helpUrl:
      "https://www.bluehost.com/help/article/dns-management-add-edit-or-delete-dns-entries",
  },
  {
    slug: "cloudflare",
    name: "Cloudflare",
    kind: "authoritative",
    /*
     * ⚠ A ZONE'S TWO NAMESERVERS ARE PERSONALISED PET NAMES — `kim.ns.cloudflare.com`,
     * `walt.ns.cloudflare.com` — so the pattern is the shared suffix rather than
     * any literal hostname.
     *
     * ⚠ `ns3`–`ns7.cloudflare.com` IS CLOUDFLARE'S OWN CORPORATE ZONE AND NOT A
     * CUSTOMER PATTERN, and `*.foundationdns.*` is their enterprise product.
     * Both are matched because a customer really can be on them; neither is
     * what a normal signup looks like.
     */
    nameserverPatterns: [
      "ns.cloudflare.com",
      "cloudflare.com",
      "foundationdns.com",
      "foundationdns.net",
      "foundationdns.org",
    ],
    nsDelegation: true,
    api: {
      docs: "https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/",
      auth: "oauth",
      scope: "Zone → DNS → Edit (plus Zone → Zone → Read to find the zone)",
      zoneScoped: true,
      /*
       * ⚠ CLOUDFLARE OAUTH IS GENERALLY AVAILABLE ON EVERY PLAN, AND THIS IS
       * THE MOST VALUABLE FACT IN THIS FILE. Cloudflare hosts more of our
       * customers' zones than everything else here combined, and until this
       * shipped the only option was asking somebody to go and mint an API token
       * — which is where most setup flows lose people. Authorization code only;
       * public clients must use PKCE S256.
       *
       * ⚠ THE ENDPOINTS BELOW ARE A FALLBACK. Cloudflare explicitly recommends
       * reading them from the discovery document at
       * https://dash.cloudflare.com/.well-known/openid-configuration rather
       * than hard-coding them, and the adapter should.
       */
      oauth: {
        authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
        tokenUrl: "https://dash.cloudflare.com/oauth2/token",
        /*
         * ⚠ READ OFF A REAL CLIENT'S EDIT PAGE, NOT INFERRED FROM THE DOCS.
         * These were `dns_records:edit` and `zone:read` — API TOKEN permission
         * syntax, which is what the documentation shows and what every other
         * integration guide repeats. Cloudflare's OAuth uses a different form,
         * and the wrong string does not fail gracefully: the authorize endpoint
         * either refuses outright or issues a token missing the one permission
         * the integration needs, which surfaces much later as a 403 on a
         * publish.
         *
         * ⚠ `offline_access` IS WHAT MAKES THE CONNECTION OUTLIVE ITS FIRST
         * ACCESS TOKEN. Without it Cloudflare issues no refresh token, so the
         * connection is dead as soon as the access token expires and the
         * customer has to reconnect — with no warning, and no way for us to
         * repair it on their behalf.
         *
         * The authoritative list is `GET /client/v4/oauth/scopes`, which needs
         * credentials; a client's own edit page in the dashboard shows the
         * identifiers beside each permission.
         */
        scopes: ["dns.write", "zone.read", "offline_access"],
      },
    },
    manualPath: "Cloudflare dashboard → your domain → DNS → Records → Add record",
    helpUrl:
      "https://developers.cloudflare.com/dns/manage-dns-records/how-to/subdomains-outside-cloudflare/",
    unverified:
      "A zone on CNAME (partial) setup cannot delegate a subdomain at all — the " +
      "adapter must check the zone `type` before offering the API path. The " +
      "1200-per-5-minutes limit is per ACCOUNT, shared with the customer's own " +
      "dashboard use.",
  },
  {
    slug: "cloudns",
    name: "ClouDNS",
    kind: "authoritative",
    // ⚠ MATCH THE `cloudns.` LABEL, NOT A FIXED HOST LIST. One zone was
    // observed answering with pns1, dns2, dns7, pns4 and a `.uk` host at once.
    nameserverPatterns: [
      "cloudns.net",
      "cloudns.uk",
      "cloudns.eu",
      "cloudns.biz",
      "cloudns.asia",
    ],
    nsDelegation: true,
    api: {
      docs: "https://www.cloudns.net/wiki/article/58/",
      auth: "key-secret",
      scope: "auth-id + auth-password, optionally IP-restricted",
      zoneScoped: false,
    },
    manualPath: "Control panel → DNS zones → your zone → Add new record",
  },
  {
    slug: "csc",
    name: "CSC Corporate Domains",
    kind: "registrar",
    nameserverPatterns: ["cscdns.net", "corporatedomains.com"],
    nsDelegation: true,
    api: null,
    manualPath: "Managed by your corporate domain administrator.",
  },
  {
    slug: "desec",
    name: "deSEC",
    kind: "authoritative",
    nameserverPatterns: ["desec.io", "desec.org"],
    nsDelegation: true,
    api: {
      docs: "https://desec.readthedocs.io/en/latest/dns/rrsets.html",
      auth: "token",
      scope: "Authorization: Token <secret>",
      zoneScoped: false,
    },
    manualPath: "desec.io → Domains → your domain → Add RRset",
    helpUrl: "https://desec.readthedocs.io/",
    unverified:
      "Bulk atomic RRset writes are exactly the shape we want — SPF, DKIM, " +
      "DMARC and MX in one transaction — but have not been exercised here.",
  },
  {
    slug: "digitalocean",
    name: "DigitalOcean",
    kind: "authoritative",
    nameserverPatterns: ["digitalocean.com"],
    nsDelegation: true,
    api: {
      docs: "https://docs.digitalocean.com/reference/api/reference/domain-records/",
      auth: "oauth",
      scope: "domain:read and domain:create",
      // ⚠ A PERSONAL ACCESS TOKEN IS ACCOUNT-WIDE; the OAuth scopes above are
      // not. This is the reason to prefer the OAuth path rather than asking for
      // a pasted token: the pasted one can also delete their droplets.
      zoneScoped: false,
      oauth: {
        authorizeUrl: "https://cloud.digitalocean.com/v1/oauth/authorize",
        tokenUrl: "https://cloud.digitalocean.com/v1/oauth/token",
        scopes: ["domain:read", "domain:create"],
      },
    },
    manualPath: "Networking → Domains → your domain → Create new record",
    helpUrl:
      "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
    unverified:
      "The domain must already exist as a Domain resource in the account — a " +
      "customer who pointed NS at DO but never added the domain in the panel " +
      "gets a 404 on records, and the adapter has to create the domain first.",
  },
  {
    slug: "dnsimple",
    name: "DNSimple",
    kind: "authoritative",
    nameserverPatterns: [
      "dnsimple.com",
      "dnsimple-edge.com",
      "dnsimple-edge.net",
      "dnsimple-edge.io",
      "dnsimple-edge.org",
    ],
    nsDelegation: true,
    api: {
      docs: "https://developer.dnsimple.com/v2/zones/records/",
      auth: "oauth",
      scope: "Full access, or a scoped token on an eligible plan",
      zoneScoped: false,
      /*
       * ⚠ THE CLEANEST OAUTH IN THE REGISTRY, AND THEREFORE THE ONE TO BUILD
       * FIRST. The token response carries `account_id`, which every other path
       * in their API needs — so the whole flow is two requests with nothing to
       * look up afterwards. Getting the adapter shape right here makes
       * Cloudflare, DigitalOcean, Vercel, Netlify and Linode mostly config.
       */
      oauth: {
        authorizeUrl: "https://dnsimple.com/oauth/authorize",
        tokenUrl: "https://api.dnsimple.com/v2/oauth/access_token",
        scopes: [],
      },
    },
    manualPath: "Domains → your domain → DNS → Manage records → Add record",
  },
  {
    slug: "domain-com",
    name: "Domain.com",
    kind: "registrar",
    nameserverPatterns: ["domain.com"],
    nsDelegation: true,
    api: null,
    manualPath: "My Domains → DNS & Nameservers → DNS Records → Add record",
  },
  {
    slug: "dynadot",
    name: "Dynadot",
    kind: "registrar",
    nameserverPatterns: ["dynadot.com"],
    nsDelegation: true,
    api: {
      docs: "https://www.dynadot.com/domain/api3.html",
      auth: "token",
      zoneScoped: false,
      // ⚠ `set_dns2` OVERWRITES THE WHOLE ZONE unless `add_dns_to_current_setting`
      // is passed. See ProviderApi.replacesZone.
      replacesZone: true,
    },
    manualPath: "My Domains → your domain → DNS Settings",
    unverified:
      "The documented record-type enum for set_dns2 does NOT include `ns`, so " +
      "subdomain delegation may be UI-only here. Verify before relying on the " +
      "API path for delegation.",
  },
  {
    slug: "easydns",
    name: "easyDNS",
    kind: "authoritative",
    nameserverPatterns: [
      "easydns.com",
      "easydns.net",
      "easydns.org",
      "easydns.info",
      "easydns.eu",
    ],
    nsDelegation: true,
    api: {
      docs: "https://docs.sandbox.rest.easydns.net/",
      auth: "basic",
      scope: "API token as username, API key as password",
      zoneScoped: false,
    },
    manualPath: "Domains → your domain → DNS → Add record",
    unverified:
      "Credentials are issued for the sandbox first and promotion to live " +
      "requires emailing easyDNS support — a one-time lead-time item for US, " +
      "not per customer.",
  },
  {
    slug: "enom",
    name: "Enom",
    kind: "registrar",
    nameserverPatterns: ["name-services.com", "enom.com"],
    nsDelegation: true,
    api: {
      docs: "https://cp.enom.com/api/API%20topics/api_SetHosts.htm",
      auth: "basic",
      zoneScoped: false,
      replacesZone: true,
      eligibility:
        "Reseller account required; retail customers cannot mint credentials.",
    },
    manualPath: "Domains → Manage Domains → Host Records",
  },
  {
    slug: "gandi",
    name: "Gandi",
    kind: "authoritative",
    nameserverPatterns: ["gandi.net", "gandi-ns.fr"],
    nsDelegation: true,
    api: {
      docs: "https://api.gandi.net/docs/livedns/",
      auth: "token",
      scope: "Personal Access Token — manage domain technical configurations",
      zoneScoped: false,
      // ⚠ `PUT /domains/{fqdn}/records` REPLACES THE WHOLE ZONE. The scoped
      // `PUT /domains/{fqdn}/records/{name}/{type}` upserts one rrset and is
      // what the adapter must use.
      replacesZone: true,
    },
    manualPath: "Domain → DNS Records → Add record",
  },
  {
    slug: "get-tech",
    name: "get.tech",
    kind: "registrar",
    /*
     * ⚠ A `.tech` TLD DOES NOT IMPLY get.tech IS THE DNS HOST, AND DETECTING ON
     * THE TLD WOULD BE WRONG FOR MOST `.tech` DOMAINS. `.tech` is a Radix gTLD
     * sold through every ordinary registrar; get.tech is only Radix's own
     * storefront. Detection is on nameservers, never on the suffix — and
     * get.tech's own default nameservers could not be established, so this row
     * matches essentially nothing and that is the honest outcome. An unmatched
     * `.tech` domain falls through to the manual delegation instructions, which
     * work regardless of who hosts it.
     */
    nameserverPatterns: [],
    nsDelegation: true,
    api: null,
    manualPath: "get.tech account → Domains → Manage → DNS → Add record",
    unverified:
      "Help pages refuse automated fetches (403), so neither the menu path nor " +
      "the default nameservers are confirmed, and no public customer DNS API " +
      "was found. Radix sells mainly through resellers, so any API is likely " +
      "reseller-scoped rather than per-customer.",
  },
  {
    slug: "godaddy",
    name: "GoDaddy",
    kind: "registrar",
    nameserverPatterns: ["domaincontrol.com", "godaddy.com"],
    nsDelegation: true,
    api: {
      docs: "https://developer.godaddy.com/en/docs/references/rest/domains/v1",
      auth: "key-secret",
      scope: "domains.dns:update",
      zoneScoped: false,
      /*
       * ⚠ `PUT /v1/domains/{domain}/records` WIPES THE ENTIRE ZONE. This is a
       * well-documented footgun that has destroyed people's DNS. The adapter
       * must use the scoped `PUT /v1/domains/{domain}/records/{type}/{name}`,
       * which replaces only that one name and type. `PATCH` appends without
       * deduplicating, so repeated calls create duplicate TXT records.
       */
      replacesZone: true,
      eligibility:
        "10 or more domains on the account, or an active Discount Domain Club plan.",
    },
    manualPath: "My Products → Domains → DNS → Add New Record",
    helpUrl: "https://www.godaddy.com/help/add-a-cname-record-19236",
  },
  {
    slug: "google-cloud-dns",
    name: "Google Cloud DNS",
    kind: "authoritative",
    /*
     * ⚠ THE NAMESERVERS LIVE ON `googledomains.com` EVEN THOUGH GOOGLE DOMAINS
     * THE REGISTRAR NO LONGER EXISTS. This pattern is Cloud DNS, which is very
     * much alive; the registrar was sold to Squarespace and the migration is
     * complete. Reading this pattern as "Google Domains" would send a Cloud DNS
     * customer to a company that cannot help them.
     */
    nameserverPatterns: ["googledomains.com"],
    nsDelegation: true,
    api: {
      docs: "https://docs.cloud.google.com/dns/docs/reference/rest/v1/resourceRecordSets/create",
      auth: "oauth",
      scope: "roles/dns.admin",
      zoneScoped: false,
      oauth: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/ndev.clouddns.readwrite"],
      },
    },
    manualPath: "Cloud DNS → your zone → Add standard → record set",
    unverified:
      "OAuth works but is not one-click: the customer must also supply a GCP " +
      "project id and have the Cloud DNS API enabled on it, and Google's app " +
      "verification applies.",
  },
  {
    slug: "google-public-dns",
    name: "Google Public DNS",
    /*
     * ⚠ A RESOLVER. IT HOSTS NOTHING. 8.8.8.8 answers queries about other
     * people's zones by walking the DNS tree; it holds no records and there is
     * nothing to connect to. People name it because it is what their laptop
     * resolves through, and the console's job is to say so and then ask who
     * their registrar is — not to offer a button that could not work.
     *
     * ⚠ NO NAMESERVER PATTERNS, ON PURPOSE. It can never appear in an NS record
     * set, so detection can never produce it. It is in the registry only so the
     * "who hosts your DNS?" picker can list it and correct the misconception.
     *
     * ⚠ IT IS STILL USEFUL TO US, AS A SECOND OPINION ON PROPAGATION. Its DoH
     * endpoint bypasses our own resolver cache, which is exactly what a
     * "have the records landed yet" check needs. Read-only, never a write
     * target.
     */
    kind: "resolver",
    nameserverPatterns: [],
    nsDelegation: false,
    api: null,
    helpUrl: "https://developers.google.com/speed/public-dns/docs/using",
  },
  {
    slug: "hetzner",
    name: "Hetzner",
    kind: "authoritative",
    nameserverPatterns: [
      "ns.hetzner.com",
      "ns.hetzner.de",
      "your-server.de",
      "second-ns.com",
      "second-ns.de",
    ],
    nsDelegation: true,
    api: {
      docs: "https://dns.hetzner.com/api-docs",
      auth: "token",
      scope: "Auth-API-Token from the DNS Console",
      zoneScoped: false,
    },
    manualPath: "Hetzner DNS Console → your zone → Add record",
    unverified:
      "Hetzner DNS Console and Hetzner Cloud are different products with " +
      "different APIs; their tokens are not interchangeable, and a Cloud token " +
      "pasted here fails in a way that looks like a bad credential.",
  },
  {
    slug: "hostgator",
    name: "HostGator",
    kind: "registrar",
    nameserverPatterns: ["hostgator.com", "websitewelcome.com"],
    nsDelegation: true,
    api: null,
    manualPath: "cPanel → Zone Editor → Manage → Add Record",
  },
  {
    slug: "hover",
    name: "Hover",
    kind: "registrar",
    nameserverPatterns: ["hover.com"],
    nsDelegation: true,
    /*
     * ⚠ THE UNDOCUMENTED ENDPOINT UNDER hover.com/api IS DELIBERATELY NOT USED.
     * Community clients have reverse-engineered it; it is explicitly
     * unsupported, it can change without notice, and building a customer's mail
     * setup on it means their DNS breaks on somebody else's deploy.
     */
    api: null,
    manualPath: "Your domain → DNS → Add a record",
    unverified: "Hover is Tucows-owned; some zones answer with ns1-3.tucows.com.",
  },
  {
    slug: "ionos",
    name: "IONOS",
    kind: "registrar",
    nameserverPatterns: ["ui-dns.com", "ui-dns.de", "ui-dns.org", "ui-dns.biz"],
    nsDelegation: true,
    api: {
      docs: "https://developer.hosting.ionos.com/docs/dns",
      auth: "token",
      scope: "X-API-Key, minted at developer.hosting.ionos.com/keys",
      zoneScoped: false,
    },
    manualPath: "Domains & SSL → your domain → DNS → Add record",
  },
  {
    slug: "linode",
    name: "Linode (Akamai)",
    kind: "authoritative",
    nameserverPatterns: ["linode.com"],
    nsDelegation: true,
    api: {
      docs: "https://techdocs.akamai.com/linode-api/reference/post-domain-record",
      auth: "oauth",
      scope: "domains:read_write",
      zoneScoped: false,
      oauth: {
        authorizeUrl: "https://login.linode.com/oauth/authorize",
        tokenUrl: "https://login.linode.com/oauth/token",
        scopes: ["domains:read_write"],
      },
    },
    manualPath: "Domains → your domain → Add a record",
    unverified: "The exact OAuth endpoint URLs were not confirmed against a live flow.",
  },
  {
    slug: "markmonitor",
    name: "MarkMonitor",
    kind: "registrar",
    nameserverPatterns: ["markmonitor.com"],
    nsDelegation: true,
    api: null,
    manualPath: "Managed by your corporate domain administrator.",
  },
  {
    slug: "name-com",
    name: "Name.com",
    kind: "registrar",
    nameserverPatterns: ["name.com"],
    nsDelegation: true,
    api: {
      docs: "https://docs.name.com/api/v1",
      auth: "basic",
      scope: "Username plus API token",
      zoneScoped: false,
    },
    manualPath: "My Domains → your domain → DNS Records → Add record",
    unverified:
      "The v4 API is deprecated in favour of the Core API. If the account has " +
      "2FA on, API access must be separately enabled under Account Settings → " +
      "Security, which otherwise presents as an invalid credential.",
  },
  {
    slug: "namecheap",
    name: "Namecheap",
    kind: "registrar",
    /*
     * ⚠ FOUR PREFIXES ON ONE SUFFIX, AND THEY MEAN DIFFERENT PRODUCTS. `dns1/2`
     * is the free BasicDNS, `pdns1/2` is PremiumDNS (UltraDNS underneath),
     * `freedns*` is FreeDNS, and `edns*` is their own corporate zone. All four
     * are Namecheap as far as the customer is concerned, which is what the
     * button says.
     */
    nameserverPatterns: ["registrar-servers.com"],
    nsDelegation: true,
    api: {
      docs: "https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/",
      auth: "key-secret",
      zoneScoped: false,
      /*
       * ⚠ `setHosts` REPLACES EVERY HOST RECORD ON THE DOMAIN. There is no
       * add-one-record call. A read-modify-write is mandatory, it races against
       * the customer editing in their own UI, and a half-completed write has
       * deleted their mail. This is the single most dangerous adapter in the
       * registry.
       */
      replacesZone: true,
      eligibility: "20+ domains, or a $50 balance, or $50 spent in the last two years.",
      /*
       * ⚠ AN INFRASTRUCTURE CONSTRAINT WE HAVE NOT MET. Namecheap pins API
       * access to IPv4 addresses registered in the account — so this works only
       * if our egress is static AND each customer allowlists our addresses.
       * Until that is decided, the connect flow for Namecheap should offer
       * delegation and say plainly why.
       */
      ipAllowlist: true,
    },
    manualPath: "Domain List → Manage → Advanced DNS → Add New Record",
    helpUrl:
      "https://www.namecheap.com/support/knowledgebase/article.aspx/579/2237/which-record-type-option-should-i-choose-for-the-information-im-about-to-enter/",
  },
  {
    slug: "namesilo",
    name: "NameSilo",
    kind: "registrar",
    // ⚠ `dnsowl.com`, NOT `namesilo.com`. NameSilo's nameservers are branded
    // differently from the company — exactly the kind of thing that makes
    // detection look broken if you assume the obvious pattern.
    nameserverPatterns: ["dnsowl.com", "namesilo.com"],
    nsDelegation: true,
    api: {
      docs: "https://www.namesilo.com/api-reference/pages?uid=dns/dns-add-record",
      auth: "token",
      zoneScoped: false,
    },
    manualPath: "Manage My Domains → your domain → Update DNS records",
    unverified:
      "Whether the record-type dropdown offers NS for a subdomain was not " +
      "confirmed — test before treating NameSilo as a delegation target. " +
      "Also: the API key travels in the URL QUERY STRING, so it lands in access " +
      "logs and proxies; scrub it from our own logging.",
  },
  {
    slug: "netlify",
    name: "Netlify",
    kind: "authoritative",
    /*
     * ⚠ BOTH PATTERNS, AND THE `nsone.net` ONE IS SHARED WITH NS1 ITSELF.
     * Netlify DNS runs on NS1's infrastructure, so a Netlify zone answers with
     * `ns01.netlifydns.com` AND `dns1.p04.nsone.net`. `backendFor` on the NS1
     * row is what stops the tie being resolved in NS1's favour.
     */
    nameserverPatterns: ["netlifydns.com", "netlify.com"],
    nsDelegation: true,
    api: {
      docs: "https://docs.netlify.com/api/get-started/",
      auth: "oauth",
      zoneScoped: false,
      oauth: {
        authorizeUrl: "https://app.netlify.com/authorize",
        tokenUrl: "https://api.netlify.com/oauth/token",
        scopes: [],
      },
    },
    manualPath: "Domains → your domain → DNS records → Add new record",
    unverified:
      "There is no update endpoint — a change is delete-then-recreate, which " +
      "means a window where the record does not exist. Personal access tokens " +
      "and team-owned zones interact badly (401 on an apparently valid token).",
  },
  {
    slug: "network-solutions",
    name: "Network Solutions",
    kind: "registrar",
    nameserverPatterns: ["worldnic.com", "netsol.com"],
    nsDelegation: true,
    api: null,
    manualPath:
      "Account Manager → My Domain Names → Manage → Change Where Domain Points → Advanced DNS",
  },
  {
    slug: "njalla",
    name: "Njalla",
    kind: "registrar",
    nameserverPatterns: ["njalla.no", "njalla.in", "njalla.fo", "njal.la"],
    nsDelegation: true,
    api: {
      docs: "https://njal.la/api/",
      auth: "token",
      scope: "Token scoped by allowed_domains, allowed_methods and allowed_types",
      zoneScoped: true,
    },
    manualPath: "Njalla → Domains → your domain → Records → Add",
    unverified:
      "Method names are from community clients; the official reference is " +
      "behind a login. Njalla's users are privacy-maximalist by definition and " +
      "are the least likely cohort here to paste a token into a SaaS — lead " +
      "with delegation.",
  },
  {
    slug: "no-ip",
    name: "No-IP",
    kind: "authoritative",
    nameserverPatterns: ["no-ip.com"],
    // ⚠ ONLY ON THE PAID MANAGED DNS TIERS. A free `*.ddns.net` hostname is a
    // subdomain of No-IP's OWN zone and cannot be delegated at all.
    nsDelegation: true,
    api: {
      docs: "https://developer.noip.com",
      auth: "basic",
      zoneScoped: false,
    },
    manualPath: "My Services → DNS Records → Modify",
    unverified: "The v2 API base URL and auth scheme were not confirmed.",
  },
  {
    slug: "ns1",
    name: "NS1 (IBM)",
    kind: "authoritative",
    nameserverPatterns: ["nsone.net"],
    /*
     * ⚠ NS1 IS THE BACKEND FOR THREE OTHER PROVIDERS IN THIS FILE, AND WITHOUT
     * THIS DECLARATION IT WOULD WIN MOST OF THEIR DETECTIONS. Netlify, Wix and
     * Squarespace all serve customer zones from NS1 shards, so `dns1.p04.nsone.net`
     * appears alongside the branded hostname. A customer sent to NS1's
     * dashboard because their Netlify site is NS1-backed has been given an
     * answer that is technically true and completely useless.
     */
    isBackend: true,
    backendFor: ["netlify", "wix", "squarespace"],
    nsDelegation: true,
    api: {
      docs: "https://www.ibm.com/docs/en/ns1-connect?topic=introduction-using-api",
      auth: "token",
      scope: "X-NSONE-Key",
      zoneScoped: false,
    },
    manualPath: "NS1 portal → Zones → your zone → Add record",
  },
  {
    slug: "opensrs",
    name: "Tucows / OpenSRS",
    kind: "registrar",
    nameserverPatterns: ["systemdns.com", "trs-dns.com", "trs-dns.net", "tucows.com"],
    nsDelegation: true,
    api: {
      docs: "https://domains.opensrs.guide/docs/set_dns_zone-",
      auth: "key-secret",
      zoneScoped: false,
      replacesZone: true,
      eligibility: "Reseller account required; end customers hold no credentials.",
    },
    manualPath: "Varies by reseller — OpenSRS is white-labelled.",
  },
  {
    slug: "ovh",
    name: "OVHcloud",
    kind: "registrar",
    nameserverPatterns: ["ovh.net", "ovh.ca", "anycast.me"],
    nsDelegation: true,
    api: {
      docs: "https://docs.ovhcloud.com/en/guides/manage-and-operate/api/first-steps",
      auth: "key-secret",
      scope: "Consumer key granting specific method+path rules",
      zoneScoped: false,
    },
    manualPath: "Web Cloud → Domain names → your domain → DNS zone → Add an entry",
    unverified:
      "Two things the adapter must not miss: requests are signed with SHA-1 " +
      "over a concatenated string (X-Ovh-Signature), and a change does NOT go " +
      "live until POST /domain/zone/{zone}/refresh. Omitting the refresh " +
      "produces records that exist in the panel and resolve nowhere.",
  },
  {
    slug: "porkbun",
    name: "Porkbun",
    kind: "registrar",
    // Nameservers are named after Brazilian cities — curitiba, fortaleza,
    // maceio, salvador — under one suffix.
    nameserverPatterns: ["ns.porkbun.com", "porkbun.com"],
    nsDelegation: true,
    api: {
      docs: "https://porkbun.com/api/json/v3/documentation",
      auth: "key-secret",
      zoneScoped: false,
      eligibility:
        "API access is opt-in PER DOMAIN in the Porkbun panel, not per account.",
    },
    manualPath: "Domain Management → your domain → DNS → Add record",
    unverified:
      "Best-designed small-registrar API here: retrieveByNameType / " +
      "editByNameType / deleteByNameType make idempotent upserts of _dmarc and " +
      "DKIM selectors clean. The API host moved to api.porkbun.com in 2025.",
  },
  {
    slug: "quad9",
    name: "Quad9",
    /*
     * ⚠ A RESOLVER, LIKE GOOGLE PUBLIC DNS, AND HERE FOR THE SAME REASON.
     * 9.9.9.9 is a filtering recursive resolver. It hosts no zones, it cannot
     * hold a TXT record, and a customer who says "I use Quad9" is telling us
     * about their network settings. Listed so the picker can say exactly that.
     */
    kind: "resolver",
    nameserverPatterns: [],
    nsDelegation: false,
    api: null,
    helpUrl:
      "https://quad9.net/news/blog/what-s-the-difference-between-recursive-dns-and-authoritative-dns-2022/",
  },
  {
    slug: "rackspace",
    name: "Rackspace",
    kind: "authoritative",
    nameserverPatterns: ["stabletransit.com", "rackspace.com"],
    nsDelegation: true,
    api: {
      docs: "https://docs.rackspace.com/reference/cloud-dns-records-operations",
      auth: "token",
      scope: "X-Auth-Token from the identity service",
      zoneScoped: false,
    },
    manualPath: "Cloud DNS → your domain → Add record",
    unverified:
      "Most writes are asynchronous and return a job to poll. Rackspace has " +
      "been de-emphasising Cloud DNS; its current deprecation status is unclear.",
  },
  {
    slug: "register-com",
    name: "Register.com",
    kind: "registrar",
    nameserverPatterns: ["register.com"],
    nsDelegation: true,
    api: null,
    manualPath: "Account → Domains → Manage → Advanced Technical Settings",
  },
  {
    slug: "route53",
    name: "Amazon Route 53",
    kind: "authoritative",
    /*
     * ⚠ FOUR TLDs, BECAUSE ROUTE 53 DELIBERATELY SPREADS A ZONE'S FOUR
     * NAMESERVERS ACROSS FOUR TOP-LEVEL DOMAINS — one `.com`, one `.net`, one
     * `.org`, one `.co.uk`. Matching only `awsdns` under `.com` identifies a
     * quarter of the answer and reports `partial` for every Route 53 zone in
     * existence.
     */
    /*
     * ⚠ A REGEX, NOT A SUFFIX, AND THE TEST SUITE IS WHY. The hostnames are
     * `ns-264.awsdns-33.com` — the identifying part is the `awsdns-NN` LABEL,
     * not a suffix, so `awsdns.com` matches nothing at all and a bare `.com`
     * would match every nameserver on the internet. See `nameserverRegex`.
     */
    nameserverPatterns: [],
    nameserverRegex: [/^ns-\d{1,4}\.awsdns-\d{2}\.(com|net|org|co\.uk)$/],
    nsDelegation: true,
    api: {
      docs: "https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html",
      auth: "sigv4",
      scope:
        "route53:ListHostedZonesByName, ListResourceRecordSets, " +
        "ChangeResourceRecordSets, GetChange",
      zoneScoped: true,
    },
    manualPath: "Route 53 → Hosted zones → your zone → Create record",
    helpUrl:
      "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
    unverified:
      "⚠ NEVER ASK FOR A PASTED ACCESS KEY AND SECRET. The correct shape for a " +
      "SaaS is cross-account role assumption: the customer launches a " +
      "CloudFormation stack creating a role that trusts our account with an " +
      "ExternalId, and we sts:AssumeRole into it. Also: a private hosted zone " +
      "with the same name will shadow the public one unless the lookup filters " +
      "on Config.PrivateZone == false.",
  },
  {
    slug: "shopify",
    name: "Shopify",
    kind: "registrar",
    /*
     * ⚠ SHOPIFY PUBLISHES NO CUSTOMER NAMESERVER SET, SO NS DETECTION CANNOT
     * FIND IT — and that is a property of Shopify rather than a gap here. Their
     * own guidance for a third-party domain is to KEEP the registrar's
     * nameservers and add an A record, so a Shopify store's NS set belongs to
     * GoDaddy or Route 53 or whoever the merchant actually uses. Spot checks of
     * well-known stores confirmed exactly that.
     *
     * ⚠ AND SHOPIFY'S OWN PROPERTIES ARE ON CLOUDFLARE FOUNDATION DNS, which is
     * Shopify corporate and emphatically not a customer signal.
     */
    nameserverPatterns: [],
    detect: {
      apexA: ["23.227.38.65"],
      cname: ["shops.myshopify.com"],
    },
    /*
     * ⚠ SHOPIFY'S DNS PANEL OFFERS A, AAAA, CNAME, MX, TXT AND SRV — AND NO NS.
     * Delegation is therefore impossible on a Shopify-managed domain, and
     * telling somebody to look for an NS row would send them hunting for a
     * control that is not there. The console routes these to the manual path,
     * or to moving DNS to a real host.
     */
    nsDelegation: false,
    api: null,
    manualPath: "Settings → Domains → your domain → Domain settings → Edit DNS",
    unverified:
      "The nameservers assigned to a domain BOUGHT through Shopify were not " +
      "established. The Admin GraphQL API exposes shop.domains as read-only " +
      "metadata and has no record management, and there is no DNS OAuth scope.",
  },
  {
    slug: "squarespace",
    name: "Squarespace Domains",
    kind: "registrar",
    /*
     * ⚠ NOTE THE ZERO PADDING: `ns01.squarespacedns.com`, NOT `ns1`. The
     * unpadded form does not resolve, and a pattern written from memory would
     * match nothing while looking obviously correct.
     *
     * ⚠ THIS ROW ABSORBS GOOGLE DOMAINS, WHICH NO LONGER EXISTS. Google sold
     * the registrar to Squarespace in September 2023 and the migration of all
     * ~10M domains is complete; domains.google.com is gone. Some migrated zones
     * still answer with `ns-cloud-*.googledomains.com` because their owner
     * chose Cloud DNS — those correctly detect as google-cloud-dns, which is
     * where their records actually live.
     */
    nameserverPatterns: ["squarespacedns.com"],
    nsDelegation: true,
    /*
     * ⚠ SQUARESPACE'S DEVELOPER PLATFORM IS COMMERCE-ONLY. Its OAuth scopes are
     * orders, inventory, products and transactions — there is no DNS scope and
     * no DNS API. Delegation or manual, and nothing else.
     */
    api: null,
    manualPath: "Settings → Domains → your domain → DNS Settings → Add record",
    helpUrl:
      "https://support.squarespace.com/hc/en-us/articles/17131164996365-About-the-Google-Domains-migration-to-Squarespace",
  },
  {
    slug: "ultradns",
    name: "Vercara UltraDNS",
    kind: "authoritative",
    nameserverPatterns: [
      "ultradns.com",
      "ultradns.net",
      "ultradns.org",
      "ultradns.biz",
    ],
    // Also the backend behind Namecheap PremiumDNS, which answers with
    // `pdns*.registrar-servers.com` rather than an UltraDNS hostname.
    isBackend: true,
    backendFor: ["namecheap"],
    nsDelegation: true,
    api: {
      docs: "https://docs.vercara.com/ultradns-rest-api",
      auth: "token",
      zoneScoped: false,
    },
    manualPath: "UltraDNS portal → Zones → your zone → Add record",
  },
  {
    slug: "vercel",
    name: "Vercel",
    kind: "authoritative",
    nameserverPatterns: ["vercel-dns.com"],
    nsDelegation: true,
    api: {
      docs: "https://vercel.com/docs/rest-api/reference/endpoints/dns/create-a-dns-record",
      auth: "oauth",
      zoneScoped: false,
      oauth: {
        authorizeUrl: "https://vercel.com/oauth/authorize",
        tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
        scopes: [],
      },
    },
    manualPath: "Project → Settings → Domains → your domain → DNS Records",
    unverified: "The exact OAuth endpoint URLs were not confirmed against a live flow.",
  },
  {
    slug: "wix",
    name: "Wix",
    kind: "registrar",
    nameserverPatterns: ["wixdns.net"],
    /*
     * ⚠ ONLY FOR DOMAINS CONNECTED TO WIX *BY NAMESERVERS*. A domain connected
     * "by pointing" is not managed by Wix DNS at all — its records live at the
     * registrar — so the Wix panel is the wrong place to look and the customer
     * will not find a record editor there.
     */
    nsDelegation: true,
    api: {
      docs: "https://dev.wix.com/docs/api-reference/account-level/domains/domain-dns/introduction",
      auth: "token",
      scope: "Account-level API key (a child-account key is not sufficient)",
      zoneScoped: false,
    },
    manualPath: "Domains → your domain → Advanced → Edit DNS → Add record",
    unverified:
      "Wix's Domain DNS API manages zones that live in Google Cloud DNS " +
      "underneath, and is API-key gated rather than OAuth — so there is no " +
      "one-click connect. Limit of 50 values per record type.",
  },
]

/** Slug → provider. Built once; the registry is static. */
export const BY_SLUG: ReadonlyMap<string, DnsProvider> = new Map(
  PROVIDERS.map((p) => [p.slug, p]),
)
