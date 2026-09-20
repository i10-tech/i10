import { AlertTriangle, CheckCircle2, Clock, Info } from "lucide-react"
import { cn } from "cn"
import type { DelegationReport, ZoneFinding } from "@/lib/types"

/**
 * What is actually wrong with a delegation.
 *
 * ⚠ THIS REPLACES A SENTENCE THAT WAS TRUE ONLY A QUARTER OF THE TIME. The page
 * said "DNS propagation is usually minutes and can be up to 72 hours — nothing
 * is wrong yet" for every unverified delegated domain, because `pending` was
 * all it knew. That is the right thing to say when the records have not
 * propagated, and it is the wrong thing to say when they were published to
 * somebody else's nameservers, or when ours are not answering — in both of
 * those the wait never ends, and telling somebody to be patient costs them
 * three days before they ask.
 *
 * ⚠ THE ORDER OF THE BRANCHES IS THE PRIORITY OF THE PROBLEMS, and our own
 * failure comes first. A silent nameserver makes every other finding
 * irrelevant: the customer can publish perfect records all day and nothing will
 * resolve. Reporting "not published yet" above it would send them to fix
 * something that is already correct.
 *
 * @param status The domain's own status. `not_started` means no verify has ever
 * succeeded for it, which is the only way to know we have not published its
 * zones — see the note on the `nameserver_silent` branch.
 */
export function DelegationNote({
  report,
  status,
}: {
  report: DelegationReport
  status: string
}) {
  if (!report.nameserversAnswering) {
    return (
      <Note
        tone="danger"
        icon={<AlertTriangle className="size-4 text-danger" />}
        title="This is on us, not on your DNS"
        body={
          <>
            Our nameservers ({report.nameservers.join(", ") || "none configured"}) are
            not answering, so a delegated domain cannot verify however it is configured.
            Your records are not the problem and changing them will not help. We are
            aware of it — contact support@i10.tech if you need this domain sending
            urgently, and we will move you to manual records, which do not depend on our
            DNS.
          </>
        }
      />
    )
  }

  const broken = report.zones.filter((z) => z.code === "nameserver_silent")
  if (broken.length > 0) {
    /*
     * ⚠ BEFORE THE FIRST SUCCESSFUL VERIFY THIS IS THE EXPECTED STATE, NOT A
     * FAULT, AND CALLING IT ONE SENT PEOPLE TO SUPPORT FOR A BUTTON. We publish
     * a delegated domain's zones inside `verify`, once ownership is proved — so
     * between publishing the NS records and pressing Verify the delegation
     * points at nameservers that correctly hold nothing. Every one of those
     * customers was told "that is our side of the handover, contact support",
     * which is the opposite of the truth: their side is finished and one press
     * completes ours.
     *
     * ⚠ `not_started` IS THE SIGNAL BECAUSE IT IS THE ONE STATUS `verify` NEVER
     * LEAVES BEHIND. A row is created `not_started` and the first proof that
     * succeeds overwrites it with whatever SES says, so it means "no verify has
     * ever got as far as publishing", which is exactly the question here.
     */
    if (status === "not_started") {
      return (
        <Note
          tone="warning"
          icon={<Clock className="size-4 text-warning" />}
          title="Your records are in place — press Verify"
          body={
            <>
              {list(broken.map((z) => z.zone))} {broken.length === 1 ? "is" : "are"}{" "}
              delegated to us correctly. We start answering for{" "}
              {broken.length === 1 ? "it" : "them"} once we have confirmed the
              delegation is yours, which is what Verify does — nothing is wrong and
              there is nothing else to change.
            </>
          }
        />
      )
    }

    return (
      <Note
        tone="danger"
        icon={<AlertTriangle className="size-4 text-danger" />}
        title="Delegated to us, and we are not serving it"
        body={
          <>
            You have published NS records for {list(broken.map((z) => z.zone))} and they
            point at us, but we are not answering for{" "}
            {broken.length === 1 ? "it" : "them"}. That is our side of the handover, not
            yours — contact support@i10.tech.
          </>
        }
      />
    )
  }

  const elsewhere = report.zones.filter((z) => z.code === "delegated_elsewhere")
  if (elsewhere.length > 0) {
    return (
      <Note
        tone="danger"
        icon={<AlertTriangle className="size-4 text-danger" />}
        title="Those names are delegated somewhere else"
        body={
          <>
            {list(elsewhere.map((z) => z.zone))}{" "}
            {elsewhere.length === 1 ? "has" : "have"} NS records pointing at{" "}
            <span className="font-mono">
              {[...new Set(elsewhere.flatMap((z) => observedOf(z)))].join(", ")}
            </span>{" "}
            rather than at us.
            {/*
             * ⚠ THE EXISTING-RECORD CASE IS NAMED, BECAUSE IT IS THE COMMON ONE
             * AND IT DOES NOT LOOK LIKE A MISTAKE. A domain that already had
             * DMARC or DKIM set up has records at exactly the names delegation
             * wants, and most providers will not let an NS record sit beside
             * them — some silently keep the old rows, which is this state.
             */}{" "}
            If this domain already had DMARC or DKIM configured, the old records are
            usually the reason: most providers refuse to add an NS record at a name that
            already has others, so delete what is there first and re-add the NS rows.
          </>
        }
      />
    )
  }

  const waiting = report.zones.filter((z) => z.code === "not_published")
  if (waiting.length > 0) {
    return (
      <Note
        tone="warning"
        icon={<Clock className="size-4 text-warning" />}
        title={
          waiting.length === report.zones.length
            ? "We cannot see the NS records yet"
            : "Some of the NS records are not visible yet"
        }
        body={
          <>
            Nothing is published at {list(waiting.map((z) => z.zone))} that we can see.
            If you have just added the records this is normal — propagation is usually
            minutes and can take up to 72 hours. If it has been longer, check that the
            host is exactly the name in the table below: many providers append the
            domain for you, so typing the full name produces{" "}
            <span className="font-mono">mail.example.com.example.com</span>.
          </>
        }
      />
    )
  }

  const failed = report.zones.filter((z) => z.code === "lookup_failed")
  if (failed.length > 0) {
    return (
      <Note
        tone="muted"
        icon={<Info className="size-4 text-muted-foreground" />}
        title="We could not check right now"
        body="The DNS lookup itself failed, which says nothing about your records. Try again in a moment."
      />
    )
  }

  return (
    <Note
      tone="success"
      icon={<CheckCircle2 className="size-4 text-success" />}
      title="Delegation is working"
      body={
        <>
          All three names resolve to us. Anything still unverified is SES catching up
          rather than DNS — that is usually minutes, and Verify checks it now.
        </>
      }
    />
  )
}

/** ⚠ NARROWED, NOT CAST. Only one variant carries `observed`. */
const observedOf = (finding: ZoneFinding): string[] =>
  finding.code === "delegated_elsewhere" ? finding.observed : []

/** `a`, `a and b`, `a, b and c` — the same list people write by hand. */
function list(items: string[]): React.ReactNode {
  const text =
    items.length <= 1
      ? (items[0] ?? "")
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
  return <span className="font-mono">{text}</span>
}

function Note({
  tone,
  icon,
  title,
  body,
}: {
  tone: "danger" | "warning" | "success" | "muted"
  icon: React.ReactNode
  title: string
  body: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3",
        tone === "danger" && "border-danger/25 bg-danger/5",
        tone === "warning" && "border-warning/25 bg-warning/5",
        tone === "success" && "border-success/25 bg-success/5",
        tone === "muted" && "border-border bg-muted/30",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
