"""Minimal ActiveSync 16.1 client: FolderSync, then a Ping on the inbox.

Usage: eas.py <user> <password> <device-id> <heartbeat-seconds>
Prints timestamps for when the Ping was sent and when (and how) it ended.
"""
import base64, http.client, sys, time

HOST, PORT = "127.0.0.1", 18080
SWITCH, END, STR_I = 0x00, 0x01, 0x03
CONTENT = 0x40


def tag(t, *children):
    out = bytes([t | CONTENT])
    for c in children:
        out += c
    return out + bytes([END])


def s(text):
    return bytes([STR_I]) + text.encode() + b"\x00"


def doc(page, body):
    return bytes([0x03, 0x01, 0x6A, 0x00, SWITCH, page]) + body


def strings(wbxml):
    """Every inline string in document order, enough to read ids and statuses."""
    out, i = [], 4
    while i < len(wbxml):
        b = wbxml[i]
        if b == STR_I:
            j = wbxml.index(0, i + 1)
            out.append(wbxml[i + 1:j].decode(errors="replace"))
            i = j + 1
        elif b == SWITCH:
            i += 2
        else:
            i += 1
    return out


def post(user, pw, device, cmd, body, timeout):
    auth = base64.b64encode(f"{user}:{pw}".encode()).decode()
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    q = f"/Microsoft-Server-ActiveSync?Cmd={cmd}&User={user}&DeviceId={device}&DeviceType=iPhone"
    conn.request("POST", q, body=body, headers={
        "Authorization": "Basic " + auth,
        "MS-ASProtocolVersion": "16.1",
        "Content-Type": "application/vnd.ms-sync.wbxml",
        "User-Agent": "Apple-iPhone17C2/2402.200",
    })
    r = conn.getresponse()
    return r.status, r.read()


def main():
    user, pw, device, hb = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    # FolderHierarchy code page 7: FolderSync 0x16, SyncKey 0x12.
    st, body = post(user, pw, device, "FolderSync", doc(7, tag(0x16, tag(0x12, s("0")))), 30)
    strs = strings(body)
    print(f"FolderSync HTTP {st} strings={strs[:12]}", flush=True)
    # Changes come as ServerId, ParentId, DisplayName, Type; the inbox is Type 2.
    inbox = next(strs[i] for i in range(len(strs) - 3) if strs[i + 2] == "Inbox")
    # AirSync code page 0: Sync 0x05, Collections 0x1C, Collection 0x0F,
    # SyncKey 0x0B, CollectionId 0x12. Prime the inbox so the Ping has a baseline.
    key = "0"
    for _ in range(3):
        st, body = post(user, pw, device, "Sync", doc(0, tag(0x05, tag(0x1C, tag(0x0F, tag(0x0B, s(key)), tag(0x12, s(inbox)))))), 30)
        strs = strings(body)
        key = strs[0] if strs else key
        print(f"Sync HTTP {st} strings={strs[:6]}", flush=True)
    # Ping code page 13: Ping 0x05, HeartbeatInterval 0x08, Folders 0x09,
    # Folder 0x0A, Id 0x0B, Class 0x0C.
    ping = doc(13, tag(0x05, tag(0x08, s(hb)), tag(0x09, tag(0x0A, tag(0x0B, s(inbox)), tag(0x0C, s("Email"))))))
    t0 = time.time()
    print(f"{time.strftime('%H:%M:%S')} Ping sent (heartbeat {hb}s, inbox {inbox})", flush=True)
    try:
        st, body = post(user, pw, device, "Ping", ping, int(hb) + 120)
        print(f"{time.strftime('%H:%M:%S')} Ping ended after {time.time() - t0:.1f}s: HTTP {st} strings={strings(body)} raw={body.hex()}", flush=True)
    except Exception as e:  # noqa: BLE001 - the probe reports whatever happened
        print(f"{time.strftime('%H:%M:%S')} Ping failed after {time.time() - t0:.1f}s: {e!r}", flush=True)
    st, body = post(user, pw, device, "FolderSync", doc(7, tag(0x16, tag(0x12, s("0")))), 30)
    print(f"{time.strftime('%H:%M:%S')} next FolderSync with the same header: HTTP {st}", flush=True)


main()
