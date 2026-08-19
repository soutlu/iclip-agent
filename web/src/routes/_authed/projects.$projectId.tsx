import { createFileRoute, redirect } from '@tanstack/react-router'
import { ProjectRoute } from '@/features/project-workspace'
import { canEditProducerProjects, requireSession } from '@/shared/auth'

export const Route = createFileRoute('/_authed/projects/$projectId')({
  beforeLoad: async ({ location }) => {
    const user = await requireSession(location.href)

    // UI 门控：未持有后端 RBAC projects:write 权限（viewer）的用户回首页；执法在后端接口。
    if (!canEditProducerProjects(user)) {
      throw redirect({ to: '/' })
    }
  },
  component: ProjectPage,
})

/**
 * 渲染 Producer 项目文件夹路由。
 *
 * @returns 当前项目文件夹页。
 */
function ProjectPage() {
  const { projectId } = Route.useParams()

  return <ProjectRoute projectId={projectId} />
}
