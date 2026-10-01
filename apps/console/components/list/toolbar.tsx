"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronDown, LayoutGrid, Search, Table2, X } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Input } from "@repo/ui/components/input"
import { Kbd } from "@repo/ui/components/kbd"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { ToggleGroup, ToggleGroupItem } from "@repo/ui/components/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
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
    <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>
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
              className="pointer-events-auto"
            >
              <Tooltip>
                <TooltipTrigger asChild>
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
                </TooltipTrigger>
                <TooltipContent>
                  Clear <Kbd className="ml-1">Esc</Kbd>
                </TooltipContent>
              </Tooltip>
            </motion.div>
          ) : !focused ? (
            <motion.div
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
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
  const current = value ? options.find((o) => o.value === value) : undefined
  const active = current !== undefined
  return (
    <Select
      value={active ? value : ALL}
      onValueChange={(v) => onValueChange(v === ALL ? "" : v)}
    >
      <SelectTrigger
        className={cn(
          "h-9 w-44 rounded-xl transition-colors hover:bg-muted/50",
          active && "border-foreground/25",
          className,
        )}
        aria-label={label}
      >
        {/*
         * ⚠ THE TEXT IS GIVEN, NOT LOOKED UP. Radix reads the selected item's
         * label from the open menu's items, which do not exist on the server,
         * so the trigger rendered empty until hydration - a flash on every load.
         */}
        <SelectValue>
          <span className="flex items-center gap-2">
            {current?.icon}
            {current?.label ?? allLabel}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex items-center gap-2">
              {o.icon}
              {o.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={label}
          className={cn(
            "h-9 w-44 justify-between rounded-xl px-3 font-normal shadow-xs hover:bg-muted/50 data-[state=open]:bg-muted/50",
            picked.length > 0 && "border-foreground/25",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {picked.length === 1 && picked[0]!.icon}
            <span className="truncate">{summary}</span>
          </span>
          <ChevronDown className="size-4 opacity-50" />
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
export function UrlRangeSelect({ param = "days" }: { param?: string }) {
  return (
    <UrlFilterSelect
      param={param}
      options={RANGES.map((r) => ({ ...r }))}
      allLabel="All time"
      label="Date range"
      className="w-40"
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
            className="h-9 rounded-xl text-muted-foreground"
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

export type View = "grid" | "table"

/** Grid or table, as the templates page offers it. */
export function ViewToggle({
  value,
  onChange,
}: {
  value: View
  onChange: (view: View) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as View)}
      className="h-9 rounded-xl border p-0.5"
      aria-label="Layout"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="grid" aria-label="Grid" className="size-8 rounded-lg">
            <LayoutGrid />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Grid</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem
            value="table"
            aria-label="Table"
            className="size-8 rounded-lg"
          >
            <Table2 />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Table</TooltipContent>
      </Tooltip>
    </ToggleGroup>
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
        return stored === "grid" || stored === "table" ? stored : fallback
      } catch {
        return fallback
      }
    },
    () => fallback,
  )
  const choose = React.useCallback(
    (next: View) => {
      try {
        localStorage.setItem(`i10.${key}.view`, next)
      } catch {
        // Remembering is a convenience.
      }
      for (const notify of viewListeners) notify()
    },
    [key],
  )
  return [view, choose]
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
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <p className="flex items-center gap-2 pt-4 text-sm text-muted-foreground">
            <span className="tabular">
              <motion.span
                key={count}
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                className="inline-block font-medium text-foreground"
              >
                {count}
              </motion.span>{" "}
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
