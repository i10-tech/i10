# Letting CI check that a deploy actually landed

`verify-rollout.sh` answers one question from the box: **is the commit CI just
pushed synced, rolled out and healthy?** Until it existed, the Build workflow
went green the moment git accepted the deploy commit — while Argo had not yet
polled, the image had not been pulled and nothing had started. An
ImagePullBackOff, a missing secret or a container that crashlooped on a config
error were all invisible to the pipeline.

## Why SSH, and why over Tailscale

`argocd-server` is a ClusterIP with no ingress, and the Kubernetes API is not
public. Both of those are deliberate. The alternative to SSH is publishing one
of them to the internet so a GitHub runner can call it, which buys a
convenience with a large amount of attack surface on a control plane.

**And SSH is not on the public internet either.** `sshd` on psl-vps binds only
the tailnet addresses:

```
LISTEN  100.127.102.63:22
LISTEN  [fd7a:115c:a1e0::9932:663f]:22
```

There is nothing listening on the public address, so this is not a firewall rule
that could be opened — a GitHub-hosted runner simply has no route to it. The job
joins the tailnet first, as an **ephemeral** node created for that run and
removed when it ends.

> ⚠ THERE IS NO SSH KEY, AND THAT IS BECAUSE TAILSCALE SSH IS ON. `tailscaled`
> intercepts port 22 on the tailnet address before sshd ever sees the
> connection, and this host's sshd binds ONLY tailnet addresses — so Tailscale
> SSH shadows OpenSSH completely. It authenticates by tailnet identity against
> the ACL's `ssh` rules and NEVER reads `authorized_keys`.
>
> ⚠ AN EARLIER VERSION OF THIS FILE DESCRIBED A PRIVATE KEY WITH A FORCED
> COMMAND, AND IT COULD NOT HAVE WORKED. The `restrict,command=` was inert, the
> key authenticated nothing, and the symptom was a shell plus
> `<sha>: command not found` — indistinguishable from a misconfigured key, and
> it cost an afternoon. If you ever need to know which daemon answered:
>
> ```bash
> ssh <host> 'p=$(ps -o ppid= -p $$ | tr -d " "); ps -o comm= -p $p'
> ```
>
> `sshd` means OpenSSH; `tailscaled` means Tailscale SSH. Do NOT use
> `tailscale status --json` for this — the `SSH_HostKeys` field is absent even
> when it is running, and `ssh-keyscan` reports the banner `SSH-2.0-Tailscale`
> while still returning sshd's REAL host key, so a matching host key proves
> nothing either. Use `tailscale debug prefs | grep RunSSH`.
>
> ⚠ SO AUTHORISATION LIVES IN THE ACL, AND THE BLAST RADIUS IS THE USER'S RBAC.
> Tailscale SSH has no forced-command concept, so `tag:ci` gets a SHELL as
> `i10-deploy` rather than one pinned command. What bounds it is that user's
> cluster role — get/list/watch on applications, deployments and pods, patch on
> applications, and no sudo. A leaked OAuth secret reaches a read-only view of
> one namespace, not the box. That is a real step down from a forced command,
> and it is the trade that comes with Tailscale SSH being on.
>
> ⚠ JOINING A TAILNET IS NOT AN AUTHORISATION. The runner is tagged `tag:ci`,
> and the tailnet ACL should grant that tag port 22 on this one host and nothing
> else. Without that rule a CI credential is a route to every machine on the
> network, which is a larger blast radius than the public SSH we were avoiding.

## One-time setup on psl-vps

### 1. A user that can only ask this question

```bash
sudo useradd --create-home --shell /bin/bash i10-deploy
sudo install -d -m 700 -o i10-deploy -g i10-deploy /home/i10-deploy/.ssh
```

Give it read access to the cluster. It needs no write verbs at all — the script
annotates one Application to trigger a refresh, and reads:

```bash
sudo k3s kubectl create clusterrole i10-deploy-verify \
  --verb=get,list,watch \
  --resource=applications.argoproj.io,deployments,pods

# ⚠ `patch` ON APPLICATIONS ONLY, AND ONLY SO THE REFRESH ANNOTATION CAN BE
# SET. Without it the script still works and every deploy waits out Argo's
# three-minute poll — which is most of what this was built to remove.
sudo k3s kubectl create clusterrole i10-deploy-refresh \
  --verb=patch --resource=applications.argoproj.io

sudo k3s kubectl create clusterrolebinding i10-deploy-verify \
  --clusterrole=i10-deploy-verify --user=i10-deploy
sudo k3s kubectl create clusterrolebinding i10-deploy-refresh \
  --clusterrole=i10-deploy-refresh --user=i10-deploy
```

…and a kubeconfig for that user. The simplest correct thing on k3s is a client
certificate with `CN=i10-deploy`, matching the bindings above; copying root's
kubeconfig would hand CI the whole cluster, which is the one thing the RBAC
above exists to prevent.

> ⚠ `KUBECONFIG` MUST BE SET, AND `verify-rollout.sh` SETS IT. k3s's `kubectl`
> points itself at `/etc/rancher/k3s/k3s.yaml` — root-only — and ignores
> `~/.kube/config` unless told otherwise. Without that line every kubectl in the
> script fails with "permission denied", each one into `/dev/null`, and the
> result is a rollout reported as never having come up when the real problem was
> a credential never read.

### 2. Install the script

```bash
sudo install -m 755 infra/scripts/verify-rollout.sh /usr/local/bin/i10-verify-rollout
```

> ⚠ IT LIVES IN THE REPO AND IS COPIED TO THE BOX, so a change to it is a commit
> — but the copy is **manual**. Editing the file here does not update the box.
> Re-run this line when it changes.

### 3. The ACL rule that authorises CI

There is no key to install — see the note above. What grants CI access is a
tailnet `ssh` rule, and it is the whole of the authorisation:

```json
"tagOwners": { "tag:ci": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["tag:ci"], "dst": ["tag:vps:22"] }
],
"ssh": [
  {
    "action": "accept",
    "src":   ["tag:ci"],
    "dst":   ["tag:vps"],
    "users": ["i10-deploy"]
  }
]
```

> ⚠ BOTH BLOCKS ARE REQUIRED AND THEY DO DIFFERENT JOBS. `acls` opens the TCP
> path to port 22; `ssh` decides who may log in and as whom. With only the first
> the connection is refused by Tailscale SSH; with only the second there is no
> route for it to refuse.
>
> ⚠ `users` IS THE PART THAT BOUNDS THIS. Naming `i10-deploy` and nothing else
> is what keeps CI off `mo`, which has sudo. An `ssh` rule with
> `"users": ["autogroup:nonroot"]` would hand CI every non-root account on the
> host, which on this box includes accounts that can read secrets.
>
> ⚠ AND `dst` MUST BE A TAG, NOT AN ADDRESS. Tailscale `ssh` rules do not accept
> IPs — psl-vps carries `tag:vps`.

### 4. Repository secrets

| Secret                      | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `TAILSCALE_OAUTH_CLIENT_ID` | an OAuth client with the `auth_keys` scope and `tag:ci` |
| `TAILSCALE_OAUTH_SECRET`    | its secret                                              |

And one variable, `DEPLOY_SSH_HOST` — the box's **tailnet** address,
`100.127.102.63`. It is a variable rather than a secret because it is not one;
a tailnet address is meaningless without a tailnet identity.

> ⚠ IT IS THE TAILNET ADDRESS, NOT THE PUBLIC ONE. Nothing listens on port 22
> publicly; pointing this at `178.105.164.132` produces a connection timeout
> that reads like the box being down.

> ⚠ TWO SECRETS, NOT FIVE, AND THAT IS THE POINT OF DOING IT THIS WAY. An
> earlier version carried a private key and a pinned host key as well. Neither
> did anything — Tailscale SSH never read them — so they were three secrets to
> rotate, leak or misconfigure in exchange for no security property at all.

Without the Tailscale credentials the step **skips** and the workflow still
passes, so a fork and a repository that has not set this up both keep working.
The job summary says which happened.
keep working. The job summary says which happened.

## What it does and does not do

It waits for `i10-workloads` to report the pushed revision as `Synced` and
`Healthy`, then waits for every deployment in `i10-prod` to finish rolling, then
asserts that each image CI rebuilt is actually running at `prod-<sha>`.

It **does not roll back.** Every app here has Argo `selfHeal` on, so
`kubectl rollout undo` is reverted to git within about 35 seconds — the cluster
is not the source of truth and cannot be edited into one. The rollback is
`git revert` of the deploy commit, and the job summary prints that command with
the sha already filled in.

That is a deliberate choice rather than a missing feature: an automatic revert
would be a second process racing the first, pushing to `main` on a judgement
call ("is a single unready pod a failed deploy?") that is frequently wrong
during a slow image pull.

---

# Putting the display face on cdn.i10.tech

`publish-fonts.sh` uploads two `.woff2` files to `s3://i10/fonts/`, which is what
`packages/ui/src/styles/fonts.css` asks for. Everything else about the interface
already works without them; see that file for why the product is correct when
the font is absent.

## Before the first run: the licence

**Check the grant before checking the pipeline.** Serving a font from a public
CDN is redistribution in the plain sense — anyone can fetch the file. Most
_webfont_ licences permit exactly that from a domain you own, usually capped by
pageviews. Most _desktop_ licences do not permit it at all, and the difference is
not visible from the file on disk.

Amazon Ember specifically is Amazon's corporate typeface, offered through the
Amazon developer portal for building and marketing **on Amazon's platforms**.
Hosting it as i10's brand face is outside that. If it is the look that is wanted
rather than the name, the closest freely-licensable faces are Ember's own
relatives — it was drawn by Dalton Maag, whose Aktiv Grotesk is commercially
licensable, and Inter, Public Sans or Geist itself sit in the same humanist-grotesk
territory at no cost and no risk.

## One-time: pointing the name at the bucket

`cdn.i10.tech` is not in the Tofu DNS stack, on purpose — that stack owns the
mail half of the zone and nothing else (see `infra/tofu/stacks/dns/main.tf`). The
web surface is hand-managed, and this is part of it.

1. Cloudflare → R2 → the `i10` bucket → **Settings** → **Public access** →
   **Custom domains** → connect `cdn.i10.tech`.
2. Cloudflare writes the CNAME itself. It **beats the proxied `*.i10.tech`
   wildcard**, because a specific record always wins over a wildcard — that is
   what stops `cdn` resolving to the cluster ingress like every other name.
3. Leave the bucket's `r2.dev` URL disabled. It is rate-limited, uncacheable and
   permanently public regardless of what the custom domain does later.
4. **Add a CORS policy to the bucket**, or the font 404s turn into CORS errors
   the moment step 1 works. A browser fetches every font in CORS mode whatever
   the stylesheet says, so R2 must answer with `Access-Control-Allow-Origin`:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://i10.tech",
         "https://dash.i10.tech",
         "https://auth.i10.tech",
         "https://docs.i10.tech"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   ⚠ **The origins are listed rather than `*`, and the reason is the licence
   rather than security.** The file is public either way — anyone can fetch it
   with curl, and an origin allow-list stops none of that. What it does stop is
   another site embedding our licensed face from our CDN and billing its
   pageviews to our licence. Add a name here when a new surface starts using
   `--font-display`; forgetting shows up as text stuck in the fallback.

## Until both of those are done, the browser lies about which is wrong

A cross-origin **404** with no `Access-Control-Allow-Origin` header is reported
by Chrome as

```
Access to font at 'https://cdn.i10.tech/fonts/…' from origin 'https://dash.i10.tech'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
```

…which reads as a CORS misconfiguration and is actually "that file is not
there". Observed on 2026-09-18: `cdn.i10.tech` resolved to the same two
addresses as `dash.i10.tech` — the proxied `*.i10.tech` wildcard — so the
request reached the cluster ingress, which has no route for it, and Traefik
answered `404 page not found`. **Check the status code with curl before
believing the console.**

```bash
curl -sI https://cdn.i10.tech/fonts/i10-display-400.woff2 | head -1
```

## Publishing

```bash
doppler run -- infra/scripts/publish-fonts.sh ~/fonts/i10-display --dry-run
doppler run -- infra/scripts/publish-fonts.sh ~/fonts/i10-display
```

The dry run checks the four things that go wrong: the secrets are absent, the
filenames do not match what the stylesheet asks for, the file is a renamed
`.ttf` rather than a real woff2, and the sizes are not what was expected.

Then:

```bash
curl -sI https://cdn.i10.tech/fonts/i10-display-400.woff2
```

Expect `200`, `content-type: font/woff2` and a year-long `immutable`
`cache-control`. **That cache header means a replacement at the same path will
not reach anybody who has already loaded it** — to change the cut, publish a new
filename and change the `src` in `fonts.css` with it.

## The follow-up worth doing: metric overrides

`font-display: swap` paints headings in Geist and then swaps. Without metric
overrides that swap **moves the text**, because the two faces have different cap
heights and advance widths — a visible reflow on every cold load.

Once the real file exists, measure it and add the overrides to the `@font-face`
blocks:

```bash
bunx fontkit-metrics i10-display-400.woff2   # or read head/hhea/OS2 directly
```

```css
@font-face {
  font-family: "i10 Display Fallback";
  src: local("Geist"), local("Helvetica Neue"), local("Arial");
  ascent-override: <A/upem>%;
  descent-override: <D/upem>%;
  line-gap-override: 0%;
  size-adjust: <capHeightRatio>%;
}
```

and put that family between `"i10 Display"` and Geist in `--font-display`. This
cannot be written in advance: every number in it comes from the font file, and
guessed values make the shift worse rather than better.
