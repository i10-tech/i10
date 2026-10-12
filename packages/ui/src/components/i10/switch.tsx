"use client"

import type { ComponentProps, CSSProperties } from "react"
import { Switch as ArcSwitch } from "../switch/switch"

/**
 * Arc's Switch, green when on.
 *
 * A product decision (2026-10-03, kept in the Arc pass): every switch in the
 * console reads on as green and off as grey. Arc's switch fills with
 * `--control-on`, so this sets that one token for the switch and nothing
 * else; checkboxes and radios keep the accent.
 */
const green = {
  "--control-on": "var(--success)",
  "--control-thumb-on": "oklch(100% 0 0)",
} as CSSProperties

export function Switch({ style, ...props }: ComponentProps<typeof ArcSwitch>) {
  return <ArcSwitch style={{ ...green, ...style }} {...props} />
}
