# CONTRACTS（インフラ側）

正本: jra-bot-web `docs/CONTRACTS.md`（contract_version 0.1.0-draft）。成果物（コンテナイメージ digest / `release-manifest.json`）、環境変数、内部 API、DB マイグレーション、運用モード契約はそちらを参照。

## infra 固有の提供契約
| 提供物 | 内容 |
|---|---|
| Terraform outputs | サービス URL、Registry パス、Job 名、SA メール（秘密を含まない） |
| `status` 出力 | `{desired, actual:{db, web, scheduler, jobs}, lastOperation, contractVersion}` を Job Summary と JSON artifact に |
| Secret 名 | `db-password`, `discord-webhook-url` 等（名称は T5.1 で確定し web CONTRACTS に反映） |
| 権限 | deploy 用 SA は Registry 読取・Run 更新・Job 実行のみ。tfstate 用バケット権限は別 SA |

契約変更は web の CONTRACTS.md を先に更新し、本ファイルは差分のみ記載。
