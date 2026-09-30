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
  const [highlight, setHighlight] = useState<{ x: number; w: number; on: boolean }>({ x: 0, w: 0, on: false })
  const [panelX, setPanelX] = useState(0)
  const [sizes, setSizes] = useState<Record<MenuId, { w: number; h: number }>>({
    product: { w: 760, h: 300 },
    developers: { w: 700, h: 280 },
    resources: { w: 640, h: 260 },
  })
  const [floating, setFloating] = useState(false)
  const [compact, setCompact] = useState(false)
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

  // Floating after the first few pixels; compact while travelling down.
  useEffect(() => {
    let last = window.scrollY
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const y = window.scrollY
        const delta = y - last
        setFloating(y > 8)
        // Near the top the full bar always shows, however we got there (a
        // route change or an anchor jump arrives with no downward travel).
        if (y <= 240) {
          setCompact(false)
          last = y
        } else if (Math.abs(delta) > 4) {
          setCompact(delta > 0)
          last = y
        }
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
    setHighlight({ x: el.offsetLeft, w: el.offsetWidth, on: true })
  }

  const openMenu = (id: MenuId, el: HTMLElement, immediate: boolean) => {
    clearTimers()
    const run = () => {
      const prev = openRef.current
      if (prev && prev !== id) setDirection(MENU_ORDER.indexOf(id) > MENU_ORDER.indexOf(prev) ? 1 : -1)
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
          "fixed inset-x-0 top-0 z-50 transition-transform duration-500 ease-[var(--ease-out-expo)]",
          compact && !sheet ? "-translate-y-1" : "translate-y-0",
        )}
        onMouseLeave={scheduleClose}
        onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
      >
        <div className="container-site pt-3">
          <div
            ref={barRef}
            className={cn(
              "nav-bar relative flex h-[52px] items-center rounded-[16px] pr-2 pl-4 transition-[background-color,box-shadow,backdrop-filter] duration-500",
              floating && !compact ? "nav-bar--floating" : "",
            )}
          >
            {/* Logo: stays put in every state, recoloured by the section below it. */}
            <Link
              href="/"
              aria-label="i10 home"
              className={cn(
                "relative z-10 -ml-2 flex h-10 items-center rounded-[12px] px-2 transition-[color,background-color,box-shadow,backdrop-filter] duration-500",
                logoColor,
                // Alone on the page while compact: it gets its own glass chip so
                // it never sits bare on top of body text.
                // Over the yellow card a dark glass chip turns olive, so there
                // it becomes a faint ink wash instead.
                compact &&
                  (tone === "brand" && !sheet
                    ? "bg-[rgb(11_11_12/0.07)] shadow-[inset_0_0_0_1px_rgb(11_11_12/0.14)]"
                    : "bg-[rgb(14_14_17/0.62)] shadow-[inset_0_0_0_1px_var(--line)] backdrop-blur-lg"),
              )}
              onMouseEnter={scheduleClose}
            >
              <Mark className="h-[17px] w-auto" />
            </Link>

            {/* Links: fade and lift out while scrolling down. */}
            <div
              className={cn(
                "ml-6 hidden flex-1 items-center transition-[opacity,transform,filter] duration-300 md:flex",
                compact ? "pointer-events-none -translate-y-1 opacity-0 blur-[2px]" : "opacity-100",
              )}
            >
              <ul
                ref={listRef}
                className="relative flex items-center"
                onMouseLeave={() => !openRef.current && setHighlight((h) => ({ ...h, on: false }))}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-0 h-8 rounded-[9px] bg-white/[0.07] transition-[transform,width,opacity] duration-[260ms] ease-[var(--ease-out-quint)]"
                  style={{
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
                        scheduleClose()
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

            {/* Right side: the session-aware link and the one primary action. */}
            <div className="ml-auto flex items-center gap-1.5">
              <div
                className={cn(
                  "hidden transition-[opacity,transform] duration-300 md:block",
                  compact ? "pointer-events-none -translate-y-1 opacity-0" : "opacity-100",
                )}
              >
                <SessionLink signedIn={signedIn} />
              </div>
              <Link
                href={signedIn ? hosts.dashboard : hosts.signUp}
                onMouseEnter={scheduleClose}
                className="nav-cta group/btn relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-[11px] bg-fg px-3.5 text-[13px] font-[540] text-brand-ink transition-colors hover:bg-white"
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

      <MobileSheet open={sheet} onClose={() => setSheet(false)} signedIn={signedIn} />
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

/*
 * "Log in" and "Dashboard" occupy the same grid cell, so the link is always
 * as wide as the longer word and swapping them moves nothing beside it.
 */
function SessionLink({ signedIn }: { signedIn: boolean }) {
  return (
    <Link
      href={signedIn ? hosts.dashboard : hosts.signIn}
      className="grid h-9 items-center rounded-[11px] px-3 text-[13.5px] text-fg-2 transition-colors hover:bg-white/[0.05] hover:text-fg"
    >
      <span className={cn("col-start-1 row-start-1 transition-opacity", signedIn ? "opacity-0" : "opacity-100")} aria-hidden={signedIn}>
        Log in
      </span>
      <span className={cn("col-start-1 row-start-1 transition-opacity", signedIn ? "opacity-100" : "opacity-0")} aria-hidden={!signedIn}>
        Dashboard
      </span>
    </Link>
  )
}

function MobileSheet({ open, onClose, signedIn }: { open: boolean; onClose: () => void; signedIn: boolean }) {
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
          <Link href={signedIn ? hosts.dashboard : hosts.signIn} className="px-2 py-2 text-[15px] text-fg-2">
            {signedIn ? "Dashboard" : "Log in"}
          </Link>
        </div>
      </nav>
    </div>
  )
}
