"use client"

import * as React from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { cn } from "cn"
import { useMounted } from "@/lib/react"

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/**
 * ⚠ NO OPTION IS MARKED SELECTED UNTIL HYDRATION, AND THAT IS NOT A LOADING
 * STATE — IT IS A HYDRATION FIX. `useTheme()` cannot know the stored preference
 * on the server, so the first render always says "system"; if the person has
 * chosen dark, the server HTML and the client's first paint disagree, React
 * logs a mismatch, and the wrong option is briefly highlighted. `useMounted`
 * answers "are we past hydration" without a state update — see lib/react.ts.
 */
export function ThemePicker() {
  const { theme, setTheme } = useTheme()
  const mounted = useMounted()

  return (
    <div
      className="flex flex-wrap gap-2"
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map((option) => {
        const selected = mounted && theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={cn(
              "flex w-28 cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 transition-colors",
              "duration-(--duration-instant) ease-(--ease-linear)",
              selected ? "border-foreground/40 bg-muted/40" : "hover:bg-muted/30",
            )}
          >
            <option.icon className="size-4" />
            <span className="text-xs font-medium">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
