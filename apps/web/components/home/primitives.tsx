"use client"

import { cn } from "cn"
import { BrandIcon, type BrandName } from "@/components/brand/brand-icon"
import { Mark } from "@/components/brand/mark"
import { PixelIcon } from "@/components/brand/pixel-icon"
import { Frame, SectionHeader, Eyebrow } from "@/components/site/section"
import { ButtonLink } from "@/components/ui/button-link"
import { hosts } from "@/lib/site"

/*
 * Vercel's /ai row: three hairline-framed stages, each a small animated
 * diagram, each with a sentence that starts with its name in white.
 */
export function Primitives() {
  return (
    <Frame className="py-24 md:py-32">
      <SectionHeader
        eyebrow={<Eyebrow>Under the hood</Eyebrow>}
        title="Small primitives,"
        muted="done properly."
        description="The parts nobody sees are the parts that decide whether a password reset arrives in four seconds or four hours."
      />
      <div className="mt-14 grid gap-10 md:grid-cols-3 md:gap-5">
        <Card
          stage={<Orbit />}
          name="Inbox reach."
          body="SPF and DKIM align from the first send, so Gmail, Outlook and iCloud see your domain, not ours."
          href="/product/deliverability"
        />
        <Card
          stage={<Pipeline />}
          name="The send path."
          body="Accepted, signed and handed to Frankfurt in milliseconds, with every step written to the log."
          href="/product/email-api"
        />
        <Card
          stage={<FileTree />}
          name="Templates in git."
          body="Connect a repository and a push to main makes the next version live. No deploy, no copy-paste."
          href="/product/templates"
        />
      </div>
    </Frame>
  )
}

function Card({ stage, name, body, href }: { stage: React.ReactNode; name: string; body: string; href: string }) {
  return (
    <div data-reveal className="flex flex-col">
      <div className="relative h-[280px] overflow-hidden border border-line bg-canvas">{stage}</div>
      <p className="mt-6 text-[17px] leading-[26px] tracking-[-0.01em] text-fg-3">
        <span className="text-fg">{name}</span> {body}
      </p>
      <div className="mt-5 flex items-center gap-4">
        <ButtonLink href={hosts.signUp} size="sm">
          Start now
        </ButtonLink>
        <ButtonLink href={href} variant="ghost" arrow>
          Learn more
        </ButtonLink>
      </div>
    </div>
  )
}

const ORBIT: BrandName[] = ["gmail", "outlook", "icloud", "proton", "zoho", "apple", "thunderbird", "gmail", "outlook", "icloud"]

function Orbit() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <svg aria-hidden viewBox="0 0 400 280" className="absolute inset-0 size-full">
        <ellipse cx="200" cy="250" rx="190" ry="190" fill="none" stroke="var(--line-strong)" strokeDasharray="3 5" />
        <ellipse cx="200" cy="250" rx="130" ry="130" fill="none" stroke="var(--line)" />
        <ellipse cx="200" cy="250" rx="70" ry="70" fill="none" stroke="var(--line)" strokeDasharray="1 4" />
      </svg>
      <div className="orbit-ring absolute top-[250px] left-1/2 size-0">
        {ORBIT.map((name, i) => {
          const a = (i / ORBIT.length) * Math.PI * 2
          const r = i % 2 === 0 ? 190 : 130
          return (
            <span
              key={`${name}-${i}`}
              className="orbit-node absolute grid size-9 place-items-center rounded-full bg-surface-2 text-fg-2 shadow-[inset_0_0_0_1px_var(--line-strong)]"
              style={{ transform: `translate(-50%, -50%) translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px)` }}
            >
              <span className="orbit-counter grid place-items-center">
                <BrandIcon name={name} size={15} />
              </span>
            </span>
          )
        })}
      </div>
      <span className="absolute top-[250px] left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-fg text-brand-ink shadow-[0_0_0_8px_rgb(255_255_255/0.04),0_0_60px_rgb(242_207_60/0.25)]">
        <Mark className="h-3.5 w-auto" />
      </span>
    </div>
  )
}

const STEPS = [
  { t: "POST /emails", d: "202 accepted" },
  { t: "Idempotency", d: "first use of welcome-maya" },
  { t: "Render", d: "template welcome · v14" },
  { t: "Sign", d: "DKIM d=acme.co s=i10" },
  { t: "Relay", d: "SES · eu-central-1" },
  { t: "Deliver", d: "250 2.0.0 OK" },
  { t: "Webhook", d: "email.delivered → 200" },
]

function Pipeline() {
  return (
    <div className="pipeline-mask absolute inset-x-6 inset-y-0">
      <div className="pipeline-track flex flex-col gap-3 py-3">
        {[...STEPS, ...STEPS].map((s, i) => (
          <div key={i} className="rounded-[10px] bg-surface-1 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
            <p className="flex items-center gap-2 text-[12.5px] text-fg">
              <span className="font-mono text-fg-4">&gt;_</span> {s.t}
            </p>
            <p className="mt-1 flex items-center gap-2 font-mono text-[11.5px] text-fg-3">
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden className="text-delivered">
                <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {s.d}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function FileTree() {
  const files = [
    { name: "welcome.tsx", icon: "code" as const, active: true },
    { name: "receipt.tsx", icon: "code" as const },
    { name: "reset-password.tsx", icon: "code" as const },
    { name: "digest.tsx", icon: "code" as const },
  ]
  return (
    <div className="absolute inset-0">
      <div aria-hidden className="absolute inset-0">
        <div className="absolute top-10 left-0 h-12 w-[16%] border border-line" />
        <div className="absolute right-0 bottom-16 h-10 w-[18%] border border-line" />
        <div className="absolute top-[45%] right-[6%] h-px w-[20%] bg-line" />
        <div className="absolute top-[45%] left-[6%] h-px w-[20%] bg-line" />
      </div>
      <div className="absolute inset-x-[16%] top-5 rounded-[12px] bg-surface-1 p-2 shadow-[inset_0_0_0_1px_var(--line-strong),0_20px_40px_-20px_black]">
        <p className="flex items-center justify-between px-2 py-1.5 text-[12.5px] text-fg">
          <span className="flex items-center gap-2">
            <PixelIcon name="template" size={12} className="text-hue-template" /> emails/
          </span>
          <span className="font-mono text-[10.5px] text-fg-4">main</span>
        </p>
        {files.map((f) => (
          <p
            key={f.name}
            className={cn(
              "flex items-center gap-2 rounded-[7px] py-1.5 pr-2 pl-6 text-[12.5px]",
              f.active ? "bg-white/[0.05] text-fg" : "text-fg-3",
            )}
          >
            <span className="font-mono text-[10px] text-hue-send">TS</span>
            {f.name}
            {f.active ? <span className="ml-auto font-mono text-[10px] text-delivered">+12 −3</span> : null}
          </p>
        ))}
      </div>
      <div className="absolute inset-x-[16%] bottom-5 flex items-center gap-2 rounded-[10px] bg-surface-1 px-3 py-2.5 font-mono text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line-strong)]">
        <span className="text-fg-4">$</span> git push origin main
        <span className="terminal-caret ml-0.5 h-3.5 w-[7px] bg-fg-2" />
      </div>
    </div>
  )
}
