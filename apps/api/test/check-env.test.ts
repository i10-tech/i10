import { describe, expect, it } from "bun:test"

/** The minimum a process needs before the interesting checks are reachable. */
const base = {
  DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
  REDIS_URL: "redis://localhost:6379",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  CLERK_SECRET_KEY: "sk_test_abc",
  MAIL_DOMAINS: "i10.tech",
  SES_CONFIGURATION_SET: "i10-events",
}

/** Runs the real entry point in a child with ONLY the given environment. */
async function checkEnv(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "src/check-env.ts"], {
    cwd: `${import.meta.dir}/..`,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, output: stdout + stderr }
}

describe("check-env", () => {
  // ⚠ THE 2026-11-14 INCIDENT: the judge's credentials were set and its provider
  // was not. The exit code is what stops a PreSync hook, and the NAME in the
  // output is what tells the person reading the failed Job what to fix.
  it("exits 1 and names the variable when the environment is refused", async () => {
    const { code, output } = await checkEnv({
      ...base,
      RISK_JUDGE_CF_ACCOUNT_ID: "acct",
      RISK_JUDGE_CF_API_TOKEN: "token-value-that-must-not-appear",
    })

    expect(code).toBe(1)
    expect(output).toContain("RISK_JUDGE_CF_ACCOUNT_ID")
    expect(output).not.toContain("token-value-that-must-not-appear")
  })

  it("exits 0 for a valid environment", async () => {
    const { code, output } = await checkEnv(base)

    expect(code).toBe(0)
    expect(output).toContain("environment valid")
  })
})
