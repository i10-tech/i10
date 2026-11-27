import { describe, expect, it, mock } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

// The panel imports its server actions; rendering it never calls them.
mock.module("server-only", () => ({}))

const { AutoForwardingPanel } = await import("@/components/sso/auto-forwarding")

const WARNING = "an attacker can add a rule to copy incoming"

describe("AutoForwardingPanel", () => {
  it("warns about compromised passwords when the saved mode is anywhere", () => {
    const html = renderToStaticMarkup(
      <AutoForwardingPanel initial={{ mode: "anywhere" }} />,
    )
    expect(html).toContain(WARNING)
  })

  it.each(["workspace", "workspace_and_members", "off"] as const)(
    "shows no warning when the saved mode is %s",
    (mode) => {
      const html = renderToStaticMarkup(<AutoForwardingPanel initial={{ mode }} />)
      expect(html).not.toContain(WARNING)
    },
  )
})
