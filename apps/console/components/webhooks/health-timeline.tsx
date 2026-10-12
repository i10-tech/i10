import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { StatusDot } from "@/components/status"
import { Time } from "@/components/time"
import type { WebhookHealthEvent } from "@/lib/types"

const KIND = {
  failing: { tone: "warning", label: "Started failing" },
  disabled: { tone: "danger", label: "Switched off by i10" },
  recovered: { tone: "success", label: "Recovered" },
} as const

/**
 * Every change in the endpoint's health, newest first (#284).
 *
 * ⚠ THE SAME CHANGES THE OWNER WAS EMAILED ABOUT, so "I got an email saying
 * my endpoint failed" can be matched to a line here, with the error that
 * caused it.
 */
export function HealthTimeline({ events }: { events: WebhookHealthEvent[] }) {
  return (
    <Section className="pt-0">
      <SectionTitle>Health</SectionTitle>
      <SectionDescription>
        When this endpoint started failing, was switched off, or recovered. Each change
        is also emailed to the workspace owner and sent to any endpoint subscribed to{" "}
        <span className="font-mono text-xs">webhook_endpoint.*</span> events.
      </SectionDescription>
      <SectionContent>
        {events.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No changes yet. It has been healthy since it was created.
          </p>
        ) : (
          <ol className="relative space-y-0">
            {events.map((event, i) => (
              <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                {i < events.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute top-4 bottom-0 left-[4.5px] w-px bg-border"
                  />
                )}
                <StatusDot tone={KIND[event.kind].tone} className="relative mt-1.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-medium">{KIND[event.kind].label}</p>
                    <p className="text-xs text-muted-foreground">
                      <Time iso={event.created_at} mode="exact" />
                    </p>
                  </div>
                  {event.reason && (
                    <p className="mt-1 rounded-md bg-muted/40 px-2 py-1 font-mono text-2xs break-all text-muted-foreground">
                      {event.reason}
                    </p>
                  )}
                  {event.kind !== "recovered" && event.failing_since && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No success since <Time iso={event.failing_since} mode="exact" />
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </SectionContent>
    </Section>
  )
}
