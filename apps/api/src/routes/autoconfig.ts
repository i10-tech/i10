import { Hono } from "hono"
import { buildMobileConfig, profileFilename } from "../autoconfig/apple-profile.js"

export interface AutoconfigDeps {
  /** The domains i10 hosts mail for — `env.MAIL_DOMAINS`. */
  hostedDomains: readonly string[]
  /** The public name of the mail server, e.g. `mail.i10.tech`. */
  mailHost: string
  imapPort: number
  smtpPort: number
  organization: string
}

/**
 * Client provisioning.
 *
 * Thunderbird and Outlook are served by Stalwart itself, which generates
 * autoconfig XML and autodiscover responses from its own listener list — see
 * `infra/k8s/i10/stalwart/`. Only Apple needs something written by hand, so
 * only Apple is here.
 *
 * ⚠ DELIBERATELY OUTSIDE THE OPENAPI DOCUMENT, for the same reason
 * `/webhooks` is. `api.i10.tech` publishes the transactional sending contract,
 * and every path in that document becomes a method on five generated SDKs.
 * This endpoint provisions a MAILBOX — a different product surface with a
 * different audience — and an `i10.autoconfig.appleMobileconfig()` in the Node
 * SDK would be noise at best.
 *
 * ⚠ AND DELIBERATELY UNAUTHENTICATED. The profile contains no password (see
 * apple-profile.ts) and no fact that is not already public in DNS: the
 * hostnames are in the SRV records, the ports are in the autoconfig XML, and
 * the address was typed by whoever is asking. Requiring a session would mean a
 * user cannot set up mail on a phone before they can read mail on it.
 *
 * What it does NOT do is confirm the mailbox exists. It answers identically for
 * a real address and an invented one, so it cannot be used to enumerate who
 * holds an account here. The domain check below is a correctness gate — we
 * cannot describe an IMAP server for a domain we do not run — not a privacy
 * one.
 */
export function createAutoconfig(deps?: AutoconfigDeps) {
  const app = new Hono()

  app.get("/apple.mobileconfig", (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Client provisioning is not configured.",
        },
        503,
      )
    }

    const email = (c.req.query("email") ?? "").trim().toLowerCase()

    // Deliberately loose. This is not the place to litigate RFC 5321 — the
    // address only has to be safe to embed and to have a domain we can check.
    // A rejection here should mean "that is not an email address", never "your
    // address is unusual".
    if (!/^[^\s@"'<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      return c.json(
        {
          statusCode: 400,
          name: "validation_error",
          message: "Pass `?email=` with the full address, e.g. you@i10.tech.",
        },
        400,
      )
    }

    const domain = email.slice(email.lastIndexOf("@") + 1)
    if (!deps.hostedDomains.includes(domain)) {
      // 404, not 403: there is no profile for this address because there is no
      // mail service behind it. 403 would imply one exists and is withheld.
      return c.json(
        {
          statusCode: 404,
          name: "not_found",
          message: `i10 does not host mail for ${domain}.`,
        },
        404,
      )
    }

    const profile = buildMobileConfig({
      email,
      imapHost: deps.mailHost,
      imapPort: deps.imapPort,
      smtpHost: deps.mailHost,
      smtpPort: deps.smtpPort,
      organization: deps.organization,
    })

    // ⚠ THE MIME TYPE IS WHAT MAKES THE FILE INSTALLABLE. Served as
    // text/xml or application/octet-stream, Safari on iOS shows the source or
    // saves it to Files, and no amount of tapping installs anything. This type
    // is what routes it to the profile installer.
    c.header("Content-Type", "application/x-apple-aspen-config")
    c.header("Content-Disposition", `attachment; filename="${profileFilename(email)}"`)
    // The profile is derived entirely from configuration, but a cached copy
    // outlives a port change, and the failure is a mail client that stops
    // connecting for reasons nobody can see.
    c.header("Cache-Control", "no-store")
    return c.body(profile)
  })

  return app
}
