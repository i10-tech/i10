import type { Metadata, Viewport } from "next"
import Script from "next/script"
import { RevealController } from "@/components/motion/reveal-controller"
import { SmoothScroll } from "@/components/providers/smooth-scroll"
import { SiteFooter } from "@/components/site/footer/site-footer"
import { SiteNav } from "@/components/site/nav/site-nav"
import { geistMono, instrumentSerif, inter } from "./fonts"
import "./globals.css"

export const metadata: Metadata = {
  metadataBase: new URL("https://i10.tech"),
  title: {
    default: "i10 - Email for developers, mailboxes for everyone else",
    template: "%s · i10",
  },
  description:
    "Resend-compatible email API, real mailboxes on your domain, and one DNS record to start. Keep your code, change one import.",
  openGraph: {
    type: "website",
    siteName: "i10",
    title: "i10 - Email for developers",
    description:
      "Resend-compatible sending and real mailboxes on your domain. One DNS record to start.",
  },
}

export const viewport: Viewport = {
  themeColor: "#09090b",
  colorScheme: "dark",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${instrumentSerif.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * ⚠ BEFORE FIRST PAINT. Reveal animations start from a hidden state
         * that lives in CSS behind `.js`, so the server paint already matches
         * the first frame and nothing flashes in and back out. Without
         * JavaScript the class never lands and every element is simply there.
         */}
        <Script id="js-flag" strategy="beforeInteractive">
          {`document.documentElement.classList.add("js")`}
        </Script>
      </head>
      {/* Extensions (Grammarly and the like) stamp attributes on <body>
          before React hydrates; this silences that one element only. */}
      <body suppressHydrationWarning>
        <a
          href="#main"
          className="type-label fixed top-3 left-3 z-[100] -translate-y-20 rounded-md bg-brand px-3 py-2.5 text-brand-ink transition-transform focus-visible:translate-y-0"
        >
          Skip to content
        </a>
        <SmoothScroll>
          <SiteNav />
          {/* ⚠ clip, NOT hidden. A safety net for horizontal overflow (which on a
              phone widens the layout viewport and drags the fixed nav off
              screen); `hidden` would make <main> a scroll container and break
              every sticky element and ScrollTrigger pin inside it. */}
          <main id="main" className="overflow-x-clip">
            {children}
          </main>
          <SiteFooter />
          <RevealController />
        </SmoothScroll>
      </body>
    </html>
  )
}
