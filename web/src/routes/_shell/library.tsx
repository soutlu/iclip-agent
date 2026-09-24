import { createFileRoute, redirect } from '@tanstack/react-router'
import { LibraryRoute, type LibraryScope } from '@/features/library'
import { ensureSessionUser, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { librarySearchSchema, scopeFromSearch, searchFromScope } from '../-library-search'

// 资料库要登录且能看出片记录；筛选范围存在查询参数里，退回、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/library')({
  beforeLoad: async () => {
    if (!hasPermission(await ensureSessionUser(), PERMISSION.generationRead)) {
      throw redirect({ to: '/' })
    }
  },
  component: LibraryPage,
  validateSearch: librarySearchSchema,
})

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data: user } = useUser()
  const setScope = (next: LibraryScope) =>
    void navigate({ replace: true, search: searchFromScope(next) })

  return (
    <LibraryRoute
      myUserName={user?.username ?? null}
      onScopeChange={setScope}
      scope={scopeFromSearch(search)}
    />
  )
}
