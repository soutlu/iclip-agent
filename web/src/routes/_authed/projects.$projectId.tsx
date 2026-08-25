import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/projects/$projectId')({
  // Agent 与 Direct Canvas 创作工作区当前统一停用；父路由仍负责登录态校验。
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
})
