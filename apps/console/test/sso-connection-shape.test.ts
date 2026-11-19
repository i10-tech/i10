import { describe, expect, test } from "bun:test"
import { shapeFromText } from "@/lib/shapes"
import {
  connectionShape,
  ssoConnectionShape,
  type SsoConnectionData,
} from "@/lib/shapes/sso-connection"
import { mfaNotes } from "@/lib/sso-runs"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"

const owner: SsoAbilities = { manage: true, owner: true, userId: "u" }
const admin: SsoAbilities = { manage: true, owner: false, userId: "u" }

const connection = (over: Partial<SsoConnection> = {}): SsoConnection => ({
  id: "c1",
  name: "Okta",
  protocol: "saml",
  provider: "okta",
  status: "active",
  enforcement: "optional",
  jitEnabled: false,
  mfaRequired: false,
  relink: "ask",
  upnAsEmail: false,
  maxSessionSeconds: null,
  idleTimeoutSeconds: null,
  attributeMapping: {},
  domains: [],
  ...over,
})

const data = (c: SsoConnection, abilities = owner): SsoConnectionData => ({
  connection: c,
  abilities,
  authOrigin: null,
  clerkEnabled: false,
})

describe("ssoConnectionShape", () => {
  test("reads the facts the page's structure turns on", () => {
    expect(ssoConnectionShape.of(data(connection()))).toEqual({
      protocol: "saml",
      provider: "okta",
      status: "active",
      isOkta: true,
      canDelete: false,
      owner: true,
      failing: false,
      mfaNotes: 0,
      sessionNote: false,
    })
  })

  test("a draft is deletable by an owner only", () => {
    const draft = connection({ status: "draft" })
    expect(connectionShape(draft, owner).canDelete).toBe(true)
    expect(connectionShape(draft, admin).canDelete).toBe(false)
  })

  test("failing health opens provider settings", () => {
    const failing = connection({
      health: {
        lastSuccessAt: null,
        failuresLastHour: 9,
        failuresLast24Hours: 9,
        failing: true,
        reason: "failure_spike",
      },
    })
    expect(connectionShape(failing, owner).failing).toBe(true)
  })

  test("counts the notes under the MFA toggle with the page's own list", () => {
    const caps = {
      label: "Okta",
      canProveMfa: "no",
      mfaUnprovableReason: "no proof",
      canProveFreshAuth: "no",
    } as unknown as SsoConnection["capabilities"]
    const c = connection({ capabilities: caps })
    expect(mfaNotes(c)).toHaveLength(2)
    expect(connectionShape(c, owner).mfaNotes).toBe(2)
  })

  test("a missing directory is the session note", () => {
    expect(
      connectionShape(connection({ directoryState: "none" }), owner).sessionNote,
    ).toBe(true)
    expect(
      connectionShape(connection({ directoryState: "enabled" }), owner).sessionNote,
    ).toBe(false)
  })

  // ⚠ A COOKIE WRITTEN BEFORE A FIELD EXISTED MUST STILL DRAW A SKELETON: it is read
  // with the quiet default for each new field, not thrown away for the fallback.
  test("an old cookie without the new fields still parses", () => {
    const old = JSON.stringify({
      protocol: "oidc",
      provider: "entra",
      status: "testing",
      isOkta: false,
      canDelete: false,
    })
    expect(shapeFromText(ssoConnectionShape, old)).toEqual({
      protocol: "oidc",
      provider: "entra",
      status: "testing",
      isOkta: false,
      canDelete: false,
      owner: true,
      failing: false,
      mfaNotes: 0,
      sessionNote: false,
    })
  })

  test("a damaged cookie falls back, a wild note count is clamped", () => {
    expect(shapeFromText(ssoConnectionShape, "{nope")).toEqual(
      ssoConnectionShape.fallback,
    )
    expect(
      shapeFromText(
        ssoConnectionShape,
        JSON.stringify({ ...ssoConnectionShape.fallback, mfaNotes: 9999 }),
      ).mfaNotes,
    ).toBe(3)
    expect(
      shapeFromText(
        ssoConnectionShape,
        JSON.stringify({ ...ssoConnectionShape.fallback, mfaNotes: -4 }),
      ).mfaNotes,
    ).toBe(0)
  })
})
