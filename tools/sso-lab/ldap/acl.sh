#!/bin/sh
# Lets cn=svc-i10 read ou=people and ou=groups (osixia's default ACL hides
# them from everyone but the admin). Run inside the openldap container over ldapi;
# idempotent. Called by lab.sh up.
set -eu
BASE_DN="dc=$(echo "$LAB_DOMAIN" | sed 's/\./,dc=/g')"
DB=$(ldapsearch -Y EXTERNAL -H ldapi:/// -b cn=config "(olcSuffix=$BASE_DN)" dn 2>/dev/null | sed -n 's/^dn: //p' | head -1)
if ldapsearch -Y EXTERNAL -H ldapi:/// -b "$DB" -s base olcAccess 2>/dev/null | grep -q svc-i10; then exit 0; fi
ldapmodify -Y EXTERNAL -H ldapi:/// >/dev/null 2>&1 <<LDIF
dn: $DB
changetype: modify
add: olcAccess
olcAccess: {0}to dn.subtree="$BASE_DN" by dn.exact="cn=svc-i10,ou=service,$BASE_DN" read by * break
LDIF
echo "ldap: svc-i10 read ACL added"
