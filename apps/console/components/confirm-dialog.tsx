"use client"

import { CopyCheckIcon } from "@repo/ui/components/icon-morph/icon-morph"
import * as React from "react"
import { Redo2 } from "lucide-react"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { useCopy } from "@repo/ui/components/i10/use-copy"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"

/**
 * The word to type, and a one-click way to have it.
 *
 * ⚠ COPYABLE, WHICH SOUNDS LIKE IT DEFEATS THE POINT AND DOES NOT. The field
 * is there to make somebody READ which row they are on - the failure it
 * prevents is deleting `acme.com` while looking at `mail.acme.dev`. It was
 * never a typing test, and a name long enough to mistype twice only teaches
 * people to resent the dialog. Paste and they have still had to look at the
 * name to know it is the one they want.
 *
 * ⚠ AND IT IS ITS OWN LINE ABOVE THE FIELD RATHER THAN THE FIELD'S HINT. That
 * row is `aria-live="polite"` and, when the hint is not reserved,
 * `pointer-events-none` - so a button in it would be unclickable on most
 * fields and announced again on every change of validity on the rest.
 */
function ConfirmWord({ word, onCopied }: { word: string; onCopied: () => void }) {
  const { copied, copy } = useCopy()

  return (
    <p className="text-sm text-muted-foreground">
      Type{" "}
      <button
        type="button"
        /*
         * ⚠ FOCUS GOES BACK TO THE BOX AFTER A COPY. The only reason to copy
         * the word is to paste it into the field below, and pressing this
         * button had moved focus onto the button - so the paste went nowhere
         * until somebody clicked the field again.
         */
        onClick={() => {
          void copy(word)
          onCopied()
        }}
        /*
         * ⚠ AND WITH A POINTER, FOCUS NEVER LEAVES THE BOX AT ALL. Pressing a
         * button focuses it on mousedown, so the field blurred and was then
         * refocused on click - a visible blip of the border. Refusing the
         * mousedown's focus keeps the field focused the whole way; a keyboard
         * press still lands on the button, and `onCopied` hands focus back.
         */
        onMouseDown={(event) => event.preventDefault()}
        /*
         * ⚠ THE ACCESSIBLE NAME CHANGES WITH THE STATE, WHICH IS HOW A SCREEN
         * READER GETS THE CONFIRMATION SIGHTED USERS GET FROM THE TICK.
         */
        aria-label={copied ? "Copied" : `Copy ${word}`}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 align-baseline font-mono text-xs text-foreground transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {word}
        <CopyCheckIcon
          state={copied}
          size={12}
          aria-hidden="true"
          className={copied ? "text-success" : "text-muted-foreground"}
        />
      </button>{" "}
      to confirm.
    </p>
  )
}

/**
 * The word every bulk delete asks for. Several things have no single name to
 * type, but there is still a deliberate word between a stray click and losing
 * them - and it is the same word on every list, so nobody has to read which.
 */
export const BULK_CONFIRM_WORD = "Delete"

/**
 * What a delete asks to have typed, the same rule everywhere: ONE thing is
 * confirmed by its own name - from its page, its row menu, or ticked alone in
 * the bulk bar - because typing the name is what proves it is the right one.
 * Several things, or one whose name is missing, take the bulk word.
 */
export function confirmWordFor(
  names: ReadonlyArray<string | null | undefined>,
  fallback: string = BULK_CONFIRM_WORD,
): string {
  const only = names.length === 1 ? names[0]?.trim() : undefined
  return only || fallback
}

/**
 * A keyboard chip sitting ON a filled button, per button variant.
 *
 * ⚠ THE ICON COLOUR HAS TO BE FORCED. `Kbd` paints its contents
 * `text-muted-foreground`, which is a grey chosen against the page, not
 * against a red or a near-black button - and `[&_svg]` rules inside `Button`
 * reach the icons too.
 */
export const KBD_ON_BUTTON = {
  destructive: "bg-black/20 text-white [&_svg]:text-white",
  default:
    "bg-primary-foreground/15 text-primary-foreground [&_svg]:text-primary-foreground",
} as const

/**
 * "Are you sure?", for the things that are worth asking about.
 *
 * ⚠ IT IS USED SPARINGLY, ON PURPOSE. A confirmation on every destructive
 * action trains people to dismiss confirmations, which makes the one that
 * mattered useless. The rule here: confirm when the action is irreversible AND
 * affects something live. Deleting a draft does not qualify; deleting a domain
 * that is carrying mail does.
 *
 * ⚠ `confirmWord` RAISES THE BAR FROM "CLICK AGAIN" TO "READ THIS". Typing the
 * name is the only confirmation that cannot be completed by muscle memory, and
 * it is the one that stops somebody deleting the production domain from a table
 * of five similar rows. It is reserved for exactly that case.
 *
 * ⚠ AND `onConfirm` RETURNS A BOOLEAN RATHER THAN THROWING. A failed delete
 * must leave the dialog open with the error visible - closing it and firing a
 * toast means the person believes the thing is gone when it is not, and the
 * list they return to still shows it.
 *
 * ⚠ `children` IS FOR A SECOND QUESTION THE FIRST ONE RAISES, NOT FOR DECORATION.
 * Deleting a domain is the case it exists for: any key restricted to that
 * domain is about to become a credential that can send from nothing, and the
 * moment to ask about it is while somebody is already deciding. A separate
 * dialog afterwards would be a second interruption about a consequence of the
 * first, and one nobody would connect to it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  doneLabel = "Done",
  confirmWord,
  ready = true,
  initialFocus = "confirm-word",
  destructive = true,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  /**
   * What the button says once it worked - "Revoked", "Deleted". Past tense of
   * `confirmLabel`, shown for a beat before the dialog closes. See
   * lib/outcome.ts.
   */
  doneLabel?: string
  /** When set, the button stays disabled until this exact string is typed. */
  confirmWord?: string
  /**
   * ⚠ FOR A DIALOG WHOSE CHILDREN HOLD A CHOICE THAT MUST BE MADE FIRST - a
   * destination, say. False keeps the button disabled whatever is typed.
   */
  ready?: boolean
  /**
   * The id of the field to put the caret in on open. `confirm-word` unless a
   * dialog asks for something first - a recipient, say - that belongs above it.
   */
  initialFocus?: string
  destructive?: boolean
  onConfirm: () => Promise<boolean>
  /** A second question, asked above the confirmation. See the note above. */
  children?: React.ReactNode
}) {
  const [typed, setTyped] = React.useState("")
  const field = React.useRef<HTMLInputElement>(null)

  function focusField() {
    const input = field.current
    if (!input) return
    input.focus()
    // Caret at the end, so the paste lands after anything already typed.
    const end = input.value.length
    input.setSelectionRange(end, end)
  }
  const outcome = useOutcome()
  const pending = outcome.state === "pending"

  // ⚠ RESET ON OPEN, NOT ON CLOSE. Resetting on close races the exit animation
  // - the field visibly empties while the dialog is still fading out, which
  // looks like the input being cleared out from under you. The tick on the
  // button is the same case.
  useResetOnOpen(open, () => {
    setTyped("")
    outcome.reset()
  })

  /*
   * ⚠ TWO ANSWERS, KEPT APART. `matches` is about the typed name alone and is
   * all the name field's colour may say; `armed` is whether the button can go,
   * which also waits on `ready`. Colouring the name by `armed` turned a
   * correctly typed domain red because the email above it was unfinished.
   */
  const matches = confirmWord === undefined || typed.trim() === confirmWord
  const armed = ready && matches

  async function confirm() {
    if (!armed || outcome.state !== "idle") return
    await outcome.run(onConfirm, () => onOpenChange(false))
  }

  const hasBody =
    (children !== undefined && children !== null && children !== false) ||
    confirmWord !== undefined

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent
        /*
         * ⚠ THE FIELD TAKES FOCUS, NOT WHATEVER HAPPENS TO BE FIRST. Radix
         * focuses the first tabbable element in the dialog, and since the word
         * became copyable that is the copy chip - so the dialog opened with a
         * focus ring around a button nobody has to press, and the field that
         * every one of these dialogs exists to have filled in was one Tab
         * away. Anything that changes the order of this markup would move the
         * ring again, which is why this is pinned to the field by id.
         */
        onOpenAutoFocus={(event) => {
          const field = document.getElementById(initialFocus)
          if (!field) return
          event.preventDefault()
          /*
           * ⚠ ON THE NEXT FRAME, NOT IN THE HANDLER. Focusing synchronously
           * here loses: Radix's focus scope mounts its trap immediately after
           * this event and pulls focus onto the content element, so the field
           * was focused for less than a frame and the dialog opened with the
           * caret nowhere. Measured - `document.activeElement` was the
           * `role="dialog"` div every time.
           */
          requestAnimationFrame(() => field.focus())
        }}
        /*
         * ⚠ ENTER IS BOUND ONCE, HERE, AND NOT ALSO ON THE FIELD. It was on
         * the field first; moving it up means a dialog with no `confirmWord`
         * has a keyboard route to its own primary action too, which it did
         * not before. Binding it in BOTH places is the bug this replaced -
         * the field's handler fires, the event bubbles, and `confirm` runs
         * twice in one tick, before `pending` has re-rendered to stop the
         * second.
         *
         * ⚠ IT LEAVES ANYTHING ALREADY ACTIVATED BY ENTER ALONE. Cancel, the
         * close button and the copy chip are buttons: Enter on a focused
         * button is that button's own press, and hijacking it would fire the
         * delete from the control somebody pressed to avoid it.
         *
         * ⚠ AND IT OBEYS `armed` BY GOING THROUGH `confirm`, so the shortcut
         * cannot do what the button refuses to.
         */
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          if ((event.target as HTMLElement).closest("button, a, textarea")) return
          event.preventDefault()
          void confirm()
        }}
        title={title}
        description={description}
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        {/*
         * ⚠ ABOVE THE TYPE-THE-NAME FIELD, WHICH IS THE ONLY ORDER THAT WORKS.
         * The field is the last thing before the button and the thing that arms
         * it; a question underneath it would be answered after somebody has
         * already committed to the action.
         */}
        {/*
         * ⚠ ONE RHYTHM FOR THE WHOLE BODY: 24px between its blocks (a field, a
         * notice, the type-the-name pair), so nothing sits tight against one
         * neighbour and loose against the next. Each block used to bring its
         * own margins, and a field's hint ended up touching the notice under it.
         */}
        {/*
         * ⚠ ONLY WHEN THERE IS SOMETHING TO SAY (2026-10-12). A plain "remove
         * this?" has nothing between the sentence and the buttons; rendering
         * the empty block anyway stacked the body's padding and the footer's
         * margin into a blank band above Cancel and Remove.
         */}
        {hasBody && (
          <div className="flex flex-col gap-6">
            {children}

            {/*
             * ⚠ `space-y-4` - 16px between the sentence and its field: close
             * enough to read as one block, apart from everything else's 24. The line inside is a sentence ABOUT
             * the field rather than its label, and the field now carries the name
             * as its own floating label, so the two were saying related things
             * eight pixels apart and reading as one block. 12px was tried first
             * and was not perceptible; this is the step that separates them.
             */}
            {confirmWord !== undefined && (
              <div className="space-y-4">
                <ConfirmWord word={confirmWord} onCopied={focusField} />
                {/*
                 * ⚠ THE LABEL IS THE NAME ITSELF, NOT AN INSTRUCTION. The line
                 * above already says what to do with it, and a field labelled
                 * "Type mail.acme.dev to confirm" says it a second time in a
                 * smaller size - two sentences for one requirement. As the
                 * floating label it also does the work a placeholder would: the
                 * word to match is in the empty field, and it rises out of the
                 * way rather than vanishing the moment somebody starts typing,
                 * which is the failure every placeholder-as-label has.
                 *
                 * ⚠ AND IT IS PLAIN TEXT, NOT MONO. A floating label animates
                 * `font-size`, so a nested element with its own family shifts at
                 * a different rate and lands a pixel out. The chip above is the
                 * monospace copy, where it can be compared character by
                 * character.
                 */}
                <FloatingInput
                  id="confirm-word"
                  ref={field}
                  label={confirmWord}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono"
                  /*
                   * ⚠ IT GOES GREEN ONLY ON AN EXACT MATCH, AND STAYS NEUTRAL WHILE
                   * EMPTY RATHER THAN GOING RED. A field that turns red the moment
                   * you focus it is scolding somebody for not having typed yet;
                   * red here means "this is not the word", which is only true once
                   * there is something to compare.
                   */
                  state={typed.length === 0 ? "idle" : matches ? "valid" : "invalid"}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter className={hasBody ? undefined : "mt-0"}>
          {/*
           * ⚠ BOTH HINTS DESCRIBE KEYS THAT ACTUALLY WORK. `Esc` is Radix's,
           * and it is correct here for the same reason the close button is:
           * `onOpenChange` is swapped for a no-op while a confirm is in
           * flight, so neither can abandon a request that is already running.
           */}
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
            <Kbd>Esc</Kbd>
          </Button>
          <StateButton
            variant={destructive ? "danger" : "primary"}
            onClick={confirm}
            state={outcome.state}
            pendingLabel={confirmLabel}
            doneLabel={doneLabel}
            disabled={!armed}
          >
            {confirmLabel}
            {/*
             * ⚠ THE CHIP TAKES A SHADE OF THE BUTTON IT SITS ON rather than
             * `Kbd`'s default grey. A muted grey block on a saturated red
             * button reads as a disabled thing stuck to a live one; a wash of
             * the surface's own colour reads as part of it. Black at 20%
             * rather than a second red token, because the button is already
             * `bg-destructive` and painting destructive on destructive is
             * invisible.
             *
             * ⚠ THE GLYPH IS A DRAWN ICON, NOT THE `↵` CHARACTER, which is
             * typed at whatever weight and baseline the UI face gives it - in
             * Geist it lands small and low.
             *
             * ⚠ AND IT IS `Redo2` TURNED HALF A TURN, WHICH IS NOT A BODGE.
             * Lucide has no return-key glyph in the version we are on -
             * `ArrowTurnDownLeft` arrived later - and `Redo2` upside down is
             * exactly it: a curve that drops and turns back to the left.
             * `CornerDownLeft`, the usual stand-in, is drawn from straight
             * segments and reads as a corner rather than a key.
             *
             * ⚠ `size-2.5` RATHER THAN `Kbd`'s DEFAULT 12px. An icon at the
             * same size as the text beside it reads heavier than the text
             * does; this sits it back down next to `Esc`.
             */}
            <Kbd className={KBD_ON_BUTTON[destructive ? "destructive" : "default"]}>
              <Redo2 aria-hidden="true" className="size-2.5 rotate-180" />
            </Kbd>
          </StateButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
