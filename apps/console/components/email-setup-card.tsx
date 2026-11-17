"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { cn } from "cn"
import { CreateMailbox } from "@/components/create-mailbox-dialog"
import type { CreateMailboxProps } from "@/components/mailboxes-list"
import {
  DKIM_NOTE,
  type EmailSetup,
  type SetupState,
  type SetupStep,
} from "@/lib/email-setup"
import { hideEmailSetup, showEmailSetup } from "@/lib/mailbox-settings-actions"
import type { StoragePool } from "@/lib/mailbox-view"

const STATE_WORDS: Record<SetupState, string> = {
  done: "Done",
  todo: "Not done yet",
  unknown: "Not known yet",
}

/**
 * The setup guide on the Mailboxes page: a checklist while the workspace has no
 * mailbox, and the quiet way back to it once it has been put away.
 *
 * ⚠ A CARD ON THE PAGE, NOT A WIZARD. Every step lives somewhere else (Domains,
 * a domain's records, the create dialog), so a modal that walked through them
 * would only be a list of links that hides the page it came from. The statuses
 * are the product here: somebody comes back after adding DNS records and sees
 * which ticks arrived.
 *
 * ⚠ "HIDE FOR NOW" IS HELD HERE AND WRITTEN TO A COOKIE, NOT ROUND-TRIPPED. The
 * page hands over where the cookie left it; from there this component is the
 * truth, so hiding is one fold and not a fold followed by the server replacing
 * the tree under it. The cookie (lib/email-setup-hidden.ts) is only so the next
 * visit knows. It ends with the browser, so the card returns until setup is done.
 *
 * ⚠ FOCUS GOES SOMEWHERE ON EVERY SWAP. Hiding removes the button that was
 * pressed, so focus moves to "Show the setup steps"; showing moves it to the
 * card's heading. Otherwise a keyboard user is dropped at the top of the page.
 */
export function EmailSetupGuide({
  setup,
  tenantId,
  initiallyHidden,
  create,
  pool,
  whenHidden,
}: {
  setup: EmailSetup
  tenantId: string
  initiallyHidden: boolean
  create: CreateMailboxProps
  pool: StoragePool
  /** What the page shows in the card's place: the empty list, with its own explanation. */
  whenHidden: React.ReactNode
}) {
  const [hidden, setHidden] = React.useState(initiallyHidden)
  // ⚠ SEPARATE FROM `hidden`: the card stays mounted while it folds shut.
  const [folding, setFolding] = React.useState(false)
  const showButton = React.useRef<HTMLButtonElement>(null)
  const heading = React.useRef<HTMLHeadingElement>(null)
  const moveFocus = React.useRef<"show" | "heading" | null>(null)

  React.useEffect(() => {
    if (moveFocus.current === "show") showButton.current?.focus()
    if (moveFocus.current === "heading") heading.current?.focus()
    moveFocus.current = null
  }, [hidden])

  function hide() {
    setFolding(true)
  }

  function reveal() {
    moveFocus.current = "heading"
    setFolding(false)
    setHidden(false)
    void showEmailSetup()
  }

  return (
    <div className="space-y-4">
      {hidden ? (
        <>
          {whenHidden}
          <div className="flex justify-center">
            <Button
              ref={showButton}
              type="button"
              variant="ghost"
              size="sm"
              onClick={reveal}
            >
              Show the setup steps
            </Button>
          </div>
        </>
      ) : (
        <Reveal
          show={!folding}
          spacing="pb-0"
          onClosed={() => {
            if (!folding) return
            moveFocus.current = "show"
            setHidden(true)
            void hideEmailSetup(tenantId)
          }}
        >
          <SetupCard
            setup={setup}
            create={create}
            pool={pool}
            headingRef={heading}
            onHide={hide}
          />
        </Reveal>
      )}
    </div>
  )
}

function SetupCard({
  setup,
  create,
  pool,
  headingRef,
  onHide,
}: {
  setup: EmailSetup
  create: CreateMailboxProps
  pool: StoragePool
  headingRef: React.Ref<HTMLHeadingElement>
  onHide: () => void
}) {
  const total = setup.steps.length
  return (
    /*
     * ⚠ `relative` IS WHAT KEEPS THE SCREEN-READER-ONLY WORDS INSIDE THE PANE.
     * `sr-only` is absolutely positioned, and with no positioned ancestor it is
     * placed against the page, so one of them at the foot of a tall card made the
     * whole window scroll by the height of the overflow instead of just the pane.
     */
    <section
      aria-labelledby="email-setup-title"
      className="relative rounded-2xl border bg-card p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2
            id="email-setup-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-medium outline-none"
          >
            Set up email hosting
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Get mail working on your own domain in four steps. Nothing changes for
            anyone until you point your mail to us in step 3.
          </p>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {setup.done} of {total} done
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onHide}
        >
          Hide for now
        </Button>
      </div>

      <ol className="mt-6 space-y-6">
        {setup.steps.map((step, index) => (
          <StepRow key={step.id} step={step} number={index + 1}>
            {step.id === "mailbox" && step.state === "todo" && setup.canCreate ? (
              <CreateMailbox actor="admin" pool={pool} {...create} />
            ) : step.action ? (
              <ButtonLink href={step.action.href} variant="secondary" size="sm">
                {step.action.label}
              </ButtonLink>
            ) : null}
          </StepRow>
        ))}
      </ol>

      {setup.sendingWaiting && (
        <p className="mt-6 max-w-prose text-sm text-muted-foreground">{DKIM_NOTE}</p>
      )}

      <div className="mt-6 border-t pt-5">
        <h3 className="text-sm font-medium">When you are ready</h3>
        <ul className="mt-3 space-y-3 text-sm">
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="max-w-prose text-muted-foreground">
              Bring your old mail over from Gmail, Apple Mail, Thunderbird or another
              mail app.
            </span>
            <ButtonLink href="/mailboxes/move-in" variant="ghost" size="sm">
              Move mail in
            </ButtonLink>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="max-w-prose text-muted-foreground">
              Choose whether people can create their own mailbox.
            </span>
            <ButtonLink href="/mailboxes/settings" variant="ghost" size="sm">
              Mailbox settings
            </ButtonLink>
          </li>
        </ul>
      </div>
    </section>
  )
}

function StepRow({
  step,
  number,
  children,
}: {
  step: SetupStep
  number: number
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs",
          step.state === "done" && "bg-success/12 text-success",
          step.state === "todo" && "border text-muted-foreground",
          step.state === "unknown" && "border border-dashed text-muted-foreground",
        )}
      >
        {step.state === "done" ? <Check className="size-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-medium">
          <span className="sr-only">Step {number}: </span>
          {step.title}
        </h3>
        <p className="max-w-prose text-sm text-muted-foreground">{step.help}</p>
        <p className="text-sm">
          <span className="sr-only">{STATE_WORDS[step.state]}. </span>
          <span className={step.state === "done" ? "text-success" : undefined}>
            {step.status}
          </span>
        </p>
        {children ? <div className="pt-1">{children}</div> : null}
      </div>
    </li>
  )
}
