#!/usr/bin/env bash
# Makes the lab CA and one leaf certificate under tools/sso-lab/certs/.
# Idempotent: does nothing if they exist. ./lab.sh reset-certs forces a redo.
#
# i10 verifies every IdP, S3 and webhook certificate against the system roots
# (or a pinned CA for LDAP). Run the API with NODE_EXTRA_CA_CERTS pointing at
# certs/lab-ca.crt so Bun trusts this CA; paste the same PEM into the LDAP
# connection's "pinned CA" box.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
[ -f certs/lab.crt ] && exit 0

# ⚠ NAME-CONSTRAINED, BECAUSE YOU TRUST THIS CA IN A BROWSER AND ITS KEY SITS
# ON DISK. Even if the key leaks it can only vouch for the lab's own host
# names, never for a real site. No fallback without the constraint: fail.
#
# ⚠ DNS CONSTRAINTS ONLY. Bun's BoringSSL refuses a CA with IP constraints
# (`UNSUPPORTED_CONSTRAINT_TYPE`, measured 2026-10-31) and then trusts none of
# its certificates, so the API could reach no lab IdP. Without one the CA could
# still sign for an IP address, so its key is 600: only you can use it.
NAME_CONSTRAINTS="permitted;DNS:lab.localhost,permitted;DNS:localhost,permitted;DNS:openldap,permitted;DNS:keycloak,permitted;DNS:authentik-server,permitted;DNS:minio"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
  -keyout certs/lab-ca.key -out certs/lab-ca.crt \
  -subj "/CN=i10 SSO lab CA (throwaway)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "nameConstraints=critical,${NAME_CONSTRAINTS}"

cat > certs/leaf.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:*.lab.localhost,DNS:lab.localhost,DNS:localhost,DNS:openldap,DNS:keycloak,DNS:authentik-server,DNS:minio,IP:127.0.0.1,IP:::1
EXT
openssl req -newkey rsa:2048 -nodes -keyout certs/lab.key -out certs/lab.csr -subj "/CN=*.lab.localhost" 2>/dev/null
openssl x509 -req -in certs/lab.csr -CA certs/lab-ca.crt -CAkey certs/lab-ca.key -CAcreateserial \
  -out certs/lab.crt -days 825 -sha256 -extfile certs/leaf.ext 2>/dev/null
# The containers run as assorted users and read the leaf key; only certs.sh,
# on this machine, needs the CA key.
chmod 644 certs/lab.key
chmod 600 certs/lab-ca.key
rm -f certs/lab.csr certs/leaf.ext certs/lab-ca.srl
echo "certs: made certs/lab-ca.crt and certs/lab.crt"
