import { AccountShell } from "@/components/section-frame"

/**
 * The account shell.
 *
 * ⚠ THIS FILE DID NOT EXIST, AND ITS ABSENCE IS THE BUG IT FIXES. `/account`
 * is listed in `SETTINGS_NAV` and looks like a settings
 * page, but it sits outside the `settings` segment - so it inherited no
 * `Page` wrapper at all and rendered flush against the left edge of the
 * viewport, with no padding and no heading, while every neighbouring page had
 * both. It read as a broken stylesheet rather than a missing layout.
 *
 * ⚠ THE FRAME IS `AccountShell`, shared with the skeleton drawn when the page
 * is entered from elsewhere (components/section-frame) - the second user that
 * made sharing it worth the indirection.
 */
export default function AccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AccountShell>{children}</AccountShell>
}
