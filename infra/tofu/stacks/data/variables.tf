variable "cloudflare_account_id" {
  description = "Cloudflare account id. An identifier, not a credential."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone id for i10.tech. Public identifier; authenticates nothing."
  type        = string
}

variable "r2_location" {
  description = "R2 location hint."
  type        = string
  default     = "eeur"
}
