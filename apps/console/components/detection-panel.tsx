"use client"

import { AlertTriangle, Check, Info } from "lucide-react"
import { ProviderMark } from "@/components/provider-mark"
import type { DnsInspection } from "@/lib/types"

/**
 * What we found when we looked the domain up.
 *
 * ⚠ IT LIVES IN ITS OWN FILE SO IT CAN OUTLIVE ITS OWN DATA BY ONE ANIMATION.
 * The form reveals and collapses this block, and a collapsing block still has
 * to render for the length of the collapse — so it is handed an inspection as a
 * prop rather than reading the form's `current`, which is already null by then.
 * Keeping it inline meant every field inside it needed a non-null assertion
 * against a value that was, at exactly that moment, null.
 *
 * ⚠ AND IT DERIVES ITS OWN PROVIDER RATHER THAN BEING GIVEN ONE. The form's
 * `provider` drives which options are offered and must always describe what is
 * CURRENTLY typed; this one describes the panel being drawn, which during a
 * collapse is the previous answer. They are different facts and sharing one
 * variable is what would put the wrong name under the wrong nameservers.
 */
export function DetectionPanel({
  inspection,
  connected,
}: {
  inspection: DnsInspection
  connected: boolean
}) {
  const current = inspection
  const provider = current.provider ?? null

  /*
   * ⚠ A RESOLVER IS NOT A HOST, AND THIS IS THE ONE CASE THE UI MUST EXPLAIN
   * RATHER THAN SOLVE. It cannot actually be reached by detection — 8.8.8.8
   * never appears in an NS record set — but the registry carries the two
   * resolvers so that any surface offering a provider list can say so.
   */
  const resolverConfusion = provider?.kind === "resolver"

  return (
    <div className="rounded-lg border">
      <div className="flex items-start gap-3 px-4 py-3">
        {provider ? (
          <ProviderMark
            slug={provider.slug}
            name={provider.name}
            /*
             * ⚠ SIZED FOR A WIDE MARK, NOT A SQUARE ONE. An official asset
             * keeps its own proportions and letterboxes inside this box —
             * Cloudflare's is roughly 1.7:1, so a `size-4` slot rendered it
             * nine pixels tall beside fourteen-pixel text and read as a
             * smudge. The box is square; what you see is the height.
             */
            className="-mt-0.5 size-7"
          />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {provider ? (
            <>
              <p className="text-sm">
                DNS hosted by <strong className="font-medium">{provider.name}</strong>
                {current.confidence === "partial" && (
                  <span className="text-muted-foreground">
                    {" "}
                    — though not all of your nameservers point there
                  </span>
                )}
              </p>
              {current.confidence === "partial" && (
                /*
                 * ⚠ A GENUINE AND COMMON STATE, NOT A ROUNDING ERROR. A
                 * domain part-way through a migration answers with two
                 * providers' nameservers at once, and records published at
                 * one of them resolve unpredictably. Saying so now saves an
                 * afternoon of "I added the record and it does not verify".
                 */
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  Your nameservers are split between providers. Records added at one of
                  them may not resolve until the migration finishes.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm">
              {current.nameservers.length > 0
                ? "We could not match your nameservers to a provider we know."
                : "No nameservers found for that domain yet."}
            </p>
          )}

          {current.nameservers.length > 0 && (
            <p className="font-mono text-2xs break-all text-muted-foreground">
              {current.nameservers.join("  ·  ")}
            </p>
          )}

          {resolverConfusion && (
            <p className="text-xs text-muted-foreground">
              {provider?.name} is a public <em>resolver</em> — it answers DNS questions
              but does not host anyone&rsquo;s records. Your DNS host is whoever your
              domain&rsquo;s nameservers point to, usually your registrar.
            </p>
          )}
        </div>
      </div>

      {provider?.canConnect && (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            {connected
              ? `${provider.name} is connected. We can publish the records for you.`
              : "We can publish the records for you."}
          </p>
          {/*
           * ⚠ LIVE NOW, AND IT LEAVES THE PAGE. Connecting is a full
           * navigation to the provider's authorisation screen and back
           * through the callback — so anything typed above is lost, which
           * is exactly why the button sits beside the detection panel
           * rather than inside the form's own flow. Somebody who connects
           * first comes back to an empty form and a working connection.
           */}
          {/*
           * ⚠ A STATUS, NEVER A SECOND BUTTON. Connecting used to be
           * offered here AND as the form's submit, eight inches apart —
           * two controls for one action, and the one up here had less
           * explanation and more prominence than it had earned. The panel
           * reports what we know about the provider; the single control at
           * the bottom is what you press.
           */}
          {connected ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <Check className="size-3.5" />
              Connected
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}
