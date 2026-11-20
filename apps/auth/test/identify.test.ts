import { describe, expect, it } from "bun:test"
import type { FlowError } from "../app/_lib/clerk-types"
import { isAddressRefused } from "../app/_lib/errors"
import { identify, inboxBase } from "../app/_lib/identify"

/**
 * The email step's decision, and the sign-up refusals that send people back
 * to it.
 *
 * ⚠ THE ERRORS ARE THE SHAPES CLERK SENT, NOT GUESSES. Each one was read off
 * the dev instance's Frontend API on 2026-11-20 and is built here the way
 * clerk-js builds `ClerkAPIResponseError`: the real code lives in `errors`,
 * never at the top level.
 */
function apiError(code: string, longMessage: string, paramName?: string): FlowError {
  return {
    code: "api_response_error",
    message: longMessage,
    errors: [
      { code, message: longMessage, longMessage, meta: paramName ? { paramName } : {} },
    ],
  } as unknown as FlowError
}

const NOT_FOUND = apiError(
  "form_identifier_not_found",
  "Couldn't find your account.",
  "identifier",
)

/** A Clerk lookup that knows exactly these addresses, recording what it was asked. */
function clerkWith(...accounts: string[]) {
  const asked: string[] = []
  const find = async (address: string) => {
    asked.push(address)
    return accounts.includes(address) ? null : NOT_FOUND
  }
  return { asked, find }
}

describe("the email step", () => {
  it("refuses a subaddress at step 1 when its inbox has an account and the setting is on", async () => {
    const clerk = clerkWith("midofc2008@gmail.com")
    const next = await identify("midofc2008+gw1@gmail.com", {
      find: clerk.find,
      ssoAvailable: false,
      blockSubaddresses: true,
    })
    expect(next).toEqual({
      to: "refused",
      reason:
        "That inbox already has an account as midofc2008@gmail.com. Use that address.",
    })
  })

  it("lets the same address into sign-up when the setting is off, without a second lookup", async () => {
    const clerk = clerkWith("midofc2008@gmail.com")
    const next = await identify("midofc2008+gw1@gmail.com", {
      find: clerk.find,
      ssoAvailable: false,
      blockSubaddresses: false,
    })
    expect(next.to).toBe("sign-up")
    expect(clerk.asked).toEqual(["midofc2008+gw1@gmail.com"])
  })

  it("signs in an address that has its own account, subaddress or not", async () => {
    const clerk = clerkWith("midofc2008@gmail.com", "midofc2008+gw1@gmail.com")
    const next = await identify("midofc2008+gw1@gmail.com", {
      find: clerk.find,
      ssoAvailable: false,
      blockSubaddresses: true,
    })
    expect(next).toEqual({ to: "account" })
    expect(clerk.asked).toEqual(["midofc2008+gw1@gmail.com"])
  })

  // Clerk: "The first sign-up for a base address is allowed, even if it uses a subaddress."
  it("lets a subaddress sign up when its inbox has no account yet", async () => {
    const next = await identify("new+tag@example.com", {
      find: clerkWith().find,
      ssoAvailable: false,
      blockSubaddresses: true,
    })
    expect(next.to).toBe("sign-up")
  })

  it("refuses before the SSO screen, so its password sign-up is no dead end", async () => {
    const next = await identify("carol+x@sso-lab.i10.tech", {
      find: clerkWith("carol@sso-lab.i10.tech").find,
      ssoAvailable: true,
      blockSubaddresses: true,
    })
    expect(next.to).toBe("refused")
  })

  it("still offers company SSO to an unknown address there", async () => {
    const next = await identify("dan@sso-lab.i10.tech", {
      find: clerkWith().find,
      ssoAvailable: true,
      blockSubaddresses: true,
    })
    expect(next).toEqual({ to: "sso" })
  })

  it("lets the sign-up go ahead when the inbox lookup itself fails", async () => {
    const outage = apiError("too_many_requests", "Too many requests.")
    const next = await identify("new+tag@example.com", {
      find: async (address) => (address === "new@example.com" ? outage : NOT_FOUND),
      ssoAvailable: false,
      blockSubaddresses: true,
    })
    expect(next.to).toBe("sign-up")
  })

  it("reports any other lookup failure instead of guessing", async () => {
    const outage = apiError("too_many_requests", "Too many requests.")
    const next = await identify("someone@example.com", {
      find: async () => outage,
      ssoAvailable: false,
      blockSubaddresses: true,
    })
    expect(next).toEqual({ to: "error", error: outage })
  })
})

describe("the inbox Clerk compares a sign-up against", () => {
  it("drops everything from the first +, = or #", () => {
    expect(inboxBase("user+1@example.com")).toBe("user@example.com")
    expect(inboxBase("user=a+b@example.com")).toBe("user@example.com")
    expect(inboxBase("user#x@example.com")).toBe("user@example.com")
  })

  it("is null for an address that is already its own base", () => {
    expect(inboxBase("user@example.com")).toBeNull()
    expect(inboxBase("User@Example.com")).toBeNull()
    expect(inboxBase("first-last@example.com")).toBeNull()
  })

  it("ignores the dots in a Gmail local part", () => {
    expect(inboxBase("j.smith@gmail.com")).toBe("jsmith@gmail.com")
    expect(inboxBase("j.smith+news@googlemail.com")).toBe("jsmith@googlemail.com")
    expect(inboxBase("j.smith@example.com")).toBeNull()
  })

  it("treats - as a separator on Yahoo's own domains only", () => {
    expect(inboxBase("john-shop@yahoo.com")).toBe("john@yahoo.com")
    expect(inboxBase("john-shop@yahoo.co.uk")).toBe("john@yahoo.co.uk")
    expect(inboxBase("john-shop@yahoo.com.br")).toBe("john@yahoo.com.br")
    expect(inboxBase("john-shop@ymail.com")).toBe("john@ymail.com")
    expect(inboxBase("john-shop@yahoo.dev")).toBeNull()
  })

  it("has no base for a local part that is all subaddress", () => {
    expect(inboxBase("+tag@example.com")).toBeNull()
    expect(inboxBase("not-an-address")).toBeNull()
  })
})

describe("a sign-up Clerk refused at Create account", () => {
  it("goes back to the email step for a disposable domain", () => {
    const disposable = apiError(
      "form_email_address_blocked",
      "Temporary email services are not supported. Please use your regular email address to create an account.",
      "email_address",
    )
    expect(isAddressRefused(disposable)).toBe(true)
  })

  it("goes back to the email step for a second address on an inbox", () => {
    const sameInbox = apiError(
      "not_allowed_access",
      "This email address is already in use. Creating multiple accounts with the same email address is not allowed.",
    )
    expect(isAddressRefused(sameInbox)).toBe(true)
  })

  it("stays on the password screen for a password problem", () => {
    const pwned = apiError(
      "form_password_pwned",
      "Password has been found in an online data breach.",
      "password",
    )
    expect(isAddressRefused(pwned)).toBe(false)
  })

  it("does not mark a taken address refused, since the email step signs it in", () => {
    const taken = apiError(
      "form_identifier_exists",
      "That email address is taken. Please try another.",
      "email_address",
    )
    expect(isAddressRefused(taken)).toBe(false)
  })
})
