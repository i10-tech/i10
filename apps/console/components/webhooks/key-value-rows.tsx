"use client"

import { Plus, X } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"

export type Pair = { name: string; value: string }

/** Rows that are not blank, as the record the API takes; null when none. */
export function pairsToRecord(pairs: Pair[]): Record<string, string> | null {
  const kept = pairs.filter((p) => p.name.trim() !== "")
  if (kept.length === 0) return null
  return Object.fromEntries(kept.map((p) => [p.name.trim(), p.value]))
}

export function recordToPairs(record: Record<string, string> | null): Pair[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
}

/**
 * Name and value rows: custom headers, and the tags a filter matches.
 *
 * ⚠ ONE EMPTY ROW IS ALWAYS THERE TO TYPE INTO, so adding the first pair is
 * typing rather than finding a button.
 */
export function KeyValueRows({
  value,
  onChange,
  nameLabel,
  valueLabel,
  namePlaceholder,
  valuePlaceholder,
  secret = false,
  max = 20,
  disabled = false,
}: {
  value: Pair[]
  onChange: (next: Pair[]) => void
  nameLabel: string
  valueLabel: string
  namePlaceholder?: string
  valuePlaceholder?: string
  /** Values are credentials: masked as they are typed. */
  secret?: boolean
  max?: number
  disabled?: boolean
}) {
  const rows = value.length === 0 ? [{ name: "", value: "" }] : value
  const set = (i: number, patch: Partial<Pair>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)))

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={row.name}
            onChange={(event) => set(i, { name: event.target.value })}
            placeholder={namePlaceholder}
            aria-label={`${nameLabel} ${i + 1}`}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Input
            value={row.value}
            onChange={(event) => set(i, { value: event.target.value })}
            placeholder={valuePlaceholder}
            aria-label={`${valueLabel} ${i + 1}`}
            type={secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="min-w-0 flex-[1.4] font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${nameLabel.toLowerCase()} ${i + 1}`}
            disabled={disabled || (rows.length === 1 && !row.name && !row.value)}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      {rows.length < max && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, { name: "", value: "" }])}
          className="-ml-2 text-muted-foreground"
        >
          <Plus />
          Add {nameLabel.toLowerCase()}
        </Button>
      )}
    </div>
  )
}
