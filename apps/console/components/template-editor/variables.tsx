"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  CornerDownLeft,
  Pencil,
  Plus,
  Trash2,
  Variable as VariableIcon,
  X,
} from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { FormDialog } from "@/components/form-dialog"
import { useResetOnOpen } from "@/lib/react"
import type { DeclaredVariable } from "@/lib/types"

/** Resend's ceiling on a template's variables. */
export const MAX_VARIABLES = 50
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Creating or editing one variable: its name, its type, and the fallback a
 * send gets when it leaves the variable out - Resend's "Create variable".
 *
 * ⚠ WITHOUT A FALLBACK, LEAVING THE VARIABLE OUT REFUSES THE SEND. The hint
 * says so, because "optional" is what people assume an empty field means.
 */
export function VariableDialog({
  open,
  onOpenChange,
  editing,
  taken,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The variable being edited, or null to create one. */
  editing: DeclaredVariable | null
  /** Names already declared, which a new one may not reuse. */
  taken: string[]
  onSave: (variable: DeclaredVariable, previousName: string | null) => void
}) {
  const [name, setName] = React.useState("")
  const [type, setType] = React.useState<"string" | "number">("string")
  const [fallback, setFallback] = React.useState("")
  // ⚠ THE NAMES AS THEY WERE WHEN IT OPENED. The new variable joins the list
  // while the dialog is still showing its tick, and must not then be told it
  // is already declared.
  const [takenAtOpen, setTakenAtOpen] = React.useState(taken)
  useResetOnOpen(open, () => {
    setTakenAtOpen(taken)
    setName(editing?.name ?? "")
    setType(editing?.type ?? "string")
    setFallback(editing?.fallback ?? "")
  })

  const n = name.trim()
  const nameProblem = !n
    ? null
    : !NAME.test(n)
      ? "Letters, digits and underscores, not starting with a digit."
      : n !== editing?.name && takenAtOpen.includes(n)
        ? `${n} is already declared.`
        : null
  const fallbackProblem =
    type === "number" &&
    fallback.trim() !== "" &&
    !Number.isFinite(Number(fallback.trim()))
      ? "A number variable's fallback is a number."
      : null

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit variable" : "Create variable"}
      submitLabel={editing ? "Save" : "Create"}
      doneLabel={editing ? "Saved" : "Created"}
      canSubmit={n !== "" && !nameProblem && !fallbackProblem}
      onSubmit={async () => {
        onSave(
          { name: n, type, fallback: fallback.trim() === "" ? null : fallback },
          editing?.name ?? null,
        )
        return { ok: true as const, data: undefined }
      }}
    >
      <FloatingInput
        label="Name"
        id="variable-name"
        value={name}
        onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
        autoComplete="off"
        autoFocus
        className="font-mono text-sm"
        adornment={
          <span className="font-mono text-xs text-muted-foreground">{"{{ }}"}</span>
        }
        state={nameProblem ? "invalid" : undefined}
        hint={
          nameProblem ??
          "Used as {{ NAME }} in the subject, the body and links, e.g. PRODUCT_NAME."
        }
      />
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Type</p>
        <Select value={type} onValueChange={(v) => setType(v as "string" | "number")}>
          <SelectTrigger className="w-full" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">String</SelectItem>
            <SelectItem value="number">Number</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <FloatingInput
        label="Fallback value"
        id="variable-fallback"
        value={fallback}
        onChange={(e) => setFallback(e.target.value)}
        autoComplete="off"
        inputMode={type === "number" ? "decimal" : undefined}
        state={fallbackProblem ? "invalid" : undefined}
        hint={
          fallbackProblem ??
          "What appears when a send leaves the variable out. Without one, such a send is refused."
        }
      />
    </FormDialog>
  )
}

/**
 * The editor's Variables panel: what the template declares, what it uses
 * without declaring, and a click to put one in the email.
 */
export function VariablesPanel({
  variables,
  used,
  onInsert,
  onCreate,
  onEdit,
  onRemove,
  onDeclare,
  onClose,
  canInsert,
}: {
  variables: DeclaredVariable[]
  /** Names the subject, body or links use. */
  used: string[]
  onInsert: (name: string) => void
  onCreate: () => void
  onEdit: (v: DeclaredVariable) => void
  onRemove: (name: string) => void
  onDeclare: (name: string) => void
  onClose: () => void
  canInsert: boolean
}) {
  const undeclared = used.filter((u) => !variables.some((v) => v.name === u))
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <p className="text-sm font-medium">Variables</p>
        <div className="flex items-center gap-1">
          {(variables.length > 0 || undeclared.length > 0) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  onClick={onCreate}
                  disabled={variables.length >= MAX_VARIABLES}
                  aria-label="Create variable"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Create variable</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7"
                onClick={onClose}
                aria-label="Close variables"
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {variables.length === 0 && undeclared.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center px-4 py-16 text-center"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
              <VariableIcon className="size-5" />
            </span>
            <p className="mt-4 text-sm font-medium">No variables yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a variable to personalise your template, then insert it anywhere in
              your content.
            </p>
            <Button size="sm" variant="outline" className="mt-5" onClick={onCreate}>
              <Plus />
              Create variable
            </Button>
          </motion.div>
        ) : (
          <ul className="space-y-0.5">
            <AnimatePresence initial={false}>
              {variables.map((v) => (
                <motion.li
                  key={v.name}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="group overflow-hidden"
                >
                  <div className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/70">
                    <button
                      type="button"
                      onClick={() => onInsert(v.name)}
                      disabled={!canInsert}
                      className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
                      title={canInsert ? "Insert at the cursor" : undefined}
                    >
                      <span className="truncate font-mono text-xs text-foreground">
                        {`{{ ${v.name} }}`}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {v.type === "number" ? "Number" : "String"}
                        {v.fallback !== null
                          ? ` · falls back to “${v.fallback}”`
                          : " · required"}
                        {!used.includes(v.name) && " · unused"}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {canInsert && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
                              onClick={() => onInsert(v.name)}
                              aria-label={`Insert ${v.name}`}
                            >
                              <CornerDownLeft />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Insert</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7"
                            onClick={() => onEdit(v)}
                            aria-label={`Edit ${v.name}`}
                          >
                            <Pencil />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 hover:text-destructive"
                            onClick={() => onRemove(v.name)}
                            aria-label={`Remove ${v.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}

        {undeclared.length > 0 && (
          <div className="mt-4 space-y-1 border-t px-2 pt-4">
            <p className="text-xs font-medium">Used, not declared</p>
            <p className="pb-1 text-[11px] text-muted-foreground">
              Sends must give these. Declare one to give it a fallback.
            </p>
            {undeclared.map((name) => (
              <div
                key={name}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/70",
                )}
              >
                <span className="truncate font-mono text-xs">{`{{ ${name} }}`}</span>
                <Button variant="ghost" size="xs" onClick={() => onDeclare(name)}>
                  Declare
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
