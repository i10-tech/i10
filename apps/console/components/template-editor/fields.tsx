"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import { AlertCircle, Check } from "lucide-react"
import { cn } from "cn"
import {
  fromProblem,
  previewProblem,
  replyToProblem,
  subjectProblem,
} from "@/lib/envelope"

export {
  addressOf,
  domainOf,
  fromProblem,
  replyToList,
  replyToProblem,
} from "@/lib/envelope"

/**
 * The envelope above the email - From, Reply-To, Subject, Preview text - laid
 * out as Resend lays it out: a label, the value, and the optional rows
 * offered on the right until they are wanted.
 *
 * ⚠ EVERY ROW IS CHECKED AS IT IS TYPED, AND THE SENDER BY THE SEND PATH'S
 * OWN RULE: an address on a domain this workspace has verified. A template
 * whose default From is refused at every send is broken while looking done.
 */

export interface Envelope {
  from: string
  replyTo: string
  subject: string
  previewText: string
}

export function EnvelopeFields({
  value,
  onChange,
  verified,
  disabled = false,
  compact = false,
}: {
  value: Envelope
  onChange: (patch: Partial<Envelope>) => void
  /** Verified domain names, lower-case. */
  verified: string[]
  disabled?: boolean
  /** Narrower padding, for the Code view's preview. */
  compact?: boolean
}) {
  const [showReplyTo, setShowReplyTo] = React.useState(value.replyTo !== "")
  const [showPreview, setShowPreview] = React.useState(value.previewText !== "")
  // ⚠ A SAVED VALUE IS JUDGED AT ONCE. Waiting for a blur suits something
  // being typed; a sender saved last week on a domain since removed must say
  // so the moment the editor opens.
  const [touched, setTouched] = React.useState<Record<string, boolean>>(() => ({
    from: value.from.trim() !== "",
    replyTo: value.replyTo.trim() !== "",
  }))
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }))

  // Never judged mid-word: an address is wrong until it is finished.
  const [fromFocused, setFromFocused] = React.useState(false)
  const fromError = fromFocused ? null : fromProblem(value.from, verified)
  const replyError = replyToProblem(value.replyTo)

  return (
    <div className={cn("text-sm", compact && "text-[13px]")}>
      <Row
        label="From"
        error={touched.from ? fromError : null}
        ok={touched.from && value.from.trim() !== "" && !fromError}
        action={
          !showReplyTo && (
            <OptionalToggle onClick={() => setShowReplyTo(true)}>
              Reply-To
            </OptionalToggle>
          )
        }
        errorAction={
          fromError && touched.from ? (
            <Link
              href="/domains"
              className="underline underline-offset-2 hover:text-neutral-900"
            >
              Domains
            </Link>
          ) : null
        }
      >
        <FromInput
          value={value.from}
          verified={verified}
          disabled={disabled}
          onChange={(from) => onChange({ from })}
          onFocus={() => setFromFocused(true)}
          onBlur={() => {
            setFromFocused(false)
            touch("from")
          }}
        />
      </Row>

      <AnimatePresence initial={false}>
        {showReplyTo && (
          <Collapse key="reply">
            <Row
              label="Reply-To"
              error={touched.replyTo ? replyError : null}
              action={
                <OptionalToggle
                  onClick={() => {
                    onChange({ replyTo: "" })
                    setShowReplyTo(false)
                  }}
                >
                  Remove
                </OptionalToggle>
              }
            >
              <input
                value={value.replyTo}
                onChange={(e) => onChange({ replyTo: e.target.value })}
                onBlur={() => touch("replyTo")}
                disabled={disabled}
                placeholder="support@acme.com, billing@acme.com"
                className="w-full bg-transparent outline-none placeholder:text-neutral-400"
                aria-label="Reply-To"
                spellCheck={false}
                autoFocus={value.replyTo === ""}
              />
            </Row>
          </Collapse>
        )}
      </AnimatePresence>

      <Row
        label="Subject"
        error={subjectProblem(value.subject)}
        action={
          !showPreview && (
            <OptionalToggle onClick={() => setShowPreview(true)}>
              Preview text
            </OptionalToggle>
          )
        }
      >
        <input
          value={value.subject}
          onChange={(e) => onChange({ subject: e.target.value })}
          disabled={disabled}
          placeholder="Welcome to Acme, {{ name }}"
          className="w-full bg-transparent outline-none placeholder:text-neutral-400"
          aria-label="Subject"
        />
      </Row>

      <AnimatePresence initial={false}>
        {showPreview && (
          <Collapse key="preview">
            <Row
              label="Preview"
              error={previewProblem(value.previewText)}
              action={
                <OptionalToggle
                  onClick={() => {
                    onChange({ previewText: "" })
                    setShowPreview(false)
                  }}
                >
                  Remove
                </OptionalToggle>
              }
            >
              <input
                value={value.previewText}
                onChange={(e) => onChange({ previewText: e.target.value })}
                disabled={disabled}
                placeholder="The line inboxes show after the subject"
                className="w-full bg-transparent outline-none placeholder:text-neutral-400"
                aria-label="Preview text"
                autoFocus={value.previewText === ""}
              />
            </Row>
          </Collapse>
        )}
      </AnimatePresence>
    </div>
  )
}

function Collapse({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  )
}

function Row({
  label,
  children,
  action,
  error,
  errorAction,
  ok,
}: {
  label: string
  children: React.ReactNode
  action?: React.ReactNode
  error?: string | null
  errorAction?: React.ReactNode
  ok?: boolean
}) {
  return (
    <div className="border-b border-neutral-200">
      <div className="flex min-h-11 items-center gap-4">
        <span className="w-24 shrink-0 text-neutral-500">{label}</span>
        <div className="relative min-w-0 flex-1 text-neutral-900">{children}</div>
        <AnimatePresence>
          {ok && (
            <motion.span
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              className="text-emerald-600"
              aria-label="Verified sender"
            >
              <Check className="size-4" />
            </motion.span>
          )}
        </AnimatePresence>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            role="alert"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-1.5 overflow-hidden pb-2 pl-28 text-xs text-red-600"
          >
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{error}</span>
            {errorAction}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}

function OptionalToggle({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-1.5 py-0.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
    >
      {children}
    </button>
  )
}

/**
 * The sender, with the workspace's verified domains offered once an `@` is
 * typed - so the only domains anybody is nudged towards are ones that send.
 */
function FromInput({
  value,
  verified,
  disabled,
  onChange,
  onFocus,
  onBlur,
}: {
  value: string
  verified: string[]
  disabled: boolean
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
}) {
  const [focused, setFocused] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const at = value.lastIndexOf("@")
  const typedDomain =
    at >= 0
      ? value
          .slice(at + 1)
          .replace(/>$/, "")
          .toLowerCase()
      : null
  const suggestions =
    focused && typedDomain !== null && !verified.includes(typedDomain)
      ? verified.filter((d) => d.startsWith(typedDomain)).slice(0, 6)
      : []

  function complete(domain: string) {
    const head = value.slice(0, at + 1)
    const closes = head.includes("<") ? ">" : ""
    onChange(`${head}${domain}${closes}`)
    setActive(0)
  }

  return (
    <>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setActive(0)
        }}
        onFocus={() => {
          setFocused(true)
          onFocus()
        }}
        onBlur={() => {
          // Late, so a click on a suggestion lands first.
          setTimeout(() => setFocused(false), 120)
          onBlur()
        }}
        onKeyDown={(e) => {
          if (suggestions.length === 0) return
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setActive((a) => (a + 1) % suggestions.length)
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault()
            complete(suggestions[active]!)
          } else if (e.key === "Escape") {
            setFocused(false)
          }
        }}
        disabled={disabled}
        placeholder={
          verified[0] ? `Acme <hello@${verified[0]}>` : "Acme <hello@acme.com>"
        }
        className="w-full bg-transparent outline-none placeholder:text-neutral-400"
        aria-label="From"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        spellCheck={false}
        autoComplete="off"
      />
      <AnimatePresence>
        {suggestions.length > 0 && (
          <motion.ul
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="absolute top-full left-0 z-30 mt-1 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
          >
            <li className="px-2 py-1 text-[11px] text-neutral-500">Verified domains</li>
            {suggestions.map((d, i) => (
              <li
                key={d}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  complete(d)
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "cursor-pointer rounded-lg px-2 py-1.5 font-mono text-xs text-neutral-800",
                  i === active && "bg-neutral-100",
                )}
              >
                @{d}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </>
  )
}
