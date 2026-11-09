// Pulumi の入口（`pulumi preview` / `up` が読む。**up は本人の承認後**）。設定は zod で検査し、秘密は扱わない（PULUMI_MIGRATION §3）。
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { readConfig } from "./config.js";
import { defineInfra } from "./infra.js";

// 設定は `jrabot:` の名前空間（例: `pulumi config set jrabot:projectId my-project`）。配列・オブジェクトは JSON の文字列
const c = new pulumi.Config("jrabot");
const cfg = readConfig((k) => c.get(k));
const provider = new gcp.Provider("gcp", { project: cfg.projectId, region: cfg.region });
const out = defineInfra(cfg, provider);

export const project_id = out.projectId;
export const region = out.region;
export const artifact_registry = out.artifactRegistry;
export const buckets = out.buckets;
export const cloud_sql_instance = out.cloudSqlInstance;
export const service_accounts = out.serviceAccounts;
export const wif_provider = out.wifProvider;
// web の Actions の変数（GCP_WIF_PROVIDER_WEB・GCP_PUSH_SERVICE_ACCOUNT）に入れる値。enableWebPush のときだけ（web D-276）
export const web_push = out.webPush;
export const services = out.services;
export const jobs = out.jobs;
export const scheduler_jobs = out.schedulerJobs;
export const iap_audience = out.iapAudience;
