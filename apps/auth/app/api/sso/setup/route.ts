import type { NextRequest } from "next/server"
import { callApiAs, fromOwnPage, json } from "../../../_lib/devices-server"
import { bindingCookie, newBinding, samlBindingCookie } from "../../../_lib/sso-server"

/**
 * The setup page's calls to the API (#340): one route, so the token never
 * appears in a URL this app serves. The page keeps it in memory and sessionStorage and sends
 * it in the body; it goes to the API in the path, server to server, and is
 * logged nowhere.
 *
 * ⚠ ONLY THE SIX OPERATIONS A SETUP LINK MAY DO, each mapped to one fixed API
 * path. Nothing about the path comes from the caller except the token, whose
 * shape is checked first: a setup link can read and set the IdP's settings and
 * start a test, never activate, change enforcement or touch domains - and the
 * API enforces that again behind every one of these.
 */

const TOKEN = /^i10_setup_[A-Za-z0-9_-]{43}$/

const OPS = {
  view: { method: "GET", path: "" },
  oidc: { method: "PUT", path: "/oidc" },
  "oidc-secret": { method: "PUT", path: "/oidc/secret" },
  saml: { method: "PUT", path: "/saml" },
  "saml-certificate": { method: "POST", path: "/saml/certificates" },
} as const

export async function POST(request: NextRequest) {
  if (!fromOwnPage(request)) return json({ message: "Not allowed." }, 403)
  const body = (await request.json().catch(() => null)) as {
    op?: unknown
    token?: unknown
    payload?: unknown
  } | null
  const token = typeof body?.token === "string" ? body.token : ""
  if (!TOKEN.test(token))
    return json(
      { message: "This setup link is not valid. Ask your contact for a new one." },
      404,
    )
  const payload =
    body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload
      : {}
  const base = `/sso/setup/${token}`

  try {
    if (body?.op === "test") {
      const binding = newBinding()
      const upstream = await callApiAs("POST", `${base}/test`, {
        binding,
        returnTo: new URL("/sso/setup", request.url).href,
      })
      const answer = (await upstream.json()) as {
        redirectUrl?: string
        protocol?: string
        message?: string
      }
      if (!upstream.ok || !answer.redirectUrl)
        return json(
          { message: answer.message ?? "We could not start the test." },
          upstream.status === 404 ? 404 : 409,
        )
      const response = json({ redirectUrl: answer.redirectUrl })
      response.headers.append("Set-Cookie", bindingCookie(binding))
      if (answer.protocol === "saml")
        response.headers.append("Set-Cookie", samlBindingCookie(binding))
      return response
    }

    const op =
      typeof body?.op === "string" && Object.hasOwn(OPS, body.op)
        ? OPS[body.op as keyof typeof OPS]
        : null
    if (!op) return json({ message: "Not found." }, 404)
    const upstream = await callApiAs(
      op.method,
      `${base}${op.path}`,
      op.method === "GET" ? undefined : payload,
    )
    // ⚠ 5xx IS ONE SENTENCE: nothing of an upstream failure's wording is passed on.
    if (upstream.status >= 500)
      return json(
        { message: "Setup is temporarily unavailable. Try again in a moment." },
        503,
      )
    return json(await upstream.json(), upstream.status)
  } catch {
    return json(
      { message: "Setup is temporarily unavailable. Try again in a moment." },
      503,
    )
  }
}
