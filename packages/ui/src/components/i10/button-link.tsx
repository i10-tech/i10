"use client"

import type { AnchorHTMLAttributes, ReactNode } from "react"
import { useEffect, useState } from "react"
import { useLinkStatus } from "next/link"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import styles from "../button/button.module.css"
import type { ButtonSize, ButtonVariant } from "../button/button"
import { motionTokens } from "../lib/motion-tokens"
import { ArcLink } from "../lib/arc-provider"

function ButtonLinkContent({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus()
  const reduceMotion = useReducedMotion() ?? false
  const [delayedPending, setDelayedPending] = useState(false)

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setDelayedPending(true), 150)
    return () => {
      clearTimeout(timer)
      setDelayedPending(false)
    }
  }, [pending])

  const showSpinner = pending && delayedPending

  return (
    <>
      <AnimatePresence initial={false}>
        {showSpinner ? (
          <motion.span
            key="loader"
            className={styles.loader}
            aria-hidden="true"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
            transition={
              reduceMotion
                ? { duration: motionTokens.duration.instant }
                : {
                    ...motionTokens.spring.snappy,
                    opacity: {
                      duration: motionTokens.duration.fast,
                      ease: [...motionTokens.ease.enter],
                    },
                  }
            }
          >
            <span className={styles.spinner} />
          </motion.span>
        ) : null}
      </AnimatePresence>
      <span
        className={[styles.labelPhase, showSpinner ? styles.loadingLabel : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </span>
    </>
  )
}

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
  return native ? (
    <a href={href} className={classes} {...props}>
      <span className={styles.labelPhase}>{children}</span>
    </a>
  ) : (
    <ArcLink href={href} className={classes} {...props}>
      <ButtonLinkContent>{children}</ButtonLinkContent>
    </ArcLink>
  )
}
