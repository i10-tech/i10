import Link from "next/link"
import { IconTile } from "@/components/brand/icon-tile"
import { BounceNotice } from "@/components/site/bounce-notice"
import { ArrowUpRight, ButtonLink } from "@/components/ui/button-link"
import { hosts, type Hue, type IconName } from "@/lib/site"

/*
 * Not found, as a bounce. An email platform's 404 is a returned letter: the
 * page you addressed does not exist, here is the notice, and here are places
 * that do (Polar's 404 ends the same way, with destinations).
 */
const DESTINATIONS: {
  title: string
  href: string
  icon: IconName
  hue: Hue
  note: string
}[] = [
  { title: "Home", href: "/", icon: "send", hue: "send", note: "Start at the top" },
  {
    title: "Documentation",
    href: hosts.docs,
    icon: "book",
    hue: "deliver",
    note: "Guides and API",
  },
  {
    title: "Pricing",
    href: "/pricing",
    icon: "status",
    hue: "domain",
    note: "Plans and limits",
  },
  {
    title: "Changelog",
    href: "/changelog",
    icon: "changelog",
    hue: "template",
    note: "What shipped",
  },
]

export default function NotFound() {
  return (
    <section
      data-nav-tone="dark"
      className="relative overflow-hidden pt-[calc(var(--nav-h)+5rem)] pb-28"
    >
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />
      <div className="container-site relative grid items-center gap-14 lg:grid-cols-[1fr_1fr]">
        <div>
          <p className="type-label text-bounced">Error 404 · 550 5.1.1</p>
          <h1 className="type-display-l mt-6 max-w-[14ch]">
            Mail delivery failed. <span className="text-fg-3">Returning page to</span>{" "}
            <span className="type-accent">sender.</span>
          </h1>
          <p className="type-lead mt-6 max-w-[30rem]">
            The page you addressed does not exist, or it moved without leaving a
            forwarding address. It happens to the best of mailboxes.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <ButtonLink href="/" size="lg" arrow>
              Back to i10
            </ButtonLink>
            <ButtonLink href="/contact" size="lg" variant="secondary">
              Report a broken link
            </ButtonLink>
          </div>
        </div>
        <BounceNotice />
      </div>

      <div className="container-site relative mt-20">
        <p className="type-label text-fg-4">Deliverable addresses</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DESTINATIONS.map((d) => (
            <Link
              key={d.title}
              href={d.href}
              className="group flex items-center gap-4 rounded-[16px] bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--line)] transition-[background-color,box-shadow] duration-300 hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--line-strong)]"
            >
              <IconTile icon={d.icon} hue={d.hue} />
              <span className="flex flex-col">
                <span className="text-[14px] font-[540] text-fg">{d.title}</span>
                <span className="text-[12.5px] text-fg-3">{d.note}</span>
              </span>
              <ArrowUpRight className="ml-auto text-fg-4 transition-[color,transform] duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
