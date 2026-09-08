Preview entries for `pnpm --filter @repo/emails dev`.

Each file holds sample props and nothing else — the templates themselves live in
`src/` because the API imports them. Keeping the two apart means the preview
cannot drift from what is actually sent: it renders the same component, with
fixed values so a screenshot is stable.
