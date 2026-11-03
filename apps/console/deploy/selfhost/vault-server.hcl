# Single-node template; NO automatic initialization/unseal, NO HA claim.
ui = false
disable_mlock = true
api_addr = "https://vault:8200"
cluster_addr = "https://vault:8201"
storage "raft" {
  path = "/vault/data"
  node_id = "console-fleet-vault-1"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file = "/vault/tls/server.crt"
  tls_key_file = "/vault/tls/server.key"
  tls_min_version = "tls12"
}
