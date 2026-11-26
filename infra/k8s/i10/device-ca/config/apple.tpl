{{- /*
  The `apple` ACME provisioner's certificate: a Mac's Secure Enclave key,
  attested by device-attest-01. README.md, "The two templates".

  CN is the order's one permanent identifier, which the challenge checked
  against Apple's attestation. step-ca's `apple` format accepts the serial OR
  the UDID there (acme/challenge.go); the API binds only when it equals the
  permit's serial, so PR 4's payload must name the serial. The CSR's one OU is the
  permit's nonce. The permanent identifier is the only SAN: never the CSR's DNS
  names. clientAuth only. The API's AUTHORIZING hook refuses anything else
  (apps/api/src/ca-hooks/body.ts).
*/ -}}
{{- if ne (len .SANs) 1 -}}
  {{- fail "apple: an order for exactly one attested permanent identifier is required" -}}
{{- end -}}
{{- if ne (index .SANs 0).Type "permanentIdentifier" -}}
  {{- fail "apple: an order for exactly one attested permanent identifier is required" -}}
{{- end -}}
{{- if ne (len .Insecure.CR.Subject.OrganizationalUnit) 1 -}}
  {{- fail "apple: the certificate request must carry exactly one OU" -}}
{{- end -}}
{
  "subject": {
    "commonName": {{ toJson (index .SANs 0).Value }},
    "organizationalUnit": {{ toJson .Insecure.CR.Subject.OrganizationalUnit }}
  },
  "sans": [{ "type": "permanentIdentifier", "value": {{ toJson (index .SANs 0).Value }} }],
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["clientAuth"]
}
