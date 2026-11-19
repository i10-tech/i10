"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ldapSetup, oidcMailSetup, saveLdap, saveOidcMail } from "@/lib/sso-actions"
import { activeLane, oidcProviderName, passwordOf, type MailLane } from "@/lib/sso-mail"
import { toastDone } from "@/lib/toast"
import type {
  LdapSetup,
  OidcMailSetup,
  OktaHookSetup,
  SsoAbilities,
  SsoConnection,
} from "@/lib/sso-types"
import { Loading, useRemote, useSsoCall } from "../shared"
import { LdapContent } from "./ldap-row"
import { OidcMailLane } from "./oidc-mail-lane"
import { OktaEventHookRow } from "./okta-event-hook-row"

/**
 * What the server read for the section. A key left out means the read failed,
 * and the section asks again from the browser, where a refusal (a plan, a role)
 * is said in its own words.
 */
export interface MailSignInInitial {
  oidc?: OidcMailSetup
  ldap?: LdapSetup
  hook?: OktaHookSetup
}

/**
 * How people managed by this connection sign in to their mailbox (IMAP and
 * SMTP) with the one password their company already has. i10 never stores a
 * mail password; the lane chosen here is where it is checked.
 *
 * ⚠ THE LANES ARE EXCLUSIVE, AND THE API IS WHAT KEEPS THEM SO. Each refuses to
 * turn on while the other is. Moving between lanes therefore asks the API to
 * turn the old one off, and only then shows the new one; the client never
 * assumes it held both off itself.
 *
 * ⚠ A SELECTION IS NOT AN ACTIVATION. Picking a lane shows its settings and,
 * if another lane was on, turns that one off. The lane's own switch is what
 * turns it on. So mail sign-in is off from the moment a lane is left until the
 * next one is switched on, and the confirmation says so.
 *
 * ⚠ ARROW KEYS ON THE CHOICE SELECT (Arc's radio cards). Leaving an ACTIVE lane
 * therefore asks first; moving between lanes that are off just moves.
 */
export function MailSignIn({
  connection,
  abilities,
  initial,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  initial: MailSignInInitial
}) {
  const oidc = useRemote(() => oidcMailSetup(connection.id), initial.oidc)
  const ldap = useRemote(() => ldapSetup(connection.id), initial.ldap)
  const call = useSsoCall()
  const [picked, setPicked] = React.useState<MailLane | null>(null)
  const [asking, setAsking] = React.useState<MailLane | null>(null)

  const isOkta = connection.provider === "okta"
  const oidcData = oidc.data
  const ldapData = ldap.data

  if (!oidcData || !ldapData) {
    return <Loading failed={oidc.failed ?? ldap.failed} />
  }

  const hasOidc = oidcData.available
  const lane = picked ?? activeLane(oidcData, ldapData)
  const name = oidcProviderName(oidcData, connection.provider)
  const named = passwordOf(name) !== "company password"
  const active = activeLane(oidcData, ldapData)

  /** Turns the lane that is on off, then moves. One step-up covers both writes. */
  async function move(next: MailLane): Promise<boolean> {
    let first = true
    if (oidcData && oidcData.enabled && next !== "oidc") {
      const after = await call(() => saveOidcMail(connection.id, { enabled: false }), {
        title: "Could not turn the password check off",
        stepUp: first,
      })
      if (!after) return false
      first = false
      oidc.setData(after)
    }
    if (ldapData && ldapData.enabled && next !== "ldap") {
      const after = await call(() => saveLdap(connection.id, { enabled: false }), {
        title: "Could not turn the directory check off",
        stepUp: first,
      })
      if (!after) return false
      ldap.setData(after)
    }
    setPicked(next)
    return true
  }

  function choose(next: MailLane) {
    if (next === lane) return
    // Only leaving a lane that is on changes anything for people; the rest is a look.
    if (active !== "off" && next !== active) setAsking(next)
    else setPicked(next)
  }

  const options = [
    {
      value: "off",
      label: "Off",
      description: "People cannot sign in to mail with their company password.",
      meta: active === "off" ? <Badge size="sm">Current</Badge> : undefined,
    },
    ...(hasOidc
      ? [
          {
            value: "oidc",
            // Short where there is no name to say: a long label is cut off on a phone.
            label: named
              ? `Password check at ${name} (OIDC)`
              : "Provider password check (OIDC)",
            description: `People sign in to mail with their ${passwordOf(name)}, and ${name} checks it.`,
            meta:
              active === "oidc" ? (
                <Badge tone="success" size="sm">
                  On
                </Badge>
              ) : undefined,
          },
        ]
      : []),
    {
      value: "ldap",
      label: "Directory password check (LDAP)",
      description:
        "People sign in to mail with their directory password, checked against your LDAP server.",
      meta:
        active === "ldap" ? (
          <Badge tone="success" size="sm">
            On
          </Badge>
        ) : undefined,
    },
  ]

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        Decide how people managed by this connection sign in to their mailbox in an
        email app. They use the one password they already have, and i10 never stores it.
      </p>

      <RadioCards
        aria-label="How people sign in to mail"
        layout="list"
        value={lane}
        onValueChange={(v) => choose(v as MailLane)}
        options={options}
      />

      {hasOidc && (
        <Reveal show={lane === "oidc"} spacing="pt-1" keepMounted>
          <OidcMailLane
            connection={connection}
            abilities={abilities}
            data={oidcData}
            setData={oidc.setData}
          />
        </Reveal>
      )}
      <Reveal show={lane === "ldap"} spacing="pt-1" keepMounted>
        <LdapContent
          connection={connection}
          abilities={abilities}
          data={ldapData}
          setData={ldap.setData}
        />
      </Reveal>

      {isOkta && (
        <div className="pt-4">
          <OktaEventHookRow
            connection={connection}
            abilities={abilities}
            initial={initial.hook}
          />
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={
          asking === "off"
            ? "Turn off mail sign-in?"
            : "Switch how mail passwords are checked?"
        }
        description={
          asking === "off"
            ? "People will not be able to sign in to mail with their company password until you turn a password check back on."
            : "The current check turns off now, so mail sign-in stops until you turn the new one on."
        }
        confirmLabel={asking === "off" ? "Turn off" : "Switch"}
        doneLabel={asking === "off" ? "Turned off" : "Switched"}
        destructive={false}
        onConfirm={async () => {
          const ok = asking ? await move(asking) : false
          if (ok)
            toastDone(
              asking === "off" ? "Mail sign-in off" : "Previous check turned off",
            )
          return ok
        }}
      />
    </div>
  )
}
