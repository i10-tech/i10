import { describe, expect, test } from "bun:test"
import { Settings } from "lucide-react"
import {
  activeHref,
  allDestinations,
  findSettingsItem,
  isActive,
  NAV,
} from "../lib/nav"

describe("findSettingsItem", () => {
  test("exact matches on root settings page resolve to General", () => {
    const item = findSettingsItem("/settings")
    expect(item?.label).toBe("General")
    expect(item?.href).toBe("/settings")
  })

  test("top-level settings tabs resolve to their respective items", () => {
    expect(findSettingsItem("/settings/team")?.label).toBe("Team")
    expect(findSettingsItem("/settings/sso")?.label).toBe("Single sign-on")
    expect(findSettingsItem("/settings/security")?.label).toBe("Security")
    expect(findSettingsItem("/settings/billing")?.label).toBe("Billing")
    expect(findSettingsItem("/settings/usage")?.label).toBe("Usage")
    expect(findSettingsItem("/settings/unsubscribe-page")?.label).toBe(
      "Unsubscribe page",
    )
  })

  test("sub-routes resolve to their parent tab (longest href wins)", () => {
    // /settings/security/audit is hidden in SETTINGS_NAV, so /settings/security wins
    expect(findSettingsItem("/settings/security/audit")?.label).toBe("Security")
    expect(findSettingsItem("/settings/security/audit")?.href).toBe(
      "/settings/security",
    )

    // /settings/sso/connect prefix matches /settings/sso
    expect(findSettingsItem("/settings/sso/connect")?.label).toBe("Single sign-on")
    expect(findSettingsItem("/settings/sso/connect")?.href).toBe("/settings/sso")
  })

  test("unmatched paths return undefined", () => {
    expect(findSettingsItem("/")).toBeUndefined()
    expect(findSettingsItem("/domains")).toBeUndefined()
    expect(findSettingsItem("/settings-other")).toBeUndefined()
  })
})

describe("isActive", () => {
  test("respects exact matches", () => {
    expect(
      isActive("/settings", {
        href: "/settings",
        label: "General",
        icon: Settings,
        exact: true,
      }),
    ).toBe(true)
    expect(
      isActive("/settings/team", {
        href: "/settings",
        label: "General",
        icon: Settings,
        exact: true,
      }),
    ).toBe(false)
  })

  test("prefix matches on segment boundaries", () => {
    expect(
      isActive("/settings/sso", {
        href: "/settings/sso",
        label: "SSO",
        icon: Settings,
      }),
    ).toBe(true)
    expect(
      isActive("/settings/sso/connect", {
        href: "/settings/sso",
        label: "SSO",
        icon: Settings,
      }),
    ).toBe(true)
    expect(
      isActive("/settings/sso-other", {
        href: "/settings/sso",
        label: "SSO",
        icon: Settings,
      }),
    ).toBe(false)
  })
})

describe("Email hosting group", () => {
  const group = NAV.find((g) => g.label === "Email hosting")
  const developers = NAV.find((g) => g.label === "Developers")

  test("is a group of its own with the four destinations, in order", () => {
    expect(group?.items.map((i) => [i.label, i.href])).toEqual([
      ["Mailboxes", "/mailboxes"],
      ["Team inboxes", "/team-inboxes"],
      ["Move mail in", "/mailboxes/move-in"],
      ["Settings", "/mailboxes/settings"],
    ])
  })

  test("Mailboxes left Developers", () => {
    expect(developers?.items.map((i) => i.href)).toEqual(["/api-keys", "/webhooks"])
  })

  test("the command menu can tell the two Settings apart", () => {
    const labels = allDestinations().map((i) => i.commandLabel ?? i.label)
    expect(labels).toContain("Mailbox settings")
    expect(labels.filter((l) => l === "Settings")).toEqual([])
  })
})

describe("activeHref", () => {
  test("a page inside Mailboxes lights only its own row", () => {
    expect(activeHref("/mailboxes", NAV)).toBe("/mailboxes")
    expect(activeHref("/mailboxes/move-in", NAV)).toBe("/mailboxes/move-in")
    expect(activeHref("/mailboxes/settings", NAV)).toBe("/mailboxes/settings")
  })

  test("a mailbox's own page belongs to Mailboxes", () => {
    expect(activeHref("/mailboxes/alice%40acme.dev", NAV)).toBe("/mailboxes")
    expect(activeHref("/mailboxes/alice@acme.dev", NAV)).toBe("/mailboxes")
  })

  test("team inboxes and their detail pages light Team inboxes, not Mailboxes", () => {
    expect(activeHref("/team-inboxes", NAV)).toBe("/team-inboxes")
    expect(activeHref("/team-inboxes/support%40acme.dev", NAV)).toBe("/team-inboxes")
  })

  test("a name that merely starts like a row does not light it", () => {
    expect(activeHref("/mailboxes-archive", NAV)).toBeUndefined()
    expect(activeHref("/mailboxes/move-in-later", NAV)).toBe("/mailboxes")
  })

  test("the overview is exact and everything else is its own", () => {
    expect(activeHref("/", NAV)).toBe("/")
    expect(activeHref("/domains/abc", NAV)).toBe("/domains")
  })
})
