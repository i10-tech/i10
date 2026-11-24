#!/bin/sh
# Every Autodiscover form an Exchange client sends, as it would arrive on
# autodiscover.<customer domain> (the Host header), against Stalwart 1.2.0 with
# STALWART_PUBLIC_URL=https://mail.i10.test.
B=http://127.0.0.1:18080
U=someone@customer-domain.test:someonepass-1
H='Host: autodiscover.customer-domain.test'
OUTLOOK='<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>ADDR</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>'
MOBILE='<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006"><Request><EMailAddress>ADDR</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema></Request></Autodiscover>'
pick() { sed 's/></>\n</g' | grep -oE '<Protocol Type="[^"]+"|<Type>[^<]+|<(EwsUrl|ASUrl|OABUrl|Url|Server|ExternalUrl|AutoDiscoverSMTPAddress|ErrorCode|Message|Action|RedirectAddr|RedirectUrl)>[^<]*|"(Protocol|Url)":"[^"]*"' | sort -u | tr '\n' ' '; echo; }

echo "== 1 classic Outlook, POX, anonymous (first try, before the password)"
curl -s -o /dev/null -w '%{http_code} %header{www-authenticate}\n' -H "$H" -H 'Content-Type: text/xml' --data "$(echo "$OUTLOOK" | sed s/ADDR/someone@customer-domain.test/)" $B/autodiscover/autodiscover.xml
for path in /autodiscover/autodiscover.xml /Autodiscover/Autodiscover.xml /AutoDiscover/AutoDiscover.xml; do
  echo "== 2 classic Outlook, POX, with X-MapiHttpCapability, $path"
  curl -s -u $U -H "$H" -H 'Content-Type: text/xml' -H 'X-MapiHttpCapability: 1' --data "$(echo "$OUTLOOK" | sed s/ADDR/someone@customer-domain.test/)" $B$path | pick
done
echo "== 3 Outlook POX without X-MapiHttpCapability (EWS clients that use POX)"
curl -s -u $U -H "$H" -H 'Content-Type: text/xml' --data "$(echo "$OUTLOOK" | sed s/ADDR/someone@customer-domain.test/)" $B/autodiscover/autodiscover.xml | pick
echo "== 4 POX for the account's alias sales@ (address typed differs from the login)"
curl -s -u $U -H "$H" -H 'Content-Type: text/xml' -H 'X-MapiHttpCapability: 1' --data "$(echo "$OUTLOOK" | sed s/ADDR/sales@customer-domain.test/)" $B/autodiscover/autodiscover.xml | pick
echo "== 5 POX with the address in capitals"
curl -s -u 'SOMEONE@Customer-Domain.test:someonepass-1' -H "$H" -H 'Content-Type: text/xml' -H 'X-MapiHttpCapability: 1' --data "$(echo "$OUTLOOK" | sed s/ADDR/SOMEONE@Customer-Domain.test/)" $B/autodiscover/autodiscover.xml | pick
echo "== 6 iPhone / Android, mobilesync schema"
curl -s -u $U -H "$H" -H 'Content-Type: text/xml' -H 'User-Agent: Apple-iPhone17C2/2402.200' --data "$(echo "$MOBILE" | sed s/ADDR/someone@customer-domain.test/)" $B/autodiscover/autodiscover.xml | pick
echo "== 7 iPhone 'Sign In' path: Microsoft 365 redirects here, JSON with ?Email=&Protocol=ActiveSync&RedirectCount=1"
curl -s -H "$H" "$B/autodiscover/autodiscover.json?Email=someone%40customer-domain.test&Protocol=ActiveSync&RedirectCount=1" -w ' [%{http_code}]'; echo
echo "== 8 Outlook for Mac, JSON v1.0 path form"
for p in AutodiscoverV1 Ews ActiveSync; do curl -s -H "$H" "$B/autodiscover/autodiscover.json/v1.0/someone@customer-domain.test?Protocol=$p" -w " [%{http_code}]"; echo; done
echo "== 9 SOAP GetUserSettings (EWS clients that use SOAP Autodiscover)"
SOAP='<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:a="http://schemas.microsoft.com/exchange/2010/Autodiscover" xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><a:RequestedServerVersion>Exchange2013</a:RequestedServerVersion><wsa:Action>http://schemas.microsoft.com/exchange/2010/Autodiscover/Autodiscover/GetUserSettings</wsa:Action><wsa:To>https://autodiscover.customer-domain.test/autodiscover/autodiscover.svc</wsa:To></soap:Header><soap:Body><a:GetUserSettingsRequestMessage><a:Request><a:Users><a:User><a:Mailbox>someone@customer-domain.test</a:Mailbox></a:User></a:Users><a:RequestedSettings><a:Setting>ExternalEwsUrl</a:Setting><a:Setting>UserDisplayName</a:Setting></a:RequestedSettings></a:Request></a:GetUserSettingsRequestMessage></soap:Body></soap:Envelope>'
curl -s -u $U -H "$H" -H 'Content-Type: text/xml; charset=utf-8' -H 'SOAPAction: "http://schemas.microsoft.com/exchange/2010/Autodiscover/Autodiscover/GetUserSettings"' --data "$SOAP" $B/autodiscover/autodiscover.svc | sed 's/></>\n</g' | grep -oE '<(a:)?(Name|Value|ErrorCode)>[^<]*' | tr '\n' ' '; echo
echo "== 10 a GET with credentials (what an Outlook HTTP-redirect probe would hit)"
curl -s -u $U -H "$H" $B/autodiscover/autodiscover.xml | pick
echo "== 11 someone asking for bob's settings"
curl -s -u $U -H "$H" -H 'Content-Type: text/xml' --data "$(echo "$OUTLOOK" | sed s/ADDR/bob@customer-domain.test/)" $B/autodiscover/autodiscover.xml | pick
