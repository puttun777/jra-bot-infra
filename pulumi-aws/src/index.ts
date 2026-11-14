// Pulumi の入口（`pulumi preview` / `up` が読む。**up は本人の承認後**: 課金リソースを作る）。設定は zod で検査する。
// 前提: `npm run build && npm run bundle:aws`（Lambda とホストの運用エージェントの成果物を build/aws に作る）。
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { readConfig } from "./config.js";
import { defineAwsInfra } from "./infra.js";

const c = new pulumi.Config("jrabot-aws");
const cfg = readConfig((k) => c.get(k));
const provider = new aws.Provider("aws", {
  region: "ap-northeast-1",
  allowedAccountIds: [cfg.accountId],
  defaultTags: { tags: { project: "jra-bot" } },
});
const out = defineAwsInfra(cfg, provider, "..");

export const instance_id = out.instanceId;
export const data_volume_id = out.dataVolumeId;
export const controller_function = out.controllerFunction;
export const state_bucket = out.stateBucket;
export const beacon_url = out.beaconUrl;
export const ops_role_arn = out.opsRoleArn;
export const host_command_document = out.hostCommandDocument;
export const web_push_role_arn = out.webPushRoleArn;
export const ecr_registry = out.ecrRegistry;
export const cognito_issuer = out.cognitoIssuer;
export const cognito_client_id = out.cognitoClientId;
export const site_url = out.siteUrl;
export const zone_name_servers = out.zoneNameServers;
export const host_images = JSON.stringify({
  mysql: cfg.hostImages.mysql,
  caddy: cfg.hostImages.caddy,
  "oauth2-proxy": cfg.hostImages.oauth2Proxy,
});
export const arch = cfg.instanceType.startsWith("t4g") ? "arm64" : "amd64";
