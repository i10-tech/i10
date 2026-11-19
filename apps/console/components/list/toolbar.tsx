"use client"

import * as React from "react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { flushSync } from "react-dom"
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type Transition,
} from "motion/react"
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
 * The bar above every list, one height (36px) and one radius, so moving
 * between pages never moves the controls. Left to right: `ListSearch`;
 * `ListResults` (count and Clear), which takes the spare width; then
 * `ListToolbarEnd`, holding the filters and the view toggle.
 *
 * ⚠ NOTHING AT THE END MOVES WHEN SOMETHING ELSE CHANGES. The end cluster is
 * fixed-width (`FilterSelect` holds its width) and pinned to the right edge,
 * and the results group is the one flexible item: it absorbs the width of its
 * own text AND the search opening, so a pick, a count or the search never
 * shifts the filters.
 */
export function ListToolbar({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-list-toolbar
      className={cn("relative z-20 flex flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  )
}

/** The right-hand cluster: the filters, then the view toggle if the page has one. */
export function ListToolbarEnd({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-list-toolbar-end
      className={cn("ml-auto flex shrink-0 items-center gap-2", className)}
    >
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

/** `/` focuses the newest search box, unless a person is typing or a layer is open. */
function useSlashShortcut(focus: () => void) {
  const latest = React.useRef(focus)
  React.useEffect(() => {
    latest.current = focus
  })
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
      latest.current()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      slashStack.splice(slashStack.indexOf(me), 1)
    }
  }, [])
}

/**
 * The search as an icon that opens into a field: 36px square while it has
 * nothing to do, ~16rem once opened. For the toolbar's left edge.
 *
 * ⚠ THE FIELD GROWS RIGHTWARDS, IN FLOW, AND THE RESULTS GROUP AFTER IT GIVES
 * WAY. The end cluster is `shrink-0` and pinned right, so the width the search
 * takes comes out of the results group and nothing at the end moves. The open
 * width is clamped to what the toolbar leaves beside that cluster, so opening
 * can never wrap it.
 *
 * ⚠ OPEN WHILE IT HAS A VALUE OR FOCUS. `wanted` is only the click or `/` that
 * asked for it: the field closes on blur when empty, and stays showing its
 * value when blurred with one. Esc clears; Esc again, or Esc on an empty
 * field, closes it and hands focus back to the icon.
 */
const SEARCH_WIDTH = 256

export function ListSearch({
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
  const reduced = useReducedMotion() ?? false
  const rootRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const [wanted, setWanted] = React.useState(false)
  const open = wanted || value !== ""
  // 36 is the icon's width until the first layout effect measures it.
  const width = useMotionValue(value !== "" ? SEARCH_WIDTH : 36)
  const placed = React.useRef(false)

  /** The icon's own width closed; open, 16rem or whatever the toolbar leaves beside the end cluster. */
  const goal = React.useCallback((isOpen: boolean) => {
    const root = rootRef.current
    if (!root) return SEARCH_WIDTH
    const closed = parseFloat(getComputedStyle(root).minWidth) || 36
    if (!isOpen) return closed
    const bar = root.closest<HTMLElement>("[data-list-toolbar]")
    if (!bar) return SEARCH_WIDTH
    const end = bar.querySelector<HTMLElement>("[data-list-toolbar-end]")
    // An end cluster already on a row of its own leaves the whole row.
    const wrapped = end !== null && end.offsetTop >= root.offsetTop + root.offsetHeight
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 8
    // The slack is the spring's overshoot: it must not push the end cluster to a new row.
    const room =
      end === null || wrapped
        ? bar.clientWidth
        : bar.clientWidth - end.offsetWidth - 2 * gap - 4
    return Math.max(closed, Math.min(SEARCH_WIDTH, room))
  }, [])

  React.useLayoutEffect(() => {
    const next = goal(open)
    if (!placed.current || reduced) {
      width.jump(next)
      placed.current = true
      return
    }
    animate(
      width,
      next,
      open ? motionTokens.spring.morph : motionTokens.spring.smooth,
    )
  }, [open, reduced, width, goal])

  // A toolbar or end cluster that resizes while the field is open is not a
  // person's action: follow it at once.
  //
  // ⚠ A ResizeObserver REPORTS ONCE WHEN IT STARTS OBSERVING. Treating that
  // first callback as a resize jumped the width to its target on every open
  // and killed the spring, so the field snapped open while closing, with no
  // observer, animated. Only a measured change counts.
  React.useLayoutEffect(() => {
    const bar = rootRef.current?.closest<HTMLElement>("[data-list-toolbar]")
    if (!open || !bar || typeof ResizeObserver === "undefined") return
    const end = bar.querySelector<HTMLElement>("[data-list-toolbar-end]")
    const size = () => `${bar.clientWidth}:${end?.offsetWidth ?? 0}`
    let last = size()
    const observer = new ResizeObserver(() => {
      const now = size()
      if (now === last) return
      last = now
      width.jump(goal(true))
    })
    observer.observe(bar)
    if (end) observer.observe(end)
    return () => observer.disconnect()
  }, [open, width, goal])

  // Cleared from outside (the results group's Clear) while not being typed in.
  React.useEffect(() => {
    if (value === "" && document.activeElement !== inputRef.current) setWanted(false)
  }, [value])

  function expand() {
    // The field is inert until this flush makes it focusable, so touch
    // keyboards open inside the same tap.
    flushSync(() => setWanted(true))
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }
  useSlashShortcut(expand)

  const fade: Transition = reduced
    ? { duration: 0.15 }
    : open
      ? { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] as [number, number, number, number], delay: 0.06 }
      : { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] as [number, number, number, number] }

  return (
    <motion.div
      ref={rootRef}
      style={{ width }}
      data-list-search
      data-open={open || undefined}
      className={cn(
        "relative h-[var(--control-height-md)] min-w-[var(--control-height-md)] shrink-0 overflow-hidden rounded-full border border-border bg-[var(--surface)] text-muted-foreground shadow-[var(--shadow-resting)]",
        "transition-[border-color,background-color,color,box-shadow] duration-150",
        "data-[open]:text-foreground [@media(hover:hover)]:not-data-[open]:hover:bg-[var(--surface-muted)] [@media(hover:hover)]:not-data-[open]:hover:text-foreground",
        "has-[input:focus]:border-foreground has-[input:focus]:shadow-[0_0_0_3px_var(--focus-ring)] has-[button:focus-visible]:border-foreground has-[button:focus-visible]:shadow-[0_0_0_3px_var(--focus-ring)]",
        className,
      )}
    >
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-[calc(var(--control-height-md)/2)] size-4 -translate-x-1/2 -translate-y-1/2"
      />
      {!open && (
        <Tooltip
          content={
            <>
              Search <Kbd className="ml-1">/</Kbd>
            </>
          }
        >
          <button
            ref={buttonRef}
            type="button"
            aria-label={label}
            onClick={expand}
            className="absolute inset-0 z-10 cursor-pointer rounded-full outline-none"
          />
        </Tooltip>
      )}
      <motion.input
        ref={inputRef}
        type="search"
        value={value}
        inert={!open}
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={fade}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          // Switching windows keeps the field as it was.
          if (!document.hasFocus()) return
          if (value === "") setWanted(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          if (value) {
            onChange("")
            return
          }
          flushSync(() => setWanted(false))
          buttonRef.current?.focus({ preventScroll: true })
        }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        className="absolute inset-0 size-full bg-transparent pr-9 pl-[var(--control-height-md)] text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      <AnimatePresence initial={false}>
        {open && value && (
          <motion.div
            key="clear"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.12 }}
            className="absolute top-1/2 right-2 flex -translate-y-1/2"
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
                // The field keeps focus through the press, so Esc still works.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange("")
                  inputRef.current?.focus({ preventScroll: true })
                }}
                className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** `ListSearch` bound to a URL parameter, debounced. */
export function UrlListSearch({
  param = "search",
  ...props
}: { param?: string } & Omit<
  React.ComponentProps<typeof ListSearch>,
  "value" | "onChange"
>) {
  const [text, setText] = useUrlSearch(param)
  return <ListSearch value={text} onChange={setText} {...props} />
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
  triggerWidth = "widest",
  className,
}: {
  /** "" for all. */
  value: string
  onValueChange: (value: string) => void
  options: FilterOption[]
  allLabel: string
  label: string
  /**
   * "widest" (the default) holds the widest option. Pass a width in px for
   * options that come from data: they are not all known while it loads, so
   * the trigger is fixed and a long label ellipsizes.
   */
  triggerWidth?: "widest" | number
  className?: string
}) {
  const active = value !== "" && options.some((o) => o.value === value)
  return (
    <MorphSelect
      label={label}
      hideLabel
      align="end"
      // ⚠ A FIXED WIDTH, OR THE WIDEST OPTION'S, SO A PICK (OR DATA ARRIVING)
      // NEVER MOVES WHAT IS BESIDE IT.
      triggerWidth={triggerWidth}
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
            // Arc's Button sizes its label slot to the label and centres it; this
            // select's label starts at the left like FilterSelect's beside it.
            "[&_[class$=__labelSlot]]:w-full! [&_[class$=__labelContent]]:w-full [&_[class$=__labelPhase]]:w-full [&_[class$=__labelPhase]]:justify-between",
            picked.length > 0 && "border-foreground/25",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center justify-start gap-2 truncate text-left">
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

/**
 * The results and Clear of a filtered list, one inline element after the
 * search: "7 keys for "acme"  Clear", or only "Clear" where the list does not
 * know a total (`count` left out). It is there while something is filtered or
 * searched, and fades in place.
 *
 * ⚠ IT TAKES THE TOOLBAR'S SPARE WIDTH (`flex-1`) AND PAINTS NOTHING UNTIL IT
 * IS NEEDED. It used to be a row of its own under the toolbar, animating its
 * height, so every filter change pushed the table down. Here the slot exists
 * either way: only its opacity changes.
 */
export function ListResults({
  count,
  noun,
  query,
  filtered,
  onClear,
}: {
  /** The number of rows; omit it where only a page of them is loaded. */
  count?: number
  noun?: [string, string]
  query: string
  filtered: boolean
  onClear: () => void
}) {
  const searching = query.trim() !== ""
  return (
    <div className="flex h-[var(--control-height-md)] min-w-0 flex-1 items-center">
      <AnimatePresence initial={false}>
        {(filtered || searching) && (
          <motion.div
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: motionTokens.duration.fast,
              ease: [...motionTokens.ease.standard],
            }}
            // The padding is here, not on the slot: a padded empty slot has a
            // minimum width, and the search is sized to leave the slot none.
            className="flex min-w-0 items-center gap-1 pl-1 text-sm text-muted-foreground"
          >
            {count !== undefined && noun && (
              <span className="tabular min-w-0 truncate">
                <SlotText
                  value={count}
                  duration={0.5}
                  spins={0}
                  className="font-medium text-foreground"
                />{" "}
                {count === 1 ? noun[0] : noun[1]}
                {searching && <> for “{query.trim()}”</>}
              </span>
            )}
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * `ListResults` for a URL list: shown while any of `params` is set, and Clear
 * deletes them all, the search included.
 */
export function UrlListResults({
  params,
  searchParam = "search",
  count,
  noun,
}: {
  /** Every parameter Clear resets, the search's among them. */
  params: string[]
  searchParam?: string
  count?: number
  noun?: [string, string]
}) {
  const { params: current, commit } = useUrlList()
  return (
    <ListResults
      count={count}
      noun={noun}
      query={current.get(searchParam) ?? ""}
      filtered={params.some((p) => p !== searchParam && Boolean(current.get(p)))}
      onClear={() => commit((p) => params.forEach((name) => p.delete(name)))}
    />
  )
}
