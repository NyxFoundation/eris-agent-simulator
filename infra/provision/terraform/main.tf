# ASCON execution box on Cherry Servers (Tokyo).
#
# Scope: this exists so the LIVE-WEEK STANDBY can be brought up with one command instead of clicking
# through a portal during an incident. It also happens to build the primary box, but Terraform is not
# what makes the setup portable between vendors — cloud-init + docker compose are. Each bare-metal
# provider has a different resource shape (cherryservers_server / vultr_bare_metal_server /
# hcloud_server / the OVH order API), so switching vendors means rewriting this file, not flipping a
# variable. See ASCON docs/27 §5 and the provisioning README.
#
#   export CHERRY_API_KEY=...        # portal.cherryservers.com/settings/api-keys
#   terraform init && terraform apply
#
# Verified against the live Cherry Servers API on 2026-09-15:
#   region slug          JP-Tokyo
#   plan  amd-ryzen-9700x   8 cores @3.8GHz, 96GB, 10Gbps   EUR 0.324/hr   EUR 189.00/mo
#   plan  amd-ryzen-9950x  16 cores @4.3GHz, 128GB, 10Gbps  EUR 0.598/hr   EUR 349.00/mo
#   image slug           ubuntu_24_04_64bit
# The 9950x is the fallback if bench-max cannot hold the 2s block budget on 8 cores; it is available
# in Tokyo too, so that escape hatch is real.

terraform {
  required_version = ">= 1.6"
  required_providers {
    cherryservers = {
      source  = "cherryservers/cherryservers"
      version = "~> 1.0"
    }
  }
}

provider "cherryservers" {
  # or set CHERRY_API_KEY in the environment and drop this line
  api_key = var.cherry_api_key
}

# Registered with Cherry so that root access exists even if cloud-init fails. cloud-init separately
# puts the same key on the `ascon` user, which is the account to actually use.
resource "cherryservers_ssh_key" "ascon" {
  name       = var.ssh_key_name
  public_key = local.ssh_public_key
}

locals {
  ssh_public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))

  # cloud-init is shared with every other vendor verbatim; only the SSH key is substituted.
  user_data = base64encode(
    replace(
      file("${path.module}/../cloud-init.yaml"),
      "ssh-ed25519 AAAA_REPLACE_ME",
      local.ssh_public_key,
    )
  )
}

resource "cherryservers_server" "ascon" {
  project_id = var.project_id
  region     = var.region
  plan       = var.plan
  image      = var.image
  hostname   = var.hostname
  name       = var.hostname

  # Hourly is the provider default and the right one for a standby: the break-even against the
  # monthly rate is 583 hours (~24 days), and a standby should live for the live week only.
  cycle = var.cycle

  ssh_key_ids = concat([cherryservers_ssh_key.ascon.id], tolist(var.extra_ssh_key_ids))
  user_data   = local.user_data

  # Changing image/ssh_key_ids/user_data silently REINSTALLS the machine. Left false so that an
  # accidental edit fails the apply instead of wiping a running competition box.
  allow_reinstall = false

  tags = {
    Name      = var.hostname
    Project   = "ASCON"
    Role      = var.role
    ManagedBy = "terraform"
  }

  # Plugin-framework provider: `timeouts` is a nested attribute, not a block (tofu validate rejects
  # the block form). Cherry quote ~15 min for a pre-configured Tokyo box; leave room for a queue.
  timeouts = {
    create = "60m"
  }
}
