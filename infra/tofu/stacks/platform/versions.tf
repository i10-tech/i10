terraform {
  required_version = ">= 1.10.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
  }

  # Partial config — the rest comes from backend.hcl, because a backend block
  # cannot take variables and the account id is environment-specific.
  #   tofu init -backend-config=backend.hcl
  backend "s3" {}

  # Encryption is configured through TF_ENCRYPTION, never here: an HCL
  # encryption block cannot read variables, so anything written here would be a
  # committed passphrase.
  #
  # ⚠ TF_ENCRYPTION needs an UNQUOTED heredoc delimiter, so the shell
  # interpolates the passphrase, and one attribute per line. Written on one
  # line, `state { method = … enforced = true }` is invalid HCL and fails with
  # an error that never mentions encryption.
}
