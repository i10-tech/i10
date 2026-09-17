/**
 * What i10 knows about the places a customer's DNS can live.
 *
 * ⚠ THE REGISTRY IS DATA, AND THE THING THAT MAKES IT USEFUL IS THE DETECTION
 * MAP. A person adding `acme.com` does not know or care who hosts their DNS —
 * they know the name of a company they pay. We resolve the apex's NS records
 * live, match the hostnames against the patterns here, and put that company's
 * name and mark on the screen next to the records they have to publish. That
 * one step is the difference between "add these six TXT records" and "click
 * Connect".
 *
 * ⚠ AND THE DISTINCTION BETWEEN A RESOLVER AND AN AUTHORITATIVE HOST IS LOAD-
 * BEARING, NOT PEDANTRY. People say "my DNS is Google" or "I use Quad9" meaning
 * the resolver their laptop is pointed at. A resolver holds nobody's records
 * and cannot publish one; offering a "Connect Google Public DNS" button would
 * be offering something that cannot exist. The registry marks them `resolver`
 * and the console explains the difference rather than failing later.
 */

export type ProviderKind =
  /** Hosts zones. Can hold the records we need. The only kind we can connect. */
  | "authoritative"
  /** Answers queries for other people's zones. Holds nothing. */
  | "resolver"
  /**
   * Sells domains and usually resells somebody's DNS. Whether we can write
   * records depends entirely on which, so these carry a `delegatesTo` note.
   */
  | "registrar"

export type AuthMethod =
  /** A single bearer token. The easy case. */
  | "token"
  /** Two fields: an id and a secret. */
  | "key-secret"
  /** AWS SigV4. Needs an access key, a secret and a region. */
  | "sigv4"
  /** A real OAuth 2.0 authorization-code flow. The only one-click case. */
  | "oauth"
  /** Basic auth over HTTPS. Rare, and noted where it happens. */
  | "basic"

export interface ProviderApi {
  /** Where the developer docs live. Shown in the connect dialog. */
  docs: string
  auth: AuthMethod
  /**
   * The write endpoint replaces the WHOLE zone or the whole record set rather
   * than adding one record.
   *
   * ⚠ THIS IS THE MOST DANGEROUS FLAG IN THE REGISTRY AND IT IS NOT ADVISORY.
   * GoDaddy's `PUT /records`, Namecheap's `setHosts`, Gandi's `PUT /records`,
   * Dynadot's `set_dns2`, Enom's `SetHosts` and OpenSRS's `set_dns_zone` all
   * REPLACE EVERYTHING. A naive "add a DKIM record" against any of them deletes
   * the customer's MX records — their mail stops, and it stops because of us.
   * An adapter for a provider marked here must read, merge and write back under
   * a lock, or use the scoped per-record endpoint where one exists.
   */
  replacesZone?: boolean
  /**
   * The provider refuses API access below an account-size or spend threshold.
   *
   * ⚠ IT PRESENTS AS A CREDENTIAL ERROR, WHICH IS WHY IT IS WORTH A FIELD.
   * GoDaddy answers `ACCESS_DENIED` and Namecheap simply refuses the key, so a
   * customer with a perfectly good token concludes they typed it wrong and
   * tries three more times. The connect dialog states the threshold up front
   * and offers delegation instead.
   */
  eligibility?: string
  /**
   * Calls must come from an IP the customer has registered with the provider.
   *
   * ⚠ AN INFRASTRUCTURE CONSTRAINT, NOT A CONFIGURATION ONE. Namecheap pins API
   * access to registered IPv4 addresses, so this only works at all if our
   * egress is static and the customer allowlists it.
   */
  ipAllowlist?: boolean
  /**
   * The exact permission a token needs, in the provider's own words.
   *
   * ⚠ QUOTED VERBATIM FROM THEIR UI, NOT PARAPHRASED. A person is about to go
   * and create a token in a screen we do not control; "Zone → DNS → Edit" is
   * something they can match against what is in front of them, and "DNS write
   * access" is something they have to interpret.
   */
  scope?: string
  /**
   * Whether a token can be restricted to one zone.
   *
   * ⚠ SURFACED IN THE UI, BECAUSE IT IS THE CUSTOMER'S RISK AND NOT OURS TO
   * QUIETLY ACCEPT. A DNS credential can rewrite MX records and take delivery
   * of somebody's mail. Where a provider only issues account-wide tokens the
   * dialog says so in plain words rather than implying a narrower blast radius
   * than exists.
   */
  zoneScoped?: boolean
  /** Filled in only where a genuine third-party OAuth app is possible. */
  oauth?: {
    authorizeUrl: string
    tokenUrl: string
    scopes: string[]
  }
}

export interface DnsProvider {
  /** Stable id. Stored in `core.dns_connections.provider`; never renamed. */
  slug: string
  name: string
  kind: ProviderKind

  /**
   * Authoritative nameserver hostnames, lowercased, without a trailing dot.
   *
   * ⚠ MATCHED AS A SUFFIX ON A LABEL BOUNDARY, NEVER AS A SUBSTRING. See
   * `detectProvider`: a plain `includes()` would match `notcloudflare.com` for
   * the pattern `cloudflare.com`, and an attacker who can name their own
   * nameserver can therefore choose which "Connect" button we show a customer.
   */
  nameserverPatterns: string[]

  /**
   * For the providers a suffix cannot express.
   *
   * ⚠ IT EXISTS FOR ROUTE 53 AND SHOULD STAY RARE. Its nameservers look like
   * `ns-264.awsdns-33.com` — the distinguishing part is a label PREFIX
   * (`awsdns-`) inside a hostname whose suffix is a bare `.com`, and a suffix
   * pattern therefore either matches nothing (`awsdns.com`) or matches every
   * `.com` nameserver on the internet. A suffix match would have silently
   * failed to detect the second-largest DNS host in the registry, which is
   * exactly what the test suite caught.
   *
   * ⚠ EVERY REGEX HERE IS OURS, ANCHORED AT BOTH ENDS, AND NEVER BUILT FROM
   * INPUT. They are matched against a hostname a resolver returned, so an
   * unanchored or catastrophically backtracking pattern would be a denial of
   * service reachable from a domain name somebody types into the onboarding
   * form. Anchored, with no nested quantifiers, they are linear.
   */
  nameserverRegex?: RegExp[]

  /**
   * Whether a customer can publish NS records on a SUBDOMAIN here, which is
   * what i10's delegation needs.
   *
   * ⚠ ALMOST EVERY AUTHORITATIVE HOST CAN, AND THE EXCEPTIONS ARE THE WHOLE
   * REASON THE FLAG EXISTS. Some site builders (Wix, Squarespace's own DNS in
   * places, several shared hosts) expose a record editor that offers A, CNAME,
   * MX and TXT and simply has no NS option. Delegation is then impossible
   * whatever the underlying software supports, and offering it would send
   * somebody hunting for a control that is not there.
   */
  nsDelegation: boolean

  /** Null where there is no usable public API for DNS records. */
  api: ProviderApi | null

  /**
   * The path a person clicks to add a record by hand, in the provider's own
   * words. Rendered verbatim in the manual instructions.
   */
  manualPath?: string

  /** Where the provider documents adding DNS records. */
  helpUrl?: string

  /** For registrars that resell somebody else's DNS. The slug they resell. */
  delegatesTo?: string

  /**
   * ⚠ ANYTHING WE COULD NOT CONFIRM FROM THE PROVIDER'S OWN DOCUMENTATION.
   * Rendered nowhere; it exists so the next person to touch this file knows
   * which rows were verified and which were inferred, rather than trusting all
   * of them equally.
   */
  unverified?: string

  /**
   * Another provider whose nameserver patterns this one's zones also match.
   *
   * ⚠ IT EXISTS FOR NS1, WHICH SERVES NETLIFY, WIX AND SQUARESPACE. A Netlify
   * zone answers with BOTH `ns01.netlifydns.com` and `dns1.p04.nsone.net`, so a
   * naive longest-match would report NS1 for a large share of Netlify customers
   * — and send them to the wrong dashboard. `detectProvider` resolves it by
   * preferring any provider that is not somebody else's backend when both
   * appear in the same set. Declaring the relationship here keeps the rule out
   * of the matching code.
   */
  backendFor?: string[]

  /**
   * Whether this provider is somebody else's white-label DNS backend.
   *
   * ⚠ A PROVIDER MARKED HERE LOSES A TIE. See `backendFor`.
   */
  isBackend?: boolean

  /**
   * Detection signals that are not nameservers.
   *
   * ⚠ SHOPIFY HAS NO CUSTOMER-FACING NAMESERVER SET AT ALL. Its own guidance is
   * to keep the registrar's nameservers and point an A record at 23.227.38.65,
   * so a Shopify store is invisible to NS-based detection by construction. The
   * apex A record and the `www` CNAME are the only signals there are.
   */
  detect?: {
    apexA?: string[]
    cname?: string[]
  }
}

export interface DetectionResult {
  provider: DnsProvider | null
  /** The nameservers the lookup actually returned. Shown either way. */
  nameservers: string[]
  /**
   * `exact` — one provider matched every nameserver.
   * `partial` — one matched some of them. Usually mid-migration.
   * `none` — nothing matched; we show the raw nameservers and the manual path.
   */
  confidence: "exact" | "partial" | "none"
}
