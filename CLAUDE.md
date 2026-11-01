# jra-bot-infra — Claude 共通ルール

JRA Bot リプレースのインフラ側リポジトリ（Terraform / GitHub Actions デプロイ / 起動・停止・状態確認 / 監視 / ロールバック）。
アプリは `puttun777/jra-bot-web`。**アプリ全体の要件・計画・契約の正本は jra-bot-web**（`docs/REQUIREMENTS.md`, `PLAN.md`, `CONTRACTS.md`）。本リポジトリはインフラ固有の仕様のみ持つ。

## 絶対ルール
1. 参照元 `puttun777/jra-bot` と jra-bot-web の main は変更しない（web への変更は web のセッション/PR で）。
2. Private 維持。新規リポジトリを作らない。`main` へ直接 push しない・保護設定を迂回しない。作業ブランチ → PR。**通常の開発 PR（文書・コード・テスト・Terraform の fmt/validate/mock まで）は、web の CLAUDE.md『開発の委任（2026-11-01）』のマージ条件を満たしたとき Claude がマージしてよい**。apply・課金リソース作成・本番操作を含む変更は本人承認が先。
3. **承認なく課金リソースを作成しない**（`terraform apply`、gcloud/az/aws の作成系コマンドを実行しない）。`plan` までをデフォルトとし、apply はユーザー承認後。実データを削除しない。
4. 長期アクセスキーを保存しない。GitHub Actions→クラウドは OIDC（GCP は Workload Identity Federation）。別 Private リポジトリへの権限を推測しない。
5. 秘密情報・tfstate・tfvars を Git に含めない。
6. Terraform apply/デプロイが運用モード（NORMAL/STOPPED）や DB の起動状態を意図せず変えない設計を維持する。
7. 版数は公式情報で確認して固定（Provider は lock file）。Alpha/Beta/RC を採用しない。
8. Claude Pro 節約: 単一エージェント、調査結果は docs に保存、ログ全文を出さない。

## 開発の委任（2026-11-01 更新。正本は jra-bot-web の CLAUDE.md）
段階ごとの『次へ』の指示は不要。上限で中断するときは『完了』とせず未完了の範囲と再開手順を PROGRESS に記録する。push 前に `terraform fmt -check`・`validate`・mock を使う試験（実行できる範囲）を実行し、GCP 認証が要る `plan` はできなかった理由を記録する（mock の成功を実 GCP の plan 成功と書かない）。web の事前検証 `python3 -m tools.ci.preflight` は infra の契約整合（`tools.ci.consistency`）も見る。

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
| docs/ARCHITECTURE.md | GCP 構成（設計採用）・セキュリティ境界 |
| docs/OPERATIONS_DESIGN.md | 運用モード・start/stop/status の確定設計 |
| docs/CONTRACTS.md | web の CONTRACTS.md への参照と infra 側の固有契約 |
| docs/CLOUD_COSTS.md | 費用比較・見積り（§10 が最新） |
後続作成: OPERATIONS.md（Runbook, 第5段階）, TEST_RESULTS.md
