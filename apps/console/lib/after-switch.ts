/**
 * Where a workspace switch lands, from the page it started on.
 *
 * ⚠ A PAGE ABOUT ONE OF THE OLD WORKSPACE'S THINGS GOES UP TO ITS LIST:
 * /domains/<id> to /domains, /webhooks/<id> and its deliveries to /webhooks,
 * and the same for emails, broadcasts and templates. Every other page stays
 * where it is. The query string goes too - filters and selections name the
 * old workspace's segments and ids - except `tab`, which only says which tab.
 */
export function afterSwitch(pathname: string, search = ""): string {
  const [section, ...rest] = pathname.split("/").filter(Boolean)
  const scoped = new Set(["domains", "emails", "broadcasts", "templates", "webhooks"])
  if (section && scoped.has(section) && rest.length > 0 && rest[0] !== "new")
    return `/${section}`
  const tab = new URLSearchParams(search).get("tab")
  return tab ? `${pathname}?tab=${encodeURIComponent(tab)}` : pathname
}
