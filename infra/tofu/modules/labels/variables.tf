variable "env" {
  description = "Environment this resource belongs to: prod, global, or preview-<pr-number>."
  type        = string

  validation {
    condition     = can(regex("^(prod|global|preview-[0-9]+)$", var.env))
    error_message = "env must be prod, global, or preview-<pr-number>."
  }
}

variable "stack" {
  description = "Which stratum owns this resource. Determines blast radius, so it is not a free-text field."
  type        = string

  validation {
    condition     = contains(["bootstrap", "data", "platform", "dns", "preview"], var.stack)
    error_message = "stack must be one of: bootstrap, data, platform, dns, preview."
  }
}

variable "role" {
  description = "Node role for compute, or 'none' for resources that are not a machine."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["mail", "app", "none"], var.role)
    error_message = "role must be one of: mail, app, none."
  }
}

variable "durable" {
  description = "True if losing this resource is unrecoverable, or if its identity must survive a full rebuild. Set it honestly — the delete guard reads it."
  type        = bool
  default     = false
}
