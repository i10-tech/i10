#!/usr/bin/env bash
#
# Checked before `turbo run dev`, so a broken local setup says what is wrong.
#
# ⚠ THIS EXISTS BECAUSE THE FAILURE IT CATCHES IS UNREADABLE. `turbo run dev`
# starts eight persistent tasks at once and interleaves their output; a port
# that is already taken surfaces as `EADDRINUSE` buried between two successful
# builds, attributed to whichever app lost the race rather than to whatever is
# actually holding the port. The usual cause is a previous `bun run dev` that
# was disowned rather than stopped — its servers are still up, still serving
# stale code, and the new run half-starts on top of them.
#
# ⚠ AND IT FAILS RATHER THAN KILLING ANYTHING. A stray `next-server` and a
# deliberately-running one are indistinguishable from here, and this script
# cannot know which; a preflight that killed the wrong process would take down
# work nobody asked it to touch. It prints the pid and the command.

set -euo pipefail

fail=0

note() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
bad() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  fail=1
}

# The ports turbo is about to bind, and who owns each one.
declare -a PORTS=(3000 3001 3002 3003 3004 3005)
declare -a OWNERS=(console api web docs auth emails)

held=()
for i in "${!PORTS[@]}"; do
  port="${PORTS[$i]}"
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || continue
  command="$(ps -o comm= -p "$pid" 2>/dev/null | sed 's|.*/||' || echo '?')"
  bad "port $port (${OWNERS[$i]}) is already in use by pid $pid — $command"
  held+=("$pid")
done

if [ ${#held[@]} -gt 0 ]; then
  # ⚠ PRINTED, NOT RUN. See the note at the top.
  note ""
  note "If those are servers from an earlier run, stop them with:"
  note "    kill ${held[*]}"
fi

# ⚠ A LISTENING SOCKET, NOT `docker compose ps`. A container can be up and its
# service still refusing connections — postgres takes a moment to accept after
# the container reports running, and that window is exactly when somebody runs
# this. Opening the socket is the thing the apps are about to do anyway.
reachable() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

declare -a SERVICES=(5432 6379 5354)
declare -a NAMES=(postgres redis powerdns)
down=()
for i in "${!SERVICES[@]}"; do
  reachable "${SERVICES[$i]}" || down+=("${NAMES[$i]}")
done

if [ ${#down[@]} -gt 0 ]; then
  bad "not reachable: ${down[*]}"
  note "    bun run dev:up"
fi

# ⚠ A WARNING RATHER THAN A FAILURE, BECAUSE BOTH WAYS OF FILLING THE
# ENVIRONMENT ARE SUPPORTED. Doppler exports into this process, so the variable
# is visible here; a `.env.development.local` is read by Next itself and is not,
# so its absence here proves nothing. Running with neither is legitimate — the
# marketing site and the docs need no identity provider — it just means the
# console will render signed-out rather than say why.
if [ -z "${CLERK_PUBLISHABLE_KEY:-}" ] && [ ! -f "$(dirname "$0")/../.env.development.local" ]; then
  note "CLERK_PUBLISHABLE_KEY is not set and there is no .env.development.local."
  note "The console and the auth app will render signed-out. To fix:"
  note "    doppler run -- bun run dev"
fi

[ "$fail" -eq 0 ] || exit 1
