"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { cn } from "cn"

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HTTPS = /^https:\/\//i
const PREFIX = "https://"

/** What the field shows: the address without its `https://`. */
export const shownUrl = (url: string) => url.replace(HTTPS, "")

/** The address the field stands for, from what is typed or pasted into it. */
export function toUrl(typed: string): string {
  const rest = typed.replace(HTTPS, "")
  if (rest === "") return ""
  // Another scheme (`http://`) is kept as typed, so validation can say what is
  // wrong with it rather than this quietly rewriting it.
  return SCHEME.test(rest) ? rest : `${PREFIX}${rest}`
}

/**
 * The prefix itself, with the variable dialog's motion (see
 * template-editor/variables.tsx): in once the label has risen, 100ms later,
 * sliding from the value; out quicker than it came.
 */
export function HttpsPrefix({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.span
          key="https"
          initial={{ opacity: 0, x: 4 }}
          animate={{ opacity: 1, x: 0, transition: { delay: 0.1, duration: 0.18 } }}
          exit={{ opacity: 0, x: 4, transition: { duration: 0.1 } }}
        >
          {PREFIX}
        </motion.span>
      )}
    </AnimatePresence>
  )
}

/**
 * Focus anywhere inside, as state. `ValidatedInput` owns the input's own
 * focus and blur handlers for its verdicts, so the wrapper listens instead
 * (React's focus events bubble).
 */
export function useFocusWithin() {
  const [focused, setFocused] = React.useState(false)
  return {
    focused,
    props: {
      onFocus: () => setFocused(true),
      onBlur: (event: React.FocusEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false)
      },
    },
  }
}

/**
 * An address field that writes the `https://` for you, the way the variable
 * dialog draws `{{{ }}}` around a name: the scheme fades in at the start of
 * the field while it is in use, and what is typed after it is the rest of the
 * address. A pasted address that starts with `https://` loses it, so it is
 * never there twice.
 *
 * ⚠ THE VALUE IS STILL THE WHOLE URL. `value`, `onValueChange` and `check` all
 * see `https://acme.com/hooks`; only the box shows `acme.com/hooks`. Callers,
 * saved values and validation do not change.
 */
export function UrlInput({
  value,
  onValueChange,
  check,
  className,
  containerClassName,
  ...props
}: Omit<
  React.ComponentProps<typeof ValidatedInput>,
  "value" | "onChange" | "type" | "underlay"
> & {
  value: string
  onValueChange: (url: string) => void
}) {
  const text = shownUrl(value)
  // Another scheme was typed: the field shows it as it is, with no prefix.
  const own = SCHEME.test(text)
  const { focused, props: focus } = useFocusWithin()
  const affix = !own && (focused || text !== "")

  return (
    <div {...focus} className={containerClassName}>
      <ValidatedInput
        {...props}
        type="text"
        inputMode="url"
        autoCapitalize="none"
        autoComplete="off"
        value={text}
        onChange={(event) => onValueChange(toUrl(event.target.value))}
        check={check ? (typed) => check(toUrl(typed)) : undefined}
        className={cn(
          "font-mono text-sm transition-[padding] duration-(--duration-dismiss) ease-(--ease-quad-out)",
          className,
        )}
        // The address starts after `https://`; `ch` is this monospace face's width.
        style={affix ? { paddingInlineStart: "calc(1.5rem + 8ch)" } : undefined}
        underlay={
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-6 flex items-center font-mono text-sm whitespace-pre text-muted-foreground"
          >
            <HttpsPrefix show={affix} />
          </span>
        }
      />
    </div>
  )
}
