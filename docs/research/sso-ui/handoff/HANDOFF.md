# SSO UI pass: motion sweep handoff (2026-11-04, 17:20)

Continue this from `/Users/mohamedabdulkhalek/i10` itself, on branch `fix/sso-setup-friction`. Do not start a new worktree for the orchestrator: the whole UI pass is uncommitted in this checkout, and a worktree cut from HEAD would not have it.

Background is in the memory file `sso-ui-pass.md`. The earlier session was `4494573c-6907-4819-89b4-4aa6aa69a221` (~/.claude/projects/-Users-mohamedabdulkhalek-i10/).

## Where it stands

The UI pass itself landed, uncommitted, on `fix/sso-setup-friction`: `/settings/sso`, `/settings/sso/connect`, `/settings/sso/[id]`, `/settings/security`. After that, a motion and micro-interaction sweep went to five Gemini Flash agents (agy), one worktree each. All five stopped on the Flash 5-hour quota at 15:09. Nothing from the sweep is reviewed or landed.

| Worktree                           | Agent's own diff                              | State                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.worktrees/i10/motion-sso`      | 20 files, +483 / -234                         | Google fix and domain errors through our validator are in. The DNS "looking it up" timeline (`full-sso.cont.txt`, second paragraph) is not. The rest of its list is unchecked.                        |
| `~/.worktrees/i10/motion-shell`    | 12 files, +245 / -41, plus `flows/shell.json` | Workspace select, switch landing, `ButtonLink` press feedback. Never reported. Closest to done; other areas' press feedback depends on its `ButtonLink`. Review its onboarding-gate change carefully. |
| `~/.worktrees/i10/motion-settings` | 8 files, +300 / -135                          | Team page done; the rest of its sweep is not.                                                                                                                                                         |
| `~/.worktrees/i10/motion-sending`  | 2 files, +44 / -5, plus `flows/sending.json`  | Almost nothing; spent its time measuring.                                                                                                                                                             |
| `~/.worktrees/i10/motion-data`     | 1 file, +2 / -2, plus `flows/data.json`       | Almost nothing; spent its time measuring.                                                                                                                                                             |

How to read a worktree: each one's git index holds the UI pass baseline, so `git -C <worktree> diff` (unstaged, no HEAD) is that agent's work alone. `git diff HEAD` also shows the whole baseline (~80 files) and is noise.

Noise to drop when landing: `AGENTS.md` at the worktree root (an agy artifact), and the five old SSO files the baseline deleted (`access-panel.tsx`, `connection-page.tsx`, `connections-panel.tsx`, `idp-setup.tsx`, `ldap.tsx`) which still exist in the worktrees.

## Files here

- `full-common.txt`: the shared brief every agent got (the owner's rules for motion, the `scripts/motion/check.ts` tool, gates, report contract).
- `full-<area>.txt`: each area's own task list. `full-<area>.cont.txt` / `.fresh.txt`: the continuation briefs. `full-sso2.txt`: the SSO extra task.
- `report-*`: the last relay output per agent (all ended on the quota error).

## Next

1. Resume the agents on Flash (the quota reset at about 16:45). Give Sending and Data a few named pages each, not the whole area, and tell them to fix before measuring. Forbid git stash in every brief (see memory `worktree-agents-shared-stash`).
2. Review each worktree's unstaged diff yourself, re-run the gates from `apps/console` (`bun x tsc --noEmit`, `bun x eslint <files> --max-warnings 0`, `bun test`) and the area's motion flow.
3. Land: `git -C <worktree> diff | git apply` in this checkout, copy its untracked flow file, then `wt remove motion-<area>`. Shell first.
4. Still open from the UI pass: a real provider sign-in through the new flow, guide screenshots from the test tenants, JumpCloud/OneLogin/Ping guide text unverified.

Never ship `apps/console/app/probe/` or `docs/research/sso-ui/`.
