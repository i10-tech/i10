#!/usr/bin/env bash
# Pushes the ids you created in the i10 console (.env) into the RUNNING lab:
#   Keycloak : SAML client id/ACS/SLO, OIDC back-channel logout URL, LDAP sync
#   authentik: SAML ACS/audience, OIDC back-channel logout, SCIM url + token
# Safe to run again after every change to .env. Needs python3 and curl.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "apply.sh: no .env" >&2; exit 1; }
set -a; . ./.env; set +a
exec python3 - <<'PY'
import json, os, sys, urllib.request, urllib.parse, urllib.error
E = os.environ.get
KC = f"http://127.0.0.1:{E('KEYCLOAK_HTTP_PORT','8180')}"
AK = f"http://127.0.0.1:{E('AUTHENTIK_HTTP_PORT','9100')}"
AUTH, CTR = E('AUTH_ORIGIN'), E('API_ORIGIN_FROM_CONTAINERS')

def call(method, url, body=None, headers=None, form=False):
    data = None
    h = dict(headers or {})
    if body is not None:
        data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
        h.setdefault('Content-Type', 'application/x-www-form-urlencoded' if form else 'application/json')
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} -> {e.code}: {e.read()[:300]!r}")

# ---------------- Keycloak ----------------
def keycloak():
    tok = call('POST', f"{KC}/realms/master/protocol/openid-connect/token",
               {'grant_type': 'password', 'client_id': 'admin-cli',
                'username': E('KEYCLOAK_ADMIN_USER'), 'password': E('KEYCLOAK_ADMIN_PASSWORD')}, form=True)['access_token']
    h = {'Authorization': f'Bearer {tok}'}
    R = f"{KC}/admin/realms/i10-lab"
    clients = call('GET', f"{R}/clients", headers=h)
    oid, sid = E('CONNECTION_ID_KEYCLOAK_OIDC'), E('CONNECTION_ID_KEYCLOAK_SAML')
    if oid:
        c = next(c for c in clients if c['clientId'] == E('KEYCLOAK_OIDC_CLIENT_ID'))
        c = call('GET', f"{R}/clients/{c['id']}", headers=h)
        c['attributes']['backchannel.logout.url'] = f"{CTR}/sso/oidc/backchannel/{oid}"
        c['secret'] = E('KEYCLOAK_OIDC_CLIENT_SECRET')
        call('PUT', f"{R}/clients/{c['id']}", c, h)
        print(f"keycloak: OIDC back-channel logout -> {CTR}/sso/oidc/backchannel/{oid}")
    if sid:
        c = next(c for c in clients if c['clientId'].startswith(f"{AUTH}/sso/saml/metadata/"))
        c = call('GET', f"{R}/clients/{c['id']}", headers=h)
        c['clientId'] = f"{AUTH}/sso/saml/metadata/{sid}"
        c['redirectUris'] = [f"{AUTH}/sso/saml/acs/{sid}"]
        a = c['attributes']
        a['saml_assertion_consumer_url_post'] = f"{AUTH}/sso/saml/acs/{sid}"
        a['saml_single_logout_service_url_post'] = f"{AUTH}/sso/saml/slo/{sid}"
        a['saml_single_logout_service_url_redirect'] = f"{AUTH}/sso/saml/slo/{sid}"
        call('PUT', f"{R}/clients/{c['id']}", c, h)
        print(f"keycloak: SAML client -> {c['clientId']}")
    comps = call('GET', f"{R}/components?type=org.keycloak.storage.UserStorageProvider", headers=h)
    for comp in comps:
        res = call('POST', f"{R}/user-storage/{comp['id']}/sync?action=triggerFullSync", headers=h)
        print("keycloak: LDAP full sync:", res)

# ---------------- authentik ----------------
def authentik():
    h = {'Authorization': f"Bearer {E('AUTHENTIK_BOOTSTRAP_TOKEN')}"}
    A = f"{AK}/api/v3"
    def one(kind, name):
        r = call('GET', f"{A}/providers/{kind}/?name={urllib.parse.quote(name)}", headers=h)['results']
        if not r: sys.exit(f"authentik: provider {name!r} not found - are the blueprints applied?")
        return r[0]
    sid, oid = E('CONNECTION_ID_AUTHENTIK_SAML'), E('CONNECTION_ID_AUTHENTIK_OIDC')
    if sid:
        p = one('saml', 'i10 lab SAML')
        call('PATCH', f"{A}/providers/saml/{p['pk']}/", {
            'acs_url': f"{AUTH}/sso/saml/acs/{sid}", 'audience': f"{AUTH}/sso/saml/metadata/{sid}"}, h)
        print("authentik: SAML ACS/audience set for", sid)
        print(f"authentik: SAML metadata URL (paste into i10): https://ak.lab.localhost:{E('AUTHENTIK_HTTPS_PORT','9443')}/api/v3/providers/saml/{p['pk']}/metadata/?download")
    if oid:
        p = one('oauth2', 'i10 lab OIDC')
        call('PATCH', f"{A}/providers/oauth2/{p['pk']}/", {
            'logout_uri': f"{CTR}/sso/oidc/backchannel/{oid}", 'logout_method': 'backchannel'}, h)
        print("authentik: OIDC back-channel logout ->", f"{CTR}/sso/oidc/backchannel/{oid}")
    if E('DIRECTORY_ID') and E('SCIM_TOKEN'):
        p = one('scim', 'i10 lab SCIM')
        call('PATCH', f"{A}/providers/scim/{p['pk']}/", {
            'url': f"{CTR}/scim/v2/{E('DIRECTORY_ID')}", 'token': E('SCIM_TOKEN')}, h)
        print("authentik: SCIM ->", f"{CTR}/scim/v2/{E('DIRECTORY_ID')}")
        print('authentik: now run the sync: admin UI > Providers > i10 lab SCIM > Run sync')

keycloak()
authentik()
PY
