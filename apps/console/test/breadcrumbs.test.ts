import { describe, expect, test } from "bun:test"
import { buildBreadcrumbs } from "../lib/breadcrumbs"

describe("buildBreadcrumbs", () => {
  const workspace = "Acme Corp"

  test("root overview crumb", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Overview", href: "/" },
    ])
  })

  test("top-level console section", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/domains" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Domains", href: "/domains" },
    ])
  })

  test("detail page with record title", () => {
    expect(
      buildBreadcrumbs({
        workspace,
        pathname: "/domains/d_123",
        title: "example.com · i10",
      }),
    ).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Domains", href: "/domains" },
      { label: "example.com", href: "/domains/d_123" },
    ])
  })

  test("/settings inserts Settings crumb and resolves to General", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/settings" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "General", href: "/settings" },
    ])
  })

  test("/settings/usage reads Workspace > Settings > Usage", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/settings/usage" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "Usage", href: "/settings/usage" },
    ])
  })

  test("/settings/security reads Workspace > Settings > Security", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/settings/security" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "Security", href: "/settings/security" },
    ])
  })

  test("/settings/security/audit reads Workspace > Settings > Identity audit log", () => {
    expect(
      buildBreadcrumbs({ workspace, pathname: "/settings/security/audit" }),
    ).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "Identity audit log", href: "/settings/security/audit" },
    ])
  })

  test("/settings/sso/connect reads Workspace > Settings > Single sign-on", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/settings/sso/connect" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "Single sign-on", href: "/settings/sso" },
    ])
  })

  test("a page inside Mailboxes keeps Mailboxes as its section", () => {
    expect(
      buildBreadcrumbs({
        workspace,
        pathname: "/mailboxes/settings",
        title: "Mailbox settings \u00b7 i10",
      }),
    ).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Mailboxes", href: "/mailboxes" },
      { label: "Mailbox settings", href: "/mailboxes/settings" },
    ])
    expect(
      buildBreadcrumbs({
        workspace,
        pathname: "/mailboxes/move-in",
        title: "Move mail in \u00b7 i10",
      }),
    ).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Mailboxes", href: "/mailboxes" },
      { label: "Move mail in", href: "/mailboxes/move-in" },
    ])
  })

  test("team inboxes is a section of its own", () => {
    expect(buildBreadcrumbs({ workspace, pathname: "/team-inboxes" })).toEqual([
      { label: "Acme Corp", href: "/" },
      { label: "Team inboxes", href: "/team-inboxes" },
    ])
  })
})
