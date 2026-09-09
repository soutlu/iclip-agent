#!/usr/bin/env bash
# 让 incoming/ 里新上传的 configs、agents 生效。
# 先用线上镜像做一次完整装配校验，通过才替换线上目录；随后给后端发 SIGHUP 热重载，
# 后端在 /healthz 的 config 段报告结果：generation 递增即成功；needs_restart 表示改的不止模型与 agent，
# 改走重启。校验不过线上目录原样不动，退出码非零。
# 放在部署目录（与 compose.yaml、.env 同目录）执行，deploy-config 工作流与手工发布都走这一个脚本。
set -euo pipefail
cd "$(dirname "$0")"

for dir in configs agents; do
  if [ ! -d "incoming/$dir" ]; then
    echo "缺少 incoming/$dir，先把仓库里的 server/$dir 同步到这里" >&2
    exit 1
  fi
done

healthz() {
  docker compose exec -T server python -c \
    "import sys, urllib.request; sys.stdout.write(urllib.request.urlopen('http://127.0.0.1:7788/healthz', timeout=3).read().decode())"
}

restart_and_wait() {
  docker compose restart server
  local container status
  container=$(docker compose ps -q server)
  for _ in $(seq 1 20); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container")
    if [ "$status" = "healthy" ]; then
      echo "配置已生效，后端健康"
      return 0
    fi
    sleep 3
  done
  echo "重启后 60 秒内后端未恢复健康，查看 docker compose logs server" >&2
  return 1
}

echo "校验 incoming/ 里的配置"
docker compose run --rm --no-deps config-check

rsync -a --delete incoming/configs/ configs/
rsync -a --delete incoming/agents/ agents/

before=$(healthz | jq -r '.config.generation // empty')
if [ -z "$before" ]; then
  echo "线上镜像不支持热重载，改为重启后端"
  restart_and_wait
  exit $?
fi

docker compose kill -s HUP server
for _ in $(seq 1 10); do
  sleep 2
  state=$(healthz)
  generation=$(printf '%s' "$state" | jq -r '.config.generation')
  if [ "$generation" -gt "$before" ]; then
    echo "配置已热重载（generation $generation）"
    exit 0
  fi
  error=$(printf '%s' "$state" | jq -r '.config.error // empty')
  if [ -n "$error" ]; then
    if [ "$(printf '%s' "$state" | jq -r '.config.needs_restart')" = "true" ]; then
      echo "$error"
      restart_and_wait
      exit $?
    fi
    # 配置本身有问题（多半是 .env 少了新变量，或声明引用了不存在的东西）。旧配置仍在跑，不动它。
    echo "热重载被拒绝，线上仍用旧配置：$error" >&2
    exit 1
  fi
done
echo "20 秒内没等到热重载结果，查看 docker compose logs server" >&2
exit 1
