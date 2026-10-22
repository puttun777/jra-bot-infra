# jra-bot-infra — Claude 共通ルール

JRA Bot リプレースのインフラ側リポジトリ（Terraform / GitHub Actions デプロイ / 起動・停止・状態確認 / 監視 / ロールバック）。
アプリは `puttun777/jra-bot-web`。**アプリ全体の要件・計画・契約の正本は jra-bot-web**（`docs/REQUIREMENTS.md`, `PLAN.md`, `CONTRACTS.md`）。本リポジトリはインフラ固有の仕様のみ持つ。

## 絶対ルール
1. 参照元 `puttun777/jra-bot` と jra-bot-web の main は変更しない（web への変更は web のセッション/PR で）。
2. Private 維持。新規リポジトリを作らない。`main` へ直接 push しない。作業ブランチ → PR、**マージはユーザー**。
3. **承認なく課金リソースを作成しない**（`terraform apply`、gcloud/az/aws の作成系コマンドを実行しない）。`plan` までをデフォルトとし、apply はユーザー承認後。実データを削除しない。
4. 長期アクセスキーを保存しない。GitHub Actions→クラウドは OIDC（GCP は Workload Identity Federation）。別 Private リポジトリへの権限を推測しない。
5. 秘密情報・tfstate・tfvars を Git に含めない。
6. Terraform apply/デプロイが運用モード（NORMAL/STOPPED）や DB の起動状態を意図せず変えない設計を維持する。
7. 版数は公式情報で確認して固定（Provider は lock file）。Alpha/Beta/RC を採用しない。
8. Claude Pro 節約: 単一エージェント、調査結果は docs に保存、ログ全文を出さない。

## 作業開始時
`docs/PROGRESS.md` → web の `docs/PLAN.md`（該当タスク）→ 必要時 `docs/ARCHITECTURE.md` `DECISIONS.md` と web の `docs/CONTRACTS.md`。
## 作業終了時
テスト/`terraform validate`・`fmt`・`plan` 結果を確認 → `docs/PROGRESS.md` 更新 → 判断は `docs/DECISIONS.md` → 契約変更は web の CONTRACTS.md と整合 → commit → `git push -u origin <branch>`。

## ドキュメント
| ファイル | 内容 |
|---|---|
| docs/REQUIREMENTS.md | インフラ固有要件（アプリ要件は web が正本） |
| docs/PLAN.md | インフラ担当タスク（全体計画は web の PLAN.md） |
| docs/PROGRESS.md / DECISIONS.md | 本リポジトリの進捗/判断 |
| docs/ARCHITECTURE.md | クラウド構成案・運用モード制御 |
| docs/CONTRACTS.md | web の CONTRACTS.md への参照と infra 側の固有契約 |
後続作成: CLOUD_COSTS.md, VERSIONS.md, OPERATIONS.md, TEST_RESULTS.md
