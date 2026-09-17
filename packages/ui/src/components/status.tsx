import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * A state, drawn.
 *
 * ⚠ THIS COMPONENT KNOWS NOTHING ABOUT WHAT THE STATES ARE, AND THAT IS THE
 * LAYER. `bounced`, `temporary_failure` and `past_due` are i10's vocabulary —
 * three of them are on the API's public contract and one is Polar's — and a
 * design-system package that held the table mapping them to colours would be a
 * package every product change has to be pushed through. What lives here is the
 * drawing: five tones, a dot, a pill, and the rule that the word is always in
 * the DOM. The table lives with the product that owns the words, in
 * `apps/console/lib/status.ts`.
 *
 * ⚠ AND THE WORD IS THE ACCESSIBLE HALF, NOT THE DOT. Roughly one man in twelve
 * cannot separate the green from the red — which is exactly the distinction this
 * component exists to draw — and a screen reader gets nothing at all from a
 * coloured circle. So `label` is REQUIRED. Shape and position are constant;
 * colour is a third signal on top, never the only one.
 *
 * ⚠ A CALLER WITH NO ROOM FOR THE TEXT MAY HIDE IT VISUALLY AND MUST NOT REMOVE
 * IT. `label={<span className="sr-only">…</span>}` is correct; `label=""` is
 * not, and deletes the only signal a screen reader or a colour-blind reader
 * has. `label` takes a node rather than a string precisely so that the correct
 * option is the easy one.
 */

export type Tone = "neutral" | "info" | "success" | "warning" | "danger"

const dotVariants = cva("inline-block size-1.5 shrink-0 rounded-full", {
  variants: {
    tone: {
      neutral: "bg-neutral",
      info: "bg-info",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
    },
  },
  defaultVariants: { tone: "neutral" },
})

export function StatusDot({
  tone,
  className,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof dotVariants>) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden="true"
      className={cn(dotVariants({ tone }), className)}
      {...props}
    />
  )
}

const statusVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap",
  {
    variants: {
      /**
       * ⚠ `plain` IS THE DEFAULT AND `pill` IS THE EXCEPTION, WHICH IS THE
       * OPPOSITE OF MOST DESIGN SYSTEMS. A log table is a hundred rows deep;
       * a hundred filled pills is a hundred rectangles of colour competing
       * with the text beside them. In a table the dot and the word are enough.
       * The pill is for a detail page, where exactly one status is on screen
       * and it is the answer to the question the page was opened to ask.
       */
      variant: {
        plain: "text-sm",
        pill: "rounded-full border px-2 py-0.5 text-xs font-medium",
      },
      tone: {
        neutral: "",
        info: "",
        success: "",
        warning: "",
        danger: "",
      },
    },
    compoundVariants: [
      /*
       * ⚠ THE PILL IS A TINT AND A BORDER, NEVER A SOLID FILL. A solid
       * `bg-danger` with white text next to a solid `bg-success` reads as a
       * traffic light bolted to the page. `/10` on the background and `/25` on
       * the border keeps the surface the page's own and lets the text carry the
       * colour, which is also what keeps it legible in both themes from one
       * declaration.
       */
      {
        variant: "pill" as const,
        tone: "neutral" as const,
        className: "border-border bg-muted text-muted-foreground",
      },
      {
        variant: "pill" as const,
        tone: "info" as const,
        className: "border-info/25 bg-info/10 text-info",
      },
      {
        variant: "pill" as const,
        tone: "success" as const,
        className: "border-success/25 bg-success/10 text-success",
      },
      {
        variant: "pill" as const,
        tone: "warning" as const,
        className: "border-warning/25 bg-warning/10 text-warning",
      },
      {
        variant: "pill" as const,
        tone: "danger" as const,
        className: "border-danger/25 bg-danger/10 text-danger",
      },
    ],
    defaultVariants: { variant: "plain", tone: "neutral" },
  },
)

export function Status({
  tone,
  label,
  variant,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children" | "label"> &
  VariantProps<typeof statusVariants> & {
    /**
     * The word. Required, and never empty — see the note at the top of this
     * file. A caller with no room for it passes a visually hidden node.
     */
    label: React.ReactNode
  }) {
  return (
    <span
      data-slot="status"
      className={cn(
        statusVariants({ variant, tone }),
        variant === "plain" || variant === undefined ? "text-foreground" : "",
        className,
      )}
      {...props}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  )
}
