"use client"

import * as React from "react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { AnimatePresence, motion } from "motion/react"
import { Search, X } from "lucide-react"
import { ChevronIcon } from "@repo/ui/components/icon-morph/icon-morph"
import { TextMorph } from "@repo/ui/components/text-morph/text-morph"
import { Button } from "@repo/ui/components/button/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import { Input } from "@repo/ui/components/i10/input"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { SlotText } from "@repo/ui/components/slot-text/slot-text"
import SegmentedControl from "@repo/ui/components/segmented-control/segmented-control"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { cn } from "cn"
import {
  useServerViews,
  viewCookie,
  type View,
} from "@/components/list/remembered-views"
import { useUrlList, useUrlParam, useUrlSearch } from "@/components/list/url-state"
import { RANGES } from "@/lib/range"

/**
 * The bar above every list: search, filters, the view, in Resend's order and
 * at one height (36px) and one radius, so moving between pages never moves
 * the controls.
 */
export function ListToolbar({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("relative z-20 flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  )
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * A search box. `/` focuses it from anywhere on the page and Esc clears it,
 * as Resend's does.
 *
 * ⚠ THE NEWEST SEARCH BOX TAKES THE SHORTCUT. During a page transition the
 * outgoing page is still mounted beside the incoming one, so "the first to
 * mount" would leave `/` with a box that is about to disappear.
 */
const slashStack: symbol[] = []

export function SearchField({
  value,
  onChange,
  placeholder = "Search…",
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  className?: string
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    const me = Symbol("search")
    slashStack.push(me)
    function onKey(event: KeyboardEvent) {
      if (slashStack.at(-1) !== me) return
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return
      if (document.querySelector("[role=dialog], [role=menu]")) return
      event.preventDefault()
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      slashStack.splice(slashStack.indexOf(me), 1)
    }
  }, [])

  return (
    <div className={cn("relative min-w-48 flex-1", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault()
            onChange("")
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 rounded-xl pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
        <AnimatePresence initial={false} mode="popLayout">
          {value ? (
            <motion.div
              key="clear"
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.12 }}
              className="pointer-events-auto flex"
            >
              <Tooltip
                content={
                  <>
                    Clear <Kbd className="ml-1">Esc</Kbd>
                  </>
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    onChange("")
                    ref.current?.focus()
                  }}
                  className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              </Tooltip>
            </motion.div>
          ) : !focused ? (
            <motion.div
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              // ⚠ FLEX, so there is no line box: a block around an inline
              // badge is taller than it by the descender, and the badge sat
              // off the field's centre line by that much.
              className="flex"
            >
              <Kbd className="hidden sm:inline-flex">/</Kbd>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** A search box bound to a URL parameter, debounced. */
export function UrlSearchField({
  param = "search",
  ...props
}: { param?: string } & Omit<
  React.ComponentProps<typeof SearchField>,
  "value" | "onChange"
>) {
  const [text, setText] = useUrlSearch(param)
  return <SearchField value={text} onChange={setText} {...props} />
}

// ── Filters ────────────────────────────────────────────────────────────────

export interface FilterOption {
  value: string
  label: string
  /** A dot or icon before the label. */
  icon?: React.ReactNode
}

/** "All …" is this value, so an empty filter is never a Radix item value. */
const ALL = "__all"

/** One filter, Resend's "All statuses" select. */
export function FilterSelect({
  value,
  onValueChange,
  options,
  allLabel,
  label,
  className,
}: {
  /** "" for all. */
  value: string
  onValueChange: (value: string) => void
  options: FilterOption[]
  allLabel: string
  label: string
  className?: string
}) {
  const active = value !== "" && options.some((o) => o.value === value)
  return (
    <MorphSelect
      label={label}
      hideLabel
      align="end"
      value={active ? value : ALL}
      onValueChange={(v) => onValueChange(v === ALL ? "" : v)}
      items={[
        { value: ALL, label: allLabel },
        ...options.map((o) => ({ value: o.value, label: o.label, icon: o.icon })),
      ]}
      className={className}
    />
  )
}

export function UrlFilterSelect({
  param,
  ...props
}: { param: string } & Omit<
  React.ComponentProps<typeof FilterSelect>,
  "value" | "onValueChange"
>) {
  const [value, setValue] = useUrlParam(param)
  return <FilterSelect value={value} onValueChange={setValue} {...props} />
}

/**
 * Several values of one filter at once - "bounced or failed" - looking like
 * the single select beside it.
 *
 * ⚠ THE MENU STAYS OPEN AS ITEMS ARE TICKED, so picking three states is one
 * trip into the menu, not three.
 */
export function FilterMulti({
  values,
  onValuesChange,
  options,
  allLabel,
  label,
  noun,
  className,
}: {
  values: string[]
  onValuesChange: (values: string[]) => void
  options: FilterOption[]
  allLabel: string
  label: string
  /** Plural, for "3 statuses". */
  noun: string
  className?: string
}) {
  const picked = options.filter((o) => values.includes(o.value))
  const summary =
    picked.length === 0
      ? allLabel
      : picked.length === 1
        ? picked[0]!.label
        : `${picked.length} ${noun}`
  const [open, setOpen] = React.useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          aria-label={label}
          className={cn(
            "h-9 w-44 justify-between rounded-xl px-3 font-normal shadow-xs hover:bg-muted/50 data-[state=open]:bg-muted/50",
            picked.length > 0 && "border-foreground/25",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {picked.length === 1 && picked[0]!.icon}
            <TextMorph className="truncate">{summary}</TextMorph>
          </span>
          <ChevronIcon state={open} size={16} className="opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={values.includes(o.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onValuesChange(
                checked ? [...values, o.value] : values.filter((v) => v !== o.value),
              )
            }
          >
            <span className="flex items-center gap-2">
              {o.icon}
              {o.label}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {values.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onValuesChange([])}>
              <X />
              Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `FilterMulti` bound to a comma-separated URL parameter. */
export function UrlFilterMulti({
  param,
  ...props
}: { param: string } & Omit<
  React.ComponentProps<typeof FilterMulti>,
  "values" | "onValuesChange"
>) {
  const [value, setValue] = useUrlParam(param)
  const values = value.split(",").filter(Boolean)
  return (
    <FilterMulti
      values={values}
      onValuesChange={(next) => setValue(next.join(","))}
      {...props}
    />
  )
}

// ── Date range ─────────────────────────────────────────────────────────────

/** Resend's "Last 15 days", as `?days=`. */
export function UrlRangeSelect({
  param = "days",
  className,
}: {
  param?: string
  className?: string
}) {
  return (
    <UrlFilterSelect
      param={param}
      options={RANGES.map((r) => ({ ...r }))}
      allLabel="All time"
      label="Date range"
      className={cn("w-40", className)}
    />
  )
}

/** "Clear filters", shown only while something is filtered. */
export function UrlClearFilters({ params }: { params: string[] }) {
  const { params: current, commit } = useUrlList()
  const active = params.some((p) => current.get(p))
  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.div
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.15 }}
        >
          <Button
            variant="ghost"

            onClick={() => commit((p) => params.forEach((name) => p.delete(name)))}
          >
            <X />
            Clear
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── View ───────────────────────────────────────────────────────────────────

export type { View }

/** Grid or table, as the templates page offers it. */
export function ViewToggle({
  value,
  onChange,
}: {
  value: View
  onChange: (view: View) => void
}) {
  return (
    <SegmentedControl
      label="Layout"
      value={value}
      onValueChange={(v) => onChange(v as View)}
      options={[
        { value: "grid", label: "Grid" },
        { value: "table", label: "Table" },
      ]}
    />
  )
}

/**
 * The view a page was last left in, per browser.
 *
 * ⚠ AN EXTERNAL STORE, so the server renders the default and the browser
 * switches to the remembered view without a render of the wrong one first.
 */
const viewListeners = new Set<() => void>()
export function useRememberedView(
  key: string,
  fallback: View = "table",
): [View, (view: View) => void] {
  // What the server rendered with: the cookie, else the page's default.
  const fromServer = useServerViews()[key] ?? fallback
  const view = React.useSyncExternalStore(
    (notify) => {
      viewListeners.add(notify)
      window.addEventListener("storage", notify)
      return () => {
        viewListeners.delete(notify)
        window.removeEventListener("storage", notify)
      }
    },
    () => {
      try {
        const stored = localStorage.getItem(`i10.${key}.view`)
        return stored === "grid" || stored === "table" ? stored : fromServer
      } catch {
        return fromServer
      }
    },
    () => fromServer,
  )
  // A choice made before views were kept in a cookie: write it now, so the
  // next load renders it from the start.
  React.useEffect(() => {
    if (view !== fromServer) writeViewCookie(key, view)
  }, [key, view, fromServer])
  const choose = React.useCallback(
    (next: View) => {
      try {
        localStorage.setItem(`i10.${key}.view`, next)
      } catch {
        // Remembering is a convenience.
      }
      writeViewCookie(key, next)
      for (const notify of viewListeners) notify()
    },
    [key],
  )
  return [view, choose]
}

function writeViewCookie(key: string, view: View) {
  document.cookie = `${viewCookie(key)}=${view}; path=/; max-age=31536000; samesite=lax`
}

// ── Results ────────────────────────────────────────────────────────────────

/** "3 results for "acme"", under the toolbar while a client-side list is filtered. */
export function ResultsLine({
  count,
  query,
  filtered,
  noun,
  onClear,
}: {
  count: number
  query: string
  filtered: boolean
  noun: [string, string]
  onClear: () => void
}) {
  const showing = filtered || query.trim() !== ""
  return (
    <AnimatePresence initial={false}>
      {showing && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={motionTokens.spring.smooth}
          className="[overflow-y:clip]"
        >
          <p className="flex items-center gap-2 pt-4 text-sm text-muted-foreground">
            <span className="tabular">
              <SlotText
                value={count}
                duration={0.5}
                className="font-medium text-foreground"
              />{" "}
              {count === 1 ? noun[0] : noun[1]}
              {query.trim() && <> for “{query.trim()}”</>}
            </span>
            <button
              type="button"
              onClick={onClear}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear
            </button>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
