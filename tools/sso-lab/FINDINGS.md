# SSO test findings

Running log from the end-to-end tests against the lab and real IdPs. Bugs are
fixed as they are found; UX items wait for the UI/UX pass.

## Fixed during testing

| Found | What | Fix |
|---|---|---|
| 2026-10-31 | Lab CA's IP name constraints are rejected by Bun (UNSUPPORTED_CONSTRAINT_TYPE), so OIDC discovery failed | DNS-only constraints in `certs.sh` |
| 2026-10-31 | A new OIDC connection never became ready: the client auth method was only saved when changed | API reads an unset method as the preset's first; console sends it when it differs |
| 2026-10-31 | Every SSO redirect in the auth app went to the bind address (`localhost:3004`, `0.0.0.0:3000` in prod) | Relative `Location` headers |
| 2026-10-31 | Console-started tests refused: Chromium labels dash -> auth on `.localhost` cross-site | `startedByUs` also accepts cross-site with our console as the Referer |

## Open bugs

- **SSO finish sometimes leaves an unbound session** (2026-11-01, 2 of 5 runs, not reproducible on demand). IdP and JIT succeed, the Clerk ticket signs in, but `/api/sso/bind` is never called. The person sees "Could not finish signing you in", or lands on onboarding when they navigate on, because the gate refuses the unbound session. Both failures were the first SSO run after a sign-out or account switch. `finishSso` now logs `[auth] sso finish failed at <step>`; capture that line on the next failure.
- **Typed email not passed to the IdP.** Typed `bob@` at the sign-in page; Keycloak still held alice's session and answered as alice. Send `login_hint` (OIDC) and consider warning when the asserted email differs from the typed one.

- **Sign-outs never reach `identity.sso_sessions`.** Only `session.created` is subscribed, so a session ended in Clerk keeps `revoked_at` empty. Harmless for back-channel logout, wrong for anything that counts live SSO sessions. Subscribe `session.ended`/`session.removed`/`session.revoked` and stamp the row.

## UX (for the UI/UX pass)

- OIDC setup has two save buttons (settings and secret); saving the secret alone silently drops unsaved settings.
- An unbound or refused SSO session lands on onboarding instead of saying what happened.
- "Could not finish signing you in" gives no reason or next step beyond Start again.
- Sign-in page shows saved accounts that were signed in through SSO; "Continue as alice@..." should go straight to her IdP.

## Passed

- OIDC test run through Keycloak (Start test, login, callback, result recorded).
- OIDC sign-in with JIT: `managed.claimed`, `managed.enforced`, `jit.provisioned` with role admin via rule `admins`, session bound with Keycloak `sid`.
- Home realm discovery with enforcement Optional: typed email offers "Continue with Keycloak lab SSO" plus the password fallback.
