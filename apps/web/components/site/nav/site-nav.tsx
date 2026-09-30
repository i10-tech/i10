"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { cn } from "cn"
import { Mark } from "@/components/brand/mark"
import { IconTile } from "@/components/brand/icon-tile"
import { Arrow, ArrowUpRight, Chevron } from "@/components/ui/button-link"
import { Badge } from "@/components/ui/badge"
import { developerNav, hosts, productNav, resourceNav } from "@/lib/site"
import { DevelopersPanel, ProductPanel, ResourcesPanel } from "./nav-panels"

type MenuId = "product" | "developers" | "resources"

const MENUS: { id: MenuId; label: string }[] = [
  { id: "product", label: "Product" },
  { id: "developers", label: "Developers" },
  { id: "resources", label: "Resources" },
]

const LINKS = [
  { label: "Pricing", href: "/pricing", external: false },
  { label: "Docs", href: hosts.docs, external: true },
]

/*
 * Signed in or not, read from Clerk's `__client_uat` cookie. Clerk sets it on
 * the apex domain (i10.tech) for every subdomain, and it is not HttpOnly by
 * design: its whole job is to let a page on the apex know a session exists
 * without a round trip. A value above 0 is the last sign-in time; 0 means
 * signed out. Clerk suffixes it with the instance id in newer SDKs, hence the
 * optional `_...`.
 *
 * ⚠ useSyncExternalStore, NOT useEffect + setState. The server has no cookie
 * to read, so it renders signed-out; the client snapshot takes over at
 * hydration without an effect-driven second render.
 */
const readSignedIn = () => {
  const match = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[\w-]+)?=(\d+)/)
  return Boolean(match && Number(match[1]) > 0)
}
const useSignedIn = () =>
  useSyncExternalStore(
    () => () => {},
    readSignedIn,
    () => false,
  )

const MENU_ORDER: MenuId[] = ["product", "developers", "resources"]

export function SiteNav() {
  const pathname = usePathname()
  const signedIn = useSignedIn()

  const [open, setOpen] = useState<MenuId | null>(null)
  const [direction, setDirection] = useState<1 | -1>(1)
  // `jump`: the pill was hidden, so it appears in place instead of sliding
  // over from wherever the pointer last left the bar.
  const [highlight, setHighlight] = useState<{ x: number; w: number; on: boolean; jump: boolean }>({
    x: 0,
    w: 0,
    on: false,
    jump: true,
  })
  const [panelX, setPanelX] = useState(0)
  // Same for the menu viewport: opened from closed, it appears at its trigger
  // at its size; only a switch between open menus slides and resizes.
  const [panelJump, setPanelJump] = useState(true)
  const [sizes, setSizes] = useState<Record<MenuId, { w: number; h: number }>>({
    product: { w: 760, h: 300 },
    developers: { w: 700, h: 280 },
    resources: { w: 640, h: 260 },
  })
  const [floating, setFloating] = useState(false)
  const [tone, setTone] = useState<"dark" | "brand" | "light">("dark")
  const [sheet, setSheet] = useState(false)

  const barRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const panelRefs = useRef<Record<MenuId, HTMLDivElement | null>>({ product: null, developers: null, resources: null })
  // Panels register themselves through a callback rather than writing into a
  // ref object handed down as a prop.
  const registerPanel = useCallback((id: MenuId, el: HTMLDivElement | null) => {
    panelRefs.current[id] = el
  }, [])
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRef = useRef<MenuId | null>(null)

  const clearTimers = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (openTimer.current) clearTimeout(openTimer.current)
  }

  const close = useCallback(() => {
    clearTimers()
    openRef.current = null
    setOpen(null)
    setHighlight((h) => ({ ...h, on: false }))
  }, [])
  // Closes the open menu but leaves the hover pill where it is. Pricing and
  // Docs call this on hover: going through close() made the pill fade out
  // 140ms after it had just slid under them, which read as a flash.
  const closeMenuOnly = () => {
    clearTimers()
    if (!openRef.current) return
    closeTimer.current = setTimeout(() => {
      openRef.current = null
      setOpen(null)
    }, 140)
  }

  // Every panel measures itself once; the viewport animates between them.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const next = { ...sizes }
      let changed = false
      for (const id of MENU_ORDER) {
        const el = panelRefs.current[id]
        if (!el) continue
        const w = el.offsetWidth
        const h = el.offsetHeight
        if (next[id].w !== w || next[id].h !== h) {
          next[id] = { w, h }
          changed = true
        }
      }
      if (changed) setSizes(next)
    })
    for (const id of MENU_ORDER) {
      const el = panelRefs.current[id]
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- observe once; the callback reads the current sizes through the closure it replaces
  }, [])

  // Floating glass after the first few pixels. The bar itself is pinned: it
  // never hides or shifts with scroll direction.
  useEffect(() => {
    let last = window.scrollY
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const y = window.scrollY
        const delta = y - last
        last = y
        setFloating(y > 8)
        if (delta > 0 && openRef.current) close()
      })
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", onScroll)
    }
  }, [close])

  // The logo takes the colour of whatever section sits under the bar.
  useEffect(() => {
    const line = 30
    let observer: IntersectionObserver | null = null
    const build = () => {
      observer?.disconnect()
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const next = (entry.target as HTMLElement).dataset.navTone
              setTone(next === "brand" || next === "light" ? next : "dark")
            }
          }
        },
        { rootMargin: `-${line}px 0px -${Math.max(0, window.innerHeight - line - 1)}px 0px` },
      )
      document.querySelectorAll<HTMLElement>("[data-nav-tone]").forEach((el) => observer?.observe(el))
    }
    build()
    window.addEventListener("resize", build)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", build)
    }
  }, [pathname])

  // Close everything on navigation and on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close()
        setSheet(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])

  useEffect(() => {
    document.documentElement.style.overflow = sheet ? "hidden" : ""
  }, [sheet])

  const moveHighlight = (el: HTMLElement) => {
    setHighlight((h) => ({ x: el.offsetLeft, w: el.offsetWidth, on: true, jump: !h.on }))
  }

  const openMenu = (id: MenuId, el: HTMLElement, immediate: boolean) => {
    clearTimers()
    const run = () => {
      const prev = openRef.current
      if (prev && prev !== id) setDirection(MENU_ORDER.indexOf(id) > MENU_ORDER.indexOf(prev) ? 1 : -1)
      setPanelJump(!prev)
      openRef.current = id
      setOpen(id)
      const bar = barRef.current
      const list = listRef.current
      if (bar && list) {
        const center = list.offsetLeft + el.offsetLeft + el.offsetWidth / 2
        const width = sizes[id].w
        setPanelX(Math.max(0, Math.min(center - width / 2, bar.offsetWidth - width)))
      }
    }
    if (immediate || openRef.current) run()
    else openTimer.current = setTimeout(run, 70)
  }

  const scheduleClose = () => {
    clearTimers()
    closeTimer.current = setTimeout(close, 140)
  }

  const size = open ? sizes[open] : null
  // The open sheet is always dark, whatever section sits under it.
  const logoColor = sheet ? "text-brand" : tone === "brand" ? "text-brand-ink" : tone === "light" ? "text-canvas" : "text-brand"

  return (
    <>
      {/* The page dims behind an open menu: attention goes to the panel. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-0 z-40 bg-canvas/55 backdrop-blur-[3px] transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50",
        )}
        onMouseLeave={scheduleClose}
        onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
      >
        <div className="container-site pt-3">
          <div
            ref={barRef}
            className={cn(
              "nav-bar relative flex h-[52px] items-center rounded-[16px] pr-2 pl-4 transition-[background-color,box-shadow,backdrop-filter] duration-500",
              floating ? "nav-bar--floating" : "",
              // Over the yellow card the dark glass turns olive; there the bar
              // goes to a pale wash with ink links instead.
              tone === "brand" && !sheet && "nav-bar--on-brand",
            )}
          >
            {/* Logo: stays put in every state, recoloured by the section below it. */}
            <Link
              href="/"
              aria-label="i10 home"
              // .nav-logo hands off to the footer's mark once that scrolls in
              // (see FooterLogo): one i10 on screen at a time.
              className={cn("nav-logo relative z-10 -ml-2 flex h-10 items-center rounded-[12px] px-2", logoColor)}
              onMouseEnter={scheduleClose}
            >
              <Mark className="h-[19px] w-auto" shapeRendering="geometricPrecision" />
            </Link>

            <div className="ml-6 hidden flex-1 items-center md:flex">
              <ul
                ref={listRef}
                className="relative flex items-center"
                onMouseLeave={() => !openRef.current && setHighlight((h) => ({ ...h, on: false }))}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-0 h-8 rounded-[9px] bg-white/[0.07] ease-[var(--ease-out-quint)]"
                  style={{
                    transition: highlight.jump ? "opacity 200ms linear" : "transform 260ms, width 260ms, opacity 260ms",
                    transitionTimingFunction: "var(--ease-out-quint)",
                    width: highlight.w,
                    transform: `translate3d(${highlight.x}px, -50%, 0)`,
                    opacity: highlight.on ? 1 : 0,
                  }}
                />
                {MENUS.map((menu) => (
                  <li key={menu.id}>
                    <button
                      type="button"
                      aria-expanded={open === menu.id}
                      aria-controls="site-nav-viewport"
                      onMouseEnter={(e) => {
                        moveHighlight(e.currentTarget)
                        openMenu(menu.id, e.currentTarget, false)
                      }}
                      onFocus={(e) => moveHighlight(e.currentTarget)}
                      onClick={(e) => (open === menu.id ? close() : openMenu(menu.id, e.currentTarget, true))}
                      className={cn(
                        "relative flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] px-3 text-[13.5px] transition-colors duration-[120ms]",
                        open === menu.id ? "text-fg" : "text-fg-2 hover:text-fg",
                      )}
                    >
                      {menu.label}
                      <Chevron
                        className={cn("mt-px text-fg-4 transition-transform duration-300", open === menu.id && "rotate-180 text-fg-2")}
                      />
                    </button>
                  </li>
                ))}
                {LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      onMouseEnter={(e) => {
                        moveHighlight(e.currentTarget)
                        closeMenuOnly()
                      }}
                      onFocus={(e) => moveHighlight(e.currentTarget)}
                      className={cn(
                        "relative flex h-8 items-center gap-1 rounded-[9px] px-3 text-[13.5px] transition-colors duration-[120ms] hover:text-fg",
                        pathname === link.href ? "text-fg" : "text-fg-2",
                      )}
                    >
                      {link.label}
                      {link.external ? <ArrowUpRight className="text-fg-4" /> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Right side: one action. Signed in it opens the dashboard; signed
                out it goes to the auth page, which both signs in and signs up,
                so a separate "Log in" would be a second door to the same room. */}
            <div className="ml-auto flex items-center gap-1.5">
              <Link
                href={signedIn ? hosts.dashboard : hosts.signIn}
                onMouseEnter={scheduleClose}
                // Wears the logo's colour: yellow on the dark page, white over
                // the yellow card (where the logo goes ink).
                className={cn(
                  "nav-cta group/btn relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-[11px] px-3.5 text-[13px] font-[540] text-brand-ink transition-[background-color,filter] duration-500",
                  tone === "brand" && !sheet ? "bg-fg hover:bg-white" : "bg-brand hover:brightness-105",
                )}
              >
                <span className="relative">{signedIn ? "Open dashboard" : "Start sending"}</span>
                <Arrow />
              </Link>
              <button
                type="button"
                aria-label={sheet ? "Close menu" : "Open menu"}
                aria-expanded={sheet}
                onClick={() => setSheet((s) => !s)}
                className={cn(
                  "relative grid size-9 cursor-pointer place-items-center rounded-[11px] transition-colors duration-500 md:hidden",
                  tone === "brand" && !sheet ? "text-brand-ink hover:bg-black/[0.06]" : "text-fg-2 hover:bg-white/[0.06]",
                )}
              >
                <span
                  className={cn(
                    "absolute h-[1.5px] w-4 rounded-full bg-current transition-transform duration-300",
                    sheet ? "rotate-45" : "-translate-y-[3.5px]",
                  )}
                />
                <span
                  className={cn(
                    "absolute h-[1.5px] w-4 rounded-full bg-current transition-transform duration-300",
                    sheet ? "-rotate-45" : "translate-y-[3.5px]",
                  )}
                />
              </button>
            </div>

            {/* One viewport for every menu: it resizes, slides to the trigger, and the content crosses over. */}
            <div
              id="site-nav-viewport"
              className={cn(
                "nav-viewport absolute top-[calc(100%+8px)] left-0 hidden overflow-hidden rounded-[16px] md:block",
                open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
              )}
              style={{
                width: size?.w,
                height: size?.h,
                transform: `translate3d(${panelX}px, ${open ? 0 : -4}px, 0)`,
                ...(panelJump ? { transition: "opacity 180ms linear" } : {}),
              }}
              onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
            >
              <PanelSlot id="product" open={open} direction={direction} register={registerPanel}>
                <ProductPanel onNavigate={close} />
              </PanelSlot>
              <PanelSlot id="developers" open={open} direction={direction} register={registerPanel}>
                <DevelopersPanel onNavigate={close} />
              </PanelSlot>
              <PanelSlot id="resources" open={open} direction={direction} register={registerPanel}>
                <ResourcesPanel onNavigate={close} />
              </PanelSlot>
            </div>
          </div>
        </div>
      </header>

      <MobileSheet open={sheet} onClose={() => setSheet(false)} />
    </>
  )
}

function PanelSlot({
  id,
  open,
  direction,
  register,
  children,
}: {
  id: MenuId
  open: MenuId | null
  direction: 1 | -1
  register: (id: MenuId, el: HTMLDivElement | null) => void
  children: ReactNode
}) {
  const active = open === id
  return (
    <div
      ref={(el) => register(id, el)}
      aria-hidden={!active}
      inert={!active}
      className="absolute top-0 left-0 w-max ease-[var(--ease-out-quint)]"
      style={{
        opacity: active ? 1 : 0,
        transform: `translate3d(${active ? 0 : direction * -28}px, 0, 0)`,
        filter: active ? "none" : "blur(3px)",
        // The outgoing panel clears quickly; the incoming one waits a beat, so
        // the two never sit on top of each other at half opacity.
        transition: active
          ? "opacity 260ms linear 70ms, transform 420ms var(--ease-out-quint), filter 260ms linear 70ms"
          : "opacity 120ms linear, transform 420ms var(--ease-out-quint), filter 160ms linear",
      }}
    >
      {children}
    </div>
  )
}

function MobileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = [
    { title: "Product", items: productNav },
    { title: "Developers", items: developerNav },
    { title: "Resources", items: resourceNav },
  ]
  return (
    <div
      className={cn(
        "fixed inset-0 z-40 overflow-y-auto bg-canvas/98 px-4 pt-20 pb-10 backdrop-blur-xl transition-[opacity,visibility] duration-300 md:hidden",
        open ? "visible opacity-100" : "invisible opacity-0",
      )}
      data-lenis-prevent
      inert={!open}
    >
      <nav aria-label="Mobile" className="flex flex-col gap-8">
        {groups.map((group, gi) => (
          <div
            key={group.title}
            className="transition-[opacity,transform] duration-500 ease-[var(--ease-out-expo)]"
            style={{ transitionDelay: open ? `${60 + gi * 50}ms` : "0ms", opacity: open ? 1 : 0, transform: open ? "none" : "translateY(10px)" }}
          >
            <p className="type-label mb-2 px-2 text-fg-4">{group.title}</p>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={onClose} className="group flex items-center gap-3 rounded-xl p-2 active:bg-white/5">
                    {item.icon ? <IconTile icon={item.icon} hue={item.hue} size="sm" /> : null}
                    <span className="text-[15px] text-fg">{item.title}</span>
                    {item.badge ? <Badge kind={item.badge} /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex flex-col gap-2 border-t border-line pt-6">
          <Link href="/pricing" onClick={onClose} className="px-2 py-2 text-[15px] text-fg">
            Pricing
          </Link>
        </div>
      </nav>
    </div>
  )
}
