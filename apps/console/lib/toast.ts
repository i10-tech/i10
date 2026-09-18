"use client"

import { toast } from "sonner"

/**
 * Every failure the console shows a person, said the same way.
 *
 * ⚠ ONE PLACE, BECAUSE THE WORDING IS A SECURITY DECISION AND NOT A STYLE ONE.
 * Twenty call sites each writing their own `toast.error(String(e))` is twenty
 * chances to put a stack trace, an internal hostname or a database constraint
 * name on somebody's screen. The message this renders has already been through
 * `safeFailure` on the server (see lib/failure.ts) — this end decides only how
 * it is presented.
 *
 * ⚠ THE TITLE IS DERIVED FROM THE STATUS AND THE MESSAGE IS THE DESCRIPTION,
 * which is what makes a toast readable in the half-second it gets. "Could not
 * add that domain" answers *what failed* at a glance; the sentence underneath
 * answers *why* for the person who reads on. A single run-on line is the shape
 * that gets dismissed unread.
 */

export interface Failure {
  error: string
  name: string
  status: number
}

/**
 * ⚠ KEYED ON `name` FIRST AND `status` SECOND, BECAUSE THE API'S NAMES ARE THE
 * PRECISE SIGNAL AND THE STATUS IS THE FALLBACK. Two different 409s —
 * `domain_already_exists` and `domain_already_claimed` — need different titles,
 * and the status cannot tell them apart. See packages/contracts/src/errors.ts.
 */
const TITLES: Record<string, string> = {
  domain_already_exists: "That domain is already here",
  domain_already_claimed: "That domain belongs to another workspace",
  plan_limit_exceeded: "Your plan does not cover that",
  tenant_not_ready: "Your workspace is still being set up",
  invalid_access: "Please sign in again",
  service_unavailable: "We could not reach the service",
  gateway_timeout: "That took too long",
}

function titleFor({ name, status }: Failure): string {
  const known = TITLES[name]
  if (known) return known

  if (status === 401 || status === 403) return "You cannot do that"
  if (status === 404) return "Not found"
  if (status === 409) return "That conflicts with something"
  if (status === 429) return "Too many requests"
  if (status >= 400 && status < 500) return "That did not work"
  return "Something went wrong"
}

/**
 * ⚠ EIGHT SECONDS, NOT SONNER'S DEFAULT FOUR. An error is the one toast a
 * person actually needs to finish reading, and it frequently arrives while they
 * are still looking at the form they submitted rather than at the corner of the
 * screen. Success stays at the default: it says the thing you just watched
 * happen, happened.
 */
const ERROR_MS = 8000

export function toastFailure(
  failure: Failure,
  options: { title?: string; action?: { label: string; onClick: () => void } } = {},
): void {
  toast.error(options.title ?? titleFor(failure), {
    description: failure.error,
    duration: ERROR_MS,
    ...(options.action ? { action: options.action } : {}),
  })
}

export function toastDone(message: string, description?: string): void {
  toast.success(message, description ? { description } : undefined)
}

/**
 * ⚠ WARNING, NOT ERROR, AND THE DISTINCTION IS THE YELLOW/RED ONE. Something
 * that has not finished — a verification still propagating, a checkout waiting
 * on a webhook — is not a failure, and colouring it red teaches people to read
 * red as "probably fine". Yellow means "not yet"; red means "no".
 */
export function toastPending(message: string, description?: string): void {
  toast.warning(message, description ? { description } : undefined)
}
