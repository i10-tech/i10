import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { cn } from "cn"
import { SettingsGroup } from "../settings-card"

/**
 * A connection's page while it loads, shaped like the page.
 *
 * ⚠ BUILT FROM THE PAGE'S OWN PARTS AND IN ITS ORDER, with its real section
 * titles, so the words are already there when the page arrives and every block
 * lands near the one that held its place. Keep it in step with
 * connection-view.tsx: a section added there is a row of a few bars here. Only
 * the data is a placeholder, so what depends on it (an Okta connection's
 * event hook, a second line of help) is not drawn.
 */

function Bar({ className }: { className?: string }) {
  return <SkeletonBlock className={cn("h-3.5 rounded-full", className)} />
}

/**
 * A settings row: a title and a line on the left, a control on the right.
 * `extra` is the third line some rows carry (a value, a note).
 */
function Row({
  title = "w-36",
  line = "w-64",
  control = "w-44",
  extra = false,
}: {
  title?: string
  line?: string
  control?: string | null
  extra?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1 space-y-2">
        <Bar className={title} />
        <Bar className={cn("h-3 opacity-70", line, "max-w-full")} />
        {extra && <Bar className="mt-3 h-3 w-24 opacity-70" />}
      </div>
      {control && (
        <SkeletonBlock
          className={cn("h-8 shrink-0 rounded-[var(--radius-control)]", control)}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  )
}

/** A closed Advanced row: its label and a short summary. */
function AdvancedRow({
  label = "w-32",
  summary = "w-48",
}: {
  label?: string
  summary?: string
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <Bar className={label} />
      <Bar className={cn("h-3 opacity-70", summary)} />
    </div>
  )
}

/** The mail section: a line about what it decides, then one card per way to sign in. */
function MailCards() {
  return (
    <div className="space-y-4">
      <div className="max-w-prose space-y-2">
        <Bar className="w-full" />
        <Bar className="w-2/3" />
      </div>
      <div className="space-y-2">
        {["w-48", "w-64", "w-56"].map((width, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-2xl border border-border px-4 py-3.5"
          >
            <SkeletonBlock className="size-4 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Bar className={width} />
              <Bar className="h-3 w-4/5 max-w-md opacity-70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ConnectionSkeleton() {
  return (
    <div aria-busy="true" className="space-y-8 pb-12">
      <div className="space-y-4">
        <Bar className="w-28" />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <SkeletonBlock className="size-9 rounded-xl" />
            <SkeletonBlock className="h-6 w-56 rounded-lg" />
          </div>
          <SkeletonBlock className="h-8 w-8 rounded-[var(--radius-control)]" />
        </div>
        <Bar className="h-3 w-96 max-w-full opacity-70" />
      </div>

      <Section title="Who can sign in">
        <SettingsGroup>
          <Row extra control="w-20" />
          <Row title="w-28" line="w-72" extra control="w-32" />
        </SettingsGroup>
        <AdvancedRow label="w-36" summary="w-20" />
      </Section>

      <Section title="New people">
        <SettingsGroup>
          <Row line="w-72" control="w-10" />
          <Row title="w-44" extra control="w-10" />
          <Row title="w-32" line="w-72" extra control="w-20" />
        </SettingsGroup>
      </Section>

      <Section title="Sessions">
        <SettingsGroup>
          <Row title="w-32" line="w-56" />
          <Row title="w-40" line="w-52" />
          <div className="space-y-2 border-t border-border px-4 py-3">
            <Bar className="h-3 w-3/4 opacity-70" />
            <Bar className="h-3 w-2/3 opacity-70" />
          </div>
        </SettingsGroup>
      </Section>

      <Section title="Mail sign-in">
        <MailCards />
      </Section>

      <Section title="Roles from groups">
        <SettingsGroup>
          <Row line="w-72" />
        </SettingsGroup>
      </Section>

      <Section title="Test">
        <SettingsGroup>
          <Row title="w-32" line="w-72" />
        </SettingsGroup>
      </Section>

      <div className="space-y-4 border-t border-border pt-4">
        <Bar className="w-40" />
        <AdvancedRow label="w-36" summary="w-56" />
        <AdvancedRow label="w-28" summary="w-52" />
        <AdvancedRow label="w-40" summary="w-44" />
      </div>
    </div>
  )
}
