import { defineShape } from "@/lib/shapes"

export interface GithubSetupData {
  error?: string
}

export type GithubSetupShape = Record<string, never>

export const githubSetupShape = defineShape<GithubSetupShape, GithubSetupData>({
  page: "github-setup",
  fallback: {},
  of: () => ({}),
  parse: () => ({}),
})
