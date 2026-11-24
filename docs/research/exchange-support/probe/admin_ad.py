"""Minimal Stalwart 1.2 admin client for the local Exchange probe (loopback only)."""
import base64, json, sys, urllib.request

BASE = "http://127.0.0.1:18080"
AUTH = "Basic " + base64.b64encode(b"admin:probeadminpass").decode()
USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]


def jmap(calls, created=None):
    body = {"using": USING, "methodCalls": calls}
    if created:
        body["createdIds"] = created
    req = urllib.request.Request(BASE + "/jmap", data=json.dumps(body).encode(), method="POST")
    req.add_header("Authorization", AUTH)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def setobj(obj, **args):
    r = jmap([[f"x:{obj}/set", args, "s"]])
    print(json.dumps(r["methodResponses"][0][1], indent=None)[:800])
    return r["methodResponses"][0][1]


def get(obj, ids=None):
    r = jmap([[f"x:{obj}/get", {"ids": ids, "properties": None}, "g"]])
    return r["methodResponses"][0][1]


def query(obj):
    r = jmap([[f"x:{obj}/query", {"filter": {}}, "q"]])
    return r["methodResponses"][0][1].get("ids", [])


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "setup":
        if not query("Domain"): setobj("Domain", create={"d": {"name": "customer-domain.test", "enable": True}})
        dom = query("Domain")[0]
        for user, pw in (("someone", "someonepass-1"), ("bob", "bobpass-1")):
            setobj("Account", create={user: {
                "@type": "User", "name": user, "domainId": dom,
                "credentials": {"0": {"@type": "Password", "secret": pw}},
            }})
        setobj("Exchange", update={"singleton": {"enable": True}})
        jmap([["x:Action/set", {"create": {"r": {"@type": "ReloadSettings"}}}, "a"]])
    elif cmd == "get":
        print(json.dumps(get(sys.argv[2], sys.argv[3:] or None), indent=1)[:4000])
    elif cmd == "query":
        print(query(sys.argv[2]))
    elif cmd == "raw":
        print(json.dumps(jmap(json.loads(sys.argv[2])), indent=1)[:4000])
