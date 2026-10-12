"use client"

import * as React from "react"
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu"
import { motion, useReducedMotion } from "motion/react"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "cn"
import { motionTokens } from "../lib/motion-tokens"
import styles from "../dropdown-menu/dropdown-menu.module.css"

/**
 * Arc's dropdown menu, composable.
 *
 * Arc's own DropdownMenu takes a text label as its trigger and its items as
 * data. The console needs what that API cannot express: an icon-only "more"
 * trigger on table rows, an avatar trigger, controlled open state, checkbox
 * items and one submenu. So this is the same Radix primitive with Arc's own
 * stylesheet (menu, item, separator, the gliding highlight) and the same
 * highlight logic, exposed as parts. Where a labelled trigger is enough, use
 * Arc's DropdownMenu directly.
 */

type Highlight = { top: number; height: number; danger: boolean; glide: boolean }

/**
 * ⚠ NOT MODAL BY DEFAULT. A modal Radix menu turns pointer events off for the
 * whole page while it is open and hands them back on close; inside a dialog
 * that hand-back is what left the dialog's buttons without hover after a menu
 * closed. Outside clicks still close the menu, and focus still returns.
 */
export function DropdownMenu({
  modal = false,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Root>) {
  return <DropdownPrimitive.Root modal={modal} {...props} />
}
export const DropdownMenuTrigger = DropdownPrimitive.Trigger
export const DropdownMenuGroup = DropdownPrimitive.Group
export const DropdownMenuSub = DropdownPrimitive.Sub

function useHighlight() {
  const [highlight, setHighlight] = React.useState<Highlight | null>(null)
  const pointer = React.useRef(false)
  const clearTimer = React.useRef(0)
  React.useEffect(() => () => window.clearTimeout(clearTimer.current), [])
  // Radix focuses the highlighted item (pointer or keyboard), and the content
  // when the pointer leaves an item.
  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const item =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(
            '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
          )
        : null
    window.clearTimeout(clearTimer.current)
    if (!item) {
      // A short grace period keeps the highlight gliding across separators.
      clearTimer.current = window.setTimeout(
        () => setHighlight(null),
        pointer.current ? 70 : 0,
      )
      return
    }
    const next = {
      top: item.offsetTop,
      height: item.offsetHeight,
      danger: item.dataset.tone === "danger",
    }
    const glide = pointer.current
    setHighlight((current) => ({ ...next, glide: glide && current !== null }))
  }
  return {
    highlight,
    onFocus,
    onPointerMoveCapture: () => {
      pointer.current = true
    },
    onKeyDownCapture: () => {
      pointer.current = false
    },
  }
}

function HighlightBar({ highlight }: { highlight: Highlight | null }) {
  const reduced = useReducedMotion()
  return (
    <motion.span
      className={styles.highlight}
      data-tone={highlight?.danger ? "danger" : undefined}
      aria-hidden="true"
      initial={false}
      animate={
        highlight
          ? { y: highlight.top, height: highlight.height, opacity: 1 }
          : { opacity: 0 }
      }
      transition={{
        default:
          highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 },
        opacity: { duration: reduced ? 0 : 0.08 },
      }}
    />
  )
}

/** Numbers the items so Arc's entrance staggers them (its `--i`). */
function useStagger(ref: React.RefObject<HTMLDivElement | null>) {
  React.useLayoutEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>(`:scope > .${styles.item}`)
    items?.forEach((node, index) => node.style.setProperty("--i", String(index)))
  })
}

export function DropdownMenuContent({
  className,
  children,
  sideOffset = 6,
  align = "end",
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Content>) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { highlight, ...handlers } = useHighlight()
  useStagger(ref)
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        loop
        className={cn(styles.menu, className)}
        {...handlers}
        {...props}
      >
        <HighlightBar highlight={highlight} />
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  )
}

export function DropdownMenuSubContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.SubContent>) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { highlight, ...handlers } = useHighlight()
  useStagger(ref)
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.SubContent
        ref={ref}
        sideOffset={6}
        collisionPadding={12}
        loop
        className={cn(styles.menu, className)}
        {...handlers}
        {...props}
      >
        <HighlightBar highlight={highlight} />
        {children}
      </DropdownPrimitive.SubContent>
    </DropdownPrimitive.Portal>
  )
}

/** Icons in items take Arc's item icon treatment: 16px, secondary ink. */
const itemIcons =
  "[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--text-secondary)] [&_svg]:[stroke-width:1.75]"

export function DropdownMenuItem({
  className,
  variant = "default",
  inset,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Item> & {
  variant?: "default" | "destructive"
  inset?: boolean
}) {
  const danger = variant === "destructive"
  return (
    <DropdownPrimitive.Item
      data-tone={danger ? "danger" : undefined}
      className={cn(
        styles.item,
        danger && styles.destructive,
        itemIcons,
        danger && "[&>svg]:text-[var(--danger)]",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.CheckboxItem>) {
  return (
    <DropdownPrimitive.CheckboxItem
      className={cn(styles.item, itemIcons, className)}
      {...props}
    >
      <span className="inline-flex w-4 shrink-0 justify-center" aria-hidden="true">
        <DropdownPrimitive.ItemIndicator>
          <Check size={14} strokeWidth={1.75} />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  )
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.SubTrigger>) {
  return (
    <DropdownPrimitive.SubTrigger
      className={cn(styles.item, itemIcons, className)}
      {...props}
    >
      {children}
      <ChevronRight
        className="ml-auto text-[var(--text-muted)]"
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </DropdownPrimitive.SubTrigger>
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Separator>) {
  return (
    <DropdownPrimitive.Separator
      className={cn(styles.separator, className)}
      {...props}
    />
  )
}

/** A quiet heading over a group of items. Sentence case, never an eyebrow. */
export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Label>) {
  return (
    <DropdownPrimitive.Label
      className={cn("px-[11px] pt-2 pb-1 text-xs text-[var(--text-muted)]", className)}
      {...props}
    />
  )
}

export function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto text-xs text-[var(--text-muted)] tabular-nums", className)}
      {...props}
    />
  )
}
