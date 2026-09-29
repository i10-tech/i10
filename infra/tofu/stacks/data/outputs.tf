output "zone_id" {
  description = "i10.tech zone id, consumed by stacks/dns."
  value       = data.cloudflare_zone.i10_tech.zone_id
}

output "files_bucket" {
  value = cloudflare_r2_bucket.files.name
}

output "backups_bucket" {
  description = "Where CNPG's Barman archives. The ObjectStore writes to s3://<this>/cnpg."
  value       = cloudflare_r2_bucket.backups.name
}

output "content_bucket" {
  description = "Message content (attachments, later bodies). Private; read only through the API."
  value       = cloudflare_r2_bucket.content.name
}

output "content_dev_bucket" {
  value = cloudflare_r2_bucket.content_dev.name
}
