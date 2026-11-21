# Mail device-binding probe

> Warning: this is research code. Never expose it beyond a lab network. Production (#383) must verify the signer chain and the one-time challenge on every enrollment request, as this version now does: phase 2 must chain to Apple Root CA, phase 3 to the step CA root, the challenge is single-use with a 10-minute expiry and is bound to the device serial, and the phase 3 certificate CN must equal that serial. One hole remains here and must not reach production: the SCEP challenge is one static string (`scep-challenge.txt`) handed to every device that passes phase 2, so the owner of any real Apple device could use it to get a step CA certificate for a key outside the Secure Enclave and receive a code they can copy. Production needs a per-enrollment SCEP challenge, single-use and bound to the serial.

The throwaway server behind `../../mail-device-binding.md`. Not product code; it is kept so the next round (Outlook, Android) can rerun it.

- `pki.sh` also downloads Apple Root CA (pinned by fingerprint) to `pki/apple-root.pem`. It makes a name-constrained test CA, a server certificate for `*.192-168-1-45.sslip.io` and client certificates. Edit the LAN address in it, `main.go`, `ota.go` and `acmeproxy.go` first.
- `go build -o probe . && ./probe "$PWD"` serves IMAP on 9993 (asks for a client certificate) and 9994 (requires one), SMTP on 9465, 9466 and 9587 (STARTTLS), profiles on http 9080, the enrollment endpoint on https 9443 and an HTTPS front for step-ca's ACME on 9444. Every event goes to `events.jsonl`.
- The enrollment flow needs step-ca on `127.0.0.1:9000` (insecure address `:9001` for SCEP) with an `apple-acme` ACME provisioner (`--challenge device-attest-01 --attestation-format apple`) and a `scep` provisioner whose challenge is in `scep-challenge.txt`.
- Remove the test CA from every device's trust store when done.
