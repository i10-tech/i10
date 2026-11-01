import type { NextRequest } from "next/server"
import { callApi, FINISH_SIGN_IN_MS } from "../../../../_lib/devices-server"
import { leave, outcomeRedirect } from "../../../../_lib/sso-callback"
import {
  SAML_COOKIE,
  bindingCookie,
  failedUrl,
  newBinding,
  readCookie,
} from "../../../../_lib/sso-server"
import { connectionOf, readForm } from "../../../../_lib/saml-server"

export const dynamic = "force-dynamic"

/**
 * `POST /sso/saml/acs/<connection id>` (#339): the Assertion Consumer
 * Service, the URL every SAML IdP is given. The IdP's page auto-submits a
 * form here with `SAMLResponse` and `RelayState`; the API verifies everything
 * (identity/saml.ts) and this route sends the browser on.
 *
 * ⚠ A CROSS-SITE POST BY DESIGN, SO THE BINDING COMES FROM `__Host-i10_sso_saml`
 * (SameSite=None), never the Lax cookie, which this POST does not carry. The
 * API checks it against the attempt before it reads the XML, so a response
 * planted in this browser from another site (login CSRF) names an attempt
 * bound to somebody else's browser and is refused.
 *
 * ⚠ AN IdP-INITIATED RESPONSE GETS A FRESH BINDING, drawn here for this
 * browser, and the continue page then asks "continue as <address>?" before
 * the code is swapped (the API says so with `confirmAs`).
 *
 * ⚠ NOTHING OF THE RESPONSE IS LOGGED, and the browser leaves with a 303 and
 * `Referrer-Policy: no-referrer`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  const connection = connectionOf((await params).connection)
  const form = await readForm(request)
  const samlResponse = form?.get("SAMLResponse") ?? null
  if (!connection || !form || !samlResponse)
    return leave(
      failedUrl("We could not read your company's sign-in. Start again."),
      true,
    )
  const relayState = form.get("RelayState")
  const freshBinding = newBinding()

  let answer: Parameters<typeof outcomeRedirect>[0] & {
    unsolicited?: boolean
    message?: string
  }
  try {
    const upstream = await callApi(
      "/sso/saml/acs",
      {
        connection,
        samlResponse,
        relayState: relayState && relayState.length <= 80 ? relayState : null,
        binding: readCookie(request, SAML_COOKIE),
        freshBinding,
      },
      {},
      FINISH_SIGN_IN_MS,
    )
    answer = (await upstream.json()) as typeof answer
    if (!upstream.ok)
      return leave(
        failedUrl(answer.message ?? "We could not sign you in. Start again."),
        true,
      )
  } catch {
    return leave(
      failedUrl("Sign-in is temporarily unavailable. Try again in a moment."),
      true,
    )
  }
  // The SAML cookie has done its one job; the Lax one carries on to the swap.
  const response = outcomeRedirect(
    answer,
    answer.unsolicited ? bindingCookie(freshBinding) : undefined,
  )
  response.headers.append(
    "Set-Cookie",
    `${SAML_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`,
  )
  return response
}
