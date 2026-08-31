output "state_bucket" {
  description = "Bucket name to put in every other stack's backend.hcl."
  value       = cloudflare_r2_bucket.tofu_state.name
}

output "s3_endpoint" {
  description = "R2's S3 endpoint. NOTE the account-level form with no bucket suffix — the per-bucket URL the dashboard shows doubles the path if pasted whole."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
