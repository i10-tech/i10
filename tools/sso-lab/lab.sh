#!/usr/bin/env bash
# up | down | reset | status | logs [svc] | extras | reset-certs
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "lab.sh: copy .env.example to .env first" >&2; exit 1; }
set -a; . ./.env; set +a
export LDAP_BASE_DN="dc=$(echo "${LAB_DOMAIN:-sso-lab.i10.tech}" | sed 's/\./,dc=/g')"
./certs.sh
c() { docker compose --env-file .env "$@"; }
case "${1:-status}" in
  up)      c up -d --wait "${@:2}"; c exec -T openldap /bin/sh /acl.sh ;;
  extras)  c --profile extras up -d ;;
  down)    c --profile extras down ;;
  reset)   c --profile extras down -v ;;
  reset-certs) rm -rf certs; ./certs.sh ;;
  status)  c --profile extras ps ;;
  logs)    c --profile extras logs --tail=80 "${@:2}" ;;
  *) echo "usage: lab.sh up|extras|down|reset|reset-certs|status|logs" >&2; exit 2 ;;
esac
