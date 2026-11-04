"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Reveal } from "@repo/ui/components/i10/reveal"
import {
  changeGroupRule,
  createGroupRule,
  deleteGroupRule,
  groupRules,
} from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  Loading,
  OwnerNote,
  useRemote,
  useSsoCall,
} from "../shared"

const RULE_ROLES = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
]

export function GroupRulesGroup({
  connection,
  abilities,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const [open, setOpen] = React.useState(false)
  const { data, setData, failed } = useRemote(() => groupRules(connection.id))
  const [group, setGroup] = React.useState("")
  const [role, setRole] = React.useState<"member" | "admin">("member")

  const rules = data?.data ?? []
  const nextPrecedence = rules.length
    ? Math.max(...rules.map((r) => r.precedence)) + 10
    : 10

  async function add() {
    const made = await call(
      () =>
        createGroupRule(connection.id, {
          group: group.trim(),
          role,
          precedence: nextPrecedence,
        }),
      {
        stepUp: connectionWriteNeedsStepUp(connection),
        title: "Could not add the rule",
      },
    )
    if (made && data) {
      setData({
        ...data,
        data: [...data.data, made].sort((a, b) => a.precedence - b.precedence),
      })
      setGroup("")
      toastDone("Rule added")
    }
  }

  const entra = connection.provider === "entra"

  return (
    <SettingsGroup>
      <SettingsRow
        title="Group rules"
        description="Roles from your provider's groups, read at every sign-in. The first matching rule by precedence wins; no match gives the default, member. Owners are never made this way."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "Done" : "Manage"}
          </Button>
        }
      >
        <div className="text-sm font-medium text-foreground">
          {rules.length === 0
            ? "No group rules configured"
            : `${rules.length} group rule${rules.length === 1 ? "" : "s"}`}
        </div>

        <Reveal show={open} spacing="pt-3" keepMounted>
          <div className="space-y-3">
            {entra && (
              <p className="text-xs text-muted-foreground">
                In Microsoft Entra, enter the group&apos;s Object ID (GUID), not its display name.
              </p>
            )}

            {!data ? (
              <Loading failed={failed} />
            ) : (
              <>
                {rules.length > 0 && (
                  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {rules.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="w-8 text-xs text-muted-foreground">
                          {r.precedence}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {r.group}
                        </span>
                        <div className="w-32">
                          <MorphSelect
                            label="Role"
                            hideLabel
                            value={r.role}
                            disabled={locked}
                            onValueChange={async (v) => {
                              const after = await call(
                                () =>
                                  changeGroupRule(connection.id, r.id, {
                                    role: v as "member" | "admin",
                                  }),
                                {
                                  stepUp: connectionWriteNeedsStepUp(connection),
                                  title: "Could not change the rule",
                                },
                              )
                              if (after)
                                setData({
                                  ...data,
                                  data: data.data.map((x) =>
                                    x.id === r.id ? after : x,
                                  ),
                                })
                            }}
                            items={RULE_ROLES}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={locked}
                          onClick={async () => {
                            const ok = await call(
                              () => deleteGroupRule(connection.id, r.id),
                              {
                                stepUp: connectionWriteNeedsStepUp(connection),
                                title: "Could not delete the rule",
                              },
                            )
                            if (ok)
                              setData({
                                ...data,
                                data: data.data.filter((x) => x.id !== r.id),
                              })
                          }}
                        >
                          Delete
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {rules.length < data.max && (
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <FloatingInput
                        label={entra ? "Group Object ID" : "Group name or ID"}
                        value={group}
                        disabled={locked}
                        maxLength={256}
                        onChange={(e) => setGroup(e.target.value)}
                      />
                    </div>
                    <div className="w-32">
                      <MorphSelect
                        label="Role"
                        value={role}
                        disabled={locked}
                        onValueChange={(v) => setRole(v as "member" | "admin")}
                        items={RULE_ROLES}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      disabled={locked || !group.trim()}
                      onClick={add}
                    >
                      Add rule
                    </Button>
                  </div>
                )}

                <OwnerNote abilities={abilities} />
              </>
            )}
          </div>
        </Reveal>
      </SettingsRow>
    </SettingsGroup>
  )
}
