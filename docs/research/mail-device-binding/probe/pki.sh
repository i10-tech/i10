#!/bin/bash
# Throwaway CA, name-constrained so it can only ever vouch for the probe names.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p pki serve
cd pki
P12PASS=$(openssl rand -hex 8)
echo -n "$P12PASS" > p12pass.txt

cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = i10 throwaway probe CA (delete me)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:192-168-1-45.sslip.io, permitted;IP:192.168.1.45/255.255.255.255, permitted;IP:127.0.0.1/255.255.255.255, permitted;email:i10.test
EOF
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 7 -config ca.cnf

cat > server.ext <<'EOF'
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:192-168-1-45.sslip.io, DNS:*.192-168-1-45.sslip.io, IP:192.168.1.45, IP:127.0.0.1
EOF
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=192-168-1-45.sslip.io"
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 7 -extfile server.ext

for name in mac iphone outlook thunderbird; do
  cat > "client-$name.ext" <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth, emailProtection
subjectAltName = email:probe-$name@i10.test
EOF
  openssl req -newkey rsa:2048 -nodes -keyout "client-$name.key" -out "client-$name.csr" -subj "/CN=i10-probe-$name/emailAddress=probe-$name@i10.test"
  openssl x509 -req -in "client-$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -out "client-$name.pem" -days 7 -extfile "client-$name.ext"
  openssl pkcs12 -export -inkey "client-$name.key" -in "client-$name.pem" -certfile ca.pem \
    -name "i10 probe $name" -out "client-$name.p12" -passout "pass:$P12PASS" \
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
done
rm -f ./*.csr
echo "pki ready"
