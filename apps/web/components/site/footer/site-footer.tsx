import Link from "next/link"
import { BrandIcon, type BrandName } from "@/components/brand/brand-icon"
import { Mark } from "@/components/brand/mark"
import { Badge } from "@/components/ui/badge"
import { ArrowUpRight } from "@/components/ui/button-link"
import { StatusPill } from "@/components/site/status-pill"
import { footerColumns, socials } from "@/lib/site"
import { FooterMark } from "./footer-mark"
import { FooterWordmark } from "./footer-wordmark"

/*
 * "Ask AI about i10" (after itsoffbrand's footer): each link opens an
 * assistant with a question already typed. The question is public and fixed;
 * nothing about the visitor goes into the URL.
 */
const ASK = "What is i10 (i10.tech), the email platform for developers? Summarise what it does and how it compares to Resend."
const ASK_AI: { name: BrandName; href: string }[] = [
  { name: "chatgpt", href: `https://chatgpt.com/?q=${encodeURIComponent(ASK)}` },
  { name: "claude", href: `https://claude.ai/new?q=${encodeURIComponent(ASK)}` },
  { name: "perplexity", href: `https://www.perplexity.ai/search?q=${encodeURIComponent(ASK)}` },
  { name: "gemini", href: `https://gemini.google.com/app?q=${encodeURIComponent(ASK)}` },
]

export function SiteFooter() {
  return (
    <footer className="relative mt-24 overflow-hidden" data-nav-tone="dark">
      <div className="container-site">
        <FooterWordmark />
      </div>
      <div className="footer-horizon" aria-hidden />

      <div className="container-site relative grid grid-cols-2 gap-x-6 gap-y-12 pt-14 pb-12 md:grid-cols-5 xl:grid-cols-[1.35fr_repeat(5,1fr)]">
        <div className="col-span-2 flex flex-col gap-6 md:col-span-5 md:flex-row md:items-start md:justify-between xl:col-span-1 xl:flex-col xl:justify-start">
          <Link href="/" aria-label="i10 home" className="w-fit text-brand">
            <Mark className="h-5 w-auto" />
          </Link>
          <p className="max-w-[16rem] text-[13px] leading-5 text-fg-3">
            <span className="text-fg-2">i + 10 letters.</span> Email for developers and mailboxes for everyone else, sent from
            Frankfurt.
          </p>
          <StatusPill />
          <ul className="flex items-center gap-1.5">
            {socials.map((s) => (
              <li key={s.title}>
                <Link
                  href={s.href}
                  aria-label={s.title}
                  {...(s.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="grid size-9 place-items-center rounded-full text-fg-3 shadow-[inset_0_0_0_1px_var(--line)] transition-[color,box-shadow,background-color] duration-200 hover:bg-white/[0.04] hover:text-fg hover:shadow-[inset_0_0_0_1px_var(--line-strong)]"
                >
                  <BrandIcon name={s.icon} size={15} />
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {footerColumns.map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col gap-4">
            <p className="text-[13px] font-[540] text-fg">{column.title}</p>
            <ul className="flex flex-col gap-2.5">
              {column.links.map((link) => (
                <li key={link.href + link.title}>
                  <Link
                    href={link.href}
                    {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="footer-link group inline-flex items-center gap-2 text-[13px] text-fg-3 transition-colors duration-150 hover:text-fg"
                  >
                    <span className="footer-link__label">{link.title}</span>
                    {link.badge ? <Badge kind={link.badge} /> : null}
                    {link.external ? <ArrowUpRight className="text-fg-4 transition-colors group-hover:text-fg-2" /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="relative h-[330px] md:h-[clamp(260px,34vw,420px)]">
        <div className="container-site relative z-10 flex flex-col gap-6 border-t border-line-faint pt-8 pb-10">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="type-label text-fg-4">Ask AI about i10</span>
            <ul className="flex items-center gap-1">
              {ASK_AI.map((a) => (
                <li key={a.name}>
                  <a
                    href={a.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Ask ${a.name}`}
                    className="grid size-8 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-white/[0.05] hover:text-fg"
                  >
                    <BrandIcon name={a.name} size={15} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <p className="font-mono text-[11px] tracking-wide text-fg-4">
            © {new Date().getFullYear()} i10 · Made in the EU · Sent from <span className="whitespace-nowrap">eu-central-1</span>
          </p>
        </div>
        {/* On a phone the mark is as wide as the screen, so it rises from below
            the text instead of beside it. */}
        <FooterMark className="absolute top-[150px] right-[-10vw] h-[240px] md:top-[18%] md:right-[-5vw] md:h-[clamp(240px,40vw,520px)]" />
      </div>
    </footer>
  )
}
