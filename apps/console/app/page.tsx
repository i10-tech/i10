import { currentUser } from "@clerk/nextjs/server"
import { UserButton } from "@clerk/nextjs"

/*
 * Scaffold placeholder, now behind a session.
 *
 * The console is the surface i10's competitive claim rests on — the comparison
 * set is Resend, Clerk, Attio, Twenty and Cloudflare's dashboard, and the
 * standard is intentional rather than generated. Nothing here is a design
 * proposal; it exists so the workspace builds. Delete it when the real
 * navigation lands.
 *
 * ⚠ IT DOES NOT CHECK WHETHER ANYONE IS SIGNED IN, AND MUST NOT START TO. The
 * middleware protects this path, so reaching this component already means a
 * session exists; a second check here would be a second place for the rule to
 * be written differently. `currentUser()` is used for the greeting, not the
 * gate.
 */
export default async function Page() {
  const user = await currentUser()

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-3 px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">i10 console</h1>
        {/* The only way out of the console until real navigation exists. */}
        <UserButton />
      </div>
      <p className="text-muted-foreground text-sm">
        Signed in as {user?.primaryEmailAddress?.emailAddress ?? "your account"}.
        Domains, DNS onboarding, API keys and the message log land here.
      </p>
    </main>
  )
}
