"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, KeyRound } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { CopyButton, CopyField } from "@repo/ui/components/copy"
import { Spinner } from "@repo/ui/components/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { createApiKey } from "@/lib/actions"
import type { CreatedApiKey, DomainSummary } from "@/lib/types"

/**
 * Sending the first email.
 *
 * ⚠ THE KEY IS MINTED HERE, IN THE FLOW, RATHER THAN SENDING SOMEBODY TO
 * ANOTHER PAGE. Set-up flows lose people at every navigation; the whole point
 * of this step is that the snippet below is copy-pasteable within ten seconds
 * of arriving. The key it creates is a real one and appears on the API keys
 * page like any other.
 *
 * ⚠ AND THE SNIPPET CONTAINS THE REAL KEY EXACTLY ONCE, WHILE IT IS ON SCREEN.
 * Nothing stores it — the API keeps a SHA-256 of it — so navigating away loses
 * it. That is stated in the interface rather than left to be discovered, and
 * the snippet falls back to a placeholder once the key is gone.
 */
export function StepSend({
  domains,
  hasApiKey,
  onDone,
}: {
  domains: DomainSummary[]
  hasApiKey: boolean
  onDone: () => void
}) {
  const router = useRouter()
  const [key, setKey] = React.useState<CreatedApiKey | null>(null)
  const [pending, setPending] = React.useState(false)

  const verified = domains.filter((d) => d.status === "verified")
  const from = verified[0] ? `hello@${verified[0].name}` : "hello@yourdomain.com"

  // ⚠ THE PLACEHOLDER IS OBVIOUSLY A PLACEHOLDER. `i10_live_xxxxxxxx` in a
  // snippet somebody pastes into a terminal produces an immediate 401 that they
  // can act on; a realistic-looking fake would send them hunting for a
  // configuration problem that does not exist.
  const secret = key?.secret ?? "i10_live_xxxxxxxxxxxxxxxxxxxx"

  async function mint() {
    if (pending) return
    setPending(true)
    const result = await createApiKey({ name: "onboarding", mode: "live" })
    setPending(false)

    if (!result.ok) {
      toast.error("Could not create a key", { description: result.error })
      return
    }

    setKey(result.data)
    router.refresh()
  }

  const curl = `curl -X POST https://api.i10.tech/emails \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "${from}",
    "to": ["you@example.com"],
    "subject": "Hello from i10",
    "html": "<p>It works.</p>"
  }'`

  const node = `import { I10 } from "@i10/node"

const i10 = new I10("${secret}")

await i10.emails.send({
  from: "${from}",
  to: ["you@example.com"],
  subject: "Hello from i10",
  html: "<p>It works.</p>",
})`

  const python = `import i10

client = i10.Client(api_key="${secret}")

client.emails.send({
    "from": "${from}",
    "to": ["you@example.com"],
    "subject": "Hello from i10",
    "html": "<p>It works.</p>",
})`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Send your first email</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a key, paste the snippet, and watch it appear in your log.
        </p>
      </div>

      {verified.length === 0 && (
        <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            No domain is verified yet, so a send will be refused. The snippet is still
            worth copying — come back to it once verification finishes.
          </span>
        </p>
      )}

      {key ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Your API key</p>
          <CopyField value={key.secret} className="py-2" />
          <p className="text-xs text-warning">
            This is the only time it is shown. It is already in the snippet below — copy
            that and you have both.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm">
            {hasApiKey
              ? "You already have a key. Create another for this snippet, or paste one you have."
              : "You will need a key to send."}
          </p>
          <Button size="sm" onClick={mint} disabled={pending}>
            {pending && <Spinner />}
            Create a key
          </Button>
        </div>
      )}

      <Tabs defaultValue="curl" className="overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between border-b px-2 py-1.5">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger value="curl">curl</TabsTrigger>
            <TabsTrigger value="node">Node</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
          </TabsList>
        </div>

        {[
          { value: "curl", code: curl },
          { value: "node", code: node },
          { value: "python", code: python },
        ].map((snippet) => (
          <TabsContent
            key={snippet.value}
            value={snippet.value}
            className="relative m-0"
          >
            <CopyButton
              value={snippet.code}
              label="Copy snippet"
              className="absolute top-2 right-2 z-10"
            />
            {/*
             * ⚠ THE CODE IS A TEXT CHILD OF <pre>, NEVER `innerHTML`. It
             * contains the customer's own domain, which they typed — so it is
             * user input on its way back to the screen, and React escaping it
             * is what stops a domain containing a tag from becoming one.
             */}
            <pre className="overflow-x-auto bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed">
              {snippet.code}
            </pre>
          </TabsContent>
        ))}
      </Tabs>

      <Button onClick={onDone}>Continue</Button>
    </div>
  )
}
