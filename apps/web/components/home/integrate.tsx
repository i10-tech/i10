"use client"

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { BrandIcon, type BrandName } from "@/components/brand/brand-icon"
import { PixelIcon } from "@/components/brand/pixel-icon"
import { Eyebrow, Frame, SectionHeader } from "@/components/site/section"
import { Pill } from "@/components/ui/badge"
import { highlight } from "@/components/ui/code"
import { CopyButton } from "@/components/ui/copy-button"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"

/*
 * "Keep your code. Change one import." The claim, shown instead of said: the
 * Node tab opens on a diff from `resend` to `@i10/node` that plays itself the
 * first time the window scrolls in. The other tabs are the same send in plain
 * HTTP - i10 is an API first, the SDKs are conveniences.
 *
 * Beside it, Resend's two best cards, rebuilt for i10: test mode (an
 * `i10_test_` key accepts sends and fires events without delivering) and a
 * webhook stream signed to the Standard Webhooks spec.
 */
type Lang = { id: string; label: string; icon: BrandName; file: string; lang: "ts" | "sh" | "py" | "go"; lines: { t: string; d?: "-" | "+" }[] }

const LANGS: Lang[] = [
  {
    id: "node",
    label: "Node.js",
    icon: "node",
    file: "send.ts",
    lang: "ts",
    lines: [
      { t: 'import { Resend } from "resend"', d: "-" },
      { t: 'import { I10 } from "@i10/node"', d: "+" },
      { t: "" },
      { t: "const client = new Resend(process.env.RESEND_API_KEY)", d: "-" },
      { t: "const client = new I10(process.env.I10_API_KEY)", d: "+" },
      { t: "" },
      { t: "await client.emails.send({" },
      { t: '  from: "Acme <hello@acme.co>",' },
      { t: '  to: "maya@northwind.dev",' },
      { t: '  subject: "Welcome to Acme",' },
      { t: '  html: "<p>Glad you are here.</p>",' },
      { t: '}, { idempotencyKey: "welcome-maya" })' },
    ],
  },
  {
    id: "next",
    label: "Next.js",
    icon: "next",
    file: "app/api/webhooks/route.ts",
    lang: "ts",
    lines: [
      { t: 'import { createWebhookHandler } from "@i10/next"' },
      { t: "" },
      { t: "// Standard Webhooks: id, timestamp and body are all signed." },
      { t: "export const POST = createWebhookHandler({" },
      { t: "  secret: process.env.I10_WEBHOOK_SECRET!," },
      { t: "  onEvent: async (event) => {" },
      { t: '    if (event.type === "email.bounced") {' },
      { t: "      await suppress(event.data.to)" },
      { t: "    }" },
      { t: "  }," },
      { t: "})" },
    ],
  },
  {
    id: "curl",
    label: "cURL",
    icon: "javascript",
    file: "terminal",
    lang: "sh",
    lines: [
      { t: 'curl "https://api.i10.tech/emails" \\' },
      { t: '  -H "Authorization: Bearer $I10_API_KEY" \\' },
      { t: '  -H "Idempotency-Key: welcome-maya" \\' },
      { t: '  -H "Content-Type: application/json" \\' },
      { t: "  -d '{" },
      { t: '    "from": "Acme <hello@acme.co>",' },
      { t: '    "to": "maya@northwind.dev",' },
      { t: '    "subject": "Welcome to Acme",' },
      { t: '    "html": "<p>Glad you are here.</p>"' },
      { t: "  }'" },
    ],
  },
  {
    id: "python",
    label: "Python",
    icon: "python",
    file: "send.py",
    lang: "py",
    lines: [
      { t: "import os, httpx" },
      { t: "" },
      { t: "httpx.post(" },
      { t: '    "https://api.i10.tech/emails",' },
      { t: '    headers={"Authorization": f"Bearer {os.environ[\'I10_API_KEY\']}"},' },
      { t: "    json={" },
      { t: '        "from": "Acme <hello@acme.co>",' },
      { t: '        "to": "maya@northwind.dev",' },
      { t: '        "subject": "Welcome to Acme",' },
      { t: '        "html": "<p>Glad you are here.</p>",' },
      { t: "    }," },
      { t: ")" },
    ],
  },
  {
    id: "go",
    label: "Go",
    icon: "go",
    file: "main.go",
    lang: "go",
    lines: [
      { t: "body := strings.NewReader(`{" },
      { t: '  "from": "Acme <hello@acme.co>",' },
      { t: '  "to": "maya@northwind.dev",' },
      { t: '  "subject": "Welcome to Acme",' },
      { t: '  "html": "<p>Glad you are here.</p>"' },
      { t: "}`)" },
      { t: 'req, _ := http.NewRequest("POST", "https://api.i10.tech/emails", body)' },
      { t: 'req.Header.Set("Authorization", "Bearer "+os.Getenv("I10_API_KEY"))' },
      { t: "res, err := http.DefaultClient.Do(req)" },
    ],
  },
]

export function Integrate() {
  return (
    <Frame className="py-24 md:py-32" id="integrate">
      <SectionHeader
        eyebrow={<Eyebrow>Integrate</Eyebrow>}
        title="Keep your code."
        muted="Change one import."
        description="The same requests, responses and error names as Resend, on purpose. Swap the package, keep every call site, and send your first email before the coffee is ready."
      />
      <div className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <CodeWindow />
        {/* ⚠ minmax(0, 1fr), NOT the implicit auto track. An auto track grows to
            its widest nowrap line (the test log's UUID), which pushed a 375px
            page out to 494px and dragged the fixed nav along with it. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <TestMode />
          <WebhookStream />
        </div>
      </div>
    </Frame>
  )
}

function CodeWindow() {
  const [tab, setTab] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const active = LANGS[tab]!

  // The first time the window scrolls in, the diff plays: removed lines dim
  // and strike through, added lines slide in and light up.
  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const removed = gsap.utils.toArray<HTMLElement>("[data-diff='-']", root.current)
      const added = gsap.utils.toArray<HTMLElement>("[data-diff='+']", root.current)
      if (!removed.length) return
      const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "top 70%", once: true } })
      tl.fromTo(removed, { opacity: 1 }, { opacity: 0.45, duration: 0.5, stagger: 0.2 })
        .fromTo(
          removed.map((r) => r.querySelector("[data-strike]")),
          { scaleX: 0 },
          { scaleX: 1, duration: 0.5, stagger: 0.2, ease: "site.inOut" },
          0,
        )
        .fromTo(added, { opacity: 0, x: -10, height: 0 }, { opacity: 1, x: 0, height: "auto", duration: 0.7, stagger: 0.25 }, 0.45)
    },
    { scope: root },
  )

  const text = active.lines.filter((l) => l.d !== "-").map((l) => l.t).join("\n")

  return (
    <div ref={root} data-reveal className="code-window flex min-w-0 flex-col overflow-hidden rounded-[16px] bg-surface-1">
      <div className="flex items-center justify-between border-b border-line pr-2">
        <div role="tablist" aria-label="Language" className="flex min-w-0 overflow-x-auto [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,#000_78%,transparent)]">
          {LANGS.map((l, i) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={i === tab}
              onClick={() => setTab(i)}
              className={cn(
                "relative flex h-11 shrink-0 cursor-pointer items-center gap-2 px-4 text-[12.5px] transition-colors",
                i === tab ? "text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {l.id === "curl" ? <PixelIcon name="terminal" size={13} /> : <BrandIcon name={l.icon} size={13} />}
              {l.label}
              {i === tab ? (
                <motion.span layoutId="code-tab" className="absolute inset-x-3 -bottom-px h-px bg-brand" transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} />
              ) : null}
            </button>
          ))}
        </div>
        <CopyButton value={text} />
      </div>
      <div className="flex items-center gap-2 border-b border-line-faint px-4 py-2 font-mono text-[11px] text-fg-4">
        <span className="size-1.5 rounded-full bg-fg-4" />
        {active.file}
      </div>
      {/* ⚠ NO data-lenis-prevent. It hands the wheel to this box, and with
          nothing to scroll vertically (plus overscroll-behavior: contain)
          the page stopped dead whenever the pointer crossed the code.
          Horizontal scrolling for long lines still works natively. */}
      <div className="relative min-h-[340px] flex-1 overflow-x-auto py-4 font-mono text-[12.5px] leading-[22px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.pre
            key={active.id}
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -4, filter: "blur(4px)" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="min-w-max"
          >
            {active.lines.map((line, i) => (
              <div
                key={i}
                data-diff={line.d}
                className={cn(
                  "relative flex overflow-hidden pr-6",
                  line.d === "-" && "bg-bounced/[0.07]",
                  line.d === "+" && "bg-delivered/[0.07]",
                )}
              >
                <span className="w-12 shrink-0 pr-4 text-right text-fg-4 select-none">{i + 1}</span>
                <span className={cn("w-4 shrink-0 select-none", line.d === "-" ? "text-bounced" : "text-delivered")}>{line.d ?? ""}</span>
                <span className="relative whitespace-pre">
                  {highlight(line.t, active.lang === "go" ? "go" : active.lang)}
                  {line.d === "-" ? (
                    <span data-strike aria-hidden className="absolute inset-x-0 top-1/2 h-px origin-left scale-x-0 bg-bounced/70" />
                  ) : null}
                </span>
              </div>
            ))}
          </motion.pre>
        </AnimatePresence>
      </div>
    </div>
  )
}

const TEST_TARGETS = ["delivered", "bounced", "complained"] as const

function TestMode() {
  const [target, setTarget] = useState<(typeof TEST_TARGETS)[number]>("delivered")
  const [log, setLog] = useState<{ id: string; status: number; target: string }[]>([
    { id: "0e4c7a1d-5b7f-4b62-9c1a-2f5d8e0a41b7", status: 202, target: "delivered" },
  ])
  const send = () =>
    setLog((prev) => [{ id: crypto.randomUUID(), status: 202, target }, ...prev].slice(0, 4))

  return (
    <div data-reveal className="flex flex-col rounded-[16px] bg-surface-1 p-5 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-[14px] font-[540] text-fg">Test mode</span>
          <Pill className="normal-case tracking-normal">i10_test_</Pill>
        </div>
        <span className="font-mono text-[10.5px] text-fg-4">nothing leaves i10</span>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-[12px] bg-canvas p-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="flex flex-1 gap-1">
          {TEST_TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTarget(t)}
              className={cn(
                "relative h-8 flex-1 cursor-pointer rounded-[8px] text-[12px] capitalize transition-colors",
                target === t ? "text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {target === t ? (
                <motion.span layoutId="test-target" className="absolute inset-0 rounded-[8px] bg-white/[0.07]" transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }} />
              ) : null}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={send}
          className="h-8 cursor-pointer rounded-[8px] bg-fg px-3.5 text-[12px] font-[540] text-brand-ink transition-transform active:scale-[0.97]"
        >
          Send
        </button>
      </div>
      {/* Pinned to four rows from the start, and popLayout takes the leaving
          row out of the flow at once, so a send never changes the card's
          height: the new row slides in and pushes the rest down. */}
      <ul className="relative mt-4 flex h-[92px] flex-col gap-1 overflow-hidden font-mono text-[11.5px]">
        <AnimatePresence initial={false} mode="popLayout">
          {log.map((row, i) => (
            <motion.li
              key={row.id}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1 - i * 0.22, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="flex h-[20px] shrink-0 items-center gap-3 truncate"
            >
              <span className="text-delivered">{row.status}</span>
              <span className="truncate text-fg-3">
                {"{ "}&quot;id&quot;: &quot;<span className="text-fg-2">{row.id}</span>&quot;{" }"}
              </span>
              <span className="ml-auto shrink-0 text-fg-4">{row.target}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  )
}

const EVENTS = [
  { type: "email.delivered", tone: "text-delivered", detail: "to maya@northwind.dev", icon: "send" as const },
  { type: "email.opened", tone: "text-hue-mail", detail: "Apple Mail · macOS", icon: "mailbox" as const },
  { type: "email.clicked", tone: "text-queued", detail: "acme.co/welcome", icon: "migrate" as const },
  { type: "email.bounced", tone: "text-bounced", detail: "550 5.1.1 · hard bounce", icon: "shield" as const },
  { type: "email.complained", tone: "text-complained", detail: "feedback loop · Yahoo", icon: "status" as const },
]

function WebhookStream() {
  const [items, setItems] = useState(() => EVENTS.slice(0, 3).map((e, i) => ({ ...e, key: i, at: `03:09:${41 - i * 2}` })))
  const root = useRef<HTMLDivElement>(null)
  const next = useRef(3)

  useEffect(() => {
    if (prefersReducedMotion()) return
    let visible = false
    const io = new IntersectionObserver(([e]) => (visible = Boolean(e?.isIntersecting)))
    if (root.current) io.observe(root.current)
    const id = setInterval(() => {
      if (!visible) return
      const n = next.current++
      const e = EVENTS[n % EVENTS.length]!
      const s = 41 + (n - 2) * 2
      setItems((prev) => [{ ...e, key: n, at: `03:${String(9 + Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` }, ...prev].slice(0, 3))
    }, 2600)
    return () => {
      clearInterval(id)
      io.disconnect()
    }
  }, [])

  return (
    <div ref={root} data-reveal className="flex flex-col overflow-hidden rounded-[16px] bg-surface-1 p-5 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-[540] text-fg">Webhooks</span>
        <span className="font-mono text-[10.5px] text-fg-4">signed · retried · replayable</span>
      </div>
      {/* Same as the test log: three rows, fixed, and the leaving row pops
          out of the flow instead of stretching the card for a beat. */}
      <ul className="relative mt-4 flex h-[141px] flex-col overflow-hidden">
        <span aria-hidden className="absolute top-3 bottom-3 left-[15px] w-px bg-line" />
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => (
            <motion.li
              key={item.key}
              layout
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="relative flex h-[47px] shrink-0 items-center gap-3"
            >
              <span className={cn("relative grid size-[31px] shrink-0 place-items-center rounded-[9px] bg-surface-3 shadow-[inset_0_0_0_1px_var(--line)]", item.tone)}>
                <PixelIcon name={item.icon} size={13} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn("font-mono text-[12px]", item.tone)}>{item.type}</span>
                <span className="truncate text-[11.5px] text-fg-3">{item.detail}</span>
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-4">{item.at}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  )
}
