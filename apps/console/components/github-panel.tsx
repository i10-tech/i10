"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Unplug,
} from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FormDialog } from "@/components/form-dialog"
import { Time } from "@/components/time"
import {
  connectGithubRepository,
  disconnectGithubRepository,
  githubInstallUrl,
  githubRepositoriesOf,
  syncGithubRepository,
  updateGithubRepository,
} from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"
import type { GithubRepository, GithubState } from "@/lib/types"
import { toastError } from "@/lib/toast"

/**
 * Repositories whose templates live in GitHub (#235).
 *
 * ⚠ THE RULE IS SAID WHERE THE BUTTON IS: a push to the target branch goes
 * live. Somebody connecting a repository is deciding that merging to `main`
 * changes what customers receive, and that belongs next to the decision, not
 * in the docs.
 *
 * ⚠ IT WATCHES A RUNNING SYNC. A connect or a push starts one in the
 * background; while any is pending or running the page refreshes itself every
 * few seconds, and stops once they finish, or after two minutes.
 */
export function GithubPanel({ state }: { state: GithubState }) {
  const router = useRouter()
  const busy = state.repositories.some(
    (r) =>
      r.last_sync &&
      (r.last_sync.status === "pending" || r.last_sync.status === "running"),
  )

  React.useEffect(() => {
    if (!busy) return
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > 120_000) clearInterval(timer)
      else router.refresh()
    }, 3000)
    return () => clearInterval(timer)
  }, [busy, router])

  if (!state.configured) return null
  const installed = state.installations.length > 0

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <GitBranch className="size-4" />
            GitHub
          </h2>
          <p className="max-w-prose text-xs text-muted-foreground">
            Keep React Email templates in a repository. A push to its target branch goes
            live; pushes to other branches are checked and reported on the commit.
          </p>
        </div>
        <div className="flex gap-2">
          {installed && <ConnectRepositoryButton state={state} />}
          <InstallButton installed={installed} />
        </div>
      </div>

      {installed && state.repositories.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          Installed on {state.installations.map((i) => i.account_login).join(", ")}.
          Connect a repository to bring its templates in.
        </p>
      )}

      {state.repositories.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-2xl border">
          {state.repositories.map((r) => (
            <RepositoryRow key={r.id} repo={r} />
          ))}
        </ul>
      )}
    </section>
  )
}

function InstallButton({ installed }: { installed: boolean }) {
  const [pending, setPending] = React.useState(false)
  return (
    <Button
      size="sm"
      variant={installed ? "ghost" : "outline"}
      disabled={pending}
      onClick={async () => {
        setPending(true)
        const result = await githubInstallUrl()
        if (!result.ok) {
          setPending(false)
          toastError("Could not start connecting GitHub", {
            description: result.error,
          })
          return
        }
        // To GitHub, and back to /templates/github/setup when it is done.
        window.location.assign(result.data.url)
      }}
    >
      {pending ? <Loader2 className="animate-spin" /> : <GitBranch />}
      {installed ? "Add a GitHub account" : "Connect GitHub"}
    </Button>
  )
}

function SyncStatus({ repo }: { repo: GithubRepository }) {
  const s = repo.last_sync
  if (repo.removed) {
    return <Badge variant="destructive">No access</Badge>
  }
  if (!s) return <span className="text-xs text-muted-foreground">Not synced yet</span>
  const commit = (
    <a
      href={`https://github.com/${repo.full_name}/commit/${s.commit_sha}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono underline-offset-4 hover:underline"
    >
      {s.commit_sha.slice(0, 7)}
    </a>
  )
  if (s.status === "pending" || s.status === "running") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Syncing {commit}
      </span>
    )
  }
  const refused = (s.outcomes ?? []).filter((o) => o.outcome === "refused").length
  const ok = s.status === "done" && refused === 0
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}
      title={[...(s.problems ?? [])].join("\n") || undefined}
    >
      {ok ? (
        <CheckCircle2 className="size-3.5 text-success" />
      ) : (
        <AlertCircle className="size-3.5" />
      )}
      {s.status === "failed"
        ? "Sync failed at"
        : refused > 0
          ? `${refused} not accepted at`
          : "In sync at"}{" "}
      {commit}
      {s.finished_at && (
        <>
          {" "}
          · <Time iso={s.finished_at} />
        </>
      )}
    </span>
  )
}

function RepositoryRow({ repo }: { repo: GithubRepository }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const problems = repo.last_sync?.problems ?? []
  const refusals = (repo.last_sync?.outcomes ?? []).flatMap((o) =>
    o.outcome === "refused" ? o.problems.map((p) => `${o.path}: ${p}`) : [],
  )

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={`https://github.com/${repo.full_name}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm font-medium underline-offset-4 hover:underline"
        >
          {repo.full_name}
        </a>
        <span className="font-mono text-2xs text-muted-foreground">
          {repo.target_branch} · /{repo.directory}
        </span>
        <span className="text-2xs text-muted-foreground">
          {repo.templates} {repo.templates === 1 ? "template" : "templates"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <SyncStatus repo={repo} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sync now"
            disabled={syncing || repo.removed}
            onClick={async () => {
              setSyncing(true)
              const result = await syncGithubRepository(repo.id)
              setSyncing(false)
              if (!result.ok)
                toastError("Could not sync", { description: result.error })
              else router.refresh()
            }}
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Branch and directory"
            onClick={() => setEditing(true)}
          >
            <Settings2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Disconnect"
            onClick={() => setDisconnecting(true)}
          >
            <Unplug />
          </Button>
        </div>
      </div>

      {(problems.length > 0 || refusals.length > 0) && (
        <ul className="space-y-0.5 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {[...problems, ...refusals].slice(0, 6).map((p, i) => (
            <li key={i} className="break-words">
              {p}
            </li>
          ))}
        </ul>
      )}

      <RepositorySettings repo={repo} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${repo.full_name}?`}
        description="Its templates stay, with every version, and keep sending. They become uploads and stop following the repository; connecting it again picks them back up by path."
        confirmLabel="Disconnect"
        doneLabel="Disconnected"
        onConfirm={async () => {
          const result = await disconnectGithubRepository(repo.id)
          if (!result.ok) {
            toastError("Could not disconnect", { description: result.error })
            return false
          }
          return true
        }}
      />
    </li>
  )
}

function RepositorySettings({
  repo,
  open,
  onOpenChange,
}: {
  repo: GithubRepository
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [branch, setBranch] = React.useState(repo.target_branch)
  const [directory, setDirectory] = React.useState(repo.directory)
  useResetOnOpen(open, () => {
    setBranch(repo.target_branch)
    setDirectory(repo.directory)
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={repo.full_name}
      description="Changing either syncs the repository again straight away, so what is live follows the new branch or directory."
      submitLabel="Save"
      doneLabel="Saved"
      canSubmit={branch.trim().length > 0}
      onSubmit={() =>
        updateGithubRepository(repo.id, {
          target_branch: branch.trim(),
          directory: directory.trim(),
        })
      }
    >
      <FloatingInput
        label="Target branch"
        id="gh-branch"
        className="font-mono text-xs"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        hint="A push here goes live."
      />
      <FloatingInput
        label="Template directory"
        id="gh-directory"
        className="font-mono text-xs"
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
        hint="Where the templates are, e.g. emails. Empty for the repository's root."
      />
    </FormDialog>
  )
}

function ConnectRepositoryButton({ state }: { state: GithubState }) {
  const [open, setOpen] = React.useState(false)
  const [installation, setInstallation] = React.useState(
    state.installations[0]!.installation_id,
  )
  // Keyed by installation, so switching account shows "loading" without a
  // synchronous reset inside the effect.
  const [loaded, setLoaded] = React.useState<{
    installation: number
    list: { id: number; full_name: string; default_branch: string }[]
  } | null>(null)
  const repos = loaded?.installation === installation ? loaded.list : null
  const [repo, setRepo] = React.useState("")
  const [branch, setBranch] = React.useState("")
  const [directory, setDirectory] = React.useState("emails")
  const connected = new Set(state.repositories.map((r) => r.full_name))

  useResetOnOpen(open, () => {
    setRepo("")
    setBranch("")
    setDirectory("emails")
    setLoaded(null)
  })

  React.useEffect(() => {
    if (!open) return
    let current = true
    void githubRepositoriesOf(installation).then((result) => {
      if (!current) return
      if (!result.ok) {
        toastError("Could not list repositories", { description: result.error })
      }
      setLoaded({ installation, list: result.ok ? result.data.data : [] })
    })
    return () => {
      current = false
    }
  }, [open, installation])

  const chosen = repos?.find((r) => r.full_name === repo)

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="outline">
          <Plus />
          Connect a repository
        </Button>
      }
      title="Connect a repository"
      description="Its templates are brought in now, and every push to the target branch after this goes live. Pushes to other branches are only checked."
      submitLabel="Connect"
      doneLabel="Connected"
      canSubmit={Boolean(chosen)}
      onSubmit={() =>
        connectGithubRepository({
          installation_id: installation,
          full_name: repo,
          target_branch: branch.trim() || chosen?.default_branch,
          directory: directory.trim(),
        })
      }
    >
      {state.installations.length > 1 && (
        <Select
          value={String(installation)}
          onValueChange={(v) => setInstallation(Number(v))}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {state.installations.map((i) => (
              <SelectItem key={i.installation_id} value={String(i.installation_id)}>
                {i.account_login}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select value={repo} onValueChange={setRepo} disabled={!repos}>
        <SelectTrigger className="w-full font-mono text-xs">
          <SelectValue
            placeholder={repos ? "Choose a repository" : "Loading repositories"}
          />
        </SelectTrigger>
        <SelectContent>
          {(repos ?? []).map((r) => (
            <SelectItem
              key={r.id}
              value={r.full_name}
              disabled={connected.has(r.full_name)}
              className="font-mono text-xs"
            >
              {r.full_name}
              {connected.has(r.full_name) ? " (connected)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {repos?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          The app cannot see any repositories yet. Grant it access on GitHub, then try
          again.
        </p>
      )}
      <FloatingInput
        label="Target branch"
        id="gh-new-branch"
        className="font-mono text-xs"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        hint={`A push here goes live. Defaults to ${chosen?.default_branch ?? "the default branch"}.`}
      />
      <FloatingInput
        label="Template directory"
        id="gh-new-directory"
        className="font-mono text-xs"
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
        hint="Where the templates are. Empty for the repository's root."
      />
    </FormDialog>
  )
}
