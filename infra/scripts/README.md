# Letting CI check that a deploy actually landed

`verify-rollout.sh` answers one question from the box: **is the commit CI just
pushed synced, rolled out and healthy?** Until it existed, the Build workflow
went green the moment git accepted the deploy commit — while Argo had not yet
polled, the image had not been pulled and nothing had started. An
ImagePullBackOff, a missing secret or a container that crashlooped on a config
error were all invisible to the pipeline.

## Why SSH and not the Argo API

`argocd-server` is a ClusterIP with no ingress, and the Kubernetes API is not
public. Both of those are deliberate. The alternative to SSH is publishing one
of them to the internet so a GitHub runner can call it, which buys a
convenience with a large amount of attack surface on a control plane.

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
certificate; copying root's kubeconfig would give CI the cluster, which is
exactly what the forced command below is trying to prevent.

### 2. Install the script

```bash
sudo install -m 755 infra/scripts/verify-rollout.sh /usr/local/bin/i10-verify-rollout
```

> ⚠ IT LIVES IN THE REPO AND IS COPIED TO THE BOX, so a change to it is a commit
> — but the copy is **manual**. Editing the file here does not update the box.
> Re-run this line when it changes.

### 3. The key, pinned to that one command

```bash
ssh-keygen -t ed25519 -C "github-actions i10 rollout verify" -f /tmp/i10-deploy -N ""
```

Append the public half to `/home/i10-deploy/.ssh/authorized_keys` with a forced
command:

```
restrict,command="/usr/local/bin/i10-verify-rollout" ssh-ed25519 AAAA… github-actions i10 rollout verify
```

> ⚠ `command=` IS WHAT MAKES THIS SAFE, AND `restrict` IS WHAT KEEPS IT SAFE.
> The forced command means the key cannot open a shell, read a secret or change
> a workload whatever the client asks for — the requested command arrives in
> `SSH_ORIGINAL_COMMAND`, and the script validates it down to a 40-character hex
> sha and a comma-separated list of image names before using it. `restrict`
> turns off port forwarding, agent forwarding, X11 and PTY allocation, each of
> which would otherwise be a way around the first part.
>
> ⚠ A PLAIN DEPLOY KEY HERE WOULD BE THE MOST VALUABLE SECRET IN THE
> ORGANISATION: shell access to the machine that runs the database, the mail
> server and every credential. This one is worth a status report.

### 4. Repository secrets

| Secret                   | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| `DEPLOY_SSH_KEY`         | the **private** half of the key above                     |
| `DEPLOY_SSH_HOST`        | the box's hostname or address                             |
| `DEPLOY_SSH_USER`        | `i10-deploy` (the default; set it only if you renamed it) |
| `DEPLOY_SSH_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <host>`                 |

> ⚠ `DEPLOY_SSH_KNOWN_HOSTS` IS NOT OPTIONAL AND MUST NOT BECOME
> `StrictHostKeyChecking=no`. Turning the check off means the first machine to
> answer on that address receives a CI credential and the commands it runs.

Without `DEPLOY_SSH_KEY` the step **skips** and the workflow still passes, so a
fork and a repository that has not set this up both keep working. The job
summary says which happened.

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
