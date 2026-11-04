import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import { AuditLog } from "@/components/sso/audit-log"
import { tryApi } from "@/lib/api"
import { ssoAbilities } from "@/lib/sso-server"
import type { IdentityEvent } from "@/lib/sso-types"

export const metadata: Metadata = { title: "Identity audit log" }

const STEPS = [50, 100, 200]

/**
 * Everything that changed about how people sign in and who they are: SSO and
 * directory settings, sessions, mailboxes, policies. An admin's page; the API
 * checks `sso:manage`.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; limit?: string }>
}) {
  const params = await searchParams
  const user = params.user?.trim() || undefined
  const requested = Number(params.limit)
  const limit = STEPS.includes(requested) ? requested : STEPS[0]!

  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />

  const events = who.abilities.manage
    ? await tryApi<{ data: IdentityEvent[] }>("/console/identity/events", {
        query: { limit, user },
      })
    : null

  return (
    <Section className="pt-0">
      <Link
        href="/settings/security"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Security
      </Link>
      <SectionTitle>Identity audit log</SectionTitle>
      <SectionDescription>
        Who changed sign-in settings, directories, sessions and mailboxes, and when.
      </SectionDescription>
      <SectionContent>
        {!events ? (
          <p className="text-sm text-muted-foreground">
            Only a workspace admin or owner can see the audit log.
          </p>
        ) : !events.ok ? (
          events.error.statusCode === 501 ? (
            <p className="text-sm text-muted-foreground">
              The identity audit log is not available on this deployment.
            </p>
          ) : (
            <PanelError
              title="Could not load the audit log"
              message={events.error.message}
            />
          )
        ) : (
          <AuditLog
            events={events.data.data}
            user={user ?? null}
            limit={limit}
            nextLimit={STEPS[STEPS.indexOf(limit) + 1] ?? null}
            clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
          />
        )}
      </SectionContent>
    </Section>
  )
}
