#!/bin/sh
# Renders the seed LDIF from the environment, then hands over to osixia's init.
# The base DN comes from LAB_DOMAIN (sso-lab.i10.tech -> dc=sso-lab,dc=i10,dc=tech).
set -eu
BASE_DN="dc=$(echo "$LAB_DOMAIN" | sed 's/\./,dc=/g')"
OUT=/container/service/slapd/assets/config/bootstrap/ldif/custom
mkdir -p "$OUT"
sed -e "s|@BASE_DN@|$BASE_DN|g" \
    -e "s|@LAB_DOMAIN@|$LAB_DOMAIN|g" \
    -e "s|@USER_PASSWORD@|$LAB_USER_PASSWORD|g" \
    -e "s|@SERVICE_PASSWORD@|$LDAP_SERVICE_PASSWORD|g" \
    /seed/seed.ldif.tpl > "$OUT/50-seed.ldif"
exec /container/tool/run --copy-service "$@"
