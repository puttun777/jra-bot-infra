# 専用 VPC。Direct VPC egress（Serverless VPC Access コネクタ・Cloud NAT・LB は使わない = 固定費ゼロ）と Cloud SQL のプライベート IP 用。
resource "google_compute_network" "main" {
  name                    = "${local.prefix}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.api]
}

resource "google_compute_subnetwork" "run" {
  name                     = "${local.prefix}-run"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  depends_on = [google_project_service.api]
}
