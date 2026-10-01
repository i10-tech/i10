import { cn } from "cn"
import { Closing } from "@/components/home/closing"
import { Frame, SectionHeader } from "@/components/site/section"
import { ButtonLink } from "@/components/ui/button-link"
import { highlight } from "@/components/ui/code"
import { CopyButton } from "@/components/ui/copy-button"
import type { SpecialPage } from "@/lib/pages"
import { hosts } from "@/lib/site"
import { PageHero } from "./page-hero"

type Line = { t: string; d?: "-" | "+" }

/*
 * The migration, as four steps you can copy. Everything here is checked
 * against the code: @i10/node exports `I10` with `emails.send` and
 * `emails.batch`, the transport is Bearer auth byte for byte, and @i10/next
 * verifies `webhook-id` / `webhook-signature` (Standard Webhooks).
 */
const STEPS: {
  title: string
  body: string
  file: string
  lang: "ts" | "sh"
  lines: Line[]
  copy: string
}[] = [
  {
    title: "Install the SDK",
    body: "Zero runtime dependencies. npm, pnpm and yarn work the same.",
    file: "terminal",
    lang: "sh",
    lines: [{ t: "bun add @i10/node" }],
    copy: "bun add @i10/node",
  },
  {
    title: "Change the import",
    body: "The client has the same shape, so every call site stays as it is.",
    file: "send.ts",
    lang: "ts",
    lines: [
      { t: 'import { Resend } from "resend"', d: "-" },
      { t: 'import { I10 } from "@i10/node"', d: "+" },
      { t: "" },
      { t: "const client = new Resend(process.env.RESEND_API_KEY)", d: "-" },
      { t: "const client = new I10(process.env.I10_API_KEY)", d: "+" },
    ],
    copy: 'import { I10 } from "@i10/node"\n\nconst client = new I10(process.env.I10_API_KEY)',
  },
  {
    title: "Swap the key",
    body: "i10 keys carry their mode in the prefix, so a live key is recognisable in a log and in a secret scan.",
    file: ".env",
    lang: "sh",
    lines: [
      { t: "RESEND_API_KEY=re_••••••••", d: "-" },
      { t: "I10_API_KEY=i10_live_••••••••", d: "+" },
    ],
    copy: "I10_API_KEY=",
  },
  {
    title: "Add one DNS record",
    body: "DKIM alone is enough to send, aligned. The console detects your DNS host and shows its exact steps.",
    file: "dns",
    lang: "sh",
    lines: [{ t: "i10._domainkey  TXT  p=MIIBIjANBgkqh…" }],
    copy: "i10._domainkey",
  },
]

const SAME = [
  ["Authorization: Bearer", "The header, byte for byte."],
  [
    "Request and response shapes",
    "POST /emails and POST /emails/batch take what Resend takes.",
  ],
  ["Error names", "The same machine names, thrown as I10Error with a retryable flag."],
  ["Idempotency-Key", "Replays return the first result instead of sending twice."],
]

const DIFFERENT = [
  ["Key format", "i10_live_ and i10_test_, where Resend uses re_."],
  [
    "Webhooks",
    "Signed to Standard Webhooks: webhook-id, webhook-timestamp and webhook-signature, all three covered by the signature.",
  ],
  ["Region", "Mail is relayed from eu-central-1, Frankfurt."],
]

export function MigratePageView({ page }: { page: SpecialPage }) {
  return (
    <>
      <PageHero
        eyebrow={page.eyebrow}
        title={page.title}
        lede={page.lede}
        color="var(--hue-send)"
      >
        <div data-reveal data-reveal-delay="0.25" className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href={hosts.signIn} size="lg" arrow>
            Get an API key
          </ButtonLink>
          <ButtonLink href="/compare/resend" size="lg" variant="secondary">
            i10 vs Resend
          </ButtonLink>
        </div>
      </PageHero>

      <Frame className="py-16 md:py-20">
        <ol className="flex flex-col">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              data-reveal
              className="grid gap-6 border-line-faint py-10 not-first:border-t lg:grid-cols-[0.8fr_1.2fr] lg:gap-16"
            >
              <div className="flex gap-5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 font-mono text-[12px] text-fg shadow-[inset_0_0_0_1px_var(--line-strong)]">
                  {i + 1}
                </span>
                <div>
                  <h2 className="text-[20px] leading-8 font-[560] tracking-[-0.02em] text-fg">
                    {step.title}
                  </h2>
                  <p className="mt-2 max-w-[26rem] text-[14.5px] leading-[23px] text-fg-3">
                    {step.body}
                  </p>
                </div>
              </div>
              <div className="code-window overflow-hidden rounded-[16px] bg-surface-1 shadow-[inset_0_0_0_1px_var(--line)]">
                <div className="flex h-10 items-center justify-between border-b border-line-faint pr-2 pl-4">
                  <span className="font-mono text-[11px] text-fg-4">{step.file}</span>
                  <CopyButton
                    value={step.copy}
                    label={`Copy ${step.title.toLowerCase()}`}
                  />
                </div>
                <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-[22px]">
                  {step.lines.map((l, j) => (
                    <div
                      key={j}
                      className={cn(
                        "flex px-4",
                        l.d === "-" && "bg-[oklch(0.68_0.19_25/0.08)]",
                        l.d === "+" && "bg-[oklch(0.78_0.16_152/0.08)]",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "w-5 shrink-0 select-none",
                          l.d === "-"
                            ? "text-bounced"
                            : l.d === "+"
                              ? "text-delivered"
                              : "text-transparent",
                        )}
                      >
                        {l.d ?? " "}
                      </span>
                      <code className={cn(l.d === "-" && "opacity-60")}>
                        {l.t ? highlight(l.t, step.lang) : " "}
                      </code>
                    </div>
                  ))}
                </pre>
              </div>
            </li>
          ))}
        </ol>
      </Frame>

      <Frame className="py-24">
        <div className="grid gap-16 lg:grid-cols-2">
          <div>
            <SectionHeader title="What stays" muted="the same." size="s" />
            <dl data-reveal className="mt-8">
              {SAME.map(([k, v]) => (
                <div key={k} className="border-t border-line py-5">
                  <dt className="font-mono text-[12.5px] text-fg">{k}</dt>
                  <dd className="mt-1.5 text-[14px] leading-[22px] text-fg-3">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <SectionHeader title="What" muted="changes." size="s" />
            <dl data-reveal className="mt-8">
              {DIFFERENT.map(([k, v]) => (
                <div key={k} className="border-t border-line py-5">
                  <dt className="font-mono text-[12.5px] text-fg">{k}</dt>
                  <dd className="mt-1.5 text-[14px] leading-[22px] text-fg-3">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Frame>

      <Closing />
    </>
  )
}
