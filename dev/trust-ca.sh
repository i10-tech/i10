#!/usr/bin/env bash
#
# Teaches this machine to trust the certificates Caddy issues locally.
#
# ⚠ WITHOUT THIS, EVERY LOCAL PAGE IS A CERTIFICATE WARNING — and a browser that
# has been click-throughed once will do it again on a page that matters. It also
# breaks things that are not a browser: a server-side `fetch` from the console to
# `https://api.i10.localhost` fails outright on an untrusted chain, with an error
# about the certificate that reads like a proxy misconfiguration.
#
# ⚠ IT TRUSTS A CA THAT CAN SIGN FOR ANY NAME, so it is worth knowing what is
# being added. Caddy generates the key inside the `caddy-data` volume on this
# machine and it never leaves; the risk is somebody else with access to this
# laptop, which is the same risk as the SSH key beside it. `bun run dev:untrust`
# removes it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT="$ROOT/dev/.caddy-root.crt"

compose() {
  # ⚠ `docker compose`, NOT `docker-compose`. The hyphenated v1 is gone from
  # current Docker Desktop and the error it leaves is "command not found",
  # which reads as Docker not being installed at all.
  docker compose -f "$ROOT/compose.dev.yaml" "$@"
}

if ! docker info >/dev/null 2>&1; then
  echo "dev:trust: Docker is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

if ! compose ps --status running --services 2>/dev/null | grep -qx caddy; then
  echo "dev:trust: the proxy is not running. Run 'bun run dev:up' first." >&2
  exit 1
fi

# ⚠ THE ROOT, NOT THE INTERMEDIATE. Caddy issues leaf certificates from an
# intermediate that the root signs; trusting the intermediate works until Caddy
# rotates it, which it does on its own schedule and without telling anybody.
echo "dev:trust: exporting Caddy's local root…"
compose exec -T caddy cat \
  /data/caddy/pki/authorities/local/root.crt > "$CERT"

if [ ! -s "$CERT" ]; then
  echo "dev:trust: the root certificate came back empty. Has Caddy served a request yet?" >&2
  rm -f "$CERT"
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    # ⚠ THE LOGIN KEYCHAIN, NOT THE SYSTEM ONE. `-d` would need sudo and would
    # trust the CA for every account on the machine; this is one developer's
    # laptop and one developer's trust decision.
    echo "dev:trust: adding to the login keychain (you will be asked to approve)…"
    security add-trusted-cert \
      -k "$HOME/Library/Keychains/login.keychain-db" \
      -p ssl \
      "$CERT"
    ;;
  Linux)
    echo "dev:trust: installing into the system trust store (sudo)…"
    sudo cp "$CERT" /usr/local/share/ca-certificates/i10-caddy-local.crt
    sudo update-ca-certificates
    # ⚠ FIREFOX AND CHROME ON LINUX KEEP THEIR OWN NSS STORES and do not read
    # the system one. `certutil` is in `libnss3-tools`.
    echo "dev:trust: Firefox and Chrome keep separate stores; see dev/README.md."
    ;;
  *)
    echo "dev:trust: unsupported platform. The root is at $CERT — trust it by hand." >&2
    exit 1
    ;;
esac

echo "dev:trust: done. Restart the browser for it to take effect."
