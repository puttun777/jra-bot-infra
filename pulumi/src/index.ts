// Pulumi の入口（`pulumi preview` / `up` が読む。**up は本人の承認後**）。設定は zod で検査し、秘密は扱わない（PULUMI_MIGRATION §3）。
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { parseConfig } from "./config.js";
import { defineInfra } from "./infra.js";

const c = new pulumi.Config("jrabot");
const raw: Record<string, unknown> = {};
for (const k of [
  "projectId",
  "projectNumber",
  "region",
  "githubRepoInfra",
  "githubRepoWeb",
  "allowedUsers",
  "adminUsers",
  "tenantId",
  "dbTier",
  "dbVersion",
  "dbDiskSizeGb",
  "dbDiskAutoresizeLimitGb",
  "maintenanceWindow",
  "releaseImages",
  "appRuntime",
  "alertEmail",
  "billingAccountId",
  "monthlyBudgetJpy",
  "schedulerResumeOnCreate",
]) {
  const v = c.getObject<unknown>(k);
  if (v !== undefined) raw[k] = v;
}
const cfg = parseConfig(raw);
const provider = new gcp.Provider("gcp", { project: cfg.projectId, region: cfg.region });
const out = defineInfra(cfg, provider);

export const project_id = out.projectId;
export const region = out.region;
export const artifact_registry = out.artifactRegistry;
export const buckets = out.buckets;
export const cloud_sql_instance = out.cloudSqlInstance;
export const service_accounts = out.serviceAccounts;
export const wif_provider = out.wifProvider;
export const services = out.services;
export const jobs = out.jobs;
export const scheduler_jobs = out.schedulerJobs;
export const iap_audience = out.iapAudience;
