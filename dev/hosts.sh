#!/usr/bin/env bash
#
# Points the local hostnames at the loopback address.
#
# ⚠ BROWSERS DO NOT NEED THIS AND EVERYTHING ELSE DOES. RFC 6761 reserves
# `.localhost`, and Chrome, Safari and Firefox all resolve `anything.localhost`
# to 127.0.0.1 with no configuration. The operating system's resolver does not:
# `curl https://api.i10.localhost` and a server-side `fetch` from a Next.js route
# both fail with NXDOMAIN while the same URL works perfectly in the address bar,
# which is a confusing half-hour the first time.
#
# ⚠ IT IS IDEMPOTENT AND SCOPED TO A MARKED BLOCK, so running it twice does not
# append a second copy and `dev:unhosts` can remove exactly what it added —
# rather than a regex over /etc/hosts, which is a file where a bad edit costs
# somebody their afternoon.

set -euo pipefail

BEGIN="# >>> i10 local development >>>"
END="# <<< i10 local development <<<"

NAMES=(
  dash.i10.localhost
  auth.i10.localhost
  api.i10.localhost
  docs.i10.localhost
  i10.localhost
  www.i10.localhost
)

if [ "${1:-add}" = "remove" ]; then
  echo "dev:hosts: removing the i10 block from /etc/hosts (sudo)…"
  sudo sed -i.i10bak "/$BEGIN/,/$END/d" /etc/hosts
  echo "dev:hosts: removed."
  exit 0
fi

if grep -qF "$BEGIN" /etc/hosts 2>/dev/null; then
  echo "dev:hosts: already present. Nothing to do."
  exit 0
fi

echo "dev:hosts: adding ${#NAMES[@]} names to /etc/hosts (sudo)…"
{
  echo ""
  echo "$BEGIN"
  for name in "${NAMES[@]}"; do
    # ⚠ BOTH FAMILIES. macOS prefers IPv6 for a name that has both, and a name
    # with only an A record still resolves — but a browser that has cached
    # `::1` from somewhere else will try it first and hang. Listing both is
    # cheaper than diagnosing that once.
    echo "127.0.0.1 $name"
    echo "::1 $name"
  done
  echo "$END"
} | sudo tee -a /etc/hosts >/dev/null

echo "dev:hosts: done."
