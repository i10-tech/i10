import { describe, expect, test } from "bun:test"
import { Settings } from "lucide-react"
import { findSettingsItem, isActive } from "../lib/nav"

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
