# 前端镜像：Node 构建静态产物，nginx 托管并把 /api 反代到后端。
FROM node:22-alpine AS build

# 本机网络到 npm 官方源慢时可换镜像源：--build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
# pnpm 11 使用独立的配置前缀，须与 npm 使用同一个构建期源。
ENV NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY \
    PNPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY

WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.npmrc ./
# pnpm 版本以 package.json 的 packageManager 为准，不在这里另写一份。
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --frozen-lockfile

COPY web/ ./
# 类型检查会读取共享 Transcript 样例，构建上下文须为仓库根。
COPY contract/ /app/contract/
RUN pnpm build

FROM nginx:1.28-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
