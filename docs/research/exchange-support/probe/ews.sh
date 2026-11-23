#!/bin/sh
# ews.sh <user:pass> [impersonate-address]  -> HTTP status + ResponseClass of a GetFolder(inbox)
B=http://127.0.0.1:18080
IMP=""
if [ -n "$2" ]; then
  IMP="<t:ExchangeImpersonation><t:ConnectingSID><t:PrimarySmtpAddress>$2</t:PrimarySmtpAddress></t:ConnectingSID></t:ExchangeImpersonation>"
fi
BODY="<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:t=\"http://schemas.microsoft.com/exchange/services/2006/types\" xmlns:m=\"http://schemas.microsoft.com/exchange/services/2006/messages\"><soap:Header><t:RequestServerVersion Version=\"Exchange2016\"/>$IMP</soap:Header><soap:Body><m:GetFolder><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id=\"inbox\"/></m:FolderIds></m:GetFolder></soap:Body></soap:Envelope>"
curl -s -w '\nHTTP %{http_code}\n' -u "$1" -H 'Content-Type: text/xml; charset=utf-8' --data "$BODY" $B/EWS/Exchange.asmx \
  | grep -oE 'ResponseClass="[A-Za-z]+"|<m:ResponseCode>[A-Za-z]+</m:ResponseCode>|<t:DisplayName>[^<]*</t:DisplayName>|HTTP [0-9]+|<faultstring>[^<]*' | tr '\n' ' '
echo
