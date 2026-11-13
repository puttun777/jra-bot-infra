/**
 * EC2 の上のコンテナの定義（Docker Compose の代わり。AL2023 に Compose のパッケージが無く、型付きの定義から `docker run` の引数を作る）。
 * 定義は純粋なデータで、引数の組み立ても純粋な関数（試験で安全の条件を確かめる: DB の外部公開なし・非 root・読取り専用・権限の削除・メモリ上限）。
 *
 * メモリの割当（2026-11-13 の実測。合成データで MySQL + dashboard + ingest + bot-run を同時に動かした RSS: dashboard 212・ingest 211・
 * bot-run 203・MySQL 175 MiB。JVM は -Xmx・SerialGC・C1 のみ）。上限は実測 + 余裕で、合計がインスタンスのメモリを超えないようにする。
 */

export interface Mount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  /** コンテナ名（docker の --name）。 */
  readonly container: string;
  readonly command?: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** 値に秘密を含む環境変数のファイル（root だけが読める。docker inspect には出るが、引数・ログには出さない）。 */
  readonly envFiles: readonly string[];
  readonly mounts: readonly Mount[];
  /** 公開するポート（"127.0.0.1:18081:8080" のようにホストの 127.0.0.1 に限るか、80/443 だけ）。 */
  readonly ports: readonly string[];
  readonly memory: string;
  readonly readOnly: boolean;
  readonly tmpfs: readonly string[];
  readonly capAdd: readonly string[];
  readonly user?: string;
  /** 固定の IP（IMDS に届かない範囲。インターネットに面するもの・DB）。アプリは指定しない（動的な範囲 = AWS の資格情報を使える）。 */
  readonly ip?: string;
}

export interface HostImages {
  readonly dashboard: string;
  readonly ingest: string;
  readonly bot: string;
  readonly dbMigration: string;
  readonly mlTrain: string;
  readonly mysql: string;
  readonly caddy: string;
  readonly oauth2Proxy: string;
}

export interface ServiceSettings {
  readonly stateBucket: string;
  readonly modelsBucket: string;
  readonly siteHost: string;
  readonly cognitoIssuer: string;
  readonly cognitoClientId: string;
}

export const NETWORK = "jrabot";
/**
 * コンテナのネットワーク。前半（動的に割り当てる範囲）はアプリ・ジョブ（S3 の運用状態・モデルを読むため、インスタンスの資格情報を IMDS から使う）。
 * 後半は固定 IP だけ。インターネットに面する Caddy・oauth2-proxy と MySQL を置き、hostctl が DOCKER-USER の規則で IMDS への通信を落とす
 * （乗っ取られても SSM の秘密・S3 に届かない）。
 */
export const NETWORK_SUBNET = "172.30.0.0/24";
export const NETWORK_APP_RANGE = "172.30.0.0/25";
export const NETWORK_NO_IMDS_RANGE = "172.30.0.128/25";
export const FIXED_IPS: Readonly<Record<"mysql" | "caddy" | "oauth2-proxy", string>> = {
  mysql: "172.30.0.200",
  caddy: "172.30.0.201",
  "oauth2-proxy": "172.30.0.202",
};
const NO_IMDS_IP = /^172\.30\.0\.(1(2[89]|[3-9]\d)|2[0-4]\d|25[0-4])$/;
const SECRETS = "/run/jrabot/secrets";
const RUN = "/run/jrabot";
const JVM =
  "-XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xss512k -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=48m -XX:+ExitOnOutOfMemoryError";
const ro = (source: string, target: string): Mount => ({ source, target, readOnly: true });

/** アプリ（Spring Boot）の共通の環境。DB は同じホストの MySQL（docker のネットワークの中だけ。TLS で暗号化）。 */
function appEnv(s: ServiceSettings, dbUser: string, xmx: string): Record<string, string> {
  return {
    APP_ENV: "prod",
    TZ: "Asia/Tokyo",
    RUNTIME_PLATFORM: "aws",
    AWS_REGION: "ap-northeast-1",
    OPS_MODE_SOURCE: `s3://${s.stateBucket}/state/ops-state.json`,
    DB_URL: "jdbc:mysql://mysql:3306/jrabot?sslMode=REQUIRED",
    DB_USER: dbUser,
    JAVA_TOOL_OPTIONS: `-Xmx${xmx} ${JVM}`,
  };
}

const hardened = { readOnly: true, tmpfs: ["/tmp:rw,size=64m"], capAdd: [] as string[] };

export function services(
  img: HostImages,
  s: ServiceSettings,
): Record<"mysql" | "dashboard" | "ingest" | "oauth2-proxy" | "caddy", ContainerSpec> {
  return {
    mysql: {
      name: "mysql",
      ip: FIXED_IPS["mysql"],
      container: "jrabot-mysql",
      image: img.mysql,
      env: { MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/mysql-root", MYSQL_DATABASE: "jrabot", TZ: "UTC" },
      envFiles: [],
      mounts: [
        { source: "/data/mysql", target: "/var/lib/mysql", readOnly: false },
        ro("/opt/jrabot/mysql.cnf", "/etc/mysql/conf.d/jrabot.cnf"),
        ro(`${SECRETS}/mysql-root`, "/run/secrets/mysql-root"),
        ro(`${SECRETS}/mysql-root.cnf`, "/run/secrets/mysql-root.cnf"),
      ],
      ports: [], // 外部にも 127.0.0.1 にも公開しない（docker のネットワークの中だけ）
      memory: "448m",
      readOnly: false,
      tmpfs: ["/tmp:rw,size=64m", "/var/run/mysqld:rw,size=8m"],
      capAdd: [],
    },
    dashboard: {
      name: "dashboard",
      container: "jrabot-dashboard",
      image: img.dashboard,
      env: {
        ...appEnv(s, "app", "160m"),
        PORT: "8080",
        COGNITO_ISSUER: s.cognitoIssuer,
        COGNITO_CLIENT_ID: s.cognitoClientId,
        INTERNAL_OPS_TOKEN_FILE: "/run/jrabot/internal-ops-token",
      },
      envFiles: [`${RUN}/app.env`, `${RUN}/env/dashboard.env`],
      mounts: [ro(`${SECRETS}/internal-ops-token`, "/run/jrabot/internal-ops-token")],
      ports: ["127.0.0.1:18081:8080"],
      memory: "288m",
      ...hardened,
    },
    ingest: {
      name: "ingest",
      container: "jrabot-ingest",
      image: img.ingest,
      env: {
        ...appEnv(s, "ingest", "160m"),
        PORT: "8080",
        INTERNAL_OPS_TOKEN_FILE: "/run/jrabot/internal-ops-token",
        AGENT_HEARTBEAT_PREFIX: `s3://${s.stateBucket}/agent/`,
      },
      envFiles: [`${RUN}/app.env`, `${RUN}/env/ingest.env`],
      mounts: [ro(`${SECRETS}/internal-ops-token`, "/run/jrabot/internal-ops-token")],
      ports: ["127.0.0.1:18082:8080"],
      memory: "288m",
      ...hardened,
    },
    "oauth2-proxy": {
      name: "oauth2-proxy",
      ip: FIXED_IPS["oauth2-proxy"],
      container: "jrabot-oauth2-proxy",
      image: img.oauth2Proxy,
      command: [
        "--provider=oidc",
        `--oidc-issuer-url=${s.cognitoIssuer}`,
        `--client-id=${s.cognitoClientId}`,
        "--client-secret-file=/run/secrets/cognito-client-secret",
        "--authenticated-emails-file=/run/secrets/allowed-emails",
        "--email-domain=",
        "--http-address=0.0.0.0:4180",
        "--upstream=http://jrabot-dashboard:8080/",
        "--reverse-proxy=true",
        "--pass-authorization-header=true",
        "--skip-provider-button=true",
        "--scope=openid email",
        "--code-challenge-method=S256",
        `--redirect-url=https://${s.siteHost}/oauth2/callback`,
        "--cookie-name=__Host-jrabot",
        "--cookie-secure=true",
        "--cookie-samesite=lax",
        "--cookie-expire=12h",
        "--cookie-refresh=50m",
      ],
      env: {},
      envFiles: [`${RUN}/env/oauth2-proxy.env`],
      mounts: [
        ro(`${SECRETS}/cognito-client-secret`, "/run/secrets/cognito-client-secret"),
        ro(`${RUN}/allowed-emails`, "/run/secrets/allowed-emails"),
      ],
      ports: [],
      memory: "64m",
      ...hardened,
    },
    caddy: {
      name: "caddy",
      ip: FIXED_IPS["caddy"],
      container: "jrabot-caddy",
      image: img.caddy,
      env: { SITE_HOST: s.siteHost },
      envFiles: [],
      mounts: [ro("/opt/jrabot/Caddyfile", "/etc/caddy/Caddyfile"), { source: "/data/caddy", target: "/data", readOnly: false }],
      ports: ["80:80", "443:443"],
      memory: "64m",
      readOnly: true,
      tmpfs: ["/tmp:rw,size=16m", "/config:rw,size=8m"],
      capAdd: ["NET_BIND_SERVICE"],
    },
  };
}

export type JobKind = "bot-run" | "bot-task" | "db-migration" | "ml-train" | "batch";

/** 1 回だけ動かすコンテナ（bot の --task・db-migration・ml-train）。 */
export function job(kind: JobKind, img: HostImages, s: ServiceSettings, container: string, command: readonly string[]): ContainerSpec {
  const bot = kind === "bot-run" || kind === "bot-task" || kind === "batch";
  const xmx = kind === "bot-run" ? "224m" : kind === "batch" ? "768m" : kind === "ml-train" ? "768m" : "160m";
  const memory = kind === "bot-run" ? "384m" : kind === "batch" || kind === "ml-train" ? "1024m" : "256m";
  if (kind === "db-migration") {
    return {
      name: "db-migration",
      container,
      image: img.dbMigration,
      command,
      env: {
        DB_URL: "jdbc:mysql://mysql:3306/jrabot?sslMode=REQUIRED",
        DB_USER: "migrate",
        JAVA_TOOL_OPTIONS: `-Xmx${xmx} ${JVM}`,
        TZ: "Asia/Tokyo",
      },
      envFiles: [`${RUN}/env/db-migration.env`],
      mounts: [],
      ports: [],
      memory,
      ...hardened,
    };
  }
  if (kind === "ml-train") {
    return {
      name: "ml-train",
      container,
      image: img.mlTrain,
      command,
      env: { ...appEnv(s, "mltrain", xmx), MODEL_STORE_URI: `s3://${s.modelsBucket}`, OPS_WORKLOAD_GATE: "required" },
      envFiles: [`${RUN}/app.env`, `${RUN}/env/ml-train.env`],
      mounts: [],
      ports: [],
      memory,
      ...hardened,
    };
  }
  if (!bot) throw new Error(`未知の job: ${kind}`);
  return {
    name: "bot",
    container,
    image: img.bot,
    command,
    env: {
      ...appEnv(s, "bot", xmx),
      OPS_WORKLOAD_GATE: "required", // 閲覧用の起動では開催日の処理・重い処理をしない（アプリ側の柵。web D-282）
      JOB_LAUNCHER: "spool",
      JOB_SPOOL_DIR: "/spool",
      MODEL_STORE_URI: `s3://${s.modelsBucket}`,
    },
    envFiles: [`${RUN}/app.env`, `${RUN}/env/bot.env`],
    mounts: [{ source: "/var/spool/jrabot", target: "/spool", readOnly: false }],
    ports: [],
    memory,
    ...hardened,
  };
}

/** `docker run` の引数（-d または --rm）。安全の条件はここで一律に付ける。 */
export function dockerRunArgs(spec: ContainerSpec, mode: { detach: boolean; remove: boolean }): string[] {
  for (const p of spec.ports) {
    if (!/^(127\.0\.0\.1:\d{4,5}:\d{2,5}|80:80|443:443)$/.test(p)) throw new Error(`公開できないポート: ${p}`);
  }
  if (spec.name === "mysql" && spec.ports.length > 0) throw new Error("MySQL を公開しない");
  if (spec.name in FIXED_IPS && (spec.ip === undefined || !NO_IMDS_IP.test(spec.ip)))
    throw new Error(`${spec.name} は IMDS に届かない固定 IP で動かす`);
  if (spec.ip !== undefined && !NO_IMDS_IP.test(spec.ip)) throw new Error(`固定 IP は IMDS に届かない範囲だけ: ${spec.ip}`);
  const args = [
    "run",
    "--name",
    spec.container,
    "--network",
    NETWORK,
    "--memory",
    spec.memory,
    "--memory-swap",
    spec.memory,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
  ];
  if (spec.name === "mysql") args.push("--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE");
  for (const c of spec.capAdd) args.push("--cap-add", c);
  if (spec.readOnly) args.push("--read-only");
  for (const t of spec.tmpfs) args.push("--tmpfs", t);
  if (spec.user !== undefined) args.push("--user", spec.user);
  args.push(
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=3",
    "--stop-timeout",
    spec.name === "mysql" ? "120" : "60",
  );
  if (spec.ip !== undefined) args.push("--ip", spec.ip);
  if (mode.detach) args.push("--detach");
  if (mode.remove) args.push("--rm");
  for (const p of spec.ports) args.push("--publish", p);
  for (const m of spec.mounts) args.push("--mount", `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ",readonly" : ""}`);
  for (const f of spec.envFiles) args.push("--env-file", f);
  for (const [k, v] of Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))) args.push("--env", `${k}=${v}`);
  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

/** サードパーティのイメージの出どころ（tag と digest の両方で固定）。CLI の HOST_IMAGES とホストの検査が共用する。 */
export const HOST_IMAGE_PATTERNS: Readonly<Record<"mysql" | "caddy" | "oauth2Proxy", RegExp>> = {
  mysql: /^(docker\.io\/library\/)?mysql:[A-Za-z0-9._-]{1,64}@sha256:[0-9a-f]{64}$/,
  caddy: /^(docker\.io\/library\/)?caddy:[A-Za-z0-9._-]{1,64}@sha256:[0-9a-f]{64}$/,
  oauth2Proxy: /^quay\.io\/oauth2-proxy\/oauth2-proxy:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
};

/**
 * ホストが動かしてよいイメージだけか（版のファイルが書き換えられても、別の出どころのイメージを動かさない）。
 * アプリは このアカウントの ECR の jra-bot/<名前>（不変のタグ・digest）、サードパーティは HOST_IMAGE_PATTERNS。
 */
export function assertTrustedImages(img: HostImages, ecrRegistry: string): void {
  if (!/^\d{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com$/.test(ecrRegistry)) throw new Error("ECR のレジストリの形式が不正");
  const app: Record<string, [string, string]> = {
    dashboard: [img.dashboard, "dashboard"],
    ingest: [img.ingest, "ingest"],
    bot: [img.bot, "bot"],
    dbMigration: [img.dbMigration, "db-migration"],
    mlTrain: [img.mlTrain, "ml-train"],
  };
  for (const [k, [ref, name]] of Object.entries(app))
    if (!new RegExp(`^${ecrRegistry.replaceAll(".", "\\.")}/jra-bot/${name}@sha256:[0-9a-f]{64}$`).test(ref))
      throw new Error(`イメージ ${k} がこのアカウントの ECR の jra-bot/${name} ではない`);
  for (const k of ["mysql", "caddy", "oauth2Proxy"] as const)
    if (!HOST_IMAGE_PATTERNS[k].test(img[k])) throw new Error(`イメージ ${k} の出どころが許可されていない`);
}

/** イメージの参照は digest で固定する（タグだけの参照は動かさない）。 */
export function assertPinned(img: HostImages): void {
  for (const [k, v] of Object.entries(img)) {
    if (
      !/^[a-z0-9.-]+(:\d+)?\/[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(v) &&
      !/^[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(v)
    ) {
      throw new Error(`イメージ ${k} が digest で固定されていない`);
    }
  }
}
