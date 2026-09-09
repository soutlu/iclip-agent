#!/usr/bin/env bash
# 让 incoming/ 里新上传的 configs、agents 生效。
# 先用线上镜像做一次完整装配校验，通过才替换线上目录并重启后端；校验不过线上目录原样不动，退出码非零。
# 放在部署目录（与 compose.yaml、.env 同目录）执行，deploy-config 工作流与手工发布都走这一个脚本。
set -euo pipefail
cd "$(dirname "$0")"

for dir in configs agents; do
  if [ ! -d "incoming/$dir" ]; then
    echo "缺少 incoming/$dir，先把仓库里的 server/$dir 同步到这里" >&2
    exit 1
  fi
done

echo "校验 incoming/ 里的配置"
docker compose run --rm --no-deps config-check

rsync -a --delete incoming/configs/ configs/
rsync -a --delete incoming/agents/ agents/
docker compose restart server

container=$(docker compose ps -q server)
for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$container")
  if [ "$status" = "healthy" ]; then
    echo "配置已生效，后端健康"
    exit 0
  fi
  sleep 3
done
echo "重启后 60 秒内后端未恢复健康，查看 docker compose logs server" >&2
exit 1
