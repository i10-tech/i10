"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  BadgeCheck,
  CircleDashed,
  Inbox,
  LoaderCircle,
  MailOpen,
  ShieldCheck,
  Star,
} from "lucide-react"
import { cn } from "cn"
import { useLiveDomain } from "@/components/domain-live"
import { EmailPreview } from "@/components/email-preview"
import { EASE } from "@/components/steps"
import { Wordmark } from "@/components/wordmark"

/**
 * Set-up's right half: one picture per step of what the step is about to
 * change, drawn live from what is being typed and checked (2026-10-03).
 *
 * ⚠ EACH PICTURE ANSWERS "WHAT IS THIS FOR", NOT "WHERE AM I". The rail on the
 * left already says where; this says why it matters - the name on an invoice,
 * the domain in somebody's inbox, the checks a receiving server runs, the email
 * itself arriving. The domain step's inbox is the same component /domains/new
 * shows beside its first step.
 *
 * ⚠ ONLY OPACITY AND A SMALL SCALE MOVE BETWEEN PICTURES, never position. The
 * panel is a fixed stage; sliding pictures across it would read as navigation,
 * and nothing here navigates.
 */
export type StageScene =
  | { kind: "workspace"; name: string }
  | { kind: "domain"; domain: string }
  | { kind: "verify" }
  | { kind: "send"; sent: boolean; from: string; to: string }

export function Stage({ scene }: { scene: StageScene }) {
  const reduce = useReducedMotion() ?? false
  return (
    <div className="relative h-full overflow-hidden">
      {/* The same square dots the events strip sits on, fading at the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-border [mask-image:radial-gradient(ellipse_at_center,#000_30%,transparent_75%)]"
        style={DOTS}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 left-1/2 size-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/6 blur-3xl"
      />
      <div className="relative grid h-full place-items-center p-10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={scene.kind}
            className="w-full max-w-md"
            initial={reduce ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {scene.kind === "workspace" && <InvoicePreview name={scene.name} />}
            {scene.kind === "domain" && <EmailPreview domain={scene.domain} />}
            {scene.kind === "verify" && <ChecksPreview />}
            {scene.kind === "send" && (
              <InboxPreview sent={scene.sent} from={scene.from} to={scene.to} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

const DOT_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Crect width='2' height='2'/%3E%3C/svg%3E")`
const DOTS: React.CSSProperties = {
  WebkitMaskImage: `${DOT_MASK}, radial-gradient(ellipse at center, #000 30%, transparent 75%)`,
  maskImage: `${DOT_MASK}, radial-gradient(ellipse at center, #000 30%, transparent 75%)`,
  WebkitMaskSize: "14px 14px, 100% 100%",
  maskSize: "14px 14px, 100% 100%",
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
}

/** The bar a value sits in until there is one, the body lines' grey. */
function Blank({ className }: { className?: string }) {
  return <span className={cn("inline-block h-3 rounded-full bg-muted", className)} />
}

/**
 * The workspace name where it ends up: at the top of an invoice.
 *
 * ⚠ THE FIELD'S HINT SAYS "WHAT APPEARS ON YOUR INVOICES", so the picture is
 * the invoice - the sentence, shown.
 */
function InvoicePreview({ name }: { name: string }) {
  return (
    <div className="rounded-3xl border bg-background/80 p-6 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-start justify-between">
        <Wordmark />
        <div className="text-right">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Invoice
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">INV-0001</p>
        </div>
      </div>

      <div className="mt-8">
        <p className="text-xs text-muted-foreground">Billed to</p>
        <div className="mt-1 h-7">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={name ? "named" : "blank"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="truncate font-display text-xl font-semibold tracking-tight"
            >
              {name || <Blank className="w-40 align-middle" />}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-6 space-y-3 border-t pt-5 text-sm">
        <Line label="Emails sent" />
        <Line label="Domains" />
        <div className="flex items-center justify-between border-t pt-3 font-medium">
          <span>Total</span>
          <span className="tabular">$0.00</span>
        </div>
      </div>
    </div>
  )
}

function Line({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <Blank className="w-14" />
    </div>
  )
}

/**
 * What a receiving mail server checks before it trusts a message, ticking off
 * as this domain's records are found.
 *
 * ⚠ LIVE, FROM THE SAME STATE AS THE VERIFY STEP'S EVENTS - the domain set-up
 * is watching (components/domain-live.tsx). A record found turns its row green
 * here at the moment the strip moves.
 */
function ChecksPreview() {
  const live = useLiveDomain()
  const records = live?.domain.records ?? []
  const delegated = live?.domain.delegated ?? false

  const purpose = (record: { record: string; name: string }) => {
    if (record.record !== "NS") return record.record
    const name = record.name.toLowerCase()
    if (name.startsWith("_domainkey.") || name.includes("._domainkey.")) return "DKIM"
    if (name.startsWith("_dmarc.")) return "DMARC"
    return "SPF"
  }
  const stateOf = (kind: string) => {
    const rows = records.filter((r) => purpose(r) === kind)
    if (rows.length === 0) return "pending"
    return rows.every((r) => r.status === "verified") ? "verified" : "pending"
  }

  const checks = [
    { kind: "DKIM", what: "Signed by you", icon: ShieldCheck },
    { kind: "SPF", what: "Allowed to send", icon: BadgeCheck },
    { kind: "DMARC", what: "Policy published", icon: Star },
  ] as const

  return (
    <div className="rounded-3xl border bg-background/80 p-6 shadow-2xl shadow-black/20 backdrop-blur">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        What inboxes check
      </p>
      <p className="mt-1 truncate font-mono text-sm">
        {live?.domain.name ?? (
          <span className="text-muted-foreground">No domain yet</span>
        )}
      </p>
      <ul className="mt-5 space-y-2">
        {checks.map(({ kind, what, icon: Icon }) => {
          const ok = live ? stateOf(kind) === "verified" : false
          return (
            <li
              key={kind}
              className={cn(
                "flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors duration-500",
                ok && "border-emerald-500/30 bg-emerald-500/8",
              )}
            >
              <span
                className={cn(
                  "grid size-9 place-items-center rounded-xl border bg-linear-to-b from-muted/80 to-background transition-colors duration-500",
                  ok ? "text-emerald-500" : "text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{kind}</span>
                <span className="block text-xs text-muted-foreground">{what}</span>
              </span>
              {ok ? (
                <BadgeCheck aria-label="Found" className="size-4 text-emerald-500" />
              ) : live ? (
                <LoaderCircle
                  aria-label="Looking"
                  className="size-4 text-warning motion-safe:animate-spin"
                />
              ) : (
                <CircleDashed
                  aria-label="Not yet"
                  className="size-4 text-muted-foreground/50"
                />
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        {!live
          ? "Add a domain and these fill in as we find its records."
          : delegated
            ? "Delegated: we serve these records ourselves once your NS records resolve."
            : "Each turns green as we find its record in your DNS."}
      </p>
    </div>
  )
}

/**
 * An inbox, and - once "Send email" has been pressed - the email in it.
 *
 * ⚠ THE NEW ROW ARRIVES THE WAY MAIL DOES: at the top, pushing the others down,
 * unread. It is a picture of the send that just happened, not of a fetch; the
 * real message is in the Emails log and the person's actual inbox.
 */
function InboxPreview({ sent, from, to }: { sent: boolean; from: string; to: string }) {
  const reduce = useReducedMotion() ?? false
  const older = [
    { who: "Your team", subject: "Weekly sync notes", w: "w-24" },
    { who: "Billing", subject: "Your receipt", w: "w-20" },
    { who: "Calendar", subject: "Reminder: launch review", w: "w-28" },
  ]
  return (
    <div className="overflow-hidden rounded-3xl border bg-background/80 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-center gap-2 border-b px-5 py-3.5">
        <Inbox className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Inbox</span>
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {to}
        </span>
      </div>
      <ul className="divide-y">
        <AnimatePresence initial={false}>
          {sent && (
            <motion.li
              key="first"
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.45, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="flex items-start gap-3 bg-emerald-500/6 px-5 py-4">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-sky-500" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <span className="truncate">{from}</span>
                    <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                      now
                    </span>
                  </p>
                  <p className="truncate text-sm">Welcome</p>
                  <p className="truncate text-xs text-muted-foreground">
                    You can start exploring right away, set up your workspace, and
                    invite your team.
                  </p>
                </div>
              </div>
            </motion.li>
          )}
        </AnimatePresence>
        {older.map((mail) => (
          <motion.li
            key={mail.subject}
            layout={!reduce}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex items-start gap-3 px-5 py-4 opacity-50"
          >
            <MailOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm">{mail.who}</p>
              <Blank className={mail.w} />
            </div>
          </motion.li>
        ))}
      </ul>
      {!sent && (
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          Press Send email and it lands here - and in your real inbox.
        </p>
      )}
    </div>
  )
}
