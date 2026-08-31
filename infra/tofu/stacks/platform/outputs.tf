output "node_ipv4" {
  description = "Public IPv4 per node. Empty until this stack has a node."
  value       = { for k, s in hcloud_server.node : k => s.ipv4_address }
}

output "node_ipv6" {
  description = "Public IPv6 per node. The mail host's AAAA record comes from here."
  value       = { for k, s in hcloud_server.node : k => s.ipv6_address }
}
