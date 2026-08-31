variable "cloudflare_account_id" {
  description = "Cloudflare account id. An identifier, not a credential — it appears in every R2 S3 URL."
  type        = string
}

variable "state_bucket_name" {
  description = "R2 bucket holding every i10 stack's OpenTofu state."
  type        = string
  default     = "i10-tofu-state"
}

variable "r2_location" {
  description = "R2 location hint. eea keeps state in the same jurisdiction as the estate."
  type        = string
  default     = "eeur"
}
