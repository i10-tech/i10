# Mail device-binding probe

The throwaway server behind `../../mail-device-binding.md`. Not product code; it is kept so the next round (Outlook, Android) can rerun it.

- `pki.sh` makes a name-constrained test CA, a server certificate for `*.192-168-1-45.sslip.io` and client certificates. Edit the LAN address in it, `main.go`, `ota.go` and `acmeproxy.go` first.
- `go build -o probe . && ./probe "$PWD"` serves IMAP on 9993 (asks for a client certificate) and 9994 (requires one), SMTP on 9465, 9466 and 9587 (STARTTLS), profiles on http 9080, the enrollment endpoint on https 9443 and an HTTPS front for step-ca's ACME on 9444. Every event goes to `events.jsonl`.
- The enrollment flow needs step-ca on `127.0.0.1:9000` (insecure address `:9001` for SCEP) with an `apple-acme` ACME provisioner (`--challenge device-attest-01 --attestation-format apple`) and a `scep` provisioner whose challenge is in `scep-challenge.txt`.
- Remove the test CA from every device's trust store when done.
