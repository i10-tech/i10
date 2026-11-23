#!/bin/sh
# Does Stalwart's HTTP auth cache keep an LDAP account signed in after the
# directory changes its password or deletes it? Counts the binds glauth logs.
cd "$(dirname "$0")"
CFG=/tmp/exch-probe/ldap2/probe.cfg
binds() { docker logs exch-ldap 2>&1 | grep -c "Bind request.*cn=dave"; }
reload() { docker restart exch-ldap >/dev/null; sleep 2; }  # hot reload does not follow sed -i; restart is unambiguous

echo "t0  dave pw1:              $(./ews.sh 'dave@ldap.test:davepass-1') binds=$(binds)"
echo "t1  dave pw1 again:        $(./ews.sh 'dave@ldap.test:davepass-1') binds=$(binds)"

# 1. Password change in the directory.
NEW=$(printf 'davepass-2' | shasum -a 256 | cut -d' ' -f1)
OLD=$(printf 'davepass-1' | shasum -a 256 | cut -d' ' -f1)
sed -i '' "s/$OLD/$NEW/" "$CFG"; reload
echo "t2  after pw change, pw1:  $(./ews.sh 'dave@ldap.test:davepass-1') binds=$(binds)"
echo "t3  after pw change, pw2:  $(./ews.sh 'dave@ldap.test:davepass-2') binds=$(binds)"

# 2. Account deleted from the directory.
python3 - "$CFG" <<'EOF'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'\[\[users\]\]\n  name = "dave".*?(?=\[\[)', '', s, flags=re.S)
open(p, "w").write(s)
EOF
reload
echo "t4  after delete, pw1:     $(./ews.sh 'dave@ldap.test:davepass-1') binds=$(binds)"
echo "t5  after delete, pw2:     $(./ews.sh 'dave@ldap.test:davepass-2') binds=$(binds)"

# 3. Stalwart's InvalidateCaches action.
python3 -I admin.py raw '[["x:Action/set",{"create":{"r":{"@type":"InvalidateCaches"}}},"a"]]' >/dev/null
echo "t6  after InvalidateCaches, pw1: $(./ews.sh 'dave@ldap.test:davepass-1') binds=$(binds)"
echo "t7  after InvalidateCaches, pw2: $(./ews.sh 'dave@ldap.test:davepass-2') binds=$(binds)"
