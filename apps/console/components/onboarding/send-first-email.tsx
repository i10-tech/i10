"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  KeyRound,
  Lock,
  MailCheck,
  PartyPopper,
  Send,
  TriangleAlert,
} from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { AutoHeight } from "@repo/ui/components/auto-height"
import { Button } from "@repo/ui/components/button"
import { CopyButton, CopyField } from "@repo/ui/components/copy"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { cn } from "cn"
import { EASE } from "@/components/steps"
import { createApiKey, emailStatus, sendFirstEmail } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { toastError } from "@/lib/toast"
import type { CreatedApiKey } from "@/lib/types"

/**
 * Set-up's send step: a key, then the code - and a button that sends it.
 *
 * ⚠ "SEND EMAIL" IS THE SHORT WAY THROUGH THIS STEP, NOT A SHORTCUT AROUND IT
 * (2026-10-03). The snippet is still the thing somebody will paste into their
 * code; the button sends the same message down the same path, so finding out
 * that sending works no longer means copying a curl into a terminal. It is live
 * once there is a verified domain to send from, a key, and somewhere to send
 * it - and only once: the API replays a second press.
 *
 * ⚠ THE CONGRATULATIONS WAIT FOR DELIVERY, NOT FOR THE REQUEST. "Accepted" is
 * our queue saying yes; "delivered" is the receiving server saying it has it.
 * The step watches the message until one of those answers arrives, so the
 * moment it celebrates is the moment the email is really there - and Continue
 * only appears then, because before it there is nothing to continue from.
 */
type Delivery =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "watching"; id: string; to: string }
  | { phase: "delivered"; to: string; at: Date }
  | { phase: "late"; to: string }
  | { phase: "failed"; to: string; status: string }

/** How long to watch a send before saying "on its way" and letting them go on. */
const WATCH_FOR_MS = 60_000
const WATCH_EVERY_MS = 2_000

export function SendFirstEmail({
  from,
  verified,
  hasApiKey,
  recipient,
  onSent,
  onDone,
}: {
  /** The verified domain it sends from, or the best candidate before it is. */
  from: string | null
  verified: boolean
  hasApiKey: boolean
  /** The signed-in person's verified address, or null if they have none. */
  recipient: string | null
  /** Once it is delivered (or very nearly certainly on its way). */
  onSent: (sent: { to: string }) => void
  onDone: () => void
}) {
  const reduce = useReducedMotion() ?? false
  const [key, setKey] = React.useState<CreatedApiKey | null>(null)
  const outcome = useOutcome()
  const [typed, setTyped] = React.useState("")
  const [delivery, setDelivery] = React.useState<Delivery>({ phase: "idle" })

  const issued = key !== null || hasApiKey
  const sender = from ? `hello@${from}` : "hello@yourdomain.com"
  const typedOk = EMAIL.test(typed.trim())
  const to = recipient ?? (typed.trim() || "you@example.com")
  const secret = key?.secret ?? "i10_live_xxxxxxxxxxxxxxxx"

  async function mint() {
    if (outcome.state !== "idle") return
    let created: CreatedApiKey | null = null
    await outcome.run(
      async () => {
        const result = await createApiKey({
          name: "onboarding",
          mode: "live",
          domains: [],
        })
        if (!result.ok) {
          toastError("Could not create a key", result.error)
          return false
        }
        created = result.data
        return true
      },
      () => setKey(created),
    )
  }

  /*
   * ⚠ WATCHED UNTIL IT IS SETTLED, FOR A MINUTE AT MOST. Delivery is usually a
   * few seconds; a minute without an answer is "on its way" rather than a
   * failure, and the person can go on - the Emails log has the rest.
   */
  React.useEffect(() => {
    if (delivery.phase !== "watching") return
    const { id, to: sentTo } = delivery
    let stopped = false
    const started = Date.now()
    const tick = async () => {
      if (stopped) return
      const result = await emailStatus(id)
      if (stopped) return
      const status = result.ok ? result.data.status : null
      if (status === "delivered" || status === "opened" || status === "clicked") {
        setDelivery({ phase: "delivered", to: sentTo, at: new Date() })
        return
      }
      if (status === "bounced" || status === "failed" || status === "complained") {
        setDelivery({ phase: "failed", to: sentTo, status })
        return
      }
      if (Date.now() - started > WATCH_FOR_MS) {
        setDelivery({ phase: "late", to: sentTo })
        return
      }
      timer = setTimeout(() => void tick(), WATCH_EVERY_MS)
    }
    let timer = setTimeout(() => void tick(), 1_000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [delivery])

  // Told once the outcome is known, so the rail's card can say so.
  const settledTo =
    delivery.phase === "delivered" || delivery.phase === "late" ? delivery.to : null
  React.useEffect(() => {
    if (settledTo) onSent({ to: settledTo })
  }, [settledTo, onSent])

  async function send() {
    if (!from || delivery.phase !== "idle") return
    setDelivery({ phase: "sending" })
    const result = await sendFirstEmail(from, recipient ? undefined : typed.trim())
    if (!result.ok) {
      setDelivery({ phase: "idle" })
      toastError("Could not send it", result.error)
      return
    }
    // No id to watch - a replay of an old send, say - is "on its way" at once.
    setDelivery(
      result.data.id
        ? { phase: "watching", id: result.data.id, to: result.data.to }
        : { phase: "late", to: result.data.to },
    )
  }

  const needsRecipient = recipient === null
  const ready = verified && issued && from !== null && (!needsRecipient || typedOk)
  const why = !verified
    ? "Sends once your domain is verified."
    : !issued
      ? "Add an API key first."
      : needsRecipient && !typedOk
        ? "Enter where it should go."
        : null

  const snippets = [
    {
      value: "node",
      label: "Node.js",
      code: `import { I10 } from "@i10/node"

const i10 = new I10("${secret}")

await i10.emails.send({
  from: "${sender}",
  to: ["${to}"],
  subject: "Your first email from i10",
  html: "<p>It works.</p>",
})`,
    },
    {
      value: "python",
      label: "Python",
      code: `import i10

client = i10.Client(api_key="${secret}")

client.emails.send({
    "from": "${sender}",
    "to": ["${to}"],
    "subject": "Your first email from i10",
    "html": "<p>It works.</p>",
})`,
    },
    {
      value: "curl",
      label: "cURL",
      code: `curl -X POST https://api.i10.tech/emails \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "${sender}",
    "to": ["${to}"],
    "subject": "Your first email from i10",
    "html": "<p>It works.</p>"
  }'`,
    },
  ]

  const busy = delivery.phase === "sending" || delivery.phase === "watching"
  const finished = delivery.phase === "delivered" || delivery.phase === "late"

  return (
    <div className="space-y-6">
      {/* ── The key ── */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4 text-muted-foreground" />
          API key
        </h3>
        <AutoHeight grow="animate">
          <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              {key ? (
                <motion.div
                  key="key"
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, ease: EASE, delay: 0.08 }}
                  className="space-y-2"
                >
                  <CopyField value={key.secret} className="py-2" />
                  <p className="text-xs text-warning">
                    Shown once. It is already in the code below - copy that and you have
                    both.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="create"
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  className="flex flex-wrap items-center gap-3"
                >
                  <ActionButton
                    className="rounded-full"
                    variant={hasApiKey ? "outline" : "default"}
                    onClick={mint}
                    state={outcome.state}
                    pendingLabel="Add API key"
                    doneLabel="Added"
                  >
                    <Lock />
                    {hasApiKey ? "Add another API key" : "Add API key"}
                  </ActionButton>
                  {hasApiKey && (
                    <p className="text-xs text-muted-foreground">
                      You already have one - use it, or add a new key for this.
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </AutoHeight>
      </section>

      {/* ── Where it goes, only when we cannot know ── */}
      {needsRecipient && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <MailCheck className="size-4 text-muted-foreground" />
            Send it to
          </h3>
          <FloatingInput
            id="first-email-to"
            label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={typed}
            disabled={delivery.phase !== "idle"}
            onChange={(event) => setTyped(event.target.value)}
            hint="Your account has no verified address, so tell us where to send it."
          />
        </section>
      )}

      {/* ── The code, and the button that runs it ── */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Send className="size-4 text-muted-foreground" />
          Send an email
        </h3>
        <Tabs defaultValue="node" className="overflow-hidden rounded-3xl border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <TabsList variant="pill">
              {snippets.map((s) => (
                <TabsTrigger key={s.value} value={s.value}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {/*
           * ⚠ THE CARD CHANGES HEIGHT WITH THE SNIPPET, SMOOTHLY. cURL is two
           * lines shorter than Node; the tab switch fades the code and the box
           * glides to its new height instead of snapping.
           */}
          <AutoHeight grow="animate">
            {snippets.map((s) => (
              <TabsContent
                key={s.value}
                value={s.value}
                className="relative m-0 animate-in duration-300 fade-in-0"
              >
                <CopyButton
                  value={s.code}
                  label="Copy code"
                  className="absolute top-3 right-3 z-10"
                />
                <pre className="overflow-x-auto px-5 py-4 font-mono text-xs leading-relaxed text-muted-foreground">
                  {s.code}
                </pre>
              </TabsContent>
            ))}
          </AutoHeight>
          <div className="flex flex-wrap items-center gap-3 border-t bg-muted/20 px-4 py-3">
            <Button
              className={cn(
                "rounded-full transition-colors duration-500",
                finished && "bg-emerald-500 text-white hover:bg-emerald-500",
              )}
              disabled={!ready || delivery.phase !== "idle"}
              onClick={() => void send()}
            >
              {busy ? <Spinner /> : finished ? <Check /> : <PartyPopper />}
              {delivery.phase === "sending"
                ? "Sending"
                : delivery.phase === "watching"
                  ? "Delivering"
                  : finished
                    ? "Sent"
                    : "Send email"}
            </Button>
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={delivery.phase + (why ?? "")}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="text-xs text-muted-foreground"
              >
                {delivery.phase === "watching"
                  ? `On its way to ${delivery.to} - waiting for their server to take it.`
                  : delivery.phase === "failed"
                    ? `It did not arrive (${delivery.status}). Check the address in Emails.`
                    : delivery.phase === "idle"
                      ? (why ?? `Sends this to ${to}, once.`)
                      : null}
              </motion.p>
            </AnimatePresence>
          </div>
        </Tabs>
      </section>

      {/*
       * ⚠ THE CELEBRATION IS PART OF THE PAGE, NOT A DIALOG. It arrives where
       * the person is already looking, under the button they pressed, and
       * Continue arrives with it - the step is finished at that moment and not
       * before.
       */}
      <AutoHeight grow="animate">
        <AnimatePresence initial={false}>
          {(finished || delivery.phase === "failed") && (
            <motion.div
              key="outcome"
              initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.6, ease: EASE }}
              className="space-y-5"
            >
              {delivery.phase === "failed" ? (
                <div className="flex items-start gap-3 rounded-3xl border border-danger/30 bg-danger/5 p-5">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">That one did not land</p>
                    <p className="text-sm text-muted-foreground">
                      The receiving server refused it. Your setup works - this is about
                      the address. You can carry on and look at it in Emails.
                    </p>
                  </div>
                </div>
              ) : (
                <Congrats
                  to={
                    delivery.phase === "delivered" || delivery.phase === "late"
                      ? delivery.to
                      : ""
                  }
                  from={sender}
                  delivered={delivery.phase === "delivered"}
                  reduce={reduce}
                />
              )}
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE, delay: reduce ? 0 : 0.35 }}
              >
                <Button className="rounded-full" onClick={onDone}>
                  Continue
                  <ArrowRight />
                </Button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>
    </div>
  )
}

/**
 * The moment the first email is in somebody's inbox.
 *
 * ⚠ A LITTLE CEREMONY AND NO MORE: a glow, a mark that settles in, and a
 * sentence with the facts in it - from where, to whom - so it reads as proof
 * rather than as confetti.
 */
function Congrats({
  to,
  from,
  delivered,
  reduce,
}: {
  to: string
  from: string
  delivered: boolean
  reduce: boolean
}) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-emerald-500/30 bg-linear-to-br from-emerald-500/14 via-emerald-500/5 to-sky-500/8 p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-emerald-500/20 blur-3xl"
      />
      <div className="relative flex items-start gap-4">
        <motion.span
          initial={reduce ? false : { scale: 0.6, rotate: -12, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.1 }}
          className="grid size-12 shrink-0 place-items-center rounded-2xl border border-emerald-500/30 bg-background/60 text-emerald-500 shadow-lg shadow-emerald-500/20"
        >
          <PartyPopper className="size-6" />
        </motion.span>
        <div className="min-w-0 space-y-1">
          <p className="font-display text-lg font-semibold tracking-tight">
            {delivered ? "You sent your first email" : "Your first email is on its way"}
          </p>
          <p className="text-sm text-muted-foreground">
            From <span className="font-mono text-foreground">{from}</span> to{" "}
            <span className="text-foreground">{to}</span>
            {delivered
              ? " - signed, sealed and delivered."
              : " - signed, sealed and on its way."}
          </p>
          <a
            href="/onboarding/skip?to=%2Femails"
            className="inline-flex items-center gap-0.5 pt-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            See it in Emails
            <ArrowUpRight className="size-3" />
          </a>
        </div>
      </div>
    </div>
  )
}

/** A plain address - the same rule the API applies to a typed recipient. */
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>.,;"]+(?:\.[^\s@<>.,;"]+)*\.[A-Za-z]{2,}$/
