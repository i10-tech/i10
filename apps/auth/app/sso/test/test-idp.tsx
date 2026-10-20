"use client"

import { useState } from "react"
import { Button } from "@repo/ui/components/button/button"
import { Input } from "@repo/ui/components/i10/input"
import { StepHeading } from "../../_components/step-heading"

/** Assert a subject and an email, as an IdP would after signing someone in. */
export function TestIdp({ state }: { state: string }) {
  const [subject, setSubject] = useState("")
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch("/api/sso/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, subject, email }),
      })
      const answer = (await response.json()) as {
        outcome?: string
        code?: string
        returnTo?: string | null
        passed?: boolean
        message?: string
      }
      if (answer.outcome === "signed_in" && answer.code) {
        window.location.replace(
          `/sso/continue#${new URLSearchParams({ code: answer.code })}`,
        )
        return
      }
      if (answer.outcome === "stepped_up" && answer.returnTo) {
        window.location.replace(answer.returnTo)
        return
      }
      setMessage(
        answer.outcome === "tested"
          ? `Test run ${answer.passed ? "passed" : "failed"}.`
          : (answer.message ?? "Refused."),
      )
    } catch {
      setMessage("The API did not answer.")
    }
    setBusy(false)
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <StepHeading title="Test identity provider">
        Development only. Whatever you enter here is what the IdP says.
      </StepHeading>
      <Input
        aria-label="Subject"
        placeholder="Subject (the IdP's user id)"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        required
      />
      <Input
        aria-label="Email"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Button type="submit" disabled={busy || !state}>
        Sign in
      </Button>
      {message ? (
        <p className="text-center text-sm text-muted-foreground">{message}</p>
      ) : null}
    </form>
  )
}
