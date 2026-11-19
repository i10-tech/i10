/**
 * The active workspace's id as the browser knows it, for URLs that must be
 * unique per workspace (the template previews the browser keeps).
 *
 * ⚠ A MODULE VALUE, NOT A HOOK. A thumbnail is also drawn where Clerk is not
 * mounted (loading views, preview mode), and Clerk's hooks throw there.
 * `ActivateWorkspace`, which sits inside the provider at the root, writes it
 * in a layout effect, so it is set before any passive effect fetches.
 *
 * ⚠ THE SERVER CHECKS IT AGAINST THE SESSION (app/api/template-preview), so a
 * stale value costs a cache miss, never a picture shown to the wrong workspace.
 */
export const PERSONAL_WORKSPACE = "personal"

let current = PERSONAL_WORKSPACE

export const setWorkspaceKey = (orgId: string | null | undefined) => {
  current = orgId || PERSONAL_WORKSPACE
}

export const workspaceKey = () => current
