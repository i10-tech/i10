"""Edit the glauth directory: dir.py restore | dir.py delete <user> | dir.py pw <user> <password>.
The caller restarts glauth afterwards (hot reload is not reliable)."""
import hashlib, re, sys

P = "/tmp/exch-probe/ldap2/probe.cfg"
USERS = {"carol": ("carolpass-1", 5001, "ldap.test"), "dave": ("davepass-1", 5002, "ldap.test"), "erin": ("erinpass-1", 5003, "other.test")}


def h(x):
    return hashlib.sha256(x.encode()).hexdigest()


def block(name, pw, uid, dom):
    return (f'[[users]]\n  name = "{name}"\n  mail = "{name}@{dom}"\n'
            f'  uidnumber = {uid}\n  primarygroup = 5501\n  passsha256 = "{h(pw)}"\n')


s = open(P).read()
cmd = sys.argv[1]
if cmd in ("delete", "pw", "restore"):
    for name in USERS:
        s = re.sub(r'\[\[users\]\]\n  name = "%s".*?(?=\[\[)' % name, "", s, flags=re.S)
    keep = {n: v for n, v in USERS.items() if not (cmd == "delete" and n == sys.argv[2])}
    if cmd == "pw":
        keep[sys.argv[2]] = (sys.argv[3],) + USERS[sys.argv[2]][1:]
    s = s.replace("[[groups]]", "".join(block(n, *v) for n, v in keep.items()) + "[[groups]]", 1)
open(P, "w").write(s)
