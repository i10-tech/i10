#!/bin/sh
# Can erin@other.test (another "customer") read dave@ldap.test's free/busy?
B=http://127.0.0.1:18080/EWS/Exchange.asmx
NS='xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"'
env() { echo "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope $NS><soap:Header><t:RequestServerVersion Version=\"Exchange2016\"/></soap:Header><soap:Body>$1</soap:Body></soap:Envelope>"; }
ews() { curl -s -u "$1" -H 'Content-Type: text/xml; charset=utf-8' --data "$(env "$2")" $B; }
DAY=$(date -u -v+1d +%Y-%m-%d)

echo "dave creates a busy event 10:00-11:00Z on $DAY: $(ews dave@ldap.test:davepass-1 "<m:CreateItem SendMeetingInvitations=\"SendToNone\"><m:SavedItemFolderId><t:DistinguishedFolderId Id=\"calendar\"/></m:SavedItemFolderId><m:Items><t:CalendarItem><t:Subject>Board meeting: acquisition of ACME</t:Subject><t:Start>${DAY}T10:00:00Z</t:Start><t:End>${DAY}T11:00:00Z</t:End><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus></t:CalendarItem></m:Items></m:CreateItem>" | grep -oE 'ResponseClass="[A-Za-z]+"')"

for who in erin@other.test:erinpass-1 carol@ldap.test:carolpass-1; do
  echo "== $who asks for dave's availability"
  ews "$who" "<m:GetUserAvailabilityRequest><t:TimeZone><t:Bias>0</t:Bias><t:StandardTime><t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>10</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:StandardTime><t:DaylightTime><t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>1</t:DayOrder><t:Month>4</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:DaylightTime></t:TimeZone><m:MailboxDataArray><t:MailboxData><t:Email><t:Address>dave@ldap.test</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType></t:MailboxData></m:MailboxDataArray><t:FreeBusyViewOptions><t:TimeWindow><t:StartTime>${DAY}T00:00:00</t:StartTime><t:EndTime>${DAY}T23:59:59</t:EndTime></t:TimeWindow><t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes><t:RequestedView>DetailedMerged</t:RequestedView></t:FreeBusyViewOptions></m:GetUserAvailabilityRequest>" \
    | sed 's/></>\n</g' | grep -oE '<(t:)?(BusyType|StartTime|EndTime|Subject|MergedFreeBusy|ResponseCode)>[^<]*' | sort -u | tr '\n' ' '
  echo
done
