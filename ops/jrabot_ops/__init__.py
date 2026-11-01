"""JRA Bot の運用（start / stop / status / deploy の補助 / Terraform の apply 前ガード）。

状態の正本は GCS の `ops-state.json`（web CONTRACTS §5.2、OPERATIONS_DESIGN §2）。外部リソースの操作は `ports.Gcp` を通して行い、
本番は `gcloud_adapter.GcloudAdapter`、試験は `fakes.FakeGcp` を使う。GCP に接続しない試験で、手順の順序・冪等性・失敗時の安全側の挙動を検証する。
"""
