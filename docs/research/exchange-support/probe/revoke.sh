#!/bin/sh
# revoke.sh <mode>   mode = directory | invalidate
#   directory:  dave is deleted from LDAP (what authd refusing every bind looks like to Stalwart)
#   invalidate: the same, then Stalwart's InvalidateCaches action
# Holds an ActiveSync Ping, an EWS streaming GetStreamingEvents and a JMAP
# EventSource open as dave, revokes, then writes to dave's inbox with the same
# header, and records what each long-lived request does.
cd "$(dirname "$0")"
MODE=$1
OUT=/tmp/exch-probe/revoke-$MODE
rm -rf "$OUT"; mkdir -p "$OUT"
B=http://127.0.0.1:18080
U=dave@ldap.test:davepass-1
NS='xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"'
env() { echo "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope $NS><soap:Header><t:RequestServerVersion Version=\"Exchange2016\"/></soap:Header><soap:Body>$1</soap:Body></soap:Envelope>"; }
ews() { curl -s -u "$1" -H 'Content-Type: text/xml; charset=utf-8' --data "$(env "$2")" $B/EWS/Exchange.asmx; }
ts() { date +%H:%M:%S; }

python3 -I dir.py restore; docker restart exch-ldap >/dev/null
python3 -I admin.py raw '[["x:Action/set",{"create":{"r":{"@type":"InvalidateCaches"}}},"a"]]' >/dev/null
sleep 2

SUB=$(ews $U '<m:Subscribe><m:StreamingSubscriptionRequest><t:FolderIds><t:DistinguishedFolderId Id="inbox"/></t:FolderIds><t:EventTypes><t:EventType>NewMailEvent</t:EventType><t:EventType>CreatedEvent</t:EventType></t:EventTypes></m:StreamingSubscriptionRequest></m:Subscribe>' | grep -oE '<m:SubscriptionId>[^<]+' | cut -d'>' -f2)
echo "$(ts) EWS subscription $SUB" | tee "$OUT/summary"

echo "$(ts) carol using dave's subscription id: $(ews carol@ldap.test:carolpass-1 "<m:GetStreamingEvents><m:SubscriptionIds><t:SubscriptionId>$SUB</t:SubscriptionId></m:SubscriptionIds><m:ConnectionTimeout>1</m:ConnectionTimeout></m:GetStreamingEvents>" | grep -oE 'ResponseCode>[A-Za-z]+|faultstring[^<]*' | head -2 | tr '\n' ' ')" | tee -a "$OUT/summary"

( curl -sN -u $U -H 'Content-Type: text/xml; charset=utf-8' --max-time 200 \
    --data "$(env "<m:GetStreamingEvents><m:SubscriptionIds><t:SubscriptionId>$SUB</t:SubscriptionId></m:SubscriptionIds><m:ConnectionTimeout>3</m:ConnectionTimeout></m:GetStreamingEvents>")" \
    $B/EWS/Exchange.asmx -w '\n[curl ended %{http_code} after %{time_total}s]\n' | while IFS= read -r l; do echo "$(ts) $l"; done > "$OUT/ews-stream" ) &
( curl -sN -u $U --max-time 200 "$B/jmap/eventsource/?types=*&closeafter=no&ping=10" -w '\n[curl ended %{http_code} after %{time_total}s]\n' | while IFS= read -r l; do echo "$(ts) $l"; done > "$OUT/eventsource" ) &
( python3 -I eas.py dave@ldap.test davepass-1 REVOKE$MODE 120 > "$OUT/eas-ping" 2>&1 ) &
sleep 6

echo "$(ts) REVOKE: dave deleted from the directory" | tee -a "$OUT/summary"
python3 -I dir.py delete dave; docker restart exch-ldap >/dev/null
if [ "$MODE" = invalidate ]; then
  python3 -I admin.py raw '[["x:Action/set",{"create":{"r":{"@type":"InvalidateCaches"}}},"a"]]' >/dev/null
  echo "$(ts) InvalidateCaches sent" | tee -a "$OUT/summary"
fi
sleep 4
echo "$(ts) CreateItem in dave's inbox with dave's header: $(ews $U '<m:CreateItem MessageDisposition="SaveOnly"><m:SavedItemFolderId><t:DistinguishedFolderId Id="inbox"/></m:SavedItemFolderId><m:Items><t:Message><t:Subject>written after revocation</t:Subject><t:Body BodyType="Text">x</t:Body></t:Message></m:Items></m:CreateItem>' | grep -oE 'ResponseClass="[A-Za-z]+"' ; curl -s -o /dev/null -w 'HTTP %{http_code}' -u $U -H 'Content-Type: text/xml' --data x $B/EWS/Exchange.asmx)" | tee -a "$OUT/summary"
echo "$(ts) fresh sign-in with dave's password and a new header form: $(curl -s -o /dev/null -w 'HTTP %{http_code}' -u 'X\dave@ldap.test:davepass-1' -H 'Content-Type: text/xml' --data x $B/EWS/Exchange.asmx)" | tee -a "$OUT/summary"
sleep 70
echo "$(ts) 80 s after revocation, same header, GetFolder: $(ews $U '<m:GetFolder><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>' | grep -oE 'ResponseClass="[A-Za-z]+"|<t:TotalCount>[0-9]+' | tr '\n' ' ')" | tee -a "$OUT/summary"
wait
