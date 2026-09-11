#!/usr/bin/env bash
set -euo pipefail

server=true
web=true
# 只缩小 PR 的范围；合入后全跑，公共文件和未知路径也全跑。
if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
  if git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA" > "$RUNNER_TEMP/ci-changed-files"; then
    server=false
    web=false
    while IFS= read -r -d '' path; do
      case "$path" in
        server/*) server=true ;;
        web/*) web=true ;;
        *) server=true; web=true ;;
      esac
    done < "$RUNNER_TEMP/ci-changed-files"
  else
    echo "::warning::无法确定 PR 变更范围，执行两端完整检查"
  fi
fi
echo "server=$server" >> "$GITHUB_OUTPUT"
echo "web=$web" >> "$GITHUB_OUTPUT"
