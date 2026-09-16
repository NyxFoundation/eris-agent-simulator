variable "cherry_api_key" {
  description = "Cherry Servers API key. Prefer the CHERRY_API_KEY environment variable."
  type        = string
  sensitive   = true
  default     = null
}

variable "project_id" {
  description = "Cherry Servers project id (a number, from the client portal)."
  type        = number
}

variable "region" {
  description = "Region slug. JP-Tokyo keeps the practice RPC in Japan (ASCON docs/27 §2.2)."
  type        = string
  default     = "JP-Tokyo"
}

variable "plan" {
  description = <<-EOT
    Plan slug. amd-ryzen-9700x is the recommendation: the block budget is bound by single-thread
    speed, and in Tokyo the higher-core EPYC plans all clock LOWER (docs/27 §3.2).
    Fallback if 8 cores cannot hold 2s blocks: amd-ryzen-9950x (16c, also in Tokyo).
  EOT
  type        = string
  default     = "amd-ryzen-9700x"
}

variable "image" {
  description = "OS image slug. bootstrap.sh targets Ubuntu 24.04."
  type        = string
  default     = "ubuntu_24_04_64bit"
}

variable "cycle" {
  description = "Billing cycle slug: hourly or monthly. Break-even is ~583 h (~24 days)."
  type        = string
  default     = "hourly"
  validation {
    condition     = contains(["hourly", "monthly"], var.cycle)
    error_message = "cycle must be hourly or monthly."
  }
}

variable "hostname" {
  type    = string
  default = "ascon-standby"
}

variable "role" {
  description = "Free-form tag: primary or standby."
  type        = string
  default     = "standby"
}

variable "ssh_key_name" {
  description = "Label for the SSH key this config registers with Cherry Servers."
  type        = string
  default     = "ascon"
}

variable "extra_ssh_key_ids" {
  description = "Additional SSH key ids already registered in the portal (teammates)."
  type        = set(string)
  default     = []
}

variable "ssh_public_key_path" {
  description = <<-EOT
    Path to the PUBLIC key. Its contents are registered with Cherry (root access) and substituted
    into cloud-init.yaml for the `ascon` user. A path, not the contents: .tfvars files cannot call
    file().
  EOT
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}
