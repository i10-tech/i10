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
| 2026-11-01 | Every step-up action by an SSO-signed-in admin did nothing: the console dropped `sso_step_up_required` and left the dialog open | `StepUpProvider` sends the browser to the IdP step-up (`/sso/step-up` on apps/auth's origin only) and back |
| 2026-11-01 | SAML groups after the first were lost: a repeated `<Attribute Name>` was dropped (Keycloak sends one per group) | Repeated attributes merge, still capped at 100 values |
| 2026-11-01 | The access gate sent a person back to the connection they were first claimed through, which after a domain move could no longer vouch for them (a loop) | `gateRead` names the live connection covering their domain now; for an owner or admin only one they are linked on (#338); none is null, so no dead button |
| 2026-11-01 | A member signing in through SSO at the seat cap was put on the waiting list: Clerk answers `organization_membership_quota_exceeded` before "already a member" | The bridge's `join` returns `added` for somebody already a member in our table and Clerk, without asking Clerk to add them |
| 2026-11-01 | Lab: Keycloak sent no `auth_time` (no `basic` client scope), so every step-up was `step_up_stale` | Realm file and `apply.sh` add `basic` |

## Open bugs

- **SSO finish sometimes leaves an unbound session** (2026-11-01, 2 of 5 runs, not reproducible on demand). IdP and JIT succeed, the Clerk ticket signs in, but `/api/sso/bind` is never called. The person sees "Could not finish signing you in", or lands on onboarding when they navigate on, because the gate refuses the unbound session. Both failures were the first SSO run after a sign-out or account switch. `finishSso` now logs `[auth] sso finish failed at <step>`; capture that line on the next failure.
- **Typed email not passed to the IdP.** Typed `bob@` at the sign-in page; Keycloak still held alice's session and answered as alice. Happens on OIDC and SAML. Send `login_hint` (OIDC) / `Subject` NameID hint (SAML) and consider warning when the asserted email differs from the typed one.
- **A slow first SSO sign-in shows a failure while it succeeds.** Bob's SAML JIT sign-in (2026-11-01 17:35:02) took about 30 s on the API: `managed.claimed` 17:35:25, member row 17:35:28, `sign_in.verified` 17:35:32, attempt `signed_in`. The auth app's ACS call gives up after 5 s (`callApi`, `AbortSignal.timeout(5000)` in `_lib/devices-server.ts`; the auth log shows `POST /sso/saml/acs 303 in 5.1s`) and shows "Sign-in is temporarily unavailable"; the one-time code is never redeemed. The API had restarted at 17:33:41 (a file edit during testing) and logs nothing between the attempt and Clerk's `user.created` at 17:35:26, so about 21 s went into the first, cold run of the path before the Clerk user existed; the risk engine's lazily loaded embedding model is the suspect, unconfirmed. Either way a 5 s budget is too tight for a first JIT sign-in, and a timeout here must not lose a sign-in that succeeded.
- **SSO start refused after arriving from the IdP's logout.** Keycloak logout redirected to `/sign-in`; discovery then "Continue with kc saml SSO" was refused "Start your company's sign-in from i10" (`startedByUs`), with no attempt created. The same click from a freshly loaded `/sign-in` passed. Not yet explained.
- **Lab: Keycloak's SAML client sends unsigned LogoutRequests** to our SLO endpoint (`logout.failed: unsigned`, refused, correct). Turn on signing in the lab's SAML client so SAML SLO can be tested.
- **Removing a domain from a live connection locks its managed people out without warning.** With the new connection still in Testing, nobody at the domain has any way in. The console should warn (count the managed accounts on that domain) and, ideally, offer the move as one step: add to the new live connection, then remove from the old.
- **Sign-outs never reach `identity.sso_sessions`.** Only `session.created` is subscribed, so a session ended in Clerk keeps `revoked_at` empty. Harmless for back-channel logout, wrong for anything that counts live SSO sessions. Subscribe `session.ended`/`session.removed`/`session.revoked` and stamp the row.

## UX (for the UI/UX pass)

- OIDC setup has two save buttons (settings and secret); saving the secret alone silently drops unsaved settings.
- An unbound or refused SSO session lands on onboarding instead of saying what happened.
- "Could not finish signing you in" gives no reason or next step beyond Start again.
- Sign-in page shows saved accounts that were signed in through SSO; "Continue as alice@..." should go straight to her IdP.
- Creating a connection whose domain another connection holds says "its domain was not added", which reads like the save failed. Say which connection holds the domain and how to move it.
- The SSO step-up leaves the page and comes back with the action not done; the person presses it again. Resuming the action after the round trip would be smoother.

## Passed

- OIDC test run through Keycloak (Start test, login, callback, result recorded).
- OIDC sign-in with JIT: `managed.claimed`, `managed.enforced`, `jit.provisioned` with role admin via rule `admins`, session bound with Keycloak `sid`.
- Home realm discovery with enforcement Optional: typed email offers "Continue with Keycloak lab SSO" plus the password fallback.
- OIDC step-up: `prompt=login max_age=0`, Keycloak re-prompts, `step_up.succeeded` on `auth_time`, the action then goes through.
- SAML test run through Keycloak: AuthnRequest, signed assertion verified, attributes and AuthnInstant read; refused `domain_not_verified` because the domain is on the OIDC connection (correct).
- Admins cannot change a live connection's domains or rules (owner-only), and the page says so.
- Access gate (`sso_required`) shown to a session whose connection lost its domain.
- #338 holds: alice (managed admin, linked on OIDC) is refused `role_exempt` through the SAML connection that now covers her domain.
- OIDC back-channel logout from Keycloak: `logout.idp` revoked exactly the 3 sessions of that Keycloak session (`sid_and_sub`), left the session from another browser alone.
- SAML sign-in through Keycloak as bob: signed AuthnRequest (rsa-sha256), assertion verified, refused `no_account` because JIT is off on the new connection (correct).
- SAML JIT with a group rule: bob provisioned `member` by rule `engineering` (the repeated-attribute groups fix, live).
- JIT respects the seat cap: a full workspace files a join request ("We've asked its admins to add you") instead of adding a member.
- UX: the waiting-list message names the workspace and says what happens next.
- SAML sign-in, linked path: bob in the dashboard, session bound to the SAML connection with Keycloak's SessionIndex and AuthnInstant.
