output "labels" {
  description = "The standard i10 label map, sanitised to Hetzner's constraints."
  value       = local.labels
}

output "name_prefix" {
  description = "Canonical resource name prefix: i10-<env>-<role>. Append -<nn> for plural resources."
  value       = "i10-${var.env}-${var.role}"
}

output "comment" {
  description = "One-line provenance string for providers with a free-form comment rather than labels — Cloudflare DNS, for one."
  value       = "i10:tofu:${var.stack}:${var.env}"
}
