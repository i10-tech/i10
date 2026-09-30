import { createSign } from "node:crypto"

/**
 * The GitHub App behind GitHub-connected templates (#235), and only the calls
 * it makes.
 *
 * ⚠ READ-ONLY ON CONTENT. The app is granted Contents: read and Checks: write,
 * and this client reads trees and blobs and writes check runs - nothing that
 * could change a customer's repository.
 *
 * ⚠ AN INSTALLATION TOKEN PER INSTALLATION, CACHED UNTIL FIVE MINUTES BEFORE IT
 * EXPIRES. GitHub issues them for an hour; minting one per call would spend a
 * request per request and hit the app's rate limit on a busy push.
 */

export interface Repository {
  id: number
  full_name: string
  default_branch: string
  private: boolean
}

export interface TreeEntry {
  path: string
  type: "blob" | "tree" | "commit"
  sha: string
  size?: number
}

export interface CheckRun {
  head_sha: string
  name: string
  conclusion: "success" | "failure" | "neutral"
  title: string
  summary: string
}

export interface GitHubApp {
  slug: string
  installation(installationId: number): Promise<{ login: string; type: string } | null>
  repositories(installationId: number): Promise<Repository[]>
  repository(installationId: number, fullName: string): Promise<Repository | null>
  /** The commit a branch points at, or null if there is no such branch. */
  branchHead(
    installationId: number,
    fullName: string,
    branch: string,
  ): Promise<string | null>
  /** Every entry of the tree at `sha`, recursively; `truncated` past GitHub's limit. */
  tree(
    installationId: number,
    fullName: string,
    sha: string,
  ): Promise<{ entries: TreeEntry[]; truncated: boolean }>
  /** A blob's content as text. */
  blob(installationId: number, fullName: string, sha: string): Promise<string>
  createCheckRun(installationId: number, fullName: string, run: CheckRun): Promise<void>
  /** The OAuth code from the setup redirect, exchanged for a user token. */
  exchangeCode(code: string): Promise<string | null>
  /** The installations the user behind a user token can see. */
  userInstallationIds(userToken: string): Promise<number[]>
}

const API = "https://api.github.com"

export function githubApp(opts: {
  appId: string
  slug: string
  privateKey: string
  clientId: string
  clientSecret: string
  fetch?: typeof fetch
  now?: () => number
}): GitHubApp {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const tokens = new Map<number, { token: string; expires: number }>()

  /** A JWT for the app itself: RS256, ten minutes at most, backdated a minute for clock skew. */
  function appJwt(): string {
    const iat = Math.floor(now() / 1000) - 60
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
    const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: opts.appId })}`
    const signature = createSign("RSA-SHA256")
      .update(body)
      .sign(opts.privateKey, "base64url")
    return `${body}.${signature}`
  }

  async function call(
    path: string,
    auth: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return doFetch(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "i10",
        Authorization: auth,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    })
  }

  async function installationToken(installationId: number): Promise<string> {
    const cached = tokens.get(installationId)
    if (cached && cached.expires - 5 * 60_000 > now()) return cached.token
    const res = await call(
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${appJwt()}`,
      { method: "POST" },
    )
    if (!res.ok) throw new Error(`GitHub refused an installation token: ${res.status}`)
    const body = (await res.json()) as { token: string; expires_at: string }
    tokens.set(installationId, {
      token: body.token,
      expires: Date.parse(body.expires_at),
    })
    return body.token
  }

  async function asInstallation<T>(
    installationId: number,
    path: string,
    init?: RequestInit,
  ) {
    const res = await call(
      path,
      `token ${await installationToken(installationId)}`,
      init,
    )
    if (res.status === 404) return null
    if (!res.ok)
      throw new Error(`GitHub ${init?.method ?? "GET"} ${path}: ${res.status}`)
    return res.status === 204 ? (null as T | null) : ((await res.json()) as T)
  }

  const repoPath = (fullName: string) =>
    fullName
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/")

  return {
    slug: opts.slug,

    async installation(installationId) {
      const res = await call(
        `/app/installations/${installationId}`,
        `Bearer ${appJwt()}`,
      )
      if (!res.ok) return null
      const body = (await res.json()) as { account?: { login?: string; type?: string } }
      return body.account?.login
        ? { login: body.account.login, type: body.account.type ?? "User" }
        : null
    },

    async repositories(installationId) {
      const out: Repository[] = []
      // A hundred per page, three pages: the picker lists what one person can
      // reasonably scroll; anything past it is found by connecting by name.
      for (let page = 1; page <= 3; page++) {
        const body = await asInstallation<{ repositories: Repository[] }>(
          installationId,
          `/installation/repositories?per_page=100&page=${page}`,
        )
        const batch = body?.repositories ?? []
        out.push(...batch)
        if (batch.length < 100) break
      }
      return out
    },

    async repository(installationId, fullName) {
      return asInstallation<Repository>(installationId, `/repos/${repoPath(fullName)}`)
    },

    async branchHead(installationId, fullName, branch) {
      const body = await asInstallation<{ object: { sha: string } }>(
        installationId,
        `/repos/${repoPath(fullName)}/git/ref/heads/${branch
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      )
      return body?.object.sha ?? null
    },

    async tree(installationId, fullName, sha) {
      const body = await asInstallation<{ tree: TreeEntry[]; truncated: boolean }>(
        installationId,
        `/repos/${repoPath(fullName)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      )
      return { entries: body?.tree ?? [], truncated: body?.truncated ?? false }
    },

    async blob(installationId, fullName, sha) {
      const body = await asInstallation<{ content: string; encoding: string }>(
        installationId,
        `/repos/${repoPath(fullName)}/git/blobs/${encodeURIComponent(sha)}`,
      )
      if (!body) throw new Error(`GitHub has no blob ${sha} in ${fullName}`)
      return body.encoding === "base64"
        ? Buffer.from(body.content, "base64").toString("utf8")
        : body.content
    },

    async createCheckRun(installationId, fullName, run) {
      await asInstallation(installationId, `/repos/${repoPath(fullName)}/check-runs`, {
        method: "POST",
        body: JSON.stringify({
          name: run.name,
          head_sha: run.head_sha,
          status: "completed",
          conclusion: run.conclusion,
          output: { title: run.title, summary: run.summary.slice(0, 65_000) },
        }),
      })
    },

    async exchangeCode(code) {
      const res = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { access_token?: string }
      return body.access_token ?? null
    },

    async userInstallationIds(userToken) {
      const res = await call("/user/installations?per_page=100", `Bearer ${userToken}`)
      if (!res.ok) return []
      const body = (await res.json()) as { installations?: { id: number }[] }
      return (body.installations ?? []).map((i) => i.id)
    },
  }
}
