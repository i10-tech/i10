#!/bin/sh
# Three EWS requests on ONE TCP connection: alice, then no Authorization, then bob.
# Each answer's mailbox owner is read with ResolveNames-free GetFolder + the
# EWS "msgfolderroot" parent id, which embeds the account. Simpler: compare the
# inbox FolderId the server returns, which is per account.
B=http://127.0.0.1:18080/EWS/Exchange.asmx
BODY='<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2016"/></soap:Header><soap:Body><m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder></soap:Body></soap:Envelope>'
curl -sv -H 'Content-Type: text/xml' --data "$BODY" -u alice@probe.test:alicepass-1 $B -w '\n[1 alice] HTTP %{http_code}\n' \
  --next -H 'Content-Type: text/xml' --data "$BODY" $B -w '\n[2 none] HTTP %{http_code}\n' \
  --next -H 'Content-Type: text/xml' --data "$BODY" -u bob@probe.test:bobpass-1 $B -w '\n[3 bob] HTTP %{http_code}\n' \
  2>&1 | grep -oE 'Re-using existing[^\r]*|Connected to[^\r]*|FolderId Id="[^"]{0,40}|\[[0-9] [a-z]+\] HTTP [0-9]+'
