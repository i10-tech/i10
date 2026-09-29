#!/bin/sh
# Starts the renderer under celld.
#
# ⚠ THE SECRET REACHES THE WORKER THROUGH `.dev.vars`, BECAUSE THAT IS THE ONE
# WAY `celld dev` TAKES A VARIABLE THAT IS NOT IN THE CONFIG. It is written at
# start from the pod's environment and never baked into the image.
#
# ⚠ AND AN EMPTY SECRET STILL STARTS. The Worker refuses every request with
# `renderer_not_configured` when it has none, which is the failure to want: a
# crashlooping pod says nothing about why.
set -eu

umask 077
printf 'RENDERER_SECRET="%s"\n' "${RENDERER_SECRET:-}" > /app/.dev.vars

# `dev` because it is the mode that needs no object-store bucket, and this
# Worker keeps no state. `--no-watch`: nothing here changes at runtime.
exec celld dev /app/celld.jsonc --host 0.0.0.0 --port 8787 --no-watch
