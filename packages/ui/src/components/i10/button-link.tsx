"use client"

import type { AnchorHTMLAttributes, ReactNode } from "react"
import styles from "../button/button.module.css"
import type { ButtonSize, ButtonVariant } from "../button/button"
import { ArcLink } from "../lib/arc-provider"

/**
 * A link that looks like Arc's Button. Arc's rule is that navigation is a
 * link, never a button that pushes a route, and its Button has no `asChild`,
 * so this renders Arc's own button classes on `ArcLink` (Next's Link via
 * ArcNext). Nothing is restyled: the variant and size classes are Button's.
 */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  native = false,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string
  /** A plain `<a>`: downloads, other origins, and anything the router must not intercept. */
  native?: boolean
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}) {
  const classes = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(" ")
  const label = <span className={styles.labelPhase}>{children}</span>
  return native ? (
    <a href={href} className={classes} {...props}>
      {label}
    </a>
  ) : (
    <ArcLink href={href} className={classes} {...props}>
      {label}
    </ArcLink>
  )
}
