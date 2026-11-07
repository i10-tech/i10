import { NAV, SETTINGS_NAV, type NavItem } from "@/lib/nav"

export const SECTIONS: NavItem[] = [...NAV, ...SETTINGS_NAV]
  .flatMap((group) => group.items)
  .filter((item) => item.href !== "/")
  // Longest first, so /settings/billing wins over /settings.
  .sort((a, b) => b.href.length - a.href.length)

export const SUFFIX = " · i10"

export interface BreadcrumbCrumb {
  label: string
  href: string
}

/**
 * Builds the breadcrumb trail for Arc's Breadcrumb bar.
 *
 * ⚠ EVERY CRUMB KEEPS AN HREF, THE CURRENT ONE INCLUDED.
 * A crumb that gains or loses its link becomes a different element, and its
 * label can then only appear, not morph (see breadcrumb.tsx).
 *
 * ⚠ /settings INSERTS A "Settings" CRUMB AFTER THE WORKSPACE.
 * /settings/usage reads "Workspace > Settings > Usage" and
 * /settings reads "Workspace > Settings > General".
 */
export function buildBreadcrumbs({
  workspace,
  pathname,
  title = "",
}: {
  workspace: string
  pathname: string
  title?: string
}): BreadcrumbCrumb[] {
  const crumbs: BreadcrumbCrumb[] = [{ label: workspace, href: "/" }]
  if (pathname === "/") {
    crumbs.push({ label: "Overview", href: "/" })
    return crumbs
  }

  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    crumbs.push({ label: "Settings", href: "/settings" })
  }

  const section = SECTIONS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  )
  if (!section) return crumbs
  crumbs.push({ label: section.label, href: section.href })
  if (pathname !== section.href) {
    const record = title.endsWith(SUFFIX) ? title.slice(0, -SUFFIX.length) : ""
    if (record && record !== section.label)
      crumbs.push({ label: record, href: pathname })
  }
  return crumbs
}
