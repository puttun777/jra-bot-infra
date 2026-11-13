// EC2 の初回起動の設定（cloud-init の user data。初回だけ実行される）。パッケージ・Node（SHA-256 で検証）・データの EBS・swap・systemd を整える。
// 運用エージェント本体（jrabot-host）と Caddyfile・mysql.cnf は起動のたびに S3 の host/ から取り直す（SHA-256 で検証。Pulumi が置く）。
// **データの EBS は、ファイルシステムが無いときだけ初期化する**（既存のデータを消さない）。秘密は含めない。
import { NODE } from "./config.js";

export interface UserDataInput {
  readonly arch: "arm64" | "amd64";
  readonly stateBucket: string;
  readonly dataVolumeId: string;
  readonly ecrRegistry: string;
  /** /etc/jrabot/host.json の内容（秘密を含まない）。 */
  readonly hostJson: string;
}

export function renderUserData(i: UserDataInput): string {
  const nodeArch = i.arch === "arm64" ? "arm64" : "x64";
  const sha = NODE.sha256[nodeArch];
  const volDev = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${i.dataVolumeId.replace("-", "")}`;
  if (!/^vol-[0-9a-f]{8,17}$/.test(i.dataVolumeId)) throw new Error("dataVolumeId の形式");
  if (i.hostJson.includes("'")) throw new Error("host.json に ' を含めない");
  return `#!/bin/bash
# jra-bot の EC2 の初回の設定（Pulumi が生成。docs/AWS_ARCHITECTURE.md §4）
set -euo pipefail
exec > >(tee -a /var/log/jrabot-userdata.log) 2>&1
dnf install -y docker amazon-ecr-credential-helper jq tar xz
mkdir -p /etc/systemd/system/docker.service.d /root/.docker /etc/jrabot /opt/jrabot/bin /data
# 停止のときに MySQL が正常に終わるまで待つ（コンテナの停止の猶予 120 秒 + 余裕）
printf '[Service]\\nTimeoutStopSec=240\\n' > /etc/systemd/system/docker.service.d/jrabot.conf
printf '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":false}\\n' > /etc/docker/daemon.json
printf '{"credHelpers":{"${i.ecrRegistry}":"ecr-login"}}\\n' > /root/.docker/config.json
systemctl enable --now docker

# Node（公式の配布物を SHA-256 で検証してから展開する）
cd /tmp
curl -fsSLO https://nodejs.org/dist/${NODE.version}/node-${NODE.version}-linux-${nodeArch}.tar.xz
echo "${sha}  node-${NODE.version}-linux-${nodeArch}.tar.xz" | sha256sum -c -
tar -xJf node-${NODE.version}-linux-${nodeArch}.tar.xz -C /opt
ln -sfn /opt/node-${NODE.version}-linux-${nodeArch} /opt/node

# データの EBS（MySQL・証明書・手元のバックアップ）。ファイルシステムが無いときだけ作る（既存のデータを消さない）
for i in $(seq 1 60); do [ -e ${volDev} ] && break; sleep 2; done
if [ -z "$(blkid -o value -s TYPE ${volDev} || true)" ]; then
  if file -sL ${volDev} | grep -q ': data$'; then mkfs.ext4 -L jrabot-data ${volDev}; else echo "データの EBS に不明な内容がある。初期化しない"; exit 1; fi
fi
UUID=$(blkid -o value -s UUID ${volDev})
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /data ext4 defaults,nofail,noatime 0 2" >> /etc/fstab
mount -a

# swap（メモリの急な増加で OOM にしない保険。1 GiB）
if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=1024 && chmod 600 /swapfile && mkswap /swapfile; fi
grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
swapon -a || true
sysctl -w vm.swappiness=10 && echo "vm.swappiness=10" > /etc/sysctl.d/90-jrabot.conf

# 設定（秘密を含まない）とインスタンス ID
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
IID=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
echo '${i.hostJson}' | jq --arg iid "$IID" '. + {instance_id: $iid}' > /etc/jrabot/host.json
chmod 644 /etc/jrabot/host.json

# 運用エージェントの取得（起動のたびに S3 の host/ から。SHA-256 で検証）
cat > /opt/jrabot/bin/jrabot-fetch <<'FETCH'
#!/bin/bash
set -euo pipefail
B=${i.stateBucket}
cd /opt/jrabot
for f in jrabot-host.mjs Caddyfile mysql.cnf; do
  aws s3 cp --only-show-errors "s3://$B/host/$f" "/opt/jrabot/$f.new"
  aws s3 cp --only-show-errors "s3://$B/host/$f.sha256" "/opt/jrabot/$f.sha256"
  echo "$(cut -d' ' -f1 /opt/jrabot/$f.sha256)  /opt/jrabot/$f.new" | sha256sum -c - >/dev/null
  mv "/opt/jrabot/$f.new" "/opt/jrabot/$f"
done
chmod 644 /opt/jrabot/Caddyfile /opt/jrabot/mysql.cnf
FETCH
cat > /opt/jrabot/bin/jrabot-host <<'HOST'
#!/bin/bash
# boot・tick・deploy・backup・restore を同時に動かさない（ホスト全体の排他）。run-batch は数時間かかるので取らない（排出は tick が止める）
case "\${1:-}" in
  run-batch) exec /opt/node/bin/node /opt/jrabot/jrabot-host.mjs "$@" ;;
  *) exec /usr/bin/flock -w 1800 /run/jrabot-host.lock /opt/node/bin/node /opt/jrabot/jrabot-host.mjs "$@" ;;
esac
HOST
chmod 755 /opt/jrabot/bin/jrabot-fetch /opt/jrabot/bin/jrabot-host

cat > /etc/systemd/system/jrabot-boot.service <<'UNIT'
[Unit]
Description=jra-bot: 運用エージェントの取得と起動時の準備
After=docker.service network-online.target data.mount
Wants=network-online.target
Requires=docker.service
RequiresMountsFor=/data
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/opt/jrabot/bin/jrabot-fetch
ExecStart=/opt/jrabot/bin/jrabot-host boot
Restart=on-failure
RestartSec=120
TimeoutStartSec=1200
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/jrabot-tick.service <<'UNIT'
[Unit]
Description=jra-bot: 1 分ごとの収束（サービス・開催日の処理・排出・報告）
After=docker.service
[Service]
Type=oneshot
ExecStart=/opt/jrabot/bin/jrabot-host tick
TimeoutStartSec=2400
UNIT
cat > /etc/systemd/system/jrabot-tick.timer <<'UNIT'
[Unit]
Description=jra-bot: 1 分ごと
[Timer]
OnBootSec=90
OnUnitInactiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable jrabot-boot.service jrabot-tick.timer
systemctl start jrabot-boot.service || true
systemctl start jrabot-tick.timer
`;
}
