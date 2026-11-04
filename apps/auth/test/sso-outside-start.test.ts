import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { NextRequest } from "next/server"

mock.module("server-only", () => ({}))

const { afterAuthUrl, allowedReturnUrl } = await import("../app/_lib/redirect")
const {
  confirmUrl,
  decideSsoEntry,
  loadInterstitial,
  MAX_START_FORM,
  readIss,
  readLoginHint,
  readStartForm,
  startedByUs,
  submittedFromHere,
} = await import("../app/_lib/sso-server")

const BIND = "https://localhost:3004"
const CONSOLE = "https://dash.i10.localhost"
const DEFAULT_AFTER = "https://dash.i10.localhost/home"
const ID = "0b9f6a52-3c1e-4c1a-9d57-2f6a4a0f1c11"
const OKTA_ISSUER = "https://integrator-2590605.okta.com"

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${BIND}${path}`, { headers })
}

describe("outside SSO starts and third-party initiated login", () => {
  let savedOrigins: string | undefined
  let savedDefault: string | undefined

  beforeEach(() => {
    savedOrigins = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS
    savedDefault = process.env.AUTH_DEFAULT_REDIRECT_URL
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = CONSOLE
    process.env.AUTH_DEFAULT_REDIRECT_URL = DEFAULT_AFTER
  })

  afterEach(() => {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = savedOrigins
    process.env.AUTH_DEFAULT_REDIRECT_URL = savedDefault
  })

  describe("startedByUs and submittedFromHere", () => {
    it("accepts same-origin, same-site, address-bar none, and missing Sec-Fetch-Site", () => {
      expect(startedByUs(req(`/sso/${ID}`, { "sec-fetch-site": "same-origin" }))).toBe(
        true,
      )
      expect(startedByUs(req(`/sso/${ID}`, { "sec-fetch-site": "same-site" }))).toBe(
        true,
      )
      expect(startedByUs(req(`/sso/${ID}`, { "sec-fetch-site": "none" }))).toBe(true)
      expect(startedByUs(req(`/sso/${ID}`))).toBe(true)
    })

    it("accepts cross-site only when our console is the exact Referer origin", () => {
      expect(
        startedByUs(
          req(`/sso/${ID}`, {
            "sec-fetch-site": "cross-site",
            referer: `${CONSOLE}/settings/security`,
          }),
        ),
      ).toBe(true)

      for (const referer of [
        undefined,
        `${OKTA_ISSUER}/app/UserHome`,
        "https://login.microsoftonline.com/",
        "https://dash.i10.localhost.evil.example/",
        "https://evildash.i10.localhost/",
        "not-a-valid-url",
      ]) {
        expect(
          startedByUs(
            req(`/sso/${ID}`, {
              "sec-fetch-site": "cross-site",
              ...(referer ? { referer } : {}),
            }),
          ),
        ).toBe(false)
      }
    })

    it("restricts POST submissions to same-origin non-framed requests", () => {
      expect(
        submittedFromHere(
          req("/sso/start", {
            "sec-fetch-site": "same-origin",
            "sec-fetch-dest": "document",
          }),
        ),
      ).toBe(true)
      // No Fetch Metadata: the form POST's Origin must be this host.
      expect(
        submittedFromHere(
          req("/sso/start", { origin: BIND, host: new URL(BIND).host }),
        ),
      ).toBe(true)
      expect(
        submittedFromHere(
          req("/sso/start", {
            origin: "https://evil.example",
            host: new URL(BIND).host,
          }),
        ),
      ).toBe(false)
      expect(submittedFromHere(req("/sso/start"))).toBe(false)

      // Even our console Referer cannot make a cross-site POST start a flow.
      expect(
        submittedFromHere(
          req("/sso/start", {
            "sec-fetch-site": "cross-site",
            referer: `${CONSOLE}/`,
          }),
        ),
      ).toBe(false)
      expect(
        submittedFromHere(req("/sso/start", { "sec-fetch-site": "same-site" })),
      ).toBe(false)
      expect(submittedFromHere(req("/sso/start", { "sec-fetch-site": "none" }))).toBe(
        false,
      )
      for (const dest of ["iframe", "frame", "embed", "object"]) {
        expect(
          submittedFromHere(
            req("/sso/start", {
              "sec-fetch-site": "same-origin",
              "sec-fetch-dest": dest,
            }),
          ),
        ).toBe(false)
      }
    })
  })

  describe("parameter validation: login_hint, iss, and target_link_uri", () => {
    it("normalizes valid login_hint emails and drops malformed ones", () => {
      expect(readLoginHint("  Ada.Lovelace@Acme.com ")).toBe("ada.lovelace@acme.com")
      expect(readLoginHint(["Ada@Acme.com"])).toBe("ada@acme.com")

      expect(readLoginHint(undefined)).toBeNull()
      expect(readLoginHint("")).toBeNull()
      expect(readLoginHint("not-an-email")).toBeNull()
      expect(readLoginHint("two@@acme.com")).toBeNull()
      expect(readLoginHint("@acme.com")).toBeNull()
      expect(readLoginHint("ada@")).toBeNull()
      expect(readLoginHint("ada lovelace@acme.com")).toBeNull()
      expect(readLoginHint("ada\u0000@acme.com")).toBeNull()
      expect(readLoginHint("ada\n@acme.com")).toBeNull()
      expect(readLoginHint(`${"a".repeat(250)}@acme.com`)).toBeNull()
      expect(readLoginHint(["a@acme.com", "b@acme.com"])).toBeNull()
    })

    it("distinguishes absent, present, and malformed iss values", () => {
      expect(readIss(undefined)).toEqual({ kind: "absent" })
      expect(readIss([])).toEqual({ kind: "absent" })
      expect(readIss([OKTA_ISSUER])).toEqual({
        kind: "present",
        value: OKTA_ISSUER,
      })
      expect(readIss([""])).toEqual({ kind: "invalid" })
      expect(readIss([OKTA_ISSUER, "https://other.okta.com"])).toEqual({
        kind: "invalid",
      })
      expect(readIss([`https://${"a".repeat(2050)}.okta.com`])).toEqual({
        kind: "invalid",
      })
    })

    it("passes target_link_uri through the afterAuthUrl allowlist and drops anything else", () => {
      expect(allowedReturnUrl(`${CONSOLE}/billing?plan=pro`)).toBe(
        `${CONSOLE}/billing?plan=pro`,
      )
      expect(allowedReturnUrl("https://evil.example/phish")).toBeNull()
      expect(allowedReturnUrl("http://dash.i10.localhost/billing")).toBeNull()
      expect(allowedReturnUrl("/relative/path")).toBeNull()
      expect(allowedReturnUrl("//evil.example/path")).toBeNull()
      expect(allowedReturnUrl("javascript:alert(1)")).toBeNull()
      expect(allowedReturnUrl("https://user:pw@dash.i10.localhost/billing")).toBeNull()
      expect(afterAuthUrl("https://evil.example/phish")).toBe(DEFAULT_AFTER)
    })
  })

  describe("decideSsoEntry decision table", () => {
    const tile = `/sso/${ID}?iss=${encodeURIComponent(OKTA_ISSUER)}&login_hint=Ada%40Acme.com&target_link_uri=${encodeURIComponent(`${CONSOLE}/projects`)}`

    it("sends a cross-site arrival without our Referer to the interstitial, params validated", () => {
      const request = req(tile, {
        "sec-fetch-site": "cross-site",
        referer: `${OKTA_ISSUER}/app/UserHome`,
      })
      expect(decideSsoEntry(request, ID, request.nextUrl.searchParams)).toEqual({
        action: "interstitial",
        connection: ID,
        returnTo: `${CONSOLE}/projects`,
        loginHint: "ada@acme.com",
        iss: OKTA_ISSUER,
      })
    })

    it("starts at once from our console, our origin, the address bar, or with no header", () => {
      for (const headers of [
        { "sec-fetch-site": "cross-site", referer: `${CONSOLE}/` },
        { "sec-fetch-site": "same-origin" },
        { "sec-fetch-site": "none" },
        {},
      ] as Array<Record<string, string>>) {
        const request = req(tile, headers)
        expect(decideSsoEntry(request, ID, request.nextUrl.searchParams)).toMatchObject(
          {
            action: "start",
            connection: ID,
            returnTo: `${CONSOLE}/projects`,
            loginHint: "ada@acme.com",
            iss: OKTA_ISSUER,
          },
        )
      }
    })

    it("passes an empty, duplicated or oversized iss on as an empty string for the API to refuse", () => {
      for (const query of [
        "iss=",
        `iss=${encodeURIComponent(OKTA_ISSUER)}&iss=https%3A%2F%2Fevil.okta.com`,
        `iss=${"a".repeat(2049)}`,
      ]) {
        const request = req(`/sso/${ID}?${query}`, { "sec-fetch-site": "cross-site" })
        expect(decideSsoEntry(request, ID, request.nextUrl.searchParams)).toMatchObject(
          {
            action: "interstitial",
            iss: "",
          },
        )
      }
    })

    it("drops an invalid login_hint and a disallowed target_link_uri silently", () => {
      const request = req(
        `/sso/${ID}?login_hint=not-an-email&target_link_uri=https%3A%2F%2Fevil.example%2Fphish`,
        { "sec-fetch-site": "cross-site" },
      )
      const entry = decideSsoEntry(request, ID, request.nextUrl.searchParams)
      expect(entry).toEqual({
        action: "interstitial",
        connection: ID,
        returnTo: null,
        loginHint: null,
        iss: null,
      })
      if (entry.action === "interstitial")
        expect(confirmUrl(entry)).toBe(`/sso/confirm?connection=${ID}`)
    })

    it("marks a malformed connection id invalid", () => {
      const request = req("/sso/not-a-uuid", { "sec-fetch-site": "cross-site" })
      expect(
        decideSsoEntry(request, "not-a-uuid", request.nextUrl.searchParams),
      ).toEqual({ action: "invalid" })
    })
  })

  describe("loadInterstitial and readStartForm", () => {
    it("loads display info from the API and ignores any name parameter in the URL", async () => {
      const calls: Array<{ path: string; body: unknown }> = []
      const state = await loadInterstitial(
        {
          connection: ID.toUpperCase(),
          name: "Spoofed Bank",
          iss: OKTA_ISSUER,
          login_hint: "Ada@Acme.com",
          target_link_uri: `${CONSOLE}/audit`,
        },
        async (path, body) => {
          calls.push({ path, body })
          return Response.json({
            name: "Acme Okta",
            protocol: "oidc",
            provider: "okta",
          })
        },
      )
      expect(calls).toEqual([
        {
          path: "/sso/connection",
          body: { connection: ID, iss: OKTA_ISSUER },
        },
      ])
      expect(state).toEqual({
        state: "confirm",
        connection: ID,
        name: "Acme Okta",
        protocol: "oidc",
        provider: "okta",
        title: "Continue to Acme Okta sign-in",
        returnTo: `${CONSOLE}/audit`,
        loginHint: "ada@acme.com",
        iss: OKTA_ISSUER,
      })
    })

    it("returns invalid for non-UUIDs or 404s, and unavailable on 503", async () => {
      let called = false
      const badId = await loadInterstitial({ connection: "not-a-uuid" }, async () => {
        called = true
        return Response.json({}, { status: 200 })
      })
      expect(badId).toEqual({ state: "invalid" })
      expect(called).toBe(false)

      const notFound = await loadInterstitial({ connection: ID }, async () =>
        Response.json({ message: "Not found." }, { status: 404 }),
      )
      expect(notFound).toEqual({ state: "invalid" })

      const down = await loadInterstitial({ connection: ID }, async () =>
        Response.json({ message: "Down." }, { status: 503 }),
      )
      expect(down).toEqual({ state: "unavailable" })
    })

    it("caps POST /sso/start form bodies at MAX_START_FORM", async () => {
      const valid = new Request(`${BIND}/sso/start`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          connection: ID,
          login_hint: "ada@acme.com",
        }).toString(),
      })
      const parsed = await readStartForm(valid)
      expect(parsed?.get("connection")).toBe(ID)
      expect(parsed?.get("login_hint")).toBe("ada@acme.com")

      const huge = new Request(`${BIND}/sso/start`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `connection=${"x".repeat(MAX_START_FORM + 10)}`,
      })
      expect(await readStartForm(huge)).toBeNull()

      const jsonBody = new Request(`${BIND}/sso/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: ID }),
      })
      expect(await readStartForm(jsonBody)).toBeNull()
    })
  })
})
