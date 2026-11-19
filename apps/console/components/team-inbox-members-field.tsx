"use client"

import * as React from "react"
import Link from "next/link"
import { X } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import {
  MorphSelect,
  type MorphSelectOption,
} from "@repo/ui/components/morph-select/morph-select"
import {
  memberCount,
  withMember,
  withoutMember,
  type Candidate,
} from "@/lib/team-inbox"

/**
 * Who is in a team inbox: a search to add somebody, and a list to take them out.
 *
 * ⚠ ONE SEARCH THAT ADDS, NOT A MULTI-SELECT. Arc's `MultiSelect` has no search,
 * and a workspace can have a hundred mailboxes. `MorphSelect` is searchable and
 * single-valued, so it is held at "nothing chosen" and each pick moves the person
 * into the list below it. The list is then the truth, in the order they were
 * added, with a remove button on each row that a screen reader can name.
 *
 * ⚠ EVERY MEMBER IS SHOWN, EVEN ONE THE PICKER WOULD NOT OFFER. A person already
 * in the inbox whose mailbox has since been suspended is not a candidate, but
 * they are still a member and still removable. Hiding them would make the list
 * disagree with who can read the mail.
 */
export function TeamInboxMembersField({
  candidates,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  /** People with a live mailbox, who can be added. */
  candidates: readonly Candidate[]
  /** The mailbox addresses in the inbox. */
  value: readonly string[]
  onChange: (members: string[]) => void
  disabled?: boolean
  /** A sentence under the list, such as what removing somebody does. */
  hint?: React.ReactNode
}) {
  const names = React.useMemo(
    () => new Map(candidates.map((candidate) => [candidate.address, candidate.name])),
    [candidates],
  )

  const items = React.useMemo<MorphSelectOption[]>(
    () =>
      candidates
        .filter((candidate) => !value.includes(candidate.address))
        .map((candidate) => ({
          value: candidate.address,
          label: candidate.name,
          keywords: candidate.address,
          ...(candidate.name === candidate.address ? {} : { meta: candidate.address }),
        })),
    [candidates, value],
  )

  const nobody = candidates.length === 0
  const everyone = !nobody && items.length === 0

  return (
    <div className="space-y-3">
      <MorphSelect
        label="Add a member"
        items={items}
        value={null}
        onValueChange={(address) => onChange(withMember(value, address))}
        searchable
        searchPlaceholder="Search people"
        placeholder={
          nobody
            ? "No one has a mailbox yet"
            : everyone
              ? "Everyone is already a member"
              : "Choose a person"
        }
        disabled={disabled || items.length === 0}
      />

      {nobody && (
        <p className="text-xs text-muted-foreground">
          Members need an active mailbox.{" "}
          <Link
            href="/mailboxes"
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
          >
            Create mailboxes
          </Link>{" "}
          for the people who should read this address first.
        </p>
      )}

      <div>
        <p className="mb-1.5 text-sm font-medium">{memberCount(value.length)}</p>
        {value.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
            No one yet. Add at least one person.
          </p>
        ) : (
          <ul
            aria-label="Members"
            className="max-h-64 divide-y overflow-y-auto rounded-xl border bg-card"
          >
            {value.map((address) => {
              const name = names.get(address)
              return (
                <li
                  key={address}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    {name && name !== address && (
                      <p className="truncate text-sm font-medium">{name}</p>
                    )}
                    <p
                      className={
                        name && name !== address
                          ? "truncate text-xs text-muted-foreground"
                          : "truncate text-sm font-medium"
                      }
                    >
                      {address}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${address}`}
                    disabled={disabled}
                    onClick={() => onChange(withoutMember(value, address))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}
