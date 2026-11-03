// GCP の資源定義（Terraform の terraform/*.tf と同じ構成・同じ値。docs/PULUMI_MIGRATION.md §2 の対応表）。
// 起動状態（Cloud SQL の activationPolicy・Cloud Run の ingress・Scheduler の paused）とイメージ・Job の args は ops・deploy が変更する値なので、
// ignoreChanges で Pulumi が戻さない（OPERATIONS_DESIGN §8）。秘密の値は扱わない（Secret の版・DB ユーザーのパスワードは作らない: §3）。
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";

export const PREFIX = "jra-bot";

export const APIS = [
  "run.googleapis.com",
  "sqladmin.googleapis.com",
  "secretmanager.googleapis.com",
  "artifactregistry.googleapis.com",
  "cloudscheduler.googleapis.com",
  "compute.googleapis.com",
  "servicenetworking.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "iap.googleapis.com",
  "monitoring.googleapis.com",
  "logging.googleapis.com",
  "billingbudgets.googleapis.com",
] as const;

/** Secret の名前（値は管理しない。本人が gcloud で入れる）。CONTRACTS §2 / infra CONTRACTS §5。 */
export const SECRETS = [
  "db-app-password",
  "db-ingest-password",
  "db-bot-password",
  "db-migrate-password",
  "db-mltrain-password",
  "discord-webhook",
  "discord-error-webhook",
  "ingest-token-pepper",
  "agent-kek",
  "beacon-signing-key",
  "model-signing-key",
] as const;
type SecretName = (typeof SECRETS)[number];

export const SERVICE_ACCOUNTS = {
  dashboard: "dashboard の実行",
  ingest: "ingest の実行",
  bot: "bot（bot-run・calendar-check・reconcile・retention・export-dataset）の実行",
  dbmigration: "db-migration の実行",
  mltrain: "ml-train の実行",
  scheduler: "Cloud Scheduler が Job を起動する",
  "gha-ops": "start/stop/status（GitHub Actions）",
  "gha-deploy": "deploy（GitHub Actions）",
  "gha-tf": "資源定義の preview/up（GitHub Actions）",
} as const;
type SaKey = keyof typeof SERVICE_ACCOUNTS;

/** Secret → アクセスできる SA。 */
export const SECRET_ACCESS: Readonly<Record<SecretName, readonly SaKey[]>> = {
  "db-app-password": ["dashboard"],
  "db-ingest-password": ["ingest"],
  "db-bot-password": ["bot"],
  "db-migrate-password": ["dbmigration"],
  "db-mltrain-password": ["mltrain"],
  "discord-webhook": ["bot"],
  "discord-error-webhook": ["bot", "gha-ops"],
  "ingest-token-pepper": ["ingest", "dashboard"],
  "agent-kek": ["ingest"],
  "beacon-signing-key": ["gha-ops"],
  "model-signing-key": ["mltrain"],
};

const RUNTIME_SAS: readonly SaKey[] = ["dashboard", "ingest", "bot", "dbmigration", "mltrain"];

export const OPS_CONTROLLER_PERMISSIONS = [
  "cloudsql.instances.get",
  "cloudsql.instances.list",
  "cloudsql.instances.update",
  "cloudsql.backupRuns.create",
  "cloudsql.backupRuns.get",
  "cloudsql.backupRuns.list",
  "run.services.get",
  "run.services.list",
  "run.services.update",
  "run.jobs.get",
  "run.jobs.list",
  "run.executions.get",
  "run.executions.list",
  "run.executions.cancel",
  "run.operations.get",
  "run.revisions.get",
  "run.revisions.list",
  "cloudscheduler.jobs.get",
  "cloudscheduler.jobs.list",
  "cloudscheduler.jobs.pause",
  "cloudscheduler.jobs.enable",
  "iap.web.getIamPolicy",
] as const;

export const DEPLOYER_PERMISSIONS = [
  "run.services.get",
  "run.services.list",
  "run.services.update",
  "run.jobs.get",
  "run.jobs.list",
  "run.jobs.update",
  "run.executions.get",
  "run.executions.list",
  "run.operations.get",
  "run.revisions.get",
  "run.revisions.list",
] as const;

/** 資源定義の SA（gha-tf）のロール。構成管理に必要な広い権限（第5段階の実機検証で最小化する: 未検証）。owner・editor は付けない。 */
export const TF_ROLES = [
  "roles/run.admin",
  "roles/cloudsql.admin",
  "roles/compute.networkAdmin",
  "roles/servicenetworking.networksAdmin",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.workloadIdentityPoolAdmin",
  "roles/iam.roleAdmin",
  "roles/secretmanager.admin",
  "roles/storage.admin",
  "roles/artifactregistry.admin",
  "roles/cloudscheduler.admin",
  "roles/monitoring.admin",
  "roles/serviceusage.serviceUsageAdmin",
  "roles/resourcemanager.projectIamAdmin",
  "roles/iap.admin",
] as const;

/** WIF で束縛するワークフロー（main ブランチの対象ファイルだけ）。 */
export const WIF_REF = "refs/heads/main";
export const WIF_WORKFLOWS: Readonly<Record<string, { sa: SaKey; file: string }>> = {
  "ops-start": { sa: "gha-ops", file: "ops-start.yml" },
  "ops-stop": { sa: "gha-ops", file: "ops-stop.yml" },
  "ops-status": { sa: "gha-ops", file: "ops-status.yml" },
  deploy: { sa: "gha-deploy", file: "deploy.yml" },
  "terraform-plan": { sa: "gha-tf", file: "terraform-plan.yml" },
  "terraform-apply": { sa: "gha-tf", file: "terraform-apply.yml" },
};

interface BotJob {
  readonly args: readonly string[];
  readonly cpu: string;
  readonly memory: string;
  readonly timeoutSeconds: number;
  readonly poolMax: string;
  readonly withRuntime: boolean;
  readonly withDiscord: boolean;
}

export function botJobs(tenantId: number): Readonly<Record<string, BotJob>> {
  const t = `--tenant-id=${tenantId}`;
  return {
    "bot-run": {
      args: ["--task=bot-run", t],
      cpu: "1",
      memory: "2Gi",
      timeoutSeconds: 50400,
      poolMax: "4",
      withRuntime: true,
      withDiscord: true,
    },
    "calendar-check": {
      args: ["--task=calendar-check", t],
      cpu: "0.5",
      memory: "1Gi",
      timeoutSeconds: 300,
      poolMax: "1",
      withRuntime: false,
      withDiscord: false,
    },
    reconcile: {
      args: ["--task=reconcile", t],
      cpu: "0.5",
      memory: "1Gi",
      timeoutSeconds: 900,
      poolMax: "1",
      withRuntime: false,
      withDiscord: false,
    },
    retention: {
      args: ["--task=retention", t],
      cpu: "0.5",
      memory: "1Gi",
      timeoutSeconds: 900,
      poolMax: "1",
      withRuntime: false,
      withDiscord: false,
    },
    "export-dataset": {
      args: ["--task=export-dataset", t],
      cpu: "1",
      memory: "2Gi",
      timeoutSeconds: 3600,
      poolMax: "2",
      withRuntime: false,
      withDiscord: false,
    },
  };
}

/** Scheduler（JST）。calendar-check は開催日の朝〜夕に 15 分ごと、reconcile は夜に、retention は月 1 回。 */
export const SCHEDULER_JOBS: Readonly<Record<string, { schedule: string; job: string }>> = {
  "calendar-check": { schedule: "*/15 6-18 * * *", job: "calendar-check" },
  reconcile: { schedule: "30 21 * * *", job: "reconcile" },
  retention: { schedule: "0 4 1 * *", job: "retention" },
};

/** ops・deploy が変更する値（Pulumi は戻さない）。試験がこの一覧と各資源の設定を照合する。 */
export const IGNORE = {
  sqlInstance: ["settings.activationPolicy"],
  service: ["ingress", "client", "clientVersion", "template.containers[0].image", "template.revision"],
  botJob: ["client", "clientVersion", "template.template.containers[0].image"],
  argJob: ["client", "clientVersion", "template.template.containers[0].image", "template.template.containers[0].args"],
  scheduler: ["paused"],
} as const;

export interface InfraOutputs {
  readonly projectId: string;
  readonly region: string;
  readonly artifactRegistry: pulumi.Output<string>;
  readonly buckets: Readonly<Record<"ops_state" | "mode_beacon" | "model_store", string>>;
  readonly cloudSqlInstance: pulumi.Output<string>;
  readonly serviceAccounts: Readonly<Record<string, pulumi.Output<string>>>;
  readonly wifProvider: pulumi.Output<string>;
  readonly services: Readonly<Record<"dashboard" | "ingest", pulumi.Output<string> | null>>;
  readonly jobs: Readonly<Record<string, pulumi.Output<string>>>;
  readonly schedulerJobs: readonly pulumi.Output<string>[];
  readonly iapAudience: string;
}

type Env =
  | { name: string; value: string | pulumi.Output<string> }
  | { name: string; valueSource: { secretKeyRef: { secret: pulumi.Output<string>; version: string } } };

/** @param transformations 試験が各資源の型・入力・オプション（ignoreChanges など）を確かめるためのもの。本番では渡さない。 */
export function defineInfra(cfg: InfraConfig, provider?: gcp.Provider, transformations?: pulumi.ResourceTransformation[]): InfraOutputs {
  const opts: pulumi.CustomResourceOptions = { ...(provider ? { provider } : {}), ...(transformations ? { transformations } : {}) };
  const region = cfg.region;
  const buckets = {
    ops_state: `${cfg.projectId}-ops-state`,
    mode_beacon: `${cfg.projectId}-mode-beacon`,
    model_store: `${cfg.projectId}-model-store`,
  } as const;
  const deployEnabled = cfg.releaseImages !== null && cfg.appRuntime !== null;

  // ---- API（apis.tf）
  const apis = APIS.map((s) => new gcp.projects.Service(`api-${s}`, { project: cfg.projectId, service: s, disableOnDestroy: false }, opts));
  const afterApis: pulumi.CustomResourceOptions = { ...opts, dependsOn: apis };

  // ---- ネットワーク（network.tf）
  const network = new gcp.compute.Network("vpc", { name: `${PREFIX}-vpc`, autoCreateSubnetworks: false }, afterApis);
  const subnet = new gcp.compute.Subnetwork(
    "subnet-run",
    { name: `${PREFIX}-run`, region, network: network.id, ipCidrRange: "10.20.0.0/24", privateIpGoogleAccess: true },
    opts,
  );
  const privateRange = new gcp.compute.GlobalAddress(
    "private-services",
    { name: `${PREFIX}-private-services`, purpose: "VPC_PEERING", addressType: "INTERNAL", prefixLength: 20, network: network.id },
    opts,
  );
  const peering = new gcp.servicenetworking.Connection(
    "private-services",
    { network: network.id, service: "servicenetworking.googleapis.com", reservedPeeringRanges: [privateRange.name] },
    afterApis,
  );

  // ---- Artifact Registry（registry.tf）
  const registry = new gcp.artifactregistry.Repository(
    "images",
    {
      repositoryId: PREFIX,
      location: region,
      format: "DOCKER",
      description: "JRA Bot のコンテナイメージ（digest 固定でデプロイ）",
      cleanupPolicyDryRun: false,
      cleanupPolicies: [
        { id: "keep-recent", action: "KEEP", mostRecentVersions: { keepCount: 3 } },
        { id: "delete-old", action: "DELETE", condition: { olderThan: "2592000s" } },
      ],
    },
    afterApis,
  );

  // ---- バケット（storage.tf）
  const opsState = new gcp.storage.Bucket(
    "ops-state",
    {
      name: buckets.ops_state,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      forceDestroy: false,
      versioning: { enabled: true },
      lifecycleRules: [{ condition: { numNewerVersions: 50, withState: "ARCHIVED" }, action: { type: "Delete" } }],
    },
    afterApis,
  );
  const modeBeacon = new gcp.storage.Bucket(
    "mode-beacon",
    {
      name: buckets.mode_beacon,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "inherited",
      forceDestroy: false,
    },
    afterApis,
  );
  new gcp.storage.BucketIAMMember(
    "beacon-public-read",
    { bucket: modeBeacon.name, role: "roles/storage.objectViewer", member: "allUsers" },
    opts,
  );
  const modelStore = new gcp.storage.Bucket(
    "model-store",
    {
      name: buckets.model_store,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      forceDestroy: false,
      versioning: { enabled: true },
      lifecycleRules: [{ condition: { age: 90, matchesPrefixes: ["datasets/"] }, action: { type: "Delete" } }],
    },
    afterApis,
  );

  // ---- SA・Secret（iam.tf）
  const sa = {} as Record<SaKey, gcp.serviceaccount.Account>;
  for (const [k, d] of Object.entries(SERVICE_ACCOUNTS) as [SaKey, string][]) {
    sa[k] = new gcp.serviceaccount.Account(`sa-${k}`, { accountId: `sa-${k}`, displayName: d }, afterApis);
  }
  const member = (k: SaKey): pulumi.Output<string> => pulumi.interpolate`serviceAccount:${sa[k].email}`;
  const secret = {} as Record<SecretName, gcp.secretmanager.Secret>;
  for (const s of SECRETS) secret[s] = new gcp.secretmanager.Secret(`secret-${s}`, { secretId: s, replication: { auto: {} } }, afterApis);
  const secretAccess: gcp.secretmanager.SecretIamMember[] = [];
  for (const [s, sas] of Object.entries(SECRET_ACCESS) as [SecretName, readonly SaKey[]][]) {
    for (const k of sas) {
      secretAccess.push(
        new gcp.secretmanager.SecretIamMember(
          `access-${s}-${k}`,
          { secretId: secret[s].id, role: "roles/secretmanager.secretAccessor", member: member(k) },
          opts,
        ),
      );
    }
  }

  // ---- バケットの権限
  const bucketMember = (
    name: string,
    bucket: gcp.storage.Bucket,
    role: string,
    who: SaKey,
    prefix?: { title: string; description: string; path: string },
  ) =>
    new gcp.storage.BucketIAMMember(
      name,
      {
        bucket: bucket.name,
        role,
        member: member(who),
        ...(prefix
          ? {
              condition: {
                title: prefix.title,
                description: prefix.description,
                expression: `resource.name.startsWith("projects/_/buckets/${prefix.path}")`,
              },
            }
          : {}),
      },
      opts,
    );
  for (const k of RUNTIME_SAS) bucketMember(`ops-state-read-${k}`, opsState, "roles/storage.objectViewer", k);
  bucketMember("ops-state-agent-write", opsState, "roles/storage.objectUser", "ingest", {
    title: "agent-prefix-only",
    description: "agent/ 配下のオブジェクトだけ",
    path: `${buckets.ops_state}/objects/agent/`,
  });
  bucketMember("ops-state-ops-admin", opsState, "roles/storage.objectAdmin", "gha-ops");
  bucketMember("beacon-ops-admin", modeBeacon, "roles/storage.objectAdmin", "gha-ops");
  bucketMember("model-store-bot-read", modelStore, "roles/storage.objectViewer", "bot");
  bucketMember("model-store-bot-datasets", modelStore, "roles/storage.objectCreator", "bot", {
    title: "datasets-prefix-only",
    description: "datasets/ 配下だけ（モデルは書けない）",
    path: `${buckets.model_store}/objects/datasets/`,
  });
  bucketMember("model-store-mltrain", modelStore, "roles/storage.objectUser", "mltrain");
  bucketMember("ops-state-deploy-read", opsState, "roles/storage.objectViewer", "gha-deploy");
  bucketMember("ops-state-deploy-state", opsState, "roles/storage.objectUser", "gha-deploy", {
    title: "state-prefix-only",
    description: "state/ 配下だけ（deploy のリースと release の記録）",
    path: `${buckets.ops_state}/objects/state/`,
  });
  bucketMember("ops-state-deploy-history", opsState, "roles/storage.objectCreator", "gha-deploy", {
    title: "history-prefix-only",
    description: "history/ 配下の追記だけ（削除・上書きはできない）",
    path: `${buckets.ops_state}/objects/history/`,
  });
  bucketMember("ops-state-tf-read", opsState, "roles/storage.objectViewer", "gha-tf");

  // ---- Artifact Registry の読取り
  for (const k of ["dashboard", "ingest", "bot", "dbmigration", "mltrain", "gha-deploy", "gha-ops"] as const) {
    new gcp.artifactregistry.RepositoryIamMember(
      `registry-reader-${k}`,
      { repository: registry.name, location: region, role: "roles/artifactregistry.reader", member: member(k) },
      opts,
    );
  }

  // ---- カスタムロールとプロジェクトの権限
  const opsRole = new gcp.projects.IAMCustomRole(
    "ops-controller",
    {
      roleId: "jraBotOpsController",
      title: "JRA Bot ops controller",
      description:
        "start/stop/status が使う権限だけ。IAM は変更できない。注意: run.services.update は IAP の有効/無効も更新できてしまうため、status が IAP の無効を常に異常として検知する",
      permissions: [...OPS_CONTROLLER_PERMISSIONS],
    },
    opts,
  );
  new gcp.projects.IAMMember("ops-controller", { project: cfg.projectId, role: opsRole.id, member: member("gha-ops") }, opts);
  const svcMember = (name: string, target: SaKey, role: string, who: SaKey) =>
    new gcp.serviceaccount.IAMMember(name, { serviceAccountId: sa[target].name, role, member: member(who) }, opts);
  for (const k of ["dashboard", "ingest", "dbmigration"] as const)
    svcMember(`ops-act-as-${k}`, k, "roles/iam.serviceAccountUser", "gha-ops");
  svcMember("ops-id-token", "gha-ops", "roles/iam.serviceAccountOpenIdTokenCreator", "gha-ops");
  const deployerRole = new gcp.projects.IAMCustomRole(
    "deployer",
    {
      roleId: "jraBotDeployer",
      title: "JRA Bot deployer",
      description: "Cloud Run のイメージ更新と Job 定義の更新。ingress・IAP・IAM は変更しない運用（deploy は ingress を指定しない）",
      permissions: [...DEPLOYER_PERMISSIONS],
    },
    opts,
  );
  new gcp.projects.IAMMember("deployer", { project: cfg.projectId, role: deployerRole.id, member: member("gha-deploy") }, opts);
  for (const k of RUNTIME_SAS) svcMember(`deploy-act-as-${k}`, k, "roles/iam.serviceAccountUser", "gha-deploy");
  for (const r of TF_ROLES)
    new gcp.projects.IAMMember(`tf-${r.replace("roles/", "")}`, { project: cfg.projectId, role: r, member: member("gha-tf") }, opts);
  for (const k of Object.keys(SERVICE_ACCOUNTS) as SaKey[]) svcMember(`tf-act-as-${k}`, k, "roles/iam.serviceAccountUser", "gha-tf");

  // ---- WIF（GitHub Actions → GCP。長期キー無し）
  const pool = new gcp.iam.WorkloadIdentityPool(
    "github",
    { workloadIdentityPoolId: `${PREFIX}-github`, displayName: "GitHub Actions" },
    afterApis,
  );
  const wifProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "github",
    {
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: "github-oidc",
      displayName: "GitHub OIDC",
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
        "attribute.ref": "assertion.ref",
        "attribute.workflow_ref": "assertion.workflow_ref",
        "attribute.job_workflow_ref": "assertion.job_workflow_ref",
        "attribute.environment": "assertion.environment",
      },
      // この infra リポジトリ以外（web を含む）は拒否
      attributeCondition: `assertion.repository == "${cfg.githubRepoInfra}"`,
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
    },
    opts,
  );
  for (const [k, w] of Object.entries(WIF_WORKFLOWS)) {
    new gcp.serviceaccount.IAMMember(
      `wif-${k}`,
      {
        serviceAccountId: sa[w.sa].name,
        role: "roles/iam.workloadIdentityUser",
        member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.workflow_ref/${cfg.githubRepoInfra}/.github/workflows/${w.file}@${WIF_REF}`,
      },
      opts,
    );
  }

  // ---- Cloud SQL（cloudsql.tf）。DB ユーザーは作らない（パスワードを state に載せない: PULUMI_MIGRATION §3。ops db-users ensure）
  const db = new gcp.sql.DatabaseInstance(
    "db",
    {
      name: `${PREFIX}-db`,
      region,
      databaseVersion: cfg.dbVersion,
      deletionProtection: true,
      settings: {
        tier: cfg.dbTier,
        edition: "ENTERPRISE",
        availabilityType: "ZONAL",
        activationPolicy: "ALWAYS", // 作成時だけ。以後は ops が変更する（ignoreChanges）
        diskType: "PD_SSD",
        diskSize: cfg.dbDiskSizeGb,
        diskAutoresize: true,
        diskAutoresizeLimit: cfg.dbDiskAutoresizeLimitGb,
        deletionProtectionEnabled: true,
        ipConfiguration: {
          ipv4Enabled: false,
          privateNetwork: network.id,
          sslMode: "ENCRYPTED_ONLY",
          enablePrivatePathForGoogleCloudServices: false,
        },
        backupConfiguration: {
          enabled: true,
          startTime: "18:00", // UTC = 03:00 JST
          pointInTimeRecoveryEnabled: false,
          transactionLogRetentionDays: 1,
          backupRetentionSettings: { retainedBackups: 7, retentionUnit: "COUNT" },
        },
        maintenanceWindow: { day: cfg.maintenanceWindow.day, hour: cfg.maintenanceWindow.hour, updateTrack: "stable" },
        databaseFlags: [
          { name: "character_set_server", value: "utf8mb4" },
          { name: "time_zone", value: "+00:00" },
        ],
      },
    },
    { ...opts, dependsOn: [peering, ...apis], ignoreChanges: [...IGNORE.sqlInstance] },
  );
  new gcp.sql.Database("jrabot", { name: "jrabot", instance: db.name, charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" }, opts);
  const dbUrl = pulumi.interpolate`jdbc:mysql://${db.privateIpAddress}:3306/jrabot?sslMode=VERIFY_CA`;
  const iapAudience = `/projects/${cfg.projectNumber}/locations/${region}/services/${PREFIX}-dashboard`;

  // ---- Cloud Run（cloud_run.tf）。release_images と app_runtime が揃うまで作らない（基盤だけ先に作る）
  const commonEnv: Record<string, string | pulumi.Output<string>> = {
    APP_ENV: "prod",
    TZ: "Asia/Tokyo",
    OPS_MODE_SOURCE: `gs://${buckets.ops_state}/state/ops-state.json`,
    DB_URL: dbUrl,
  };
  const plain = (m: Record<string, string | pulumi.Output<string>>): Env[] => Object.entries(m).map(([name, value]) => ({ name, value }));
  const fromSecret = (m: Record<string, SecretName>): Env[] =>
    Object.entries(m).map(([name, s]) => ({ name, valueSource: { secretKeyRef: { secret: secret[s].secretId, version: "latest" } } }));
  const vpcAccess = { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ network: network.id, subnetwork: subnet.id }] };
  const afterSecrets: pulumi.CustomResourceOptions = { ...opts, dependsOn: [...secretAccess, ...apis] };
  const jobs: Record<string, pulumi.Output<string>> = {};
  const schedulerJobs: pulumi.Output<string>[] = [];
  let dashboardName: pulumi.Output<string> | null = null;
  let ingestName: pulumi.Output<string> | null = null;

  if (deployEnabled && cfg.releaseImages !== null && cfg.appRuntime !== null) {
    const img = cfg.releaseImages;
    const runtimeEnv = cfg.appRuntime;
    const dashboard = new gcp.cloudrunv2.Service(
      "dashboard",
      {
        name: `${PREFIX}-dashboard`,
        location: region,
        ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY", // 作成時は停止側。以後は ops が変更する
        iapEnabled: true,
        deletionProtection: true,
        launchStage: "BETA",
        template: {
          serviceAccount: sa.dashboard.email,
          timeout: "60s",
          maxInstanceRequestConcurrency: 40,
          scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
          vpcAccess,
          containers: [
            {
              image: img.dashboard,
              resources: { limits: { cpu: "1", memory: "1Gi" } },
              envs: [
                ...plain({
                  ...commonEnv,
                  DB_USER: "app",
                  DB_POOL_MAX: "3",
                  IAP_AUDIENCE: iapAudience,
                  OPS_SA_EMAIL: sa["gha-ops"].email,
                  ALLOWED_USERS: cfg.allowedUsers.join(","),
                  ADMIN_USERS: cfg.adminUsers.join(","),
                }),
                ...fromSecret({ DB_PASSWORD: "db-app-password", INGEST_TOKEN_PEPPER: "ingest-token-pepper" }),
              ],
            },
          ],
        },
      },
      { ...afterSecrets, ignoreChanges: [...IGNORE.service] },
    );
    const ingest = new gcp.cloudrunv2.Service(
      "ingest",
      {
        name: `${PREFIX}-ingest`,
        location: region,
        ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
        deletionProtection: true,
        template: {
          serviceAccount: sa.ingest.email,
          timeout: "60s",
          maxInstanceRequestConcurrency: 20,
          scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
          vpcAccess,
          containers: [
            {
              image: img.ingest,
              resources: { limits: { cpu: "1", memory: "1Gi" } },
              envs: [
                ...plain({
                  ...commonEnv,
                  DB_USER: "ingest",
                  DB_POOL_MAX: "3",
                  INTERNAL_ID_TOKEN_AUDIENCE: `https://${PREFIX}-ingest-${cfg.projectNumber}.${region}.run.app`,
                  OPS_SA_EMAIL: sa["gha-ops"].email,
                  AGENT_HEARTBEAT_PREFIX: `gs://${buckets.ops_state}/agent/`,
                  INGEST_ODDS_BELOW_PAR: "quarantine",
                  INGEST_STORE_COMBO_ODDS: "false",
                }),
                ...fromSecret({
                  DB_PASSWORD: "db-ingest-password",
                  INGEST_TOKEN_PEPPER: "ingest-token-pepper",
                  AGENT_KEK_KEYS: "agent-kek",
                }),
              ],
            },
          ],
        },
      },
      { ...afterSecrets, ignoreChanges: [...IGNORE.service] },
    );
    dashboardName = dashboard.name;
    ingestName = ingest.name;
    // ingest はアプリ認証（トークン + HMAC。IAP の外）なので allUsers を invoker にする。ingress=internal の間は到達できない
    new gcp.cloudrunv2.ServiceIamMember(
      "ingest-public-invoker",
      { name: ingest.name, location: region, role: "roles/run.invoker", member: "allUsers" },
      opts,
    );
    // dashboard: 直接 IAP。許可リストは本人のメールだけ（空なら誰も入れない）
    for (const u of cfg.allowedUsers) {
      new gcp.iap.WebCloudRunServiceIamMember(
        `dashboard-user-${u}`,
        {
          project: cfg.projectId,
          location: region,
          cloudRunServiceName: dashboard.name,
          role: "roles/iap.httpsResourceAccessor",
          member: `user:${u}`,
        },
        opts,
      );
    }
    new gcp.iap.WebCloudRunServiceIamMember(
      "dashboard-ops-health",
      {
        project: cfg.projectId,
        location: region,
        cloudRunServiceName: dashboard.name,
        role: "roles/iap.httpsResourceAccessor",
        member: member("gha-ops"),
      },
      opts,
    );
    new gcp.cloudrunv2.ServiceIamMember(
      "dashboard-iap-invoker",
      {
        project: cfg.projectId,
        location: region,
        name: dashboard.name,
        role: "roles/run.invoker",
        member: `serviceAccount:service-${cfg.projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`,
      },
      afterApis,
    );

    // ---- Jobs
    const bot: Record<string, gcp.cloudrunv2.Job> = {};
    for (const [k, j] of Object.entries(botJobs(cfg.tenantId))) {
      const runtime = Object.fromEntries(Object.entries(runtimeEnv).filter(([key]) => j.withRuntime || key.startsWith("CALENDAR_")));
      // calendar-check だけが bot-run を起動する（web CONTRACTS §5.2 の RUN_JOBS_*。Job 名は <prefix>-<task>）
      const launch: Record<string, string> =
        k === "calendar-check" ? { RUN_JOBS_PROJECT_ID: cfg.projectId, RUN_JOBS_REGION: region, RUN_JOBS_PREFIX: PREFIX } : {};
      bot[k] = new gcp.cloudrunv2.Job(
        `job-${k}`,
        {
          name: `${PREFIX}-${k}`,
          location: region,
          deletionProtection: true,
          template: {
            parallelism: 1,
            taskCount: 1,
            template: {
              serviceAccount: sa.bot.email,
              maxRetries: 0,
              timeout: `${j.timeoutSeconds}s`,
              vpcAccess,
              containers: [
                {
                  image: img.bot,
                  args: [...j.args],
                  resources: { limits: { cpu: j.cpu, memory: j.memory } },
                  envs: [
                    ...plain({
                      ...commonEnv,
                      DB_USER: "bot",
                      DB_POOL_MAX: j.poolMax,
                      MODEL_STORE_URI: `gs://${buckets.model_store}`,
                      ...runtime,
                      ...launch,
                    }),
                    ...fromSecret({ DB_PASSWORD: "db-bot-password" }),
                    ...(j.withDiscord
                      ? fromSecret({ DISCORD_WEBHOOK_URL: "discord-webhook", DISCORD_ERROR_WEBHOOK_URL: "discord-error-webhook" })
                      : []),
                  ],
                },
              ],
            },
          },
        },
        { ...opts, dependsOn: secretAccess, ignoreChanges: [...IGNORE.botJob] },
      );
      jobs[k] = bot[k].name;
    }
    const dbMigration = new gcp.cloudrunv2.Job(
      "job-db-migration",
      {
        name: `${PREFIX}-db-migration`,
        location: region,
        deletionProtection: true,
        template: {
          template: {
            serviceAccount: sa.dbmigration.email,
            maxRetries: 0,
            timeout: "900s",
            vpcAccess,
            containers: [
              {
                image: img.db_migration,
                args: ["--mode=validate"], // --mode は実行時の上書きで必須指定する
                resources: { limits: { cpu: "1", memory: "1Gi" } },
                envs: [
                  ...plain({ ...commonEnv, DB_USER: "migrate", DB_POOL_MAX: "2" }),
                  ...fromSecret({ DB_PASSWORD: "db-migrate-password" }),
                ],
              },
            ],
          },
        },
      },
      { ...opts, dependsOn: secretAccess, ignoreChanges: [...IGNORE.argJob] },
    );
    jobs["db-migration"] = dbMigration.name;
    const mlTrain = new gcp.cloudrunv2.Job(
      "job-ml-train",
      {
        name: `${PREFIX}-ml-train`,
        location: region,
        deletionProtection: true,
        template: {
          template: {
            serviceAccount: sa.mltrain.email,
            maxRetries: 0,
            timeout: "3600s",
            vpcAccess,
            containers: [
              {
                image: img.ml_train,
                args: [`--tenant-id=${cfg.tenantId}`], // --dataset-id は実行時に指定する
                resources: { limits: { cpu: "2", memory: "4Gi" } },
                envs: [
                  ...plain({ ...commonEnv, DB_USER: "mltrain", DB_POOL_MAX: "1", MODEL_STORE_URI: `gs://${buckets.model_store}` }),
                  ...fromSecret({ DB_PASSWORD: "db-mltrain-password", MODEL_SIGNING_KEY: "model-signing-key" }),
                ],
              },
            ],
          },
        },
      },
      { ...opts, dependsOn: secretAccess, ignoreChanges: [...IGNORE.argJob] },
    );
    jobs["ml-train"] = mlTrain.name;

    // ---- Job の実行権限
    for (const [k, s] of Object.entries(SCHEDULER_JOBS)) {
      const target = bot[s.job];
      if (target === undefined) throw new Error(`Scheduler ${k} の Job ${s.job} が無い`);
      new gcp.cloudrunv2.JobIamMember(
        `scheduler-invoker-${k}`,
        { name: target.name, location: region, role: "roles/run.invoker", member: member("scheduler") },
        opts,
      );
    }
    const botRun = bot["bot-run"];
    if (botRun === undefined) throw new Error("bot-run の Job が無い");
    new gcp.cloudrunv2.JobIamMember(
      "bot-launches-bot-run",
      { name: botRun.name, location: region, role: "roles/run.jobsExecutorWithOverrides", member: member("bot") },
      opts,
    );
    for (const k of ["gha-ops", "gha-deploy"] as const) {
      new gcp.cloudrunv2.JobIamMember(
        `db-migration-exec-${k}`,
        {
          project: cfg.projectId,
          location: region,
          name: dbMigration.name,
          role: "roles/run.jobsExecutorWithOverrides",
          member: member(k),
        },
        opts,
      );
    }

    // ---- Scheduler（scheduler.tf）。作成時は PAUSED（start が resume する）。paused は ops が変更する値
    for (const [k, s] of Object.entries(SCHEDULER_JOBS)) {
      const target = bot[s.job];
      if (target === undefined) throw new Error(`Scheduler ${k} の Job ${s.job} が無い`);
      const job = new gcp.cloudscheduler.Job(
        `scheduler-${k}`,
        {
          name: `${PREFIX}-${k}`,
          region,
          schedule: s.schedule,
          timeZone: "Asia/Tokyo",
          paused: !cfg.schedulerResumeOnCreate,
          attemptDeadline: "180s",
          retryConfig: { retryCount: 0 },
          httpTarget: {
            httpMethod: "POST",
            uri: pulumi.interpolate`https://run.googleapis.com/v2/projects/${cfg.projectId}/locations/${region}/jobs/${target.name}:run`,
            body: Buffer.from("{}").toString("base64"),
            headers: { "Content-Type": "application/json" },
            oauthToken: { serviceAccountEmail: sa.scheduler.email, scope: "https://www.googleapis.com/auth/cloud-platform" },
          },
        },
        { ...afterApis, ignoreChanges: [...IGNORE.scheduler] },
      );
      schedulerJobs.push(job.name);
    }
  }

  // ---- 監視（monitoring.tf）
  const channels: pulumi.Output<string>[] = [];
  if (cfg.alertEmail !== "") {
    channels.push(
      new gcp.monitoring.NotificationChannel(
        "email",
        { displayName: "JRA Bot 運用者", type: "email", labels: { email_address: cfg.alertEmail } },
        afterApis,
      ).id,
    );
  }
  const threshold = (name: string, displayName: string, filter: string, value: number, duration: string) =>
    new gcp.monitoring.AlertPolicy(
      name,
      {
        displayName,
        combiner: "OR",
        notificationChannels: channels,
        conditions: [
          {
            displayName: name === "job-failed" ? "failed executions" : "5xx responses",
            conditionThreshold: {
              filter,
              comparison: "COMPARISON_GT",
              thresholdValue: value,
              duration,
              aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_SUM" }],
            },
          },
        ],
      },
      afterApis,
    );
  threshold(
    "job-failed",
    "JRA Bot: Cloud Run Job の失敗",
    'metric.type="run.googleapis.com/job/completed_execution_count" AND resource.type="cloud_run_job" AND metric.labels.result="failed"',
    0,
    "0s",
  );
  threshold(
    "service-5xx",
    "JRA Bot: Cloud Run サービスの 5xx",
    'metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND metric.labels.response_code_class="5xx"',
    5,
    "300s",
  );
  if (cfg.billingAccountId !== "") {
    new gcp.billing.Budget(
      "monthly",
      {
        billingAccount: cfg.billingAccountId,
        displayName: "JRA Bot 月額予算",
        budgetFilter: { projects: [`projects/${cfg.projectNumber}`] },
        amount: { specifiedAmount: { currencyCode: "JPY", units: String(cfg.monthlyBudgetJpy) } },
        thresholdRules: [
          { thresholdPercent: 0.5 },
          { thresholdPercent: 0.8 },
          { thresholdPercent: 1.0 },
          { thresholdPercent: 1.0, spendBasis: "FORECASTED_SPEND" },
        ],
      },
      opts,
    );
  }

  return {
    projectId: cfg.projectId,
    region,
    artifactRegistry: pulumi.interpolate`${region}-docker.pkg.dev/${cfg.projectId}/${registry.repositoryId}`,
    buckets,
    cloudSqlInstance: db.name,
    serviceAccounts: Object.fromEntries(Object.entries(sa).map(([k, v]) => [k, v.email])),
    wifProvider: wifProvider.name,
    services: { dashboard: dashboardName, ingest: ingestName },
    jobs,
    schedulerJobs,
    iapAudience,
  };
}
