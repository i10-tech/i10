# i10 SSO lab

A local, free test bench for i10's own SSO stack: **Keycloak**, **authentik** and
**OpenLDAP**, seeded with the same six people, behind a TLS front that i10's
egress guard accepts. Optional **MinIO** (SIEM export target) and a **webhook
catcher** sit behind the `extras` profile.

> Every password, secret and token in `.env.example` is a **throwaway lab
> credential**. The lab holds six fake people and listens on this machine only.
> Never reuse any of it.

## Why it looks the way it does (read once)

i10 refuses to talk to anything that is not a dotted host name over https with a
verifiable certificate (`routes/console/identity-oidc.ts` readIdpUrl,
`identity/ldap.ts` host schema, `identity/oidc-fetch.ts`, `siem.ts`, webhooks).
So the lab uses `*.lab.localhost` names (they resolve to loopback in browsers and
in `getaddrinfo`), a throwaway CA (`certs/lab-ca.crt`), and a Caddy front. Then
the **API process on the host needs two settings** (these are dev-only; env.ts
refuses the first in production):

```
WEBHOOK_EGRESS_ALLOW=127.0.0.0/8,::1/128        # the egress guard's only dev allowance
NODE_EXTRA_CA_CERTS=<repo>/tools/sso-lab/certs/lab-ca.crt   # Bun must trust the lab CA
SCIM_BASE_URL=https://api.i10.localhost/scim/v2 # otherwise the console shows api.i10.tech
```

Restart the API after setting them. The `*.lab.localhost` names resolve to both
`::1` and `127.0.0.1`; the allow list must cover both (one refused address
refuses the host).

## Start, stop, reset

```
cd tools/sso-lab
cp .env.example .env        # edit LAB_DOMAIN if you want; fill ids later
./lab.sh up                 # certs, OpenLDAP, Keycloak, authentik (+ worker, db), Caddy
./lab.sh extras             # MinIO + bucket + webhook catcher
./lab.sh status | logs [svc] | down | reset   # reset also wipes volumes
./apply.sh                  # after you have connection ids / directory id / SCIM token in .env
```

First `up` takes a few minutes (authentik migrates its database).
`./lab.sh reset-certs` regenerates the CA (then re-trust it everywhere).

## Ports and URLs

| What                                  | URL                                              | Login                                             |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Keycloak (via TLS front, the issuer)  | https://kc.lab.localhost:8443/admin              | `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` |
| Keycloak direct http (apply.sh only)  | http://127.0.0.1:8180                            |                                                   |
| authentik (via TLS front, the issuer) | https://ak.lab.localhost:9443/if/admin/          | `akadmin` / `AUTHENTIK_ADMIN_PASSWORD`            |
| authentik direct http (apply.sh only) | http://127.0.0.1:9100                            | API token `AUTHENTIK_BOOTSTRAP_TOKEN`             |
| OpenLDAP                              | `ldap.lab.localhost` 389 (plain) and 636 (ldaps) | `cn=admin,<base>` / `OPENLDAP_ADMIN_PASSWORD`     |
| MinIO API (https)                     | https://s3.lab.localhost:9012                    | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`         |
| MinIO console                         | http://127.0.0.1:9011                            | same                                              |
| Webhook catcher                       | https://hooks.lab.localhost:8090                 | `./lab.sh logs webhook-catcher`                   |

389 and 636 are fixed: i10 accepts LDAP on those two ports only
(`identity/ldap.ts` LDAP_PORTS). To make your browser stop warning, trust
`certs/lab-ca.crt` (Keychain Access, "Always Trust").

## The people (same in OpenLDAP, Keycloak, authentik)

Domain `LAB_DOMAIN` (default `sso-lab.i10.tech`; **prove it first** in the i10
console under Settings > Team > Access domains, with the `_i10-access` TXT record
it shows; a `.test` name cannot be proved). Password for all: `LAB_USER_PASSWORD`. Username is the part before `@`.

| user  | email            | groups              | manager |
| ----- | ---------------- | ------------------- | ------- |
| alice | alice@LAB_DOMAIN | engineering, admins | -       |
| bob   | bob@LAB_DOMAIN   | engineering         | alice   |
| carol | carol@LAB_DOMAIN | engineering         | -       |
| dave  | dave@LAB_DOMAIN  | sales               | -       |
| erin  | erin@LAB_DOMAIN  | sales               | dave    |
| frank | frank@LAB_DOMAIN | admins              | -       |

Groups: `engineering`, `sales`, `admins`. IdPs send them as the `groups` claim /
attribute. In OpenLDAP `manager` is a DN; in authentik it is the manager's email
(user attribute `manager`).

## Fill in `.env` (after the console shows you the ids)

`CONNECTION_ID_{KEYCLOAK,AUTHENTIK}_{OIDC,SAML}` are the ids of the i10 SSO
connections you create; `DIRECTORY_ID` and `SCIM_TOKEN` come from a SCIM
directory. Run `./apply.sh` after every change (it patches the running Keycloak and
authentik and triggers the Keycloak LDAP sync; idempotent), then `./lab.sh up` so
authentik's blueprint env matches (otherwise its periodic blueprint re-apply
writes the placeholder `unset` ids back).

## Runbooks

Create each connection as a draft/testing connection with the domain
`LAB_DOMAIN` unless the step says otherwise.

### OIDC sign-in

1. Console > SSO > New connection > OIDC. Issuer
   `https://kc.lab.localhost:8443/realms/i10-lab` (Keycloak) or
   `https://ak.lab.localhost:9443/application/o/i10-lab-oidc/` (authentik).
2. Client id / secret: `KEYCLOAK_OIDC_CLIENT_ID` / `KEYCLOAK_OIDC_CLIENT_SECRET`
   (or the AUTHENTIK pair). Client auth: client secret. Scopes: `openid email profile` (+ `groups` for authentik).
3. Put the connection id in `.env`, run `./apply.sh`. Redirect URI is already
   `AUTH_ORIGIN/sso/callback`.
4. Use the console's test run, then sign in at the auth app as alice@LAB_DOMAIN.
   Expect the IdP login page, then back in i10 signed in as that address. `email_verified` is true on both.

### SAML sign-in

1. Console > New connection > SAML. Metadata URL: Keycloak
   `https://kc.lab.localhost:8443/realms/i10-lab/protocol/saml/descriptor`,
   authentik `https://ak.lab.localhost:9443/api/v3/providers/saml/<pk>/metadata/?download` (apply.sh prints the exact URL; the friendlier `/application/saml/i10-lab-saml/metadata/` redirects there and i10 never follows redirects).
   i10 reads it through the egress guard (needs the two settings above).
2. Put the connection id in `.env` (`..._SAML`), run `./apply.sh` (Keycloak: client
   id = our entity id; authentik: ACS + audience). NameID is the email; attributes
   `email firstName lastName groups manager`; assertions are signed.
3. Test run, then sign in. Expect IdP login, POST to the ACS, signed in.

### Step-up / ForceAuthn

Sign in once, then trigger an action that needs step-up (owner action on an
active connection). i10 sends `ForceAuthn="true"` (SAML) or `prompt=login
max_age=0` (OIDC). Expect the IdP to ask for the password again even though its
session is live. Keycloak honours both. If authentik does not re-prompt, i10 must
answer `step_up_stale` - that is a finding, not a lab fault.

### JIT + group-to-role rules

Connection > JIT/rules: enable JIT, map group `admins` to a role, `engineering`
to member. Sign in as frank (admins) and bob (engineering) via either IdP;
expect each to land with the mapped role. Move bob out of `engineering` in the IdP
(Keycloak groups are read-only from LDAP: edit the LDAP entry, or use authentik)
and sign in again to see the rule re-evaluate.

### SCIM provision / update / deactivate / delete (authentik)

1. Console > Directories > New SCIM directory; copy its id into `DIRECTORY_ID`
   and mint a token into `SCIM_TOKEN`. Run `./apply.sh`.
2. In authentik admin: Applications > Providers > "i10 lab SCIM" > Run sync (or
   edit a user). Expect the six users and three groups in the i10 directory.
3. Update: change a user's name in authentik; expect it in i10 within the sync.
   Deactivate: untick Active; expect the i10 user suspended. Delete: delete the
   user; expect deprovision. `manager` is sent as the enterprise-extension value
   (the manager's email; i10 may want a SCIM id there - check the response).
   Containers reach the API at `API_ORIGIN_FROM_CONTAINERS` (plain http to bun).

### LDAP pass-through

1. Verify the mail setup for a managed account first (an SSO or SCIM-managed user).
2. Console > connection > Mail > LDAP pass-through: host `ldap.lab.localhost`,
   port 636, `ldaps`, service DN `cn=svc-i10,ou=service,<base>`, secret
   `LDAP_SERVICE_PASSWORD`, base `ou=people,<base>`, filter `(mail={email})`,
   pinned CA = contents of `certs/lab-ca.crt`. Base is `dc=sso-lab,dc=i10,dc=tech` by default.
3. Run the setup test with alice@LAB_DOMAIN and `LAB_USER_PASSWORD`. Expect `ok`. A wrong password gives `user_bind_failed`.
   authd (services/authd) needs the same reachability and CA from wherever it runs.

### OIDC back-channel logout (Keycloak)

1. Keycloak OIDC connection active, `CONNECTION_ID_KEYCLOAK_OIDC` set, `./apply.sh`.
   The client sends logout tokens to
   `http://host.docker.internal:3001/sso/oidc/backchannel/<id>`.
2. Sign in as alice. In Keycloak admin > Sessions, sign out her session (or
   Realm > Sessions > Sign out all). Expect i10 to revoke her session on that
   connection (audit log shows the back-channel logout). authentik: same with the
   "i10 lab OIDC" provider (Logout method: back-channel, set by apply.sh).

### Identity webhooks (extras)

1. `./lab.sh extras`. In the console add a webhook endpoint
   `https://hooks.lab.localhost:8090/` for the identity events.
2. Do something that emits one (sign in via SSO, deprovision a user).
3. `./lab.sh logs webhook-catcher` shows the signed POST body and headers.

### SIEM export (extras)

1. `./lab.sh extras` (creates bucket `i10-siem`).
2. Console > Audit > SIEM export: endpoint `https://s3.lab.localhost:9012`,
   bucket `i10-siem`, region `us-east-1`, access key = `MINIO_ROOT_USER`, secret =
   `MINIO_ROOT_PASSWORD`, path-style.
3. Expect objects under the prefix in the MinIO console (http://127.0.0.1:9011) after the next export window.

## Notes

- MinIO's own images are gone from Docker Hub and Quay, so the lab pins the
  `bitnamilegacy` copies (2025.7.23). authentik 2026.8.5 needs no Redis.
- The OpenLDAP `svc-i10` account gets read access from `ldap/acl.sh` (run by `./lab.sh up`).
- The SAML ForceAuthn and SCIM manager-as-email behaviours are unverified against i10 itself.

## Not covered / manual

- authentik's LDAP outpost needs a token the running authentik creates; add an
  LDAP provider + outpost in its UI if you want authentik itself to answer LDAP.
  OpenLDAP already covers pass-through.
- Nothing here signs in to i10 for you.
