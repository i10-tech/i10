import Link from "next/link"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "cn"

type Variant = "primary" | "secondary" | "ghost" | "brand"
type Size = "sm" | "md" | "lg"

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-fg text-brand-ink shadow-[inset_0_-1px_0_rgb(0_0_0/0.18),0_1px_0_rgb(255_255_255/0.08)] hover:bg-white",
  brand: "bg-brand text-brand-ink shadow-[inset_0_-1px_0_rgb(0_0_0/0.2)] hover:brightness-105",
  secondary:
    "bg-surface-3 text-fg shadow-[inset_0_0_0_1px_var(--line-strong),inset_0_1px_0_rgb(255_255_255/0.06)] hover:bg-surface-4",
  ghost: "text-fg-2 hover:text-fg",
}

const SIZE: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3.5 text-[13px]",
  md: "h-10 gap-2 px-4.5 text-sm",
  // One notch smaller on phones, so a primary and a secondary still share a row.
  lg: "h-11 gap-2 px-5 text-[14px] sm:h-12 sm:gap-2.5 sm:px-6 sm:text-[15px]",
}

/*
 * Every call to action on the site. A link, always: nothing here submits a
 * form, and a <button> that navigates breaks middle-click and "open in new
 * tab". The arrow is optional and nudges on hover; it is the only thing that
 * moves, so the label never shifts under the cursor.
 */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  arrow = false,
  external,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & {
  href: string
  variant?: Variant
  size?: Size
  arrow?: boolean
  external?: boolean
  children: ReactNode
}) {
  const isExternal = external ?? /^https?:\/\//.test(href)
  return (
    <Link
      href={href}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "group/btn relative inline-flex shrink-0 items-center justify-center rounded-full font-[520] tracking-[-0.005em] whitespace-nowrap transition-[background-color,color,filter,box-shadow] duration-200 ease-out select-none",
        VARIANT[variant],
        variant !== "ghost" && SIZE[size],
        variant === "ghost" && "gap-1.5 text-sm",
        className,
      )}
      {...props}
    >
      {children}
      {arrow ? <Arrow /> : null}
    </Link>
  )
}

export function Arrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden
      className={cn(
        "shrink-0 transition-transform duration-300 ease-[var(--ease-out-expo)] group-hover/btn:translate-x-0.5",
        className,
      )}
    >
      <path d="M3.5 8h8.5M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className={cn("shrink-0", className)}>
      <path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden className={cn("shrink-0", className)}>
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
