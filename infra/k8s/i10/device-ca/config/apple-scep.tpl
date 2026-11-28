{{- /*
  The `apple-scep` provisioner's certificate: the enrollment identity a device
  uses inside one enrollment to sign and decrypt CMS (PR 4). README.md, "The two
  templates".

  CN only and NO SANs: step-ca's default SCEP template copies the CN into a DNS
  SAN. digitalSignature and keyEncipherment, and an explicit EKU of
  emailProtection, never clientAuth: a certificate with no EKU at all would pass
  Go's clientAuth check. cahookrelay's AUTHORIZING hook refuses anything else
  (services/authd/cmd/cahookrelay/body.go).
*/ -}}
{{- if not .Insecure.CR.Subject.CommonName -}}
  {{- fail "apple-scep: the certificate request must carry a CN" -}}
{{- end -}}
{
  "subject": { "commonName": {{ toJson .Insecure.CR.Subject.CommonName }} },
  "keyUsage": ["digitalSignature", "keyEncipherment"],
  "extKeyUsage": ["emailProtection"]
}
