import * as React from "react"
import { cn } from "cn"

/*
 * The frame every console screen sits in.
 *
 * ⚠ IT EXISTS SO THAT NO PAGE DECIDES ITS OWN MARGINS. Twenty screens each
 * picking `px-6` or `px-8` for themselves is how a dashboard ends up with a
 * title that moves two pixels when you change tab — which nobody can name but
 * everybody feels. The horizontal padding, the max width and the gap between a
 * title and its content are properties of the CONSOLE, set once, here.
 *
 * ⚠ AND THERE IS NO `maxWidth` PROP. A log table wants the full viewport and a
 * settings form wants a readable measure, which is a real difference — but it
 * is a difference between KINDS of page, so it belongs in `PageBody`'s
 * `width` variant where there are three named answers, rather than in a number
 * each page passes and gets slightly wrong.
 */

export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      {...props}
    />
  )
}

/**
 * The sticky header: title, description, and the actions for the whole screen.
 *
 * ⚠ STICKY, AND THE BACKGROUND IS OPAQUE RATHER THAN BLURRED. A blurred
 * translucent header over a scrolling table smears the rows underneath it into
 * a grey band, and on the one surface where a person is scanning for a single
 * row that is actively hostile. The border below it is the whole affordance.
 */
export function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "sticky top-0 z-20 flex flex-col gap-1 border-b bg-background px-6 pt-5 pb-4",
        className,
      )}
      {...props}
    />
  )
}

export function PageHeaderRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-8 items-center justify-between gap-4", className)}
      {...props}
    />
  )
}

export function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-title"
      /*
       * ⚠ `font-display` IS THE DISPLAY FACE, AND IT IS SAFE TO APPLY BEFORE THE
       * FILE EXISTS. `--font-display` falls back to Geist's own stack (see
       * styles/tokens.css), so until something is published to cdn.i10.tech this
       * renders exactly as it did — and the day it is published, every page
       * title in the console changes with it and nothing else does.
       */
      className={cn("font-display text-xl font-semibold tracking-tight", className)}
      {...props}
    />
  )
}

export function PageDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-description"
      className={cn("max-w-2xl text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export function PageActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-actions"
      className={cn("flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  )
}

/**
 * The scrolling region.
 *
 * `full` — tables and logs, which want every pixel of width.
 * `wide` — dashboards and record lists: roomy, still bounded.
 * `prose` — settings and forms, bounded to a readable measure.
 */
export function PageBody({
  className,
  width = "wide",
  ...props
}: React.ComponentProps<"div"> & { width?: "full" | "wide" | "prose" }) {
  return (
    <div
      data-slot="page-body"
      className={cn(
        "flex-1 px-6 py-6",
        width === "wide" && "mx-auto w-full max-w-7xl",
        width === "prose" && "mx-auto w-full max-w-3xl",
        className,
      )}
      {...props}
    />
  )
}

/**
 * A titled block inside a settings page.
 *
 * ⚠ NOT A `Card`. Settings are a list of things you can change, and wrapping
 * each one in a raised surface turns a list into a stack of boxes with more
 * border than content. A heading, a description and a rule is the same
 * structure with none of the weight — which is what Resend, Attio and Vercel's
 * own settings all do.
 */
export function Section({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="section"
      className={cn("border-b py-6 first:pt-0 last:border-b-0 last:pb-0", className)}
      {...props}
    />
  )
}

export function SectionTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-sm font-medium", className)} {...props} />
}

export function SectionDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("mt-1 max-w-2xl text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export function SectionContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-4", className)} {...props} />
}
